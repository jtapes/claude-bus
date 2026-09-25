#!/usr/bin/env node
/**
 * Расписание шины: задачи по cron. Модуль (хранилище, CLI `bus.js schedule …`, API для ui.js) и он же процесс:
 *   node scheduler.js daemon                 — демон под pm2 (bus-scheduler): раз в 20 с сверяет cron задач всех проектов шины;
 *   node scheduler.js run <каталог> <имя> …  — отвязанный раннер одного запуска: демон и `schedule run` его не ждут.
 *
 * Задача — файл <проект>/.claude/bus/scheduler/<имя>.md: frontmatter (cron, to, enabled, model, timeout, catchup, rules) + тело-промпт,
 * правится и руками. Рядом: <имя>.log — отчёты, <имя>.state.json — итог последнего запуска, <имя>.lock — запуск идёт.
 * Глобальные задачи — ~/.claude/bus/scheduler/, исполняются в домашней папке и только headless.
 *
 * to: <агент> — TASK от оркестратора каталога + фоновый подъём (wake.js), ответ агента — в ленте UI.
 * без to      — headless `claude -p` в каталоге проекта; отчёт — в лог и сообщением «schedule → оркестратор» в журнал каталога.
 *
 * Демон живёт, пока есть хоть одна включённая задача: поднимают и гасят его add / on / off / rm и UI (syncDaemon),
 * сам он гаснет, если задачи убрали руками. pm2 на Windows после перезагрузки не встаёт — в автозагрузку кладётся
 * bus-scheduler.vbs с `pm2 resurrect`.
 *
 * Лимит автоподъёмов в час расписание не держит (human: true): петли здесь быть не может, тормоз — сам cron;
 * частое расписание режет saveJob(). Рубильник autowake off гасит и расписание.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const bus = require('./bus.js');
const cron = require('./cron.js');
const wake = require('./wake.js');
const { stamp, writeAtomic, readJson, writeJson, appendLog: appendTo, alive, lockHeld, takeRunLock } = require('./fsx.js');

const PM2_NAME = 'bus-scheduler';
const PM2_CMD = process.env.BUS_PM2_CMD || 'pm2'; // подменяют тесты
const HEARTBEAT = path.join(bus.BUS, 'scheduler.json'); // { pid, at, lastTick } — жив ли демон, без вызова pm2 (тот стоит секунды)
const STARTUP_DIR = process.env.BUS_STARTUP_DIR || (process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null);
const STARTUP_FILE = STARTUP_DIR ? path.join(STARTUP_DIR, `${PM2_NAME}.vbs`) : null;
const TICK_MS = Number(process.env.BUS_SCHEDULER_TICK_MS) || 20 * 1000;
const HEARTBEAT_FRESH_MS = 90 * 1000;
const START_WAIT_MS = process.env.BUS_SCHEDULER_START_WAIT_MS === undefined ? 8000 : Number(process.env.BUS_SCHEDULER_START_WAIT_MS); // тесты с подставным pm2 не ждут
const IDLE_TICKS = 3; // столько проходов подряд без включённых задач — и демон гасит себя
const CATCHUP_MAX_MS = 7 * 24 * 60 * 60 * 1000; // пропуск старше недели не догоняем
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const settings = require('./settings.js');
const MODEL = settings.MODEL; // та же проверка, шо у настройки schedule.model: «opus[1m]» проходит и там, и в задаче
// Дефолты; проект переопределяет их настройками schedule.* (settings.js, шестерёнка в UI). Глобальные задачи (root = null) живут на дефолтах
const DEFAULT_TIMEOUT_MIN = settings.DEFAULTS['schedule.timeoutMin'];
const MAX_TIMEOUT_MIN = settings.SCHEMA.find((item) => item.key === 'schedule.timeoutMin').max;
const WARN_GAP_MIN = 15; // чаще — задача принимается, но с ценой в токенах за сутки; порог не настройка: пользователь убрал его из формы 21.09.2026
const INLINE_MARGIN = 300; // длиннее «лимит сообщения − запас» — промпт уходит агенту вложением: сообщение шины — одна строка до message.maxLength символов
const conf = (root) => settings.get(root);
const modelOf = (job) => job.model || conf(job.root)['schedule.model'];
const FEED_REPORT = 600; // отчёт headless-запуска в ленте; целиком — в логе задачи
const LOG_REPORT = 4000;
const WAKE_TOKENS = 20000; // первый ход фонового подъёма без урезанного доступа (access-weights.json, замер 21.09.2026 — 19.7к), для оценки цены частого расписания

const dirOf = (root) => (root ? path.join(root, '.claude', 'bus', 'scheduler') : path.join(bus.BUS, 'scheduler'));
const jobFile = (root, name) => path.join(dirOf(root), `${name}.md`);
const logFile = (root, name) => path.join(dirOf(root), `${name}.log`);
const stateFile = (root, name) => path.join(dirOf(root), `${name}.state.json`);
const lockFile = (root, name) => path.join(dirOf(root), `${name}.lock`);
const cwdOf = (root) => root || os.homedir();
const minuteKey = (date) => stamp(false, date).slice(0, 16); // 2026-09-20 09:00

// ---------- хранилище ----------

function requireJobName(name) {
  if (!NAME.test(name || '')) throw new bus.BusError('Имя задачи: латиница в нижнем регистре, цифры и дефис, до 31 символа. Пример: bus.js schedule add morning "0 9 * * 1-5" --to dima Проверь задачи');
}

/** Frontmatter — плоские `ключ: значение`. В кавычках — как есть, без кавычек хвост ` # …` — комментарий. */
function parseJob(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
  if (!m) return { meta: {}, prompt: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const quoted = /^(["'])(.*)\1/.exec(kv[2]);
    meta[kv[1]] = quoted ? quoted[2] : kv[2].replace(/\s+#.*$/, '').trim();
  }
  return { meta, prompt: m[2].trim() };
}

/** Файл задачи → задача. Кривая — не падаем: error с причиной, такая не запускается, а list и UI её показывают. */
function readJob(root, name) {
  const file = jobFile(root, name);
  const { meta, prompt } = parseJob(fs.readFileSync(file, 'utf8'));
  const timeout = Number(meta.timeout) || conf(root)['schedule.timeoutMin']; // в задаче не указан — таймаут проекта
  // Флаги правят и руками: «False», «no», «0» молча читались как «включена», и задача дальше жгла токены
  const flag = (value, fallback) => (value === undefined || value === '' ? fallback : { true: true, false: false }[String(value).toLowerCase()]);
  const flags = { enabled: flag(meta.enabled, true), catchup: flag(meta.catchup, false), rules: flag(meta.rules, false) };
  const job = {
    name, root, file, prompt,
    cron: meta.cron || '',
    to: meta.to || '',
    enabled: flags.enabled === true,
    model: meta.model || '',
    timeout: Math.min(Math.max(timeout, 1), MAX_TIMEOUT_MIN),
    catchup: flags.catchup === true,
    rules: flags.rules === true,
    error: '',
  };
  try {
    for (const key of Object.keys(flags)) if (flags[key] === undefined) throw new Error(`${key}: «${meta[key]}» — только true или false`);
    cron.parse(job.cron);
    if (!prompt) throw new Error('пустой промпт');
    if (job.model && !MODEL.test(job.model)) throw new Error(`model: «${job.model}» — только латиница, цифры, точка, дефис, [ ]`);
    if (job.to && !root) throw new Error('глобальная задача идёт только headless-сессией: to: — для задач проекта');
    if (job.to && !NAME.test(job.to)) throw new Error(`to: «${job.to}» — не имя агента`);
  } catch (e) {
    job.error = e.message;
  }
  return job;
}

function listJobs(root) {
  let names = [];
  try {
    names = fs.readdirSync(dirOf(root)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => NAME.test(n));
  } catch {
    // расписания в каталоге нет
  }
  return names.sort().map((name) => {
    try {
      return readJob(root, name);
    } catch (e) {
      return { name, root, file: jobFile(root, name), cron: '', to: '', enabled: false, model: '', timeout: DEFAULT_TIMEOUT_MIN, catchup: false, rules: false, prompt: '', error: e.message };
    }
  });
}

/** Каталоги с расписанием: живые проекты из реестра шины + домашняя шина (null). */
function roots() {
  const globals = bus.loadRegistry(bus.REGISTRY);
  const projects = Object.values(globals).map((a) => a && a.project).filter((p) => typeof p === 'string' && fs.existsSync(p));
  return [null, ...new Set(projects)];
}

const allJobs = () => roots().flatMap(listJobs);
const runnable = (job) => job.enabled && !job.error;

function serialize(job) {
  const lines = ['---', `cron: "${job.cron}"`];
  if (job.to) lines.push(`to: ${job.to}`);
  lines.push(`enabled: ${job.enabled !== false}`);
  if (job.model) lines.push(`model: ${job.model}`);
  if (job.timeout && job.timeout !== conf(job.root)['schedule.timeoutMin']) lines.push(`timeout: ${job.timeout}`);
  if (job.catchup) lines.push('catchup: true');
  if (job.rules && !job.to) lines.push('rules: true'); // агенту правила включает галочка в его форме, а не задача
  return `${lines.join('\n')}\n---\n${job.prompt.trim()}\n`;
}

/** Адресат задачи — субагент, видимый из каталога; отправителем будет оркестратор каталога. → { from, to } */
function parties(root, toName) {
  const from = bus.orchestratorOf(root);
  if (!from) throw new bus.BusError(`Каталог ${root} не подключён к шине — слать агенту не от кого. Подключится сам первой командой из него (bus.js inbox) или bus.js init <имя>.`);
  const to = bus.describe(bus.contextOf(root), toName);
  if (!to || !bus.isSubagent(to)) throw new bus.BusError(`to: «${toName}» — такого субагента из ${root} не видно. Проекту по расписанию не пишем: его не поднять.`);
  bus.requireAlive(to);
  return { from, to };
}

const tokensNote = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')} млн` : `${Math.round(n / 1000)}к`);

/** Цена частого расписания словами — для предупреждения в CLI и UI. */
function costNote(gap) {
  const perDay = Math.round((24 * 60) / gap);
  return `запуск каждые ${gap} мин — это ≈${perDay} в сутки, от ≈${tokensNote(perDay * WAKE_TOKENS)} токенов в сутки только на подъём`;
}

/**
 * Создать или перезаписать задачу. Проверки — до записи. force: перезаписать существующую и разрешить cron чаще schedule.minGapMin.
 * → { job, warning }
 */
function saveJob(root, input, { force = false, overwrite = force } = {}) {
  const name = String(input.name || '');
  requireJobName(name);
  if (!overwrite && fs.existsSync(jobFile(root, name))) throw new bus.BusError(`Задача «${name}» уже есть. Перезаписать — --force, выключить — schedule off ${name}.`);
  let parsed;
  try {
    parsed = cron.parse(input.cron);
  } catch (e) {
    throw new bus.BusError(e.message);
  }
  if (!cron.next(parsed)) throw new bus.BusError(`cron «${parsed.expr}» не наступит никогда.`);
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new bus.BusError('Пустой промпт.');
  const model = String(input.model || '');
  if (model && !MODEL.test(model)) throw new bus.BusError('--model: только латиница, цифры, точка, дефис, [ ] — до 60 символов.');
  const to = String(input.to || '');
  if (to && !root) throw new bus.BusError('Глобальная задача идёт только headless-сессией: агенту — задача в проекте.');
  if (to) parties(root, to);
  const limits = conf(root);
  const timeout = input.timeout === undefined || input.timeout === '' ? limits['schedule.timeoutMin'] : Number(input.timeout);
  if (!(timeout >= 1 && timeout <= MAX_TIMEOUT_MIN)) throw new bus.BusError(`timeout — минуты, от 1 до ${MAX_TIMEOUT_MIN}.`);

  const gap = cron.minGapMinutes(parsed);
  // code — для UI: по нему страница предлагает «Всё равно сохранить» (L.isFrequentError)
  if (gap < limits['schedule.minGapMin'] && !force) throw Object.assign(new bus.BusError(`Слишком часто: ${costNote(gap)}. Уверен — повтори с --force.`), { code: 'frequent' });
  const warning = gap < WARN_GAP_MIN ? `Часто: ${costNote(gap)}.` : '';

  // Промпт режется тем же redact, шо и сообщения: файл задачи уходит агенту текстом или вложением
  const { redact } = require('./lib/redact.js');
  const job = { name, root, cron: parsed.expr, to, enabled: input.enabled !== false, model, timeout, catchup: Boolean(input.catchup), rules: Boolean(input.rules), prompt: redact(prompt) };
  writeAtomic(jobFile(root, name), serialize(job));
  return { job: readJob(root, name), warning };
}

function requireJob(root, name) {
  requireJobName(name);
  if (!fs.existsSync(jobFile(root, name))) throw new bus.BusError(`Задачи «${name}» нет. Есть: ${listJobs(root).map((j) => j.name).join(', ') || 'ни одной'}`);
  return readJob(root, name);
}

/** Правим одну строку frontmatter, остальное — байт в байт: файл могли писать руками, с комментариями. */
function setEnabled(root, name, on) {
  const job = requireJob(root, name);
  const text = fs.readFileSync(job.file, 'utf8');
  const head = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
  if (!head) throw new bus.BusError(`«${name}»: в файле нет frontmatter — поправь ${job.file} руками.`);
  const lines = /^enabled\s*:.*$/m.test(head[2]) ? head[2].replace(/^enabled\s*:.*$/m, `enabled: ${on}`) : `${head[2]}\nenabled: ${on}`;
  writeAtomic(job.file, text.replace(head[0], () => `${head[1]}${lines}${head[3]}`)); // функцией: строку-замену replace разбирает сам, и «$&» из рукописного frontmatter портил файл
  return readJob(root, name);
}

function removeJob(root, name) {
  const job = requireJob(root, name);
  // Раннер дописал бы состояние и лог уже удалённой задачи — мусор, который достался бы новой задаче с тем же именем
  if (isRunning(root, name)) throw new bus.BusError(`Задача «${name}» сейчас выполняется — дождись конца запуска и удали.`);
  for (const file of [job.file, logFile(root, name), `${logFile(root, name)}.1`, stateFile(root, name), lockFile(root, name)]) fs.rmSync(file, { force: true });
}

// ---------- состояние запуска ----------

const isRunning = (root, name) => lockHeld(lockFile(root, name), DEFAULT_TIMEOUT_MIN * 60000);

/** Итог последнего запуска. running без живого лока — раннер убили: честно говорим «упал». */
function jobState(root, name) {
  const saved = readJson(stateFile(root, name), null);
  if (!saved) return null;
  if (saved.state === 'running' && !isRunning(root, name)) return { ...saved, state: 'failed', reason: 'фоновый процесс пропал, не дописав итог' };
  return saved;
}

const saveState = (root, name, patch) => writeJson(stateFile(root, name), { ...readJson(stateFile(root, name), {}), ...patch });

const appendLog = (root, name, text) => appendTo(logFile(root, name), text);

/** Для list и UI: задача + итог последнего запуска + ближайший запуск. */
function view(job) {
  let next = null;
  const about = job.error ? '' : cron.describe(job.cron);
  if (!job.error && job.enabled) {
    const at = cron.next(cron.parse(job.cron));
    next = at ? at.getTime() : null;
  }
  return { name: job.name, root: job.root, cron: job.cron, about, to: job.to, enabled: job.enabled, model: job.model, timeout: job.timeout, catchup: job.catchup, rules: job.rules, prompt: job.prompt, error: job.error, next, last: jobState(job.root, job.name) };
}

// ---------- запуск задачи ----------

/** Отвязанный раннер: демон, CLI и UI запуск не ждут. fired — минута cron, по которой запуск состоялся (защита от дубля). */
function spawnRun(root, name, { manual = false, fired = '' } = {}) {
  const { spawn } = require('child_process');
  const runner = spawn(process.execPath, [__filename, 'run', root || '-', name, manual ? 'manual' : 'cron', fired], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  runner.on('error', () => {});
  runner.unref();
}

/** Наложение запусков — пропуск: живой или только что созданный чужой лок (fsx.takeRunLock). */
const takeLock = (root, name, timeoutMs) => takeRunLock(lockFile(root, name), { pid: process.pid, at: Date.now(), timeoutMs }, DEFAULT_TIMEOUT_MIN * 60000);

/** TASK агенту от оркестратора каталога + фоновый подъём. Длинный промпт — вложением. → { state, note, reason } */
function runForAgent(job) {
  const { from, to } = parties(job.root, job.to);
  const head = `По расписанию «${job.name}»: `;
  let text = head + job.prompt;
  let attachments = [];
  let tmpDir = null;
  const limits = conf(job.root);
  if (text.length > limits['message.maxLength'] - INLINE_MARGIN) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-schedule-'));
    const file = path.join(tmpDir, `${job.name}.md`);
    // внутрь вложений шина не заглядывает — промпт режем сами: файл задачи могли править руками
    fs.writeFileSync(file, require('./lib/redact.js').redact(job.prompt) + '\n');
    attachments = bus.checkAttachments([{ src: file }], { maxFiles: limits['files.max'], maxFileBytes: limits['files.maxMb'] * 1024 * 1024 });
    text = `${head}${job.prompt.split(/\r?\n/)[0].slice(0, 200)}… — полный текст задачи во вложении, прочитай его.`;
  }
  let sent = {};
  try {
    // ui: true — ответ агента адресован пользователю в ленте: сессии проекта придёт счётчик, а не текст
    sent = bus.deliver(from, to, 'TASK', bus.clean(text, limits['message.maxLength']), attachments, { ui: true });
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const r = bus.autoWake(from, to, 'TASK', { here: job.root, ringSelf: true, human: true, messageId: sent.id });
  if (r.state === 'started') return { state: 'ok', note: `TASK ушёл ${to.name}, поднят в фоне — ответ будет в ленте` };
  if (r.state === 'busy') return { state: 'ok', note: `TASK ушёл ${to.name}, он уже работает в фоне — заберёт сам` };
  return { state: 'ok', note: `TASK ушёл ${to.name}, но фон его не поднял (${r.reason || 'автоподъём выключен'})${r.ring ? ` — звонок ушёл оркестратору ${r.ring}` : ''}` };
}

function headlessPrompt(job) {
  return [
    `Тебя запустил планировщик шины bus: задача «${job.name}» по расписанию (${cron.describe(job.cron)}). Каталог: ${cwdOf(job.root)}.`,
    'Ты работаешь в фоне, без чата: вопросы задавать некому — шо неясно, реши сам по месту или опиши в итоге.',
    'Твой итоговый ответ уйдёт пользователю в ленту шины: закончи коротким итогом — шо сделано, шо нет и почему.',
    '',
    'Задача:',
    job.prompt,
  ].join('\n');
}

/**
 * Отчёт headless-запуска — сообщением в журнал каталога: лента UI рисует его как обычное, удаление и фильтры работают сами.
 * Тип всегда DONE — запуск закончен; сбой виден по тексту «СБОЙ: …».
 */
function reportToFeed(job, report) {
  const to = job.root ? bus.orchestratorOf(job.root) : null;
  const text = bus.clean(`Расписание «${job.name}»: ${report.length > FEED_REPORT ? `${report.slice(0, FEED_REPORT)}… (целиком — schedule log ${job.name})` : report || '(пустой отчёт)'}`);
  bus.journalNote(job.root ? path.join(job.root, '.claude', 'bus') : bus.BUS, { from: 'schedule', fk: 's', to: to ? to.name : 'user', tk: to ? 'p' : 'h', type: 'DONE', text, job: job.name });
}

async function runHeadless(job) {
  if (!wake.enabled()) return { state: 'skipped', reason: 'автоподъём выключен (bus.js autowake on)' };
  // Глобальные CLAUDE.md и rules/ — про чат с пользователем, в фоне это ≈3.3к токенов шума на запуск; нужны задаче — rules: true в её файле
  const r = await wake.runClaude({ cwd: cwdOf(job.root), model: modelOf(job), settings: job.rules ? null : wake.headlessSettings(dirOf(job.root)), prompt: headlessPrompt(job), timeoutMs: job.timeout * 60000 });
  reportToFeed(job, r.ok ? r.report : `СБОЙ: ${r.reason}`);
  return { state: r.ok ? 'ok' : 'failed', ms: r.ms, tokens: r.tokens, cost: r.cost, reason: r.reason, report: r.report };
}

/** Один запуск задачи, под локом. Идёт в раннере (`scheduler.js run`). */
async function runJob(root, name, { manual = false, fired = '' } = {}) {
  const job = readJob(root, name);
  const mark = fired ? { fired } : {};
  if (job.error) {
    saveState(root, name, { state: 'failed', at: Date.now(), reason: job.error, ...mark });
    return appendLog(root, name, `\n=== ${stamp()} · СБОЙ: ${job.error}\n`);
  }
  if (!takeLock(root, name, job.timeout * 60000)) {
    // Состояние не трогаем — там «running» идущего запуска; в логе пропуск остаётся
    return appendLog(root, name, `\n=== ${stamp()} · пропуск: предыдущий запуск ещё идёт\n`);
  }
  const started = Date.now();
  try {
    saveState(root, name, { state: 'running', at: started, manual, reason: '', note: '', ...mark });
    let r;
    try {
      r = job.to ? runForAgent(job) : await runHeadless(job);
    } catch (e) {
      r = { state: 'failed', reason: e instanceof bus.BusError ? e.message : `раннер упал: ${e.message}` };
    }
    saveState(root, name, { state: r.state, at: Date.now(), manual, ms: r.ms || Date.now() - started, tokens: r.tokens || 0, cost: r.cost || 0, reason: r.reason || '', note: r.note || '' });
    const title = r.state === 'ok' ? 'ok' : r.state === 'skipped' ? `пропуск: ${r.reason}` : `СБОЙ: ${r.reason}`;
    appendLog(root, name, `\n=== ${stamp()} · ${manual ? 'вручную' : job.cron} · ${title}${r.tokens ? ` · ${Math.round(r.ms / 1000)} с · ≈${r.tokens} ток.` : ''}\n${(r.note || r.report || '').slice(0, LOG_REPORT)}\n`);
  } finally {
    fs.rmSync(lockFile(root, name), { force: true });
  }
}

// ---------- демон ----------

const readHeartbeat = () => readJson(HEARTBEAT, null);

function daemonAlive() {
  const beat = readHeartbeat();
  return Boolean(beat && alive(beat.pid) && Date.now() - beat.at < HEARTBEAT_FRESH_MS);
}

/**
 * Один проход: какие задачи пора запускать. prev — время прошлого прохода: задачи с catchup догоняют пропущенное
 * (комп спал, демон лежал) одним запуском. launch — чем запускать (тесты подставляют свой).
 * → число включённых задач
 */
function tick(now, prev, fired, launch = spawnRun) {
  const key = minuteKey(now);
  const minuteStart = new Date(now.getTime());
  minuteStart.setSeconds(0, 0);
  let active = 0;
  for (const job of allJobs()) {
    // Включённая, но кривая — тоже повод жить: файл правят руками, и за минуту с опечаткой демон иначе гасил бы себя насовсем
    if (job.enabled) active++;
    if (!runnable(job)) continue;
    const id = `${job.root || ''}|${job.name}`;
    if (fired.get(id) === key) continue;
    const parsed = cron.parse(job.cron);
    let due = cron.matches(parsed, now);
    if (!due && job.catchup && prev && now - prev < CATCHUP_MAX_MS) {
      const missed = cron.next(parsed, prev);
      due = Boolean(missed && missed < minuteStart);
    }
    if (!due) continue;
    // Демон перезапустили в ту же минуту — в памяти пусто, но раннер уже записал fired в состояние задачи
    if ((readJson(stateFile(job.root, job.name), {}) || {}).fired === key) continue;
    fired.set(id, key);
    launch(job.root, job.name, { fired: key });
  }
  return active;
}

function daemon() {
  const fired = new Map();
  const beat = readHeartbeat();
  let prev = beat && beat.lastTick ? new Date(beat.lastTick) : null;
  let idle = 0;
  console.log(`${stamp()} расписание шины: демон поднят, pid ${process.pid}`);
  const pass = () => {
    // Второй демон (подняли руками рядом с pm2) стоит в резерве: задачи не дублирует, подхватит, если первый умрёт
    const other = readHeartbeat();
    if (other && other.pid !== process.pid && alive(other.pid) && Date.now() - other.at < HEARTBEAT_FRESH_MS) {
      if (other.lastTick) prev = new Date(other.lastTick); // подхватим работу — catchup считаем от его последнего прохода, а не от своего давнего
      return;
    }
    const now = new Date();
    try {
      const active = tick(now, prev, fired);
      idle = active ? 0 : idle + 1;
    } catch (e) {
      console.error(`${stamp()} проход: ${e.message}`);
    }
    prev = now;
    writeJson(HEARTBEAT, { pid: process.pid, at: Date.now(), lastTick: now.getTime() });
    if (idle >= IDLE_TICKS) {
      console.log(`${stamp()} включённых задач нет — демон гасит себя`);
      selfStop();
    }
  };
  pass();
  setInterval(pass, TICK_MS);
}

/** Просто выйти нельзя: pm2 перезапустит. Под pm2 — удаляем себя из него, без pm2 (тесты, запуск руками) — выходим. */
function selfStop() {
  fs.rmSync(HEARTBEAT, { force: true });
  if (process.env.pm_id === undefined) return process.exit(0);
  removeStartup();
  // pm2 delete убивает этот процесс раньше, чем вернётся вызов: save после него не выполнялся, и запись в дампе воскрешала
  // демона при каждом pm2 resurrect. Оба шага делает отвязанный помощник — демон поднят с --no-treekill, его он переживает
  const { spawn } = require('child_process');
  const then = process.platform === 'win32' ? '&' : ';';
  spawn(`${PM2_CMD} delete ${PM2_NAME} ${then} ${PM2_CMD} save --force`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// ---------- pm2 и автозагрузка ----------

function pm2(args) {
  const { spawnSync } = require('child_process');
  // shell: pm2 на Windows — .cmd-обёртка npm
  const r = spawnSync(`${PM2_CMD} ${args.join(' ')}`, { shell: true, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function installStartup() {
  if (!STARTUP_FILE || !fs.existsSync(STARTUP_DIR)) return false;
  fs.writeFileSync(STARTUP_FILE, 'CreateObject("WScript.Shell").Run "cmd /c pm2 resurrect", 0, False\r\n');
  return true;
}

const removeStartup = () => STARTUP_FILE && fs.rmSync(STARTUP_FILE, { force: true });

/** → строка о том, шо сделано. pm2 не стоит — BusError с подсказкой. */
function startDaemon() {
  if (daemonAlive()) return 'демон уже работает';
  pm2(['delete', PM2_NAME]); // остановленная или упавшая запись с тем же именем не дала бы стартовать
  const r = pm2(['start', `"${__filename}"`, '--name', PM2_NAME, '--cwd', `"${os.homedir()}"`, '--time', '--no-treekill', '--', 'daemon']); // no-treekill: остановка демона не рубит идущие запуски задач — они его дети
  if (!r.ok) throw new bus.BusError(`pm2 не поднял демона расписания: ${r.out.slice(-300) || 'pm2 не найден'}. Нет pm2 — npm i -g pm2.`);
  // Ждём первый heartbeat: без него следующая команда (второй add подряд) сочла бы демона мёртвым и подняла заново
  for (const end = Date.now() + START_WAIT_MS; Date.now() < end && !daemonAlive(); ) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  pm2(['save', '--force']);
  const startup = installStartup();
  return `демон поднят (pm2: ${PM2_NAME})${startup ? ', автозагрузка: bus-scheduler.vbs' : process.platform === 'win32' ? '' : '; после перезагрузки его вернёт pm2 startup'}`;
}

function stopDaemon() {
  const r = pm2(['delete', PM2_NAME]);
  pm2(['save', '--force']);
  removeStartup();
  fs.rmSync(HEARTBEAT, { force: true });
  return r.ok ? 'демон остановлен' : 'демон и так не работал';
}

/** Есть включённые задачи — демон должен жить, нет — гаснет. Зовут add / on / off / rm и UI после каждой правки. */
function syncDaemon() {
  const active = allJobs().filter(runnable).length;
  if (active) return startDaemon();
  return daemonAlive() ? `${stopDaemon()}: включённых задач не осталось` : 'демон не нужен: включённых задач нет';
}

/**
 * Страховка: включённые задачи есть, а демона нет — pm2 после перезагрузки не воскрес, процесс убили. Поднимаем молча;
 * зовут list и старт UI. Не вышло (pm2 нет) — причина строкой, команду это не роняет. → строка о сделанном или ''
 */
function ensureDaemon() {
  if (daemonAlive() || !allJobs().some(runnable)) return '';
  try {
    return startDaemon();
  } catch (e) {
    if (e instanceof bus.BusError) return e.message;
    throw e;
  }
}

function daemonStatus() {
  const beat = readHeartbeat();
  const alive = daemonAlive();
  return { alive, pid: alive ? beat.pid : null, lastTick: beat ? beat.lastTick : null, active: allJobs().filter(runnable).length };
}

// ---------- CLI: bus.js schedule … ----------

const USAGE = `bus.js schedule — задачи по расписанию (cron), только оркестратор
  schedule [list] [--all]            задачи каталога (--all — всех проектов) и статус демона
  schedule add <имя> "<cron>" [--to <агент>] [--model m] [--timeout мин] [--catchup] [--rules] [--off] [--force] [--global] <промпт | ->
                                     cron — 5 полей, время локальное; без --to — headless-сессия проекта; «-» — промпт из stdin
  schedule on|off <имя>              включить / выключить
  schedule rm <имя>                  удалить задачу и её лог
  schedule run <имя>                 запустить сейчас, мимо cron
  schedule log <имя> [N]             хвост отчётов запусков (по умолчанию 40 строк)
  schedule daemon [start|stop|status]   демон под pm2; обычно поднимается и гаснет сам
--global — задача в ~/.claude/bus/scheduler/ (только headless, исполняется в домашней папке)`;

const clock = (ms) => (ms ? stamp(true, ms) : '—');

function lastNote(last) {
  if (!last) return 'ещё не запускалась';
  const when = clock(last.at);
  if (last.state === 'running') return `идёт с ${when}`;
  if (last.state === 'ok') return `ок ${when}${last.tokens ? ` · ≈${Math.round(last.tokens / 1000)}к ток.` : ''}${last.note ? ` · ${last.note}` : ''}`;
  if (last.state === 'skipped') return `пропуск ${when}: ${last.reason}`;
  return `упала ${when}: ${last.reason}`;
}

function printJobs(jobs, showRoot) {
  for (const job of jobs) {
    const v = view(job);
    const flag = v.error ? 'ОШИБКА' : v.enabled ? 'вкл' : 'выкл';
    console.log(`${v.name.padEnd(20)} ${flag.padEnd(6)} ${`"${v.cron}"`.padEnd(18)} ${v.error || v.about} → ${v.to || `сессия (${modelOf(v)})`}${showRoot ? ` · ${v.root || '~ (глобальная)'}` : ''}`);
    if (!v.error) console.log(`${''.padEnd(20)} след.: ${v.enabled ? clock(v.next) : '—'} · ${lastNote(v.last)}`);
  }
}

function takeFlag(args, flag, withValue = false) {
  const at = args.indexOf(flag);
  if (at < 0) return withValue ? undefined : false;
  const [, value] = args.splice(at, withValue ? 2 : 1);
  if (withValue && value === undefined) throw new bus.BusError(`${flag}: не указано значение.`);
  return withValue ? value : true;
}

/**
 * У add флаги стоят между cron и промптом: дальше «--to» и «--global» — просто слова текста, как --file у send.
 * Вырезает флаги из rest (остаются имя, cron и слова промпта) и возвращает их отдельным списком.
 */
function addFlags(rest) {
  let end = 2;
  while (end < rest.length && rest[end].startsWith('--')) end += ['--to', '--model', '--timeout'].includes(rest[end]) ? 2 : 1;
  return rest.splice(2, end - 2);
}

function cli(asName, args) {
  if (asName) throw new bus.BusError('Расписание ведёт только оркестратор: с --as нельзя. Нужна задача по расписанию — попроси пользователя.');
  if (!args.length || args[0].startsWith('--')) args = ['list', ...args]; // `schedule --all` — тот же list
  const [command, ...rest] = args;
  const flags = command === 'add' ? addFlags(rest) : rest;
  const isGlobal = takeFlag(flags, '--global');
  const ctx = bus.context();
  const project = bus.projectSelf(ctx);
  const needRoot = () => {
    if (isGlobal) return null;
    if (!project) throw new bus.BusError('Этот каталог не подключён к шине: он подключится сам первой командой из него (bus.js inbox) или bus.js init <имя>. Глобальная задача — с --global.');
    return project.root;
  };

  if (command === 'list') {
    const all = takeFlag(rest, '--all');
    const jobs = all ? allJobs() : listJobs(needRoot());
    if (jobs.length) printJobs(jobs, all);
    else console.log(all ? 'Задач по расписанию нет.' : 'В этом каталоге задач по расписанию нет. Все проекты — schedule --all.');
    const raised = ensureDaemon();
    if (raised) console.log(`Демон не работал, а включённые задачи есть — ${raised}.`);
    const d = daemonStatus();
    console.log(`Демон: ${d.alive ? `работает (pid ${d.pid})` : d.active ? 'НЕ работает, а включённые задачи есть — schedule daemon start' : 'не нужен, включённых задач нет'}.`);
  } else if (command === 'add') {
    const force = takeFlag(flags, '--force');
    const input = { to: takeFlag(flags, '--to', true), model: takeFlag(flags, '--model', true), timeout: takeFlag(flags, '--timeout', true), catchup: takeFlag(flags, '--catchup'), rules: takeFlag(flags, '--rules'), enabled: !takeFlag(flags, '--off') };
    if (flags.length) throw new bus.BusError(`schedule add: не знаю флага «${flags[0]}».`);
    const [name, expr, ...words] = rest;
    const prompt = words.length === 1 && words[0] === '-' ? bus.readStdin() : words.join(' ');
    const { job, warning } = saveJob(needRoot(), { ...input, name, cron: expr, prompt }, { force });
    console.log(`Задача «${job.name}»: ${cron.describe(job.cron)} → ${job.to || `headless-сессия (${modelOf(job)})`}. Ближайший запуск: ${clock(view(job).next)}. Файл: ${job.file}`);
    if (warning) console.log(warning);
    console.log(`Расписание: ${syncDaemon()}.`);
  } else if (command === 'on' || command === 'off') {
    const job = setEnabled(needRoot(), rest[0], command === 'on');
    console.log(`Задача «${job.name}» ${job.enabled ? `включена, ближайший запуск: ${clock(view(job).next)}` : 'выключена'}.`);
    console.log(`Расписание: ${syncDaemon()}.`);
  } else if (command === 'rm') {
    removeJob(needRoot(), rest[0]);
    console.log(`Задача «${rest[0]}» удалена.`);
    console.log(`Расписание: ${syncDaemon()}.`);
  } else if (command === 'run') {
    const job = requireJob(needRoot(), rest[0]);
    if (job.error) throw new bus.BusError(`«${job.name}» не запустить: ${job.error}`);
    if (isRunning(job.root, job.name)) throw new bus.BusError(`«${job.name}» уже идёт.`);
    spawnRun(job.root, job.name, { manual: true });
    console.log(`«${job.name}» запущена в фоне. Итог: schedule log ${job.name}${job.to ? ', ответ агента — в ленте UI' : ''}.`);
  } else if (command === 'log') {
    const job = requireJob(needRoot(), rest[0]);
    let text = '';
    try {
      text = fs.readFileSync(logFile(job.root, job.name), 'utf8');
    } catch {
      // запусков ещё не было
    }
    console.log(text.trim() ? text.trimEnd().split('\n').slice(-(Number(rest[1]) || 40)).join('\n') : `«${job.name}» ещё не запускалась.`);
  } else if (command === 'daemon') {
    if (rest[0] === 'start') console.log(`Расписание: ${startDaemon()}.`);
    else if (rest[0] === 'stop') console.log(`Расписание: ${stopDaemon()}.`);
    else {
      const d = daemonStatus();
      console.log(`Демон: ${d.alive ? `работает, pid ${d.pid}, последний проход ${clock(d.lastTick)}` : 'не работает'}. Включённых задач: ${d.active}.`);
    }
  } else {
    console.log(USAGE);
    process.exitCode = command === 'help' ? 0 : 1;
  }
}

module.exports = { cli, listJobs, allJobs, saveJob, setEnabled, removeJob, requireJob, view, isRunning, spawnRun, tick, syncDaemon, ensureDaemon, daemonStatus };

if (require.main === module) {
  const [mode, root, name, how, fired] = process.argv.slice(2);
  if (mode === 'daemon') daemon();
  else if (mode === 'run') {
    runJob(root === '-' ? null : root, name, { manual: how === 'manual', fired: fired || '' }).catch((e) => {
      try {
        saveState(root === '-' ? null : root, name, { state: 'failed', at: Date.now(), reason: `раннер упал: ${e.message}` });
      } catch {
        // писать уже некуда
      }
      process.exitCode = 1;
    });
  } else {
    console.log('node scheduler.js daemon | run <каталог|-> <имя> [manual|cron] [минута]. Задачи — через bus.js schedule.');
    process.exitCode = 1;
  }
}
