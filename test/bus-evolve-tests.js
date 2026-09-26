/**
 * Тесты самоправки роли агента шины (skills/bus/scripts/bus.js, wake.js, ui.js, ui-logic.js): флаг send --evolve и галочка в UI,
 * разбор после DONE в той же сессии claude (--resume), черновик role-proposal.json, принять и отклонить из редактора роли.
 * Зовёт run-tests.js — песочница, подменённый CLAUDE_CONFIG_DIR и check() общие. Настоящий claude не зовётся: BUS_CLAUDE_CMD —
 * подставной, ведёт себя по слову в сообщении (СПРОСИ, ПРОВАЛ, ЭВО-НЕ-JSON, ЭВО-ШИНА, ЭВО-ТО-ЖЕ).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

module.exports = async function busEvolveTests({ sandbox, configDir, baseEnv, check, HOOKS }) {
  const SCRIPTS = path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts');
  const BUS_JS = path.join(SCRIPTS, 'bus.js');
  fs.rmSync(path.join(configDir, 'bus'), { recursive: true, force: true }); // прошлые блоки оставили свой реестр — начинаем с чистого

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const json = (file, fallback = null) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (cond, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (cond()) return true;
    return false;
  };

  // ---------- песочница ----------
  const proj = path.join(sandbox, 'work', 'evolve-a');
  const other = path.join(sandbox, 'work', 'evolve-b');
  for (const dir of [proj, other]) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const fakeClaude = path.join(sandbox, 'fake-claude-evolve.js');
  const seenFile = path.join(sandbox, 'fake-claude-evolve-seen.jsonl');
  const env = (dir, extra = {}) => ({ ...baseEnv, CLAUDE_PROJECT_DIR: dir, BUS_AUTOWAKE: '0', BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"`, ...extra });
  const bus = (dir, args, extra = {}) => {
    const r = spawnSync(process.execPath, [BUS_JS, ...args], { cwd: dir, encoding: 'utf8', env: env(dir, extra) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const def = (dir, name, body) => {
    const file = path.join(dir, 'agents', `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: субагент ${name}\n---\n\n${body}\n`);
    return file;
  };
  const box = (name, file = '') => path.join(proj, '.claude', 'bus', name, file);
  const seen = () => read(seenFile).split('\n').filter(Boolean).map((line) => JSON.parse(line));

  // Подставной claude: обычный подъём берёт inbox из промпта и отвечает отправителю (DONE, по слову СПРОСИ — QUESTION, по слову ПРОВАЛ — сбой),
  // называет сессию и кладёт её файл туда же, куда настоящий; --resume с просьбой о самоправке — отвечает черновиком роли
  fs.writeFileSync(fakeClaude, `const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
let s = '';
let fired = false;
process.stdin.on('data', (c) => {
  s += c;
  if (!fired && s.includes('\\n')) {
    fired = true;
    main();
  }
});
function main() {
  const name = argv[argv.indexOf('--agent') + 1];
  const resumed = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : '';
  const id = resumed || 'evo' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const prompt = JSON.parse(s.split('\\n')[0]).message.content;
  fs.appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ name, argv, prompt }) + '\\n');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, id + '.jsonl'), '{}\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  const say = (result, bad = false) => console.log(JSON.stringify({ type: 'result', is_error: bad, num_turns: 1, session_id: id, result, usage: { input_tokens: 100, output_tokens: 50 } }));
  if (resumed && prompt.includes('самоправку роли')) {
    if (prompt.includes('ЭВО-НЕ-JSON')) return say('Роль и так хороша, держи совет.');
    if (prompt.includes('ЭВО-ШИНА')) return say(JSON.stringify({ description: 'x', body: 'Роль.\\n\\n## Шина\\n\\nсвои правила', note: 'полез в шину' }));
    if (prompt.includes('ЭВО-ТО-ЖЕ')) return say(JSON.stringify({ same: true }));
    return say('\`\`\`json\\n' + JSON.stringify({ description: 'выучено: когда поднимать', body: '# Роль\\n\\nВыучил: тесты гонять до ответа.', note: 'Добавил правило про тесты: пользователь поправил дважды.' }) + '\\n\`\`\`');
  }
  const run = (args) => require('child_process').spawnSync(process.execPath, [${JSON.stringify(BUS_JS)}, '--as', name, ...args], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  const inbox = prompt.includes('<inbox>') ? prompt : run(['inbox']).stdout || ''; // входящие раннер кладёт в промпт сам
  if (inbox.includes('ПРОВАЛ')) return say('упал', true);
  const from = (/from:([a-z0-9-]+)/.exec(inbox) || [])[1];
  if (from) run(['send', from, inbox.includes('СПРОСИ') ? 'QUESTION' : 'DONE', inbox.includes('СПРОСИ') ? 'какой каталог?' : 'готово']);
  say('ответил');
}
`);

  bus(proj, ['init', 'evo']);
  bus(other, ['init', 'evob']);
  const learnerRole = def(path.join(proj, '.claude'), 'learner', '# Роль\n\nДелает задачи.');
  bus(proj, ['add', 'learner']);
  def(path.join(proj, '.claude'), 'peer', 'Сосед.');
  bus(proj, ['add', 'peer']);
  const globalRole = def(configDir, 'gevo', 'Глобальная роль под обёрткой.');
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'gevo.md'), '---\nname: gevo\ndescription: обёртка\n---\n\nРоль прочитай: cat "$HOME/.claude/agents/gevo.md"\n');
  bus(proj, ['add', 'gevo']);

  // ---------- логика страницы ----------
  const L = require(path.join(SCRIPTS, 'ui-logic.js'));
  const notes = (agent) => L.agentStatus({ name: 'a', kind: 'local', registered: true, alive: true, ...agent }).notes.map((n) => n.text).join('|');
  check('V1 самоправка в UI: галочка — только субагенту, которому можно писать; у агента в списке — «разбирает свою работу», «предлагает правку роли», «самоправка не вышла», «роль менять нечего»',
    L.canEvolve({ kind: 'local' }) && L.canEvolve({ kind: 'global' }) && !L.canEvolve({ kind: 'project' }) && !L.canEvolve({ kind: 'local', blocked: 'нельзя' }) && !L.canEvolve(null)
    && notes({ wake: { state: 'ok', at: 1, evolve: 'running' }, proposal: true }).includes('разбирает свою работу') && notes({ wake: { state: 'ok', at: 1, evolve: 'proposed' }, proposal: true }).includes('предлагает правку роли')
    && notes({ wake: { state: 'ok', at: 1, evolve: 'failed', evolveReason: 'x' } }).includes('самоправка не вышла') && notes({ wake: { state: 'ok', at: 1, evolve: 'same' } }).includes('роль менять нечего') && !notes({ wake: { state: 'ok', at: 1 } }).includes('рол'), notes({ wake: { state: 'ok', at: 1, evolve: 'same' } }));

  // ---------- CLI: кому можно ----------
  const fromAgent = bus(proj, ['--as', 'peer', 'send', 'learner', 'TASK', '--evolve', 'сделай']);
  const toProject = bus(proj, ['send', 'evob', 'TASK', '--evolve', 'сделай']);
  const toAll = bus(proj, ['broadcast', 'TASK', '--evolve', 'сделай']);
  const asWord = bus(proj, ['send', 'peer', 'TASK', 'флаг', '--evolve', 'в тексте — просто слово']);
  check('V2 send --evolve: от субагента, проекту и в broadcast — отказ с причиной, метки нет; после текста это просто слово',
    fromAgent.code !== 0 && fromAgent.err.includes('только от проекта') && toProject.code !== 0 && toProject.err.includes('только субагенту') && toAll.code !== 0 && toAll.err.includes('только у send')
    && asWord.code === 0 && !fs.existsSync(box('learner', 'wake-evolve.json')) && !fs.existsSync(box('peer', 'wake-evolve.json')), fromAgent.err + toProject.err + toAll.err + asWord.err);

  const noWake = bus(proj, ['send', 'peer', 'TASK', '--evolve', 'автоподъём выключен']);
  check('V2a send --evolve при выключенном автоподъёме: метка снята, сказано, что самоправки не будет, и обычный wake: — чат поднимет агента сам',
    noWake.code === 0 && noWake.out.includes('самоправки роли не будет') && noWake.out.includes('wake: peer local') && !fs.existsSync(box('peer', 'wake-evolve.json')), noWake.out + noWake.err);
  fs.rmSync(box('peer', 'inbox.md'), { force: true });

  // ---------- полный круг: задача → DONE → разбор в той же сессии → черновик ----------
  const wakeEnv = { BUS_AUTOWAKE: '1' };
  const idle = (name) => !fs.existsSync(box(name, 'wake.lock'));
  const evolveOf = (name) => (json(box(name, 'wake.json'), {}) || {}).evolve || '';
  const roleBefore = read(learnerRole);
  bus(proj, ['send', 'learner', 'TASK', '--evolve', 'собери отчёт'], wakeEnv);
  const proposed = await until(() => evolveOf('learner') === 'proposed' && idle('learner'));
  const draft = json(box('learner', 'role-proposal.json'), {});
  const calls = seen().filter((c) => c.name === 'learner');
  const second = calls[1] || { argv: [], prompt: '' };
  const journal = read(path.join(proj, '.claude', 'bus', 'history.jsonl'));
  check('V3 самоправка: после DONE раннер продолжает ту же сессию (--resume <id>) просьбой о самоправке — в ней переписка по задаче и текущая роль; ответ в ограде ложится черновиком с пояснением и хешем роли; файл роли не тронут, метка снята, подъём ok, сообщение в журнале помечено',
    proposed && calls.length === 2 && second.argv.includes('--resume') && /^evo/.test(second.argv[second.argv.indexOf('--resume') + 1]) && second.prompt.includes('[TASK] evo → learner: собери отчёт') && second.prompt.includes('[DONE] learner → evo: готово') && second.prompt.includes('Делает задачи.')
    && draft.body === '# Роль\n\nВыучил: тесты гонять до ответа.' && draft.description === 'выучено: когда поднимать' && draft.note.includes('правило про тесты') && /^[0-9a-f]{40}$/.test(draft.base || '')
    && read(learnerRole) === roleBefore && !fs.existsSync(box('learner', 'wake-evolve.json')) && json(box('learner', 'wake.json'), {}).state === 'ok' && journal.includes('"evolve":true') && read(box('learner', 'wake.log')).includes('черновик роли готов'),
    JSON.stringify({ proposed, calls: calls.length, argv: second.argv, draft, state: json(box('learner', 'wake.json')) }).slice(0, 900));

  // ---------- QUESTION: задача не закрыта — метка ждёт DONE ----------
  fs.rmSync(box('learner', 'role-proposal.json'), { force: true });
  let before = seen().length;
  bus(proj, ['send', 'learner', 'TASK', '--evolve', 'СПРОСИ и почини сборку'], wakeEnv);
  const asked = await until(() => seen().length > before && idle('learner') && json(box('learner', 'wake.json'), {}).state === 'ok');
  await wait(300);
  const waits = asked && seen().length === before + 1 && fs.existsSync(box('learner', 'wake-evolve.json')) && !fs.existsSync(box('learner', 'role-proposal.json')) && evolveOf('learner') === '';
  before = seen().length;
  bus(proj, ['send', 'learner', 'DONE', '--evolve', 'каталог build'], wakeEnv); // галочка второй раз: прежняя метка остаётся, переписка — с первого сообщения
  const closed = await until(() => evolveOf('learner') === 'proposed' && idle('learner'));
  const closing = seen().slice(before);
  check('V4 самоправка после QUESTION: агент переспросил — разбора нет, метка лежит; ответил DONE на следующем подъёме — разбор идёт, и в просьбе вся переписка с помеченного сообщения, включая вопрос из прошлой сессии',
    waits && closed && closing.length === 2 && closing[1].prompt.includes('СПРОСИ и почини сборку') && closing[1].prompt.includes('[QUESTION] learner → evo: какой каталог?') && closing[1].prompt.includes('каталог build') && fs.existsSync(box('learner', 'role-proposal.json')) && !fs.existsSync(box('learner', 'wake-evolve.json')),
    JSON.stringify({ waits, closed, n: closing.length, prompt: (closing[1] || {}).prompt }).slice(0, 900));

  // ---------- сбои ----------
  fs.rmSync(box('learner', 'role-proposal.json'), { force: true });
  bus(proj, ['send', 'learner', 'TASK', '--evolve', 'ПРОВАЛ на старте'], wakeEnv);
  const crashed = await until(() => json(box('learner', 'wake.json'), {}).state === 'failed' && idle('learner'));
  const markKept = fs.existsSync(box('learner', 'wake-evolve.json'));
  fs.rmSync(box('learner', 'wake-evolve.json'), { force: true });
  fs.rmSync(box('learner', 'inbox.md'), { force: true });

  const outcome = async (word) => {
    const from = seen().length;
    bus(proj, ['send', 'learner', 'TASK', '--evolve', `${word} задача`], wakeEnv);
    await until(() => seen().length >= from + 2 && idle('learner') && evolveOf('learner') !== 'running' && evolveOf('learner') !== '');
    const state = json(box('learner', 'wake.json'), {});
    return { state: state.state, evolve: state.evolve, reason: state.evolveReason || '', draft: fs.existsSync(box('learner', 'role-proposal.json')) };
  };
  const notJson = await outcome('ЭВО-НЕ-JSON');
  const intoBus = await outcome('ЭВО-ШИНА');
  const same = await outcome('ЭВО-ТО-ЖЕ');
  check('V5 самоправка, сбои: упавший подъём разбора не запускает, метка остаётся; ответ не JSON и роль с «## Шина» — evolve failed с причиной, сам подъём ok, черновика нет; {"same": true} — evolve same, черновика нет; роль на диске прежняя',
    crashed && markKept && notJson.state === 'ok' && notJson.evolve === 'failed' && notJson.reason.includes('не по форме') && !notJson.draft && intoBus.state === 'ok' && intoBus.evolve === 'failed' && intoBus.reason.includes('Шина') && !intoBus.draft
    && same.state === 'ok' && same.evolve === 'same' && !same.draft && read(learnerRole) === roleBefore, JSON.stringify({ crashed, markKept, notJson, intoBus, same }));

  // ---------- обёртка над глобальной ролью ----------
  before = seen().length;
  bus(proj, ['send', 'gevo', 'TASK', '--evolve', 'сделай по глобальной роли'], wakeEnv);
  const wrapProposed = await until(() => evolveOf('gevo') === 'proposed' && idle('gevo'));
  const wrapPrompt = (seen().slice(before)[1] || { prompt: '' }).prompt;
  const globalBefore = read(globalRole);
  check('V6 самоправка обёртки: в просьбе — тело глобальной роли, а не обёртки; черновик лежит в ящике проекта, глобальная роль не тронута', wrapProposed && wrapPrompt.includes('Глобальная роль под обёрткой.') && !wrapPrompt.includes('Роль прочитай') && fs.existsSync(box('gevo', 'role-proposal.json')) && globalBefore.includes('Глобальная роль под обёрткой.'), wrapPrompt.slice(-300));

  // ---------- UI: галочка, значок, принять, отклонить ----------
  bus(proj, ['send', 'learner', 'TASK', '--evolve', 'ещё задача'], wakeEnv);
  await until(() => evolveOf('learner') === 'proposed' && idle('learner'));

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
    if (!(await until(() => banner.includes(`UI: http://127.0.0.1:${port}`), 8000))) return check('V7 самоправка в UI: сервер поднялся', false, banner);
    const token = (/TOKEN = '([0-9a-f]{32})'/.exec((await request('GET', '/')).text) || [])[1];
    const post = (url, body) => request('POST', url, { headers: { 'X-Bus-Token': token }, body });
    const role = async (key) => (await request('GET', `/api/agent?key=${encodeURIComponent(key)}&k=${token}`)).json();
    const stateAgent = async (name) => (await request('GET', '/api/state')).json().agents.find((a) => a.name === name) || {};
    const key = `learner@${proj}`;

    const flagged = (await stateAgent('learner')).proposal === true && (await stateAgent('peer')).proposal === false && (await stateAgent('evo')).proposal === false;
    const opened = await role(key);
    fs.writeFileSync(learnerRole, roleBefore.replace('Делает задачи.', 'Делает задачи. Поправлено руками.'));
    const stale = (await role(key)).proposal.stale;
    fs.writeFileSync(learnerRole, roleBefore);
    check('V7 самоправка в UI: агент с черновиком помечен в списке; редактор получает роль с диска и черновик отдельно — тело, описание, пояснение; роль правили после разбора — черновик помечен устаревшим',
      flagged && opened.body === '# Роль\n\nДелает задачи.' && opened.proposal.body === '# Роль\n\nВыучил: тесты гонять до ответа.' && opened.proposal.description === 'выучено: когда поднимать' && opened.proposal.note.includes('правило про тесты') && opened.proposal.stale === false && stale === true, JSON.stringify(opened.proposal));

    const rejected = await post('/api/agent/reject', { key });
    const afterReject = await role(key);
    check('V8 самоправка в UI, отклонить: черновик удалён, роль на диске дословно прежняя, значок у агента погас', rejected.status === 200 && afterReject.proposal === null && !fs.existsSync(box('learner', 'role-proposal.json')) && read(learnerRole) === roleBefore && (await stateAgent('learner')).proposal === false, rejected.text);

    const wrapKey = `gevo@${proj}`;
    const wrapOpened = await role(wrapKey);
    const accepted = await post('/api/agent/save', { key: wrapKey, description: wrapOpened.proposal.description, model: '', effort: '', fast: false, body: wrapOpened.proposal.body });
    check('V9 самоправка в UI, принять: «Сохранить» с черновиком в форме пишет глобальную роль обёртки, обёртка цела, черновик удалён',
      wrapOpened.where === globalRole && wrapOpened.proposal.stale === false && accepted.status === 200 && read(globalRole).includes('Выучил: тесты гонять до ответа.') && read(path.join(proj, '.claude', 'agents', 'gevo.md')).includes('Роль прочитай') && !fs.existsSync(box('gevo', 'role-proposal.json')) && (await role(wrapKey)).proposal === null, accepted.text);

    const sent = await post('/api/send', { to: `peer@${proj}`, type: 'TASK', text: 'задача с галочкой', evolve: true });
    const mark = json(box('peer', 'wake-evolve.json'), {});
    const toBoss = await post('/api/send', { to: (await stateAgent('evob')).key, type: 'TASK', text: 'проекту галочка не положена', evolve: true });
    const asText = await post('/api/send', { to: key, type: 'TASK', text: 'галочка строкой', evolve: 'true' });
    check('V10 самоправка в UI, галочка: /api/send с evolve кладёт метку в ящик субагента — id сообщения, заказчик, файл роли, журнал; проекту метка не ставится; evolve строкой — не галочка',
      sent.status === 200 && mark.from === 'evo' && typeof mark.id === 'string' && mark.role === path.join(proj, '.claude', 'agents', 'peer.md') && mark.journal === path.join(proj, '.claude', 'bus')
      && toBoss.status === 200 && !fs.existsSync(path.join(other, '.claude', 'bus', 'evob', 'wake-evolve.json')) && !fs.existsSync(path.join(configDir, 'bus', 'evob', 'wake-evolve.json'))
      && asText.status === 200 && !fs.existsSync(box('learner', 'wake-evolve.json')), sent.text + JSON.stringify(mark) + toBoss.text + asText.text);
  } finally {
    server.kill();
    try {
      fs.rmSync(path.join(os.tmpdir(), `bus-ui-${server.pid}`), { recursive: true, force: true }); // kill не даёт серверу убрать загрузки самому
    } catch {
      // подметёт следующий сервер на старте
    }
  }
};
