/**
 * Автоподъём субагента шины без чата: отвязанный фоновый `claude -p --agent <имя>` в каталоге агента.
 * Модуль (request, state, enabled, setEnabled) и он же раннер: node wake.js run <имя> <ящик> <каталог> <кто разбудил>.
 * Грузится только при подъёме — хук inbox --hook и обычный send его не парсят.
 *
 * Человека в петле нет, поэтому тормоза здесь: один процесс на агента (wake.lock), не больше WAKES_PER_HOUR
 * автоподъёмов в час (сообщение пользователя из UI — human — лимит не держит и в счёт не идёт: там человек в петле есть), таймаут запуска, лог каждого запуска, общий рубильник.
 * В ящике агента: wake.lock — идёт запуск, wake.json — чем кончился последний, wake.log — отчёты запусков.
 *
 * BUS_WAKE=1 в окружении claude: хук inbox --hook проекта с ним молчит — иначе фоновая сессия, запущенная
 * в каталоге проекта, забрала бы входящие оркестратора. TG_LISTENER_RUN=1 глушит tg-notify.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SWITCH = path.join(CONFIG_DIR, 'bus', 'autowake.json');
const CLAUDE_CMD = process.env.BUS_CLAUDE_CMD || 'claude'; // подменяют тесты
const TIMEOUT_MS = Number(process.env.BUS_WAKE_TIMEOUT_MS) || 10 * 60 * 1000;
const WAKES_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 256 * 1024;
const REPORT_LENGTH = 2000;
// Будит любое сообщение; старые FYI/STATUS/ACK, долежавшие в ящике, — нет
const WAKE_LINE = /^\[(?:TASK|QUESTION|DONE) /;
// Замер 19.09.2026: с этими флагами подъём на «привет» — 11 с и ≈14к токенов записи в кэш. MCP и скиллы агентам шины не нужны
const CLAUDE_ARGS = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--no-chrome', '--disable-slash-commands'];

const lockFile = (box) => path.join(box, 'wake.lock');
const stateFile = (box) => path.join(box, 'wake.json');
const logFile = (box) => path.join(box, 'wake.log');
const inboxFile = (box) => path.join(box, 'inbox.md');
// Fast mode у субагента во frontmatter не задать — только настройкой сессии. Файл в ящике — и флаг, и сами настройки: он уходит в claude --settings
const fastFile = (box) => path.join(box, 'claude-settings.json');
// Глобальные CLAUDE.md и rules/ писаны для чата с пользователем (тон, планы, MCP, субагенты): фоновому агенту это шум.
// Замер 20.09.2026: claudeMdExcludes снимает ≈3.3к токенов с каждого подъёма. CLAUDE.md и .claude/rules/ проекта остаются
const sessionFile = (box) => path.join(box, 'wake-settings.json');

/** Настройки фоновой сессии: пишутся перед каждым запуском, в claude уходят через --settings. */
function sessionSettings(box) {
  const home = CONFIG_DIR.split(path.sep).join('/');
  writeJson(sessionFile(box), { claudeMdExcludes: [`${home}/CLAUDE.md`, `${home}/rules/**`], ...(isFast(box) ? { fastMode: true } : {}) });
  return sessionFile(box);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n');
  fs.renameSync(tmp, file);
}

// ---------- рубильник ----------

/** BUS_AUTOWAKE=0|1 в окружении сильнее файла: так тесты не запускают настоящий claude. По умолчанию включён. */
function enabled() {
  if (process.env.BUS_AUTOWAKE === '0') return false;
  if (process.env.BUS_AUTOWAKE === '1') return true;
  return readJson(SWITCH, {}).on !== false;
}

const setEnabled = (on) => writeJson(SWITCH, { on: Boolean(on) });

// ---------- состояние ----------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Лок держит живой раннер. Процесс умер или висит дольше таймаута с запасом — лок протух. Раннер освежает at перед каждым запуском claude. */
function running(box) {
  const lock = readJson(lockFile(box), null);
  return Boolean(lock && alive(lock.pid) && Date.now() - lock.at < TIMEOUT_MS + 60 * 1000);
}

const recent = (times) => (Array.isArray(times) ? times.filter((t) => Date.now() - t < HOUR_MS) : []);

const isFast = (box) => readJson(fastFile(box), {}).fastMode === true;

function setFast(box, on) {
  if (!on) return fs.rmSync(fastFile(box), { force: true });
  fs.mkdirSync(box, { recursive: true });
  writeJson(fastFile(box), { fastMode: true });
}

/** Для UI и autowake: шо с агентом сейчас. running без живого лока — раннер убили, честно говорим «упал». */
function state(box) {
  const saved = readJson(stateFile(box), null);
  if (!saved) return null;
  const { times, ...rest } = saved;
  // limit в файле остаётся до следующего подъёма, а сам лимит — скользящий час: вышел — говорить не о чем
  if (rest.state === 'limit') return recent(times).length >= WAKES_PER_HOUR ? { ...rest, wakes: recent(times).length, until: Math.min(...recent(times)) + HOUR_MS } : null;
  if (rest.state === 'running' && !running(box)) return { ...rest, state: 'failed', reason: 'фоновый процесс пропал, не дописав итог', wakes: recent(times).length };
  return { ...rest, wakes: recent(times).length };
}

function saveState(box, patch) {
  const saved = readJson(stateFile(box), {});
  writeJson(stateFile(box), { ...saved, ...patch, times: recent(patch.times || saved.times) });
}

// ---------- запрос подъёма ----------

/**
 * Зовут send и UI. Сам ничего не ждёт: стартует отвязанный раннер и возвращается.
 * → { state: 'started' | 'busy' | 'limit' | 'off' | 'failed', reason? }. busy — агент уже работает и новое сообщение заберёт сам.
 */
function request(agent, { cwd, by, human = false }) {
  if (!enabled()) return { state: 'off' };
  if (running(agent.box)) return { state: 'busy' };
  const saved = readJson(stateFile(agent.box), {});
  if (!human && recent(saved.times).length >= WAKES_PER_HOUR) {
    saveState(agent.box, { state: 'limit', at: Date.now(), by, reason: `лимит ${WAKES_PER_HOUR} автоподъёмов в час` });
    return { state: 'limit', reason: `лимит ${WAKES_PER_HOUR} автоподъёмов в час` };
  }
  try {
    const { spawn } = require('child_process');
    // detached + stdio ignore + unref — процесс переживает send; windowsHide — без окна консоли на Windows
    // 'error' у spawn прилетает событием, а не исключением: без обработчика он уронил бы зовущего — сервер UI
    const runner = spawn(process.execPath, [__filename, 'run', agent.name, agent.box, cwd, by || '?', human ? 'human' : ''], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    runner.on('error', () => {});
    runner.unref();
    return { state: 'started' };
  } catch (e) {
    return { state: 'failed', reason: e.message };
  }
}

// ---------- раннер ----------

function takeLock(box) {
  fs.mkdirSync(box, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile(box), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (running(box)) return false; // два send подряд — второй раннер просто уходит
      fs.rmSync(lockFile(box), { force: true });
    }
  }
  return false;
}

/** claude на Windows — .cmd-обёртка под cmd.exe: kill() снял бы только оболочку, сам claude остался бы жить. */
function killTree(child) {
  if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

const wakeLines = (box) => {
  try {
    return fs.readFileSync(inboxFile(box), 'utf8').split('\n').filter((line) => WAKE_LINE.test(line));
  } catch {
    return [];
  }
};

function prompt(cwd, by) {
  return [
    `Тебя подняла шина bus: в твоём inbox непрочитанное (разбудил «${by}»). Каталог проекта: ${cwd}.`,
    'Прочитай inbox и ответь отправителям — порядок и правила в блоке «Шина» твоей роли.',
    'Ты запущен в фоне, без чата: отчёт сюда никто не прочтёт, результат — только твои ответы в шине. Последним сообщением — одна строка: кому и шо ответил, без списков и пересказа.',
  ].join('\n');
}

/**
 * Один фоновый запуск claude -p, промпт через stdin. agent — подъём субагента шины; без него — безымянная сессия каталога
 * (задача расписания без адресата, scheduler.js), ей можно задать model.
 * → { ok, ms, tokens, cost, reason, report }
 */
function runClaude({ cwd, agent = null, model = null, settings = null, prompt: text, timeoutMs = TIMEOUT_MS }) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const started = Date.now();
    // shell: claude на Windows — .cmd-обёртка npm, напрямую её не запустить. Имя агента проверено шиной (латиница, цифры, дефис), модель — scheduler.js
    // Путь к настройкам — относительный, когда ящик лежит в каталоге запуска: в командную строку не едут пробелы и кириллица из пути проекта
    const rel = settings ? path.relative(cwd, settings) : '';
    const settingsArg = settings ? ['--settings', `"${(rel.startsWith('..') || path.isAbsolute(rel) ? settings : rel).split(path.sep).join('/')}"`] : [];
    const args = [...CLAUDE_ARGS, ...(agent ? ['--agent', agent] : []), ...(model ? ['--model', model] : []), ...settingsArg];
    const child = spawn(`${CLAUDE_CMD} ${args.join(' ')}`, { cwd, shell: true, windowsHide: true, env: { ...process.env, BUS_WAKE: '1', TG_LISTENER_RUN: '1' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, ms: Date.now() - started, reason: `claude не запустился: ${e.message}`, report: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = {};
      try {
        const data = JSON.parse(stdout.trim());
        result = (Array.isArray(data) ? data.find((item) => item.type === 'result') : data) || {};
      } catch {
        // не JSON — причиной ниже станет хвост вывода
      }
      const usage = result.usage || {};
      const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0); // чтение из кэша почти бесплатное — в «вес» подъёма не идёт
      const report = typeof result.result === 'string' ? result.result.trim() : '';
      const ok = !timedOut && code === 0 && !result.is_error;
      const reason = ok ? '' : timedOut ? `таймаут ${Math.round(timeoutMs / 1000)} с` : `claude вернул ошибку (код ${code}): ${(report || stderr || stdout).trim().slice(-200) || 'пустой ответ'}`;
      resolve({ ok, ms: Date.now() - started, tokens, cost: result.total_cost_usd || 0, reason, report });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

function appendLog(box, text) {
  try {
    if (fs.statSync(logFile(box)).size > LOG_ROTATE_BYTES) fs.renameSync(logFile(box), `${logFile(box)}.1`);
  } catch {
    // лога ещё нет
  }
  fs.appendFileSync(logFile(box), text);
}

const stamp = () => new Date().toLocaleString('sv-SE'); // 2026-09-19 21:40:05

async function run(name, box, cwd, by, human = false) {
  // Раннер зовут и руками: кривой путь без проверки создал бы ящик где попало (20.09.2026 — C:\.claude) и поднял агента в текущем каталоге
  if (!box || !fs.existsSync(box) || !cwd || !fs.existsSync(cwd)) return;
  if (!takeLock(box)) return;
  try {
    for (let round = 0; ; round++) {
      // Повторный запуск идёт под тем же локом: без свежего at он протух бы посреди работы, и второй раннер поднял бы агента параллельно
      writeJson(lockFile(box), { pid: process.pid, at: Date.now() });
      const before = wakeLines(box);
      // Первый круг по сообщению пользователя в счёт лимита не идёт; повторные — идут: их причина уже пришедшее от агентов
      const times = [...recent(readJson(stateFile(box), {}).times), ...(human && round === 0 ? [] : [Date.now()])];
      saveState(box, { state: 'running', at: Date.now(), by, reason: '', times });
      const r = await runClaude({ cwd, agent: name, settings: sessionSettings(box), prompt: prompt(cwd, by) });
      saveState(box, { state: r.ok ? 'ok' : 'failed', at: Date.now(), by, ms: r.ms, tokens: r.tokens, cost: r.cost, reason: r.reason });
      appendLog(box, `\n=== ${stamp()} · разбудил ${by} · ${r.ok ? 'ok' : 'СБОЙ: ' + r.reason} · ${Math.round(r.ms / 1000)} с · ≈${r.tokens} ток.\n${r.report.slice(0, REPORT_LENGTH)}\n`);

      // Пока агент работал, могло прийти новое сообщение. Строка, лежавшая ещё до запуска, значит другое:
      // агент inbox не прочёл — повтор ничего не даст, только сожжёт токены
      const after = wakeLines(box);
      if (!r.ok || !after.length || after.some((line) => before.includes(line)) || !enabled()) break;
      if (recent(readJson(stateFile(box), {}).times).length >= WAKES_PER_HOUR) {
        saveState(box, { state: 'limit', at: Date.now(), by, reason: `лимит ${WAKES_PER_HOUR} автоподъёмов в час` });
        break;
      }
    }
  } finally {
    fs.rmSync(lockFile(box), { force: true });
  }
}

module.exports = { WAKES_PER_HOUR, LOG_ROTATE_BYTES, enabled, setEnabled, request, state, running, runClaude, killTree, alive, readJson, writeJson, isFast, setFast };

if (require.main === module && process.argv[2] === 'run') {
  const [name, box, cwd, by, human] = process.argv.slice(3);
  run(name, box, cwd, by, human === 'human').catch((e) => {
    try {
      saveState(box, { state: 'failed', at: Date.now(), by, reason: `раннер упал: ${e.message}` });
      fs.rmSync(lockFile(box), { force: true });
    } catch {
      // писать уже некуда
    }
    process.exitCode = 1;
  });
}
