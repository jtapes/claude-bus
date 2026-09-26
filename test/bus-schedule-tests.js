/**
 * Тесты расписания шины (skills/bus/scripts/cron.js, scheduler.js, API расписания в ui.js). Зовёт run-tests.js — песочница,
 * подменённый CLAUDE_CONFIG_DIR и check() общие. Настоящие claude и pm2 не зовутся: BUS_CLAUDE_CMD и BUS_PM2_CMD — подставные,
 * автозагрузка пишется в BUS_STARTUP_DIR песочницы.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

module.exports = async function busScheduleTests({ sandbox, configDir, baseEnv, check, HOOKS }) {
  const SCRIPTS = path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts');
  const BUS_JS = path.join(SCRIPTS, 'bus.js');
  const SCHEDULER_JS = path.join(SCRIPTS, 'scheduler.js');
  const cron = require(path.join(SCRIPTS, 'cron.js'));
  const busDir = path.join(configDir, 'bus');
  fs.rmSync(busDir, { recursive: true, force: true }); // прошлые блоки оставили свой реестр — начинаем с чистого

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const lines = (file) => read(file).split('\n').filter(Boolean);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (cond, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (cond()) return true;
    return false;
  };

  // ---------- cron ----------
  const at = (...args) => new Date(...args);
  const nextOf = (expr, from) => {
    const n = cron.next(cron.parse(expr), from);
    return n ? n.toLocaleString('sv-SE').slice(0, 16) : null;
  };
  const sunday = at(2026, 8, 20, 15, 30); // 20.09.2026 — воскресенье
  check('C1 cron: будни, шаг, списки, граница месяца и года', nextOf('0 9 * * 1-5', sunday) === '2026-09-21 09:00' && nextOf('*/15 * * * *', sunday) === '2026-09-20 15:45' && nextOf('30 8,20 * * *', sunday) === '2026-09-20 20:30' && nextOf('0 10 1 * *', sunday) === '2026-10-01 10:00' && nextOf('0 0 1 1 *', sunday) === '2027-01-01 00:00' && nextOf('30 15 * * *', sunday) === '2026-09-21 15:30', [nextOf('0 9 * * 1-5', sunday), nextOf('0 0 1 1 *', sunday), nextOf('30 15 * * *', sunday)].join());
  check('C2 cron: 7 — тоже воскресенье; день месяца и день недели вместе — «или»; 31 февраля не наступит — null, а не вечный цикл', nextOf('0 12 * * 7', at(2026, 8, 21)) === '2026-09-27 12:00' && nextOf('0 9 25 * 1', sunday) === '2026-09-21 09:00' && nextOf('0 9 25 * 1', at(2026, 8, 22)) === '2026-09-25 09:00' && nextOf('0 0 31 2 *', sunday) === null);
  const bad = (expr) => {
    try {
      cron.parse(expr);
      return '';
    } catch (e) {
      return e instanceof cron.CronError ? e.message : `чужая ошибка: ${e.message}`;
    }
  };
  check('C3 cron: мусор — CronError с полем и причиной', bad('61 * * * *').includes('минута') && bad('* * *').includes('5 полей') && bad('a * * * *').includes('не понял') && bad('*/0 * * * *').includes('шаг') && bad('5-1 * * * *').includes('вне') && bad('* * * * 8').includes('день недели'), [bad('61 * * * *'), bad('*/0 * * * *'), bad('* * * * 8')].join(' | '));
  check('C4 cron describe: человеческая подпись, на мусоре — текст ошибки, а не исключение', cron.describe('0 9 * * 1-5') === 'по будням в 09:00' && cron.describe('*/15 * * * *') === 'каждые 15 мин' && cron.describe('30 8 * * *') === 'каждый день в 08:30' && cron.describe('0 12 * * 0,6') === 'по выходным в 12:00' && cron.describe('0 */2 * * *') === 'каждые 2 ч в :00' && cron.describe('0 9 * * 1,3,5') === 'по пн, ср, пт в 09:00' && cron.describe('nope').includes('5 полей'), cron.describe('0 9 * * 1,3,5'));
  check('C5 cron: matches по минуте, upcoming и самый короткий промежуток', cron.matches(cron.parse('0 9 * * 1-5'), at(2026, 8, 21, 9, 0, 40)) && !cron.matches(cron.parse('0 9 * * 1-5'), at(2026, 8, 21, 9, 1)) && !cron.matches(cron.parse('0 9 * * 1-5'), at(2026, 8, 20, 9, 0)) && cron.upcoming(cron.parse('0 9 * * *'), 3, sunday).length === 3 && cron.minGapMinutes(cron.parse('*/2 * * * *')) === 2 && cron.minGapMinutes(cron.parse('0 9,10 * * *')) === 60 && cron.minGapMinutes(cron.parse('0 9 * * *')) === Infinity);

  // ---------- логика панели расписания (ui-logic.js) ----------
  const L = require(path.join(SCRIPTS, 'ui-logic.js'));
  const roundTrip = [['daily', { time: '08:30' }, '30 8 * * *'], ['weekdays', { time: '09:00' }, '0 9 * * 1-5'], ['weekly', { time: '10:15', day: '3' }, '15 10 * * 3'], ['minutes', { n: '15' }, '*/15 * * * *'], ['hours', { n: '2', minute: '5' }, '5 */2 * * *']];
  check('L40 расписание в UI: пресет собирает cron, а cron задачи распознаётся обратно в тот же пресет; незнакомый cron — «свой», кривое время — null', roundTrip.every(([preset, p, expr]) => L.buildScheduleCron(preset, p) === expr && JSON.stringify(L.scheduleCronPreset(expr)) === JSON.stringify({ preset, ...p })) && roundTrip.every(([, , expr]) => !cron.describe(expr).includes('cron')) && L.scheduleCronPreset('0 9 * * 1,3').preset === 'custom' && L.buildScheduleCron('custom', { expr: ' 0 9 1 * * ' }) === '0 9 1 * *' && L.buildScheduleCron('daily', { time: '25:99' }) === null);
  const notes = [L.scheduleLastNote(null), L.scheduleLastNote({ state: 'running', at: Date.now() }), L.scheduleLastNote({ state: 'ok', at: Date.now(), tokens: 14000, note: 'dima поднят' }), L.scheduleLastNote({ state: 'skipped', at: Date.now(), reason: 'автоподъём выключен' }), L.scheduleLastNote({ state: 'failed', at: Date.now(), reason: 'таймаут' })];
  const groups = L.scheduleGroups([{ name: 'a', root: '/x' }, { name: 'g', root: null }, { name: 'b', root: '/here' }], [{ root: null, project: '' }, { root: '/x', project: 'x' }, { root: '/here', project: 'h' }], '/here');
  check('L41 расписание в UI: подписи итога запуска и тон (упавшая — «bad»), статус демона, счётчик кнопки, группы — каталог UI первым, глобальные последними; «слишком часто» распознаётся по code, а не по тексту, — для кнопки «Всё равно сохранить»', notes[0].text.includes('ещё не запускалась') && notes[1].tone === 'run' && notes[2].text.includes('ок') && notes[2].text.includes('dima поднят') && notes[3].text.includes('пропуск') && notes[4].tone === 'bad' && notes[4].text.includes('таймаут') && L.scheduleDaemonNote({ alive: false, active: 2 }).tone === 'bad' && L.scheduleDaemonNote({ alive: false, active: 0 }).tone === '' && L.scheduleDaemonNote({ alive: true, lastTick: Date.now() }).text.includes('работает') && JSON.stringify(L.scheduleBadge([{ enabled: true }, { enabled: true, error: 'x' }, { enabled: false, last: { state: 'failed' } }])) === '{"count":1,"alert":true}' && JSON.stringify(groups.map((g) => g.jobs.map((j) => j.name))) === '[["b"],["a"],["g"]]' && L.isFrequentError({ code: 'frequent', message: 'Too often: …' }) && !L.isFrequentError({ message: 'Слишком часто: …' }) && !L.isFrequentError(null) && L.validScheduleName('morning-1') && !L.validScheduleName('Bad_Name'), JSON.stringify([notes, groups]));
  // ---------- песочница ----------
  const proj = path.join(sandbox, 'work', 'sched-a');
  const stranger = path.join(sandbox, 'work', 'sched-stranger');
  for (const dir of [proj, stranger]) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const startupDir = path.join(sandbox, 'startup');
  fs.mkdirSync(startupDir, { recursive: true });
  const vbs = path.join(startupDir, 'bus-scheduler.vbs');

  const pm2Seen = path.join(sandbox, 'fake-pm2-seen.jsonl');
  const fakePm2 = path.join(sandbox, 'fake-pm2.js');
  fs.writeFileSync(fakePm2, `require('fs').appendFileSync(${JSON.stringify(pm2Seen)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  const pm2Calls = () => lines(pm2Seen).map((l) => JSON.parse(l));
  const pm2Reset = () => fs.rmSync(pm2Seen, { force: true });

  // Подставной claude: с --agent — «поднятый шиной агент» (забирает свой inbox), без — headless-сессия расписания
  const claudeSeen = path.join(sandbox, 'fake-sched-claude.jsonl');
  const claudeMode = path.join(sandbox, 'fake-sched-mode.txt');
  const fakeClaude = path.join(sandbox, 'fake-sched-claude.js');
  // Подъём агента потоковый (--input-format stream-json): stdin остаётся открытым, промпт — первая строка. Сессия расписания — разовая, до EOF
  fs.writeFileSync(fakeClaude, `let s = '';
let fired = false;
const go = () => {
  if (fired) return;
  fired = true;
  main();
};
process.stdin.on('data', (c) => {
  s += c;
  if (process.argv.includes('--input-format') && s.includes('\\n')) go();
}).on('end', go);
function main() {
  const fs = require('fs');
  const argv = process.argv.slice(2);
  const agent = argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : '';
  const mode = fs.existsSync(${JSON.stringify(claudeMode)}) ? fs.readFileSync(${JSON.stringify(claudeMode)}, 'utf8').trim() : 'ok';
  fs.appendFileSync(${JSON.stringify(claudeSeen)}, JSON.stringify({ agent, cwd: process.cwd(), wakeEnv: process.env.BUS_WAKE || '', argv, stdin: s }) + '\\n');
  if (agent) require('child_process').spawnSync(process.execPath, [${JSON.stringify(BUS_JS)}, '--as', agent, 'inbox', '--quiet'], { cwd: process.cwd(), env: process.env });
  if (mode === 'fail') { console.error('модель недоступна'); process.exit(1); }
  if (mode === 'split') {
    // итог двумя чанками, граница — посреди двухбайтной «ш»
    const bytes = Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'Отчёт: решение принято', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
    const cut = bytes.indexOf(Buffer.from('ш')) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    return setTimeout(() => process.stdout.write(bytes.subarray(cut)), 300);
  }
  const done = () => console.log(JSON.stringify({ type: 'result', is_error: false, result: agent ? 'ответил отправителю' : 'Отчёт по расписанию: всё проверено, ключ ${baseEnv.SOME_SERVICE_API_KEY}', total_cost_usd: 0.05, usage: { input_tokens: 10, cache_creation_input_tokens: 9000, output_tokens: 200 } }));
  return mode === 'slow' ? setTimeout(done, 1500) : done();
}
`);
  const claudeRuns = () => lines(claudeSeen).map((l) => JSON.parse(l));
  // Только headless-сессии расписания: подъём агента из соседнего теста мог дописаться в лог с опозданием
  const sessions = () => claudeRuns().filter((c) => !c.agent);
  const setMode = (mode) => fs.writeFileSync(claudeMode, mode);

  const env = (dir, extra = {}) => ({ ...baseEnv, CLAUDE_PROJECT_DIR: dir, BUS_PM2_CMD: `"${process.execPath}" "${fakePm2}"`, BUS_STARTUP_DIR: startupDir, BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"`, ...extra });
  const bus = (dir, args, { input = '', extra = {} } = {}) => {
    const r = spawnSync(process.execPath, [BUS_JS, ...args], { cwd: dir, input, encoding: 'utf8', env: env(dir, extra) });
    return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
  };
  const sched = (args, opts) => bus(proj, ['schedule', ...args], opts);
  const jobPath = (name, ext = 'md', dir = proj) => path.join(dir, '.claude', 'bus', 'scheduler', `${name}.${ext}`);
  const jobState = (name) => JSON.parse(read(jobPath(name, 'state.json')) || '{}');
  const settled = (name, state) => until(() => jobState(name).state === state && !fs.existsSync(jobPath(name, 'lock')));
  const journal = () => lines(path.join(proj, '.claude', 'bus', 'history.jsonl')).map((l) => JSON.parse(l));
  /** tick() в дочернем процессе: модуль читает CLAUDE_CONFIG_DIR при загрузке, в процессе тестов он указывал бы на настоящий ~/.claude. */
  const tick = (now, prev = null, passes = 1) => {
    const code = `const s = require(${JSON.stringify(SCHEDULER_JS)}); const out = []; const fired = new Map();
      for (let i = 0; i < ${passes}; i++) s.tick(new Date(${now.getTime()}), ${prev ? `new Date(${prev.getTime()})` : 'null'}, fired, (root, name) => out.push(name));
      console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: env(proj) });
    return r.status === 0 ? JSON.parse(r.stdout) : [`упал: ${r.stderr}`];
  };

  bus(proj, ['init', 'scheda']);
  const def = path.join(proj, '.claude', 'agents', 'dima.md');
  fs.mkdirSync(path.dirname(def), { recursive: true });
  fs.writeFileSync(def, '---\nname: dima\ndescription: тестовый субагент\n---\n\nРоль.\n');
  bus(proj, ['add', 'dima']);

  // ---------- CLI ----------
  let r = bus(stranger, ['schedule', 'add', 'x', '0 9 * * *', 'привет']);
  check('P1 schedule: каталог без init расписание не ведёт', r.code === 1 && r.all.includes('не подключён к шине') && !fs.existsSync(jobPath('x', 'md', stranger)), r.all);

  const refusals = [
    [sched(['add', 'Bad_Name', '0 9 * * *', 'привет']), 'Имя задачи'],
    [sched(['add', 'x', '61 * * * *', 'привет']), 'минута'],
    [sched(['add', 'x', '0 0 31 2 *', 'привет']), 'не наступит никогда'],
    [sched(['add', 'x', '0 9 * * *']), 'Пустой промпт'],
    [sched(['add', 'x', '0 9 * * *', '--to', 'nobody', 'привет']), 'не видно'],
    [sched(['add', 'x', '0 9 * * *', '--to', 'scheda', 'привет']), 'не видно'],
    [sched(['add', 'x', '0 9 * * *', '--model', 'son;net', 'привет']), '--model'],
    [sched(['add', 'x', '0 9 * * *', '--timeout', '999', 'привет']), 'timeout'],
    [sched(['add', 'x', '0 9 * * *', '--wat', 'привет']), 'не знаю флага'],
    [sched(['add', 'x', '0 9 * * *', '--global', '--to', 'dima', 'привет']), 'только headless'],
    [sched(['add', 'x', '*/2 * * * *', 'привет']), 'Слишком часто'],
  ];
  check('P2 schedule add: кривое имя, cron, пустой промпт, чужой адресат, проект адресатом, модель, таймаут, флаг, глобальная с --to, слишком частый cron — отказ, файла и демона нет', refusals.every(([x, text]) => x.code === 1 && x.all.includes(text)) && !fs.existsSync(jobPath('x')) && pm2Calls().length === 0, refusals.map(([x, text]) => `${text}: ${x.code} ${x.all.slice(0, 80)}`).join('\n'));

  r = sched(['add', 'morning', '0 9 * * 1-5', '--to', 'dima', 'Проверь', 'задачи', '--to', 'masha', `ключ ${baseEnv.SOME_SERVICE_API_KEY}`]);
  let file = read(jobPath('morning'));
  let calls = pm2Calls();
  check('P3 schedule add: файл задачи с frontmatter, секрет вырезан, «--to» в тексте промпта — просто слово; демон поднят через pm2, список сохранён, в автозагрузке pm2 resurrect', r.code === 0 && r.out.includes('по будням в 09:00') && file.includes('cron: "0 9 * * 1-5"') && file.includes('to: dima') && file.includes('enabled: true') && file.includes('Проверь задачи --to masha') && !file.includes(baseEnv.SOME_SERVICE_API_KEY) && calls.some((c) => c[0] === 'start' && c.includes('bus-scheduler') && c.includes('daemon')) && calls.some((c) => c[0] === 'save') && read(vbs).includes('pm2 resurrect'), r.all + file + JSON.stringify(calls));

  const dup = sched(['add', 'morning', '0 10 * * *', 'другое']);
  const forced = sched(['add', 'morning', '*/10 * * * *', '--force', '--to', 'dima', 'чаще']);
  check('P4 schedule add: имя занято — отказ, --force перезаписывает; cron каждые 10 минут проходит с предупреждением о цене', dup.code === 1 && dup.all.includes('уже есть') && forced.code === 0 && forced.out.includes('Часто:') && forced.out.includes('токенов') && read(jobPath('morning')).includes('*/10 * * * *'), dup.all + forced.all);
  sched(['add', 'morning', '0 9 * * 1-5', '--force', '--to', 'dima', 'Проверь задачи']);

  // Порог отказа, таймаут и модель по умолчанию — настройки каталога (settings.js); в задаче своё не указано — берётся его
  bus(proj, ['settings', 'set', 'schedule.minGapMin', '20']);
  bus(proj, ['settings', 'set', 'schedule.timeoutMin', '25']);
  bus(proj, ['settings', 'set', 'schedule.model', 'haiku']);
  const tooOften = sched(['add', 'often', '*/10 * * * *', 'при пороге 20 минут']);
  const allowed = sched(['add', 'often', '*/20 * * * *', 'при пороге 20 минут']);
  const warned = sched(['add', 'often', '*/10 * * * *', '--force', 'чаще порога — только с --force, и с ценой']);
  const oftenList = sched(['list']);
  bus(proj, ['settings', 'reset']);
  const relaxed = sched(['add', 'often', '*/10 * * * *', '--force', 'пороги снова дефолтные']);
  check('P4a schedule и настройки проекта: порог отказа и модель headless-сессии — из настроек каталога, предупреждение о цене — чаще 15 минут; после сброса — прежние 5 минут и sonnet',
    tooOften.code === 1 && tooOften.all.includes('Слишком часто') && allowed.code === 0 && !allowed.out.includes('Часто:') && allowed.out.includes('headless-сессия (haiku)') && warned.code === 0 && warned.out.includes('Часто:') && /often.*сессия \(haiku\)/.test(oftenList.out)
    && relaxed.code === 0 && relaxed.out.includes('headless-сессия (sonnet)'), tooOften.all + allowed.all + warned.all + oftenList.out + relaxed.all);
  // Headless-задача — сессия оркестратора: его модель сильнее schedule.model, своя модель задачи — сильнее обеих
  bus(proj, ['settings', 'set', 'schedule.model', 'haiku']);
  bus(proj, ['settings', 'set', 'orchestrator.projectModel', 'opus']);
  const bossModel = sched(['add', 'often', '*/10 * * * *', '--force', 'на модели оркестратора']);
  const ownModel = sched(['add', 'often', '*/10 * * * *', '--force', '--model', 'haiku', 'своя модель']);
  bus(proj, ['settings', 'reset', 'orchestrator.projectModel']);
  bus(proj, ['settings', 'reset']);
  fs.rmSync(path.join(proj, '.claude', 'settings.local.json'), { force: true });
  check('P4b schedule: headless-задача без своей модели идёт на модели оркестратора проекта, а не schedule.model; --model задачи сильнее',
    bossModel.code === 0 && bossModel.out.includes('headless-сессия (opus)') && ownModel.code === 0 && ownModel.out.includes('headless-сессия (haiku)'), bossModel.all + ownModel.all);
  sched(['rm', 'often']);

  pm2Reset();
  r = sched(['list']);
  check('P5 schedule list: задача, подпись cron, адресат, ближайший запуск; демона нет, а задачи есть (pm2 после ребута не воскрес) — list сам поднимает его и говорит об этом', r.code === 0 && r.out.includes('morning') && r.out.includes('вкл') && r.out.includes('по будням в 09:00 → dima') && r.out.includes('след.:') && r.out.includes('ещё не запускалась') && r.out.includes('Демон не работал') && pm2Calls().some((c) => c[0] === 'start'), r.all + JSON.stringify(pm2Calls()));

  pm2Reset();
  r = sched(['off', 'morning']);
  calls = pm2Calls();
  check('P6 schedule off: последняя включённая задача выключена — enabled: false в файле; демон гасить незачем (его и не было), автозагрузка цела до stop', r.code === 0 && read(jobPath('morning')).includes('enabled: false') && r.out.includes('выключена') && r.out.includes('демон не нужен'), r.all + JSON.stringify(calls));
  fs.writeFileSync(jobPath('morning'), read(jobPath('morning')).replace('to: dima', 'to: dima   # бэкендер') + '\n<!-- дописано руками -->\n');
  r = sched(['on', 'morning']);
  check('P7 schedule on: правится одна строка frontmatter — комментарий и дописанное руками целы; демон поднят снова', r.code === 0 && read(jobPath('morning')).includes('enabled: true') && read(jobPath('morning')).includes('# бэкендер') && read(jobPath('morning')).includes('дописано руками') && pm2Calls().some((c) => c[0] === 'start'), r.all + read(jobPath('morning')));

  // ---------- проход демона ----------
  const monday9 = at(2026, 8, 21, 9, 0, 20);
  check('P8 tick: задача стреляет в свою минуту один раз, хоть проходов в минуте три; в другую минуту и в воскресенье молчит', JSON.stringify(tick(monday9, null, 3)) === '["morning"]' && tick(at(2026, 8, 21, 9, 1, 0)).length === 0 && tick(at(2026, 8, 20, 9, 0, 0)).length === 0, JSON.stringify(tick(monday9, null, 3)));
  sched(['off', 'morning']);
  const offTick = tick(monday9);
  sched(['on', 'morning']);
  fs.writeFileSync(jobPath('broken'), '---\ncron: "каждый день"\n---\nпривет\n');
  const brokenTick = tick(monday9);
  r = sched(['list']);
  check('P9 tick: выключенная и кривая (правили руками) задачи не запускаются; list показывает кривую с причиной и не падает', offTick.length === 0 && JSON.stringify(brokenTick) === '["morning"]' && r.code === 0 && r.out.includes('broken') && r.out.includes('ОШИБКА') && r.out.includes('cron'), JSON.stringify([offTick, brokenTick]) + r.all);
  fs.rmSync(jobPath('broken'));

  const friday = at(2026, 8, 18, 18, 0);
  const noCatchup = tick(at(2026, 8, 21, 11, 30), friday);
  sched(['add', 'morning', '0 9 * * 1-5', '--force', '--to', 'dima', '--catchup', 'Проверь задачи']);
  const caught = tick(at(2026, 8, 21, 11, 30), friday, 2);
  const tooOld = tick(at(2026, 8, 21, 11, 30), at(2026, 7, 1));
  const nothingMissed = tick(at(2026, 8, 21, 11, 30), at(2026, 8, 21, 9, 30));
  check('P10 tick catchup: комп спал с пятницы — задача с catchup догоняет один раз, без catchup пропуск остаётся пропуском; пропуск старше недели и отсутствие пропуска — тишина', noCatchup.length === 0 && JSON.stringify(caught) === '["morning"]' && tooOld.length === 0 && nothingMissed.length === 0, JSON.stringify([noCatchup, caught, tooOld, nothingMissed]));

  // ---------- запуск: агенту ----------
  setMode('ok');
  const wakeOn = { extra: { BUS_AUTOWAKE: '1' } };
  r = sched(['run', 'morning'], wakeOn);
  let ok = await settled('morning', 'ok');
  await until(() => claudeRuns().some((c) => c.agent === 'dima'));
  let task = journal().find((m) => m.to === 'dima' && m.type === 'TASK') || {};
  const woke = claudeRuns().find((c) => c.agent === 'dima') || { argv: [] };
  check('P11 schedule run → агенту: TASK от оркестратора с пометкой «По расписанию», в журнале ui: true; агент поднят в фоне из каталога проекта; итог в state.json и логе, лок снят', r.code === 0 && ok && task.from === 'scheda' && task.text.startsWith('По расписанию «morning»: Проверь задачи') && task.ui === true && woke.agent === 'dima' && path.relative(woke.cwd, proj) === '' && woke.wakeEnv === '1' && jobState('morning').manual === true && jobState('morning').note.includes('поднят в фоне') && read(jobPath('morning', 'log')).includes('вручную') && !fs.existsSync(jobPath('morning', 'lock')), r.all + JSON.stringify(jobState('morning')) + JSON.stringify(task));
  await until(() => !fs.existsSync(path.join(proj, '.claude', 'bus', 'dima', 'wake.lock')));

  const longPrompt = `Шаг первый: проверь API.\n${'Дальше идёт длинное описание задачи. '.repeat(160)}\nключ ${baseEnv.SOME_SERVICE_API_KEY}`;
  sched(['add', 'long', '0 3 * * *', '--to', 'dima', '-'], { input: longPrompt });
  r = sched(['run', 'long'], wakeOn);
  ok = await settled('long', 'ok');
  task = journal().filter((m) => m.to === 'dima' && m.type === 'TASK').pop() || {};
  const attached = (task.files || [])[0] || {};
  check('P12 schedule run: промпт длиннее лимита сообщения уходит вложением long.md — в тексте первая строка и отсылка к файлу, секрет вырезан и из вложения', ok && task.text.includes('Шаг первый: проверь API.') && task.text.includes('во вложении') && task.text.length <= 2001 && attached.name === 'long.md' && read(attached.path).includes('длинное описание') && !read(attached.path).includes(baseEnv.SOME_SERVICE_API_KEY), JSON.stringify(task).slice(0, 400));
  await until(() => !fs.existsSync(path.join(proj, '.claude', 'bus', 'dima', 'wake.lock')));

  // ---------- запуск: headless ----------
  fs.rmSync(claudeSeen, { force: true });
  const inboxBefore = read(path.join(proj, '.claude', 'bus', 'scheda', 'inbox.md'));
  sched(['add', 'report', '0 8 * * *', 'Собери отчёт по проекту']);
  r = sched(['run', 'report'], wakeOn);
  ok = await settled('report', 'ok');
  let session = sessions()[0] || { argv: [], stdin: '' };
  let note = journal().find((m) => m.from === 'schedule') || {};
  check('P13 schedule run → headless: claude -p на sonnet из каталога проекта с BUS_WAKE, без --agent; в промпте задача и «в фоне, без чата»; отчёт — в логе и сообщением schedule → оркестратор в журнале (секрет вырезан), токены в state.json, inbox оркестратора не тронут', r.code === 0 && ok && !session.argv.includes('--agent') && session.argv[session.argv.indexOf('--model') + 1] === 'sonnet' && session.argv.includes('bypassPermissions') && path.relative(session.cwd, proj) === '' && session.wakeEnv === '1' && session.stdin.includes('Собери отчёт по проекту') && session.stdin.includes('«report»') && session.stdin.includes('без чата') && note.to === 'scheda' && note.type === 'DONE' && note.job === 'report' && note.text.includes('всё проверено') && !note.text.includes(baseEnv.SOME_SERVICE_API_KEY) && jobState('report').tokens === 9210 && read(jobPath('report', 'log')).includes('Отчёт по расписанию') && read(path.join(proj, '.claude', 'bus', 'scheda', 'inbox.md')) === inboxBefore, JSON.stringify({ ...session, stdin: session.stdin.slice(0, 80) }) + JSON.stringify(note) + JSON.stringify(jobState('report')));

  sched(['add', 'report', '0 8 * * *', '--force', '--model', 'haiku', '--timeout', '3', 'Собери отчёт по проекту']);
  setMode('fail');
  fs.rmSync(claudeSeen, { force: true });
  sched(['run', 'report'], wakeOn);
  ok = await settled('report', 'failed');
  session = sessions()[0] || { argv: [] };
  note = journal().filter((m) => m.from === 'schedule').pop() || {};
  r = sched(['list']);
  check('P14 schedule run: claude упал — задача «упала» с причиной в state.json, логе, ленте (DONE с «СБОЙ») и list; модель берётся из задачи', ok && session.argv[session.argv.indexOf('--model') + 1] === 'haiku' && jobState('report').reason.includes('модель недоступна') && note.type === 'DONE' && note.text.includes('СБОЙ') && read(jobPath('report', 'log')).includes('СБОЙ') && r.out.includes('упала'), JSON.stringify(jobState('report')) + r.out);

  // Модель с «[1m]» настройка schedule.model принимала, а задача — нет; в командную строку claude она едет в кавычках
  setMode('split');
  fs.rmSync(claudeSeen, { force: true });
  r = sched(['add', 'report', '0 8 * * *', '--force', '--model', 'opus[1m]', 'Собери отчёт по проекту']);
  sched(['run', 'report'], wakeOn);
  ok = await settled('report', 'ok');
  session = sessions()[0] || { argv: [] };
  note = journal().filter((m) => m.from === 'schedule').pop() || {};
  check('P14a schedule: модель «opus[1m]» у задачи проходит и доезжает до claude; итог claude, разорванный на границе чанков посреди русской буквы, в логе и ленте цел', r.code === 0 && read(jobPath('report')).includes('model: opus[1m]') && ok && session.argv[session.argv.indexOf('--model') + 1] === 'opus[1m]' && read(jobPath('report', 'log')).includes('решение принято') && !read(jobPath('report', 'log')).includes('�') && String(note.text).includes('решение принято'), r.all + JSON.stringify(session.argv) + JSON.stringify(note) + read(jobPath('report', 'log')).slice(-200));

  // Глобальные CLAUDE.md и rules/ headless-запуску по умолчанию срезаны настройками сессии; rules: true — запуск без них
  const leanFile = path.join(proj, '.claude', 'bus', 'scheduler', 'headless-settings.json');
  const leanArgv = session.argv;
  const lean = JSON.parse(read(leanFile) || '{}');
  fs.rmSync(claudeSeen, { force: true });
  r = sched(['add', 'report', '0 8 * * *', '--force', '--rules', 'Собери отчёт по проекту']);
  sched(['run', 'report'], wakeOn);
  await until(() => sessions().length > 0); // прошлый запуск уже «ok»: ждём сам claude, иначе settled вернётся раньше, чем раннер стартует
  ok = await settled('report', 'ok');
  session = sessions()[0] || { argv: ['--settings'] };
  const listed = sched(['list']).all;
  check('P14c schedule rules: без поля headless-запуск идёт с --settings и claudeMdExcludes на глобальные CLAUDE.md и rules/; --rules пишет rules: true, и запуск идёт без --settings; файл настроек задачей не считается',
    leanArgv.includes('--settings') && String(leanArgv[leanArgv.indexOf('--settings') + 1]).includes('headless-settings.json') && Array.isArray(lean.claudeMdExcludes) && lean.claudeMdExcludes.some((p) => p.endsWith('/CLAUDE.md')) && lean.claudeMdExcludes.some((p) => p.endsWith('/rules/**'))
    && r.code === 0 && /^rules: true$/m.test(read(jobPath('report'))) && ok && !session.argv.includes('--settings') && !listed.includes('headless-settings'), JSON.stringify(leanArgv) + JSON.stringify(lean) + r.all + JSON.stringify(session.argv) + listed);

  // «$&» в дописанном руками frontmatter: строку-замену replace разбирал сам и дублировал в файл весь frontmatter
  fs.writeFileSync(jobPath('report'), read(jobPath('report')).replace('enabled: true', () => "enabled: true\nnote: цена $& и $' — как есть"));
  sched(['off', 'report']);
  r = sched(['on', 'report']);
  file = read(jobPath('report'));
  check('P14b schedule on/off: «$&» и «$\'» в рукописном frontmatter файл не портят', r.code === 0 && file.includes("note: цена $& и $' — как есть") && file.split('enabled:').length === 2 && file.includes('enabled: true') && file.split('---').length === 3, file);

  setMode('ok');
  fs.rmSync(claudeSeen, { force: true });
  sched(['run', 'report'], { extra: { BUS_AUTOWAKE: '0' } });
  ok = await settled('report', 'skipped');
  check('P15 schedule run: рубильник autowake выключен — headless-запуск пропущен, claude не звали', ok && sessions().length === 0 && jobState('report').reason.includes('автоподъём выключен'), JSON.stringify(jobState('report')));

  // Лок держит живой процесс (сами тесты) — второй запуск не стартует
  fs.writeFileSync(jobPath('report', 'lock'), JSON.stringify({ pid: process.pid, at: Date.now(), timeoutMs: 60000 }));
  r = sched(['run', 'report'], wakeOn);
  const direct = spawnSync(process.execPath, [SCHEDULER_JS, 'run', proj, 'report', 'cron', '2026-09-21 08:00'], { encoding: 'utf8', env: env(proj, { BUS_AUTOWAKE: '1' }) });
  check('P16 schedule: предыдущий запуск ещё идёт — run отказывает, раннер демона пишет пропуск в лог и claude не зовёт', r.code === 1 && r.all.includes('уже идёт') && direct.status === 0 && read(jobPath('report', 'log')).includes('пропуск: предыдущий запуск ещё идёт') && sessions().length === 0, r.all + direct.stderr);
  fs.rmSync(jobPath('report', 'lock'));

  // Лок пишется в два шага (open wx → запись pid). Пустой и молодой — чужой раннер между ними: стирать нельзя; пустой и старый — мусор
  const skips = () => read(jobPath('report', 'log')).split('пропуск: предыдущий запуск').length;
  const runDirect = () => spawnSync(process.execPath, [SCHEDULER_JS, 'run', proj, 'report', 'manual'], { encoding: 'utf8', env: env(proj, { BUS_AUTOWAKE: '1' }) });
  fs.writeFileSync(jobPath('report', 'lock'), '');
  const skipsBefore = skips();
  runDirect();
  const youngKept = skips() === skipsBefore + 1 && fs.existsSync(jobPath('report', 'lock')) && sessions().length === 0;
  const longAgo = new Date(Date.now() - 10000);
  fs.utimesSync(jobPath('report', 'lock'), longAgo, longAgo);
  runDirect();
  // Тот же замок у подъёма агента (wake.js) плюс правило «лок старше загрузки системы — его pid уже чужой»; в дочернем процессе — модуль читает CLAUDE_CONFIG_DIR при загрузке
  const lockProbe = spawnSync(process.execPath, ['-e', `const fs = require('fs'), os = require('os'), path = require('path');
const wake = require(${JSON.stringify(path.join(SCRIPTS, 'wake.js'))});
const box = ${JSON.stringify(path.join(sandbox, 'lock-probe'))};
fs.mkdirSync(box, { recursive: true });
const lock = path.join(box, 'wake.lock');
const put = (at) => fs.writeFileSync(lock, JSON.stringify({ pid: ${process.pid}, at, timeoutMs: 1e13 }));
put(Date.now());
const live = wake.running(box);
put(Date.now() - (os.uptime() + 60) * 1000);
const rebooted = wake.running(box);
fs.writeFileSync(lock, '');
const young = wake.freshBlank(lock);
fs.utimesSync(lock, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
console.log(JSON.stringify({ live, rebooted, young, old: wake.freshBlank(lock) }));`], { encoding: 'utf8', env: baseEnv });
  check('P16a локи: пустой молодой лок раннер не стирает (пропуск), пустой старый — занимает и запускает; wake.lock старше загрузки системы не считается живым, хоть pid и жив', youngKept && sessions().length === 1 && !fs.existsSync(jobPath('report', 'lock')) && lockProbe.stdout.trim() === JSON.stringify({ live: true, rebooted: false, young: true, old: false }), `youngKept=${youngKept} sessions=${sessions().length} ${lockProbe.stdout}${lockProbe.stderr}`);

  r = sched(['log', 'report', '5']);
  check('P17 schedule log: хвост отчётов задачи', r.code === 0 && r.out.includes('пропуск') && r.out.trim().split('\n').length <= 5, r.all);

  // ---------- глобальная задача ----------
  r = sched(['add', 'nightly', '0 2 * * *', '--global', 'Глобальная проверка']);
  const all = sched(['list', '--all']);
  check('P18 schedule --global: задача лежит в домашней шине, видна в list --all с пометкой, в list каталога её нет', r.code === 0 && fs.existsSync(path.join(busDir, 'scheduler', 'nightly.md')) && all.out.includes('nightly') && all.out.includes('глобальная') && all.out.includes('morning') && !sched(['list']).out.includes('nightly'), r.all + all.all);
  sched(['rm', 'nightly', '--global']);

  // ---------- имена ----------
  const reserved = [bus(stranger, ['init', 'scheduler']), bus(stranger, ['init', 'files']), bus(proj, ['add', 'schedule'])];
  check('P19 bus: имена scheduler, files и schedule агенту не дать — это служебные папки шины и отправитель отчётов', reserved.every((x) => x.code === 1 && x.all.includes('занято самой шиной')), reserved.map((x) => x.all).join('|'));

  // ---------- демон ----------
  sched(['off', 'morning']);
  sched(['off', 'long']);
  sched(['off', 'report']);
  const heartbeat = path.join(busDir, 'scheduler.json');
  const idle = spawnSync(process.execPath, [SCHEDULER_JS, 'daemon'], { encoding: 'utf8', timeout: 15000, env: env(proj, { BUS_SCHEDULER_TICK_MS: '150' }) });
  check('P20 демон: включённых задач нет — три прохода и гаснет сам, heartbeat убран (без pm2 просто выходит)', idle.status === 0 && idle.stdout.includes('гасит себя') && !fs.existsSync(heartbeat), `${idle.status} ${idle.stdout}${idle.stderr}`);

  sched(['add', 'everymin', '* * * * *', '--force', 'Ежеминутная проверка']);
  fs.rmSync(claudeSeen, { force: true });
  const daemonEnv = env(proj, { BUS_SCHEDULER_TICK_MS: '150', BUS_AUTOWAKE: '1' });
  delete daemonEnv.pm_id;
  const daemon = spawn(process.execPath, [SCHEDULER_JS, 'daemon'], { env: daemonEnv, stdio: 'ignore' });
  try {
    const fired = await until(() => claudeRuns().some((c) => c.stdin.includes('Ежеминутная проверка')), 10000);
    await settled('everymin', 'ok');
    await wait(600); // ещё несколько проходов в ту же минуту — повторного запуска быть не должно
    const beat = JSON.parse(read(heartbeat) || '{}');
    const status = sched(['daemon', 'status']);
    // Минута могла смениться посреди теста — тогда законных запусков два
    check('P21 демон: задача «каждую минуту» запущена сама, в пределах минуты — один раз; heartbeat с pid демона, status видит его живым', fired && sessions().length <= 2 && beat.pid === daemon.pid && status.out.includes(`pid ${daemon.pid}`) && jobState('everymin').fired.length === 16 && jobState('everymin').manual === false, `${claudeRuns().length} ${JSON.stringify(beat)} ${status.all} ${JSON.stringify(jobState('everymin'))}`);

    pm2Reset();
    r = sched(['on', 'morning']);
    check('P22 schedule: демон жив (heartbeat свежий) — pm2 второй раз не зовётся', r.code === 0 && r.out.includes('демон уже работает') && pm2Calls().length === 0, r.all + JSON.stringify(pm2Calls()));
  } finally {
    daemon.kill();
  }
  await until(() => !fs.existsSync(jobPath('everymin', 'lock')));

  // ---------- rm и остановка демона ----------
  fs.writeFileSync(heartbeat, JSON.stringify({ pid: process.pid, at: Date.now(), lastTick: Date.now() })); // «живой демон» — сами тесты
  sched(['rm', 'everymin']);
  sched(['rm', 'long']);
  sched(['rm', 'report']);
  pm2Reset();
  r = sched(['rm', 'morning']);
  calls = pm2Calls();
  check('P23 schedule rm: файлы задачи убраны; ушла последняя включённая — демон снят из pm2, список сохранён, автозагрузка и heartbeat убраны', r.code === 0 && !fs.existsSync(jobPath('morning')) && !fs.existsSync(jobPath('morning', 'log')) && !fs.existsSync(jobPath('morning', 'state.json')) && calls.some((c) => c[0] === 'delete' && c.includes('bus-scheduler')) && calls.some((c) => c[0] === 'save') && !fs.existsSync(vbs) && !fs.existsSync(heartbeat) && r.out.includes('демон остановлен'), r.all + JSON.stringify(calls));

  // ---------- API расписания в UI ----------
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [BUS_JS, 'ui', '--port', String(port), '--no-open'], { cwd: proj, env: env(proj) });
  let banner = '';
  server.stdout.on('data', (c) => (banner += c));
  server.stderr.on('data', (c) => (banner += c));
  const request = (method, url, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  try {
    if (!(await until(() => banner.includes(`UI: http://127.0.0.1:${port}`)))) return check('P24 bus ui: сервер для тестов расписания поднялся', false, banner);
    const page = await request('GET', '/');
    const auth = { 'X-Bus-Token': (/TOKEN = '([0-9a-f]{32})'/.exec(page.text) || [])[1] };
    const cronJs = await request('GET', '/cron.js');
    const empty = (await request('GET', '/api/schedule')).json();
    check('P24 bus ui schedule: /cron.js отдаётся странице; пустое состояние — задач нет, каталоги с адресатами есть (у глобальных — только headless), модель по умолчанию', cronJs.status === 200 && cronJs.text.includes('BusCron') && empty.jobs.length === 0 && empty.daemon.alive === false && empty.here === proj && empty.defaultModel === 'sonnet' && JSON.stringify((empty.targets.find((t) => t.root === proj) || {}).agents) === '["dima"]' && (empty.targets.find((t) => t.root === null) || { agents: [1] }).agents.length === 0, JSON.stringify(empty));

    const job = { root: proj, name: 'from-ui', cron: '0 9 * * 1-5', to: 'dima', prompt: 'Проверь задачи <img src=x onerror=alert(1)>', isNew: true };
    const noToken = await request('POST', '/api/schedule/save', { body: job });
    const foreignRoot = await request('POST', '/api/schedule/save', { headers: auth, body: { ...job, root: path.join(sandbox, 'work', 'sched-nowhere') } });
    const frequent = await request('POST', '/api/schedule/save', { headers: auth, body: { ...job, cron: '* * * * *' } });
    check('P25 bus ui schedule save: без токена — 403, каталог не из шины и слишком частый cron — 400 с причиной (у частого — code: frequent), на диске пусто', noToken.status === 403 && foreignRoot.status === 400 && foreignRoot.text.includes('нет в шине') && frequent.status === 400 && frequent.text.includes('Слишком часто') && JSON.parse(frequent.text).code === 'frequent' && !JSON.parse(foreignRoot.text).code && !fs.existsSync(jobPath('from-ui')) && !fs.existsSync(path.join(sandbox, 'work', 'sched-nowhere')), `${noToken.status} ${foreignRoot.status} ${foreignRoot.text} ${frequent.status} ${frequent.text} ${fs.existsSync(jobPath('from-ui'))} ${fs.existsSync(path.join(sandbox, 'work', 'sched-nowhere'))} ${JSON.stringify(foreignRoot.text.includes('нет в шине'))} ${frequent.text.includes('Слишком часто')}`);

    pm2Reset();
    const saved = (await request('POST', '/api/schedule/save', { headers: auth, body: job })).json();
    const again = await request('POST', '/api/schedule/save', { headers: auth, body: job });
    const edited = (await request('POST', '/api/schedule/save', { headers: auth, body: { ...job, cron: '30 10 * * *', isNew: false } })).json();
    check('P26 bus ui schedule save: задача на диске, демон поднят, в ответе свежий список с подписью и ближайшим запуском; то же имя как новое — отказ, правка (isNew: false) перезаписывает', saved.ok && read(jobPath('from-ui')).includes('30 10 * * *') && pm2Calls().some((c) => c[0] === 'start') && saved.daemonNote.includes('демон поднят') && saved.daemon.alive === false && saved.jobs[0].about === 'по будням в 09:00' && saved.jobs[0].next > Date.now() && again.status === 400 && again.text.includes('уже есть') && edited.jobs[0].about === 'каждый день в 10:30', JSON.stringify(saved).slice(0, 300) + again.text);

    const toggled = (await request('POST', '/api/schedule/toggle', { headers: auth, body: { root: proj, name: 'from-ui', on: false } })).json();
    const ran = await request('POST', '/api/schedule/run', { headers: auth, body: { root: proj, name: 'from-ui' } });
    const ranOk = await settled('from-ui', 'ok');
    const afterRun = (await request('GET', '/api/schedule')).json();
    const removed = (await request('POST', '/api/schedule/delete', { headers: auth, body: { root: proj, name: 'from-ui' } })).json();
    const audit = read(path.join(busDir, 'audit.log'));
    check('P27 bus ui schedule: тумблер выключает, «запустить сейчас» работает и для выключенной, итог запуска виден в состоянии, удаление убирает файл; всё — в audit.log', toggled.jobs[0].enabled === false && read(jobPath('from-ui')) === '' && ran.status === 200 && ranOk && afterRun.jobs[0].last.state === 'ok' && removed.jobs.length === 0 && audit.includes('ui schedule save | from-ui') && audit.includes('ui schedule delete | from-ui'), JSON.stringify(afterRun.jobs) + ran.text);
  } finally {
    server.kill();
  }

  // ---------- субагент ставит в расписание себя (--as) ----------
  const me = (args, opts) => bus(proj, ['--as', 'dima', 'schedule', ...args], opts);
  const own = me(['add', 'daily-report', '0 9 * * *', '--off', '--catchup', 'Пришли', 'сводку']);
  const ownText = read(jobPath('daily-report'));
  const forOther = me(['add', 'x2', '0 9 * * *', '--to', 'masha', 'привет']);
  const agentTooOften = me(['add', 'fast', '*/2 * * * *', '--force', 'привет']);
  const headlessFlag = me(['add', 'hl', '0 9 * * *', '--model', 'sonnet', 'привет']);
  const globalFlag = me(['add', 'g', '0 9 * * *', '--global', 'привет']);
  const overwrite = me(['add', 'daily-report', '0 10 * * *', '--off', '--force', 'Новая', 'сводка']);
  sched(['add', 'orch-job', '0 9 * * *', '--off', 'headless-задача']);
  const foreignRm = me(['rm', 'orch-job']);
  const foreignOverwrite = me(['add', 'orch-job', '0 9 * * *', '--off', '--force', 'моя теперь']);
  const ownList = me([]);
  const daemonCmd = me(['daemon', 'stop']);
  check('P28 schedule --as: субагент ставит себя (to — он сам, флаги --off/--catchup работают); другому агенту, headless-флаги, --global, демон — отказ; --force перезаписывает только свою и порог частоты не обходит; список — только свои',
    own.code === 0 && ownText.includes('to: dima') && ownText.includes('enabled: false') && ownText.includes('catchup: true') && ownText.includes('Пришли сводку')
    && forOther.code === 1 && forOther.all.includes('только себя') && !fs.existsSync(jobPath('x2'))
    && agentTooOften.code === 1 && agentTooOften.all.includes('Слишком часто') && !fs.existsSync(jobPath('fast'))
    && headlessFlag.code === 1 && headlessFlag.all.includes('--model') && globalFlag.code === 1 && globalFlag.all.includes('--global')
    && overwrite.code === 0 && read(jobPath('daily-report')).includes('Новая сводка') && read(jobPath('daily-report')).includes('0 10 * * *')
    && foreignRm.code === 1 && foreignRm.all.includes('не твоя') && fs.existsSync(jobPath('orch-job')) && foreignOverwrite.code === 1 && read(jobPath('orch-job')).includes('headless-задача')
    && ownList.out.includes('daily-report') && !ownList.out.includes('orch-job') && daemonCmd.code === 1 && daemonCmd.out.includes('твои задачи'),
    [own, forOther, agentTooOften, headlessFlag, globalFlag, overwrite, foreignRm, foreignOverwrite, ownList, daemonCmd].map((x) => x.all).join('\n---\n'));

  const ownOff = me(['on', 'daily-report']);
  const ownRm = me(['rm', 'daily-report']);
  const auditAs = read(path.join(busDir, 'audit.log'));
  check('P29 schedule --as: on / rm своей задачи работают, каждая правка агента — строка в audit.log с его именем',
    ownOff.code === 0 && ownRm.code === 0 && !fs.existsSync(jobPath('daily-report')) && auditAs.includes('schedule add daily-report "0 9 * * *" · от dima (--as)') && auditAs.includes('schedule rm daily-report · от dima'),
    ownOff.all + ownRm.all + auditAs.slice(-600));
  sched(['rm', 'orch-job']);

  // Подсказка про расписание — только когда во входящих про него просят; задача самого расписания её не зовёт
  bus(proj, ['send', 'dima', 'TASK', 'Присылай', 'сводку', 'каждое', 'утро']);
  const hinted = bus(proj, ['--as', 'dima', 'inbox']).out;
  bus(proj, ['send', 'dima', 'TASK', 'Почини', 'тест']);
  const plain = bus(proj, ['--as', 'dima', 'inbox']).out;
  bus(proj, ['send', 'dima', 'TASK', 'По расписанию «daily»: ежедневная сводка']);
  const fromSchedule = bus(proj, ['--as', 'dima', 'inbox']).out;
  check('P30 inbox --as: просьба про расписание — подсказка «# расписание:» с командой от своего имени; обычная задача и задача самого расписания — без неё',
    hinted.includes('# расписание:') && hinted.includes('bus.js --as dima schedule add') && !plain.includes('# расписание') && !fromSchedule.includes('# расписание'), hinted + '\n---\n' + plain + '\n---\n' + fromSchedule);
};
