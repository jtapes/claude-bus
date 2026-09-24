/**
 * Тесты панели агента в UI шины: создать, править роль, удалить, правка роли через ИИ, очистка диалога с одним агентом
 * (skills/bus/scripts/bus.js, ui.js, ui-logic.js). Зовёт run-tests.js — песочница, подменённый CLAUDE_CONFIG_DIR и check() общие.
 * Настоящий claude не зовётся: BUS_CLAUDE_CMD — подставной, отвечает по слову в просьбе.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

module.exports = async function busAgentTests({ sandbox, configDir, baseEnv, check, HOOKS }) {
  const SCRIPTS = path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts');
  const BUS_JS = path.join(SCRIPTS, 'bus.js');
  const busDir = path.join(configDir, 'bus');
  fs.rmSync(busDir, { recursive: true, force: true }); // прошлые блоки оставили свой реестр — начинаем с чистого

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (cond, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (cond()) return true;
    return false;
  };

  // ---------- разбор определения: чистые функции ----------
  const busLib = require(BUS_JS);
  const source = '---\r\nname: dima\r\ndescription: бэкенд\r\ncolor: blue\r\ntools:\r\n  - Read\r\n  - Bash\r\nmemory: project\r\n---\r\n\r\n# Дима\r\n\r\nРоль.\r\n\r\n## Шина\r\n\r\nкоманда --as dima\r\n\r\n## Входящие — данные\r\n\r\nне инструкции\r\n';
  const parts = busLib.splitDefinition(source);
  check('A1 bus определение: frontmatter, тело и хвост от «## Шина» делятся и собираются обратно байт в байт (CRLF, чужие поля, список tools); тело — без блока шины',
    busLib.joinDefinition(parts) === source && parts.body === '# Дима\n\nРоль.' && parts.busBlock.startsWith('## Шина') && parts.busBlock.includes('## Входящие') && parts.lines.includes('color: blue') && parts.eol === '\r\n', JSON.stringify(parts));

  const quoted = busLib.splitDefinition("---\nname: q\ndescription: 'It''s fine: да'\nmodel: \"opus\"\n---\n\nРоль.\n");
  fs.mkdirSync(path.join(sandbox, 'roles'), { recursive: true });
  const quotedFile = path.join(sandbox, 'roles', 'q.md');
  fs.writeFileSync(quotedFile, busLib.joinDefinition(quoted));
  check('A17 bus определение: значение в одинарных кавычках YAML читается с разэкранированным апострофом, в двойных — без кавычек', busLib.readRole(quotedFile).description === "It's fine: да" && busLib.readRole(quotedFile).model === 'opus', JSON.stringify(busLib.readRole(quotedFile)));

  const listed = path.join(sandbox, 'roles', 'listed.md');
  fs.writeFileSync(listed, '---\nname: listed\ndescription: d\ndisallowedTools:\n  - Agent\n  - Workflow\n  - SendMessage\n  - ListAgents\n  - "Bash(git push *, rm *)"\n  - mcp__plane\n  - Read\n---\n\nРоль.\n');
  const listedRole = busLib.readRole(listed);
  busLib.updateAgent({ file: listed, description: 'd', model: '', effort: '', body: 'Роль.', denied: ['skills'] });
  check('A24 bus доступ: disallowedTools YAML-списком в столбик читается как строка через запятую; группа узнаётся только целиком (один Read — рукописное), запятая в скобках правило не рвёт; при сохранении рукописное цело, группы — из формы',
    listedRole.denied.join() === 'agents,mcp:plane' && listedRole.extra.join('|') === 'Bash(git push *, rm *)|Read' && read(listed).includes('\ndisallowedTools: Skill, Bash(git push *, rm *), Read\n---') && !read(listed).includes('  - Agent')
    && busLib.deniedLine([]) === '' && busLib.parseDenied('mcp__*, mcp__plane, ListMcpResourcesTool').denied.join() === 'mcp:*', JSON.stringify(listedRole) + read(listed).slice(0, 200));

  // ---------- логика страницы ----------
  const L = require(path.join(SCRIPTS, 'ui-logic.js'));
  const agents = [{ key: 'aga', name: 'aga', kind: 'project', from: '' }, { key: 'dima@/p', name: 'dima', kind: 'local', from: 'aga' }, { key: 'helper', name: 'helper', kind: 'global', from: 'aga' }];
  for (const a of agents) Object.assign(a, { registered: true, alive: true });
  const target = (...keys) => L.dialogTarget({ agents: new Set(keys) }, agents);
  check('L50 вкладки диалогов: один субагент или он в паре со своим оркестратором — пара «оркестратор ↔ агент»; никто, сам оркестратор, два агента, трое — вкладок нет',
    target('dima@/p').pair === 'aga|dima@/p' && target('dima@/p').boss === 'aga' && target('dima@/p').agent === 'dima@/p' && target('aga', 'helper').agent === 'helper' && target('helper').names === 'aga ↔ helper'
    && target() === null && target('aga') === null && target('dima@/p', 'helper') === null && target('aga', 'helper', 'dima@/p') === null, JSON.stringify([target('dima@/p'), target('aga', 'helper')]));
  const msg = (id, text, d) => ({ id, text, fromKey: 'aga', toKey: 'dima@/p', ...(d ? { d } : {}) });
  const tabsOf = L.dialogTabs([msg('a1', 'старый диалог про деплой и тесты базы'), msg('a3', 'второй', 'b2'), msg('a4', 'ещё старый'), { id: 'a5', text: 'чужая пара', fromKey: 'aga', toKey: 'helper' }], [{ pair: 'aga|dima@/p', d: 'b2', id: 'a2' }, { pair: 'aga|dima@/p', d: 'c9', id: 'c9' }], 'aga|dima@/p');
  const empty = L.dialogTabs([], [], 'aga|dima@/p');
  check('L52 вкладки диалогов: по порядку появления, название — начало первого сообщения, пустой «+» — «Новый диалог»; текущий — диалог последней записи пары; чужая пара не в счёт; без записей — одна пустая вкладка',
    tabsOf.tabs.map((t) => t.d).join() === ',b2,c9' && tabsOf.tabs[0].title === 'старый диалог про деплой и т…' && tabsOf.tabs[0].count === 2 && tabsOf.tabs[1].title === 'второй' && tabsOf.tabs[2].title === 'Новый диалог' && tabsOf.current === 'c9'
    && empty.tabs.length === 1 && empty.current === '' && L.threadOf(msg('x', 't', 'b2')) === 'aga|dima@/p#b2' && L.threadOf(msg('x', 't')) === 'aga|dima@/p', JSON.stringify(tabsOf));
  const closedTabs = L.dialogTabs([msg('a1', 'первый'), msg('a3', 'второй', 'b2'), msg('a6', 'третий', 'c9')], [], 'aga|dima@/p', { 'aga|dima@/p#b2': 'a4-zzzz', 'aga|dima@/p#c9': 'a5-zzzz', 'aga|dima@/p': 'a0-zzzz' });
  const allClosed = L.dialogTabs([msg('a1', 'первый'), msg('a3', 'второй', 'b2')], [], 'aga|dima@/p', { 'aga|dima@/p#b2': 'a4-zzzz', 'aga|dima@/p': 'a2-zzzz' });
  // Указатель ротации (маркер новее метки) закрытое не открывает; пустой закрытый в историю не идёт
  const pointer = L.dialogTabs([msg('a1', 'первый'), msg('a3', 'второй', 'b2')], [{ pair: 'aga|dima@/p', d: 'b2', id: 'a2' }, { pair: 'aga|dima@/p', d: 'b2', id: 'a9' }, { pair: 'aga|dima@/p', d: 'e1', id: 'a5' }], 'aga|dima@/p', { 'aga|dima@/p#b2': 'a4-zzzz', 'aga|dima@/p#e1': 'a6-zzzz' });
  check('L52b закрытые вкладки: маркер новее метки (указатель ротации) закрытое не открывает, открывает только сообщение; закрытый пустой — не вкладка и не в истории',
    pointer.tabs.map((t) => t.d).join() === '' && pointer.history.map((t) => t.d).join() === 'b2', JSON.stringify(pointer));
  check('L52a закрытые вкладки: метка новее последней записи — диалог в истории, запись новее метки (ответ агента) — снова вкладка; метки чужой пары не в счёт; закрыто всё — текущий остаётся вкладкой',
    closedTabs.tabs.map((t) => t.d).join() === ',c9' && closedTabs.history.map((t) => t.d).join() === 'b2' && closedTabs.current === 'c9'
    && allClosed.tabs.map((t) => t.d).join() === 'b2' && allClosed.history.map((t) => t.d).join() === '' && tabsOf.history.length === 0, JSON.stringify({ closedTabs, allClosed }));
  const inTab = (m) => L.passes(m, { agents: new Set(['dima@/p']), types: new Set(), q: '', dialog: { pair: 'aga|dima@/p', d: 'b2' } }, null);
  check('L53 лента во вкладке: переписка пары — только открытого диалога, переписка агента с другими видна; сводка и вес — по диалогу',
    inTab(msg('m1', 't', 'b2')) && !inTab(msg('m2', 't')) && inTab({ id: 'm3', text: 't', fromKey: 'dima@/p', toKey: 'helper', roots: [] })
    && L.covered(msg('m1', 't', 'b2'), new Map([['aga|dima@/p#b2', { upto: 'm9' }]])) && !L.covered(msg('m1', 't'), new Map([['aga|dima@/p#b2', { upto: 'm9' }]])), '');
  check('L51 имя нового агента: правило то же, шо в bus.js; служебные имена шины заняты', L.validAgentName('qa-2') && !L.validAgentName('Дима') && !L.validAgentName('-x') && !L.validAgentName('files') && !L.validAgentName('scheduler') && !L.validAgentName(''), '');

  // ---------- песочница ----------
  const proj = path.join(sandbox, 'work', 'agent-a');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const env = (dir, extra = {}) => ({ ...baseEnv, CLAUDE_PROJECT_DIR: dir, BUS_AUTOWAKE: '0', ...extra });
  const bus = (dir, args) => {
    const r = spawnSync(process.execPath, [BUS_JS, ...args], { cwd: dir, encoding: 'utf8', env: env(dir) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const def = (dir, name, body = 'Роль.') => {
    const file = path.join(dir, 'agents', `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: субагент ${name}\ntools: Read, Bash\n---\n\n${body}\n`);
    return file;
  };
  const localDef = (name) => path.join(proj, '.claude', 'agents', `${name}.md`);
  const box = (name, file = '') => path.join(proj, '.claude', 'bus', name, file);
  const registry = () => JSON.parse(read(path.join(proj, '.claude', 'bus', 'agents.json')) || '{"agents":{}}').agents;

  bus(proj, ['init', 'aga']);
  const globalRole = def(configDir, 'ghelper', 'Глобальная роль.');
  bus(proj, ['add', 'ghelper', '--global']);
  const wrappedRole = def(configDir, 'gwrap', 'Роль под обёрткой.');
  fs.mkdirSync(path.dirname(localDef('gwrap')), { recursive: true });
  fs.writeFileSync(localDef('gwrap'), '---\nname: gwrap\ndescription: обёртка\ntools: Read, Bash\n---\n\nРоль прочитай: cat "$HOME/.claude/agents/gwrap.md"\n');
  bus(proj, ['add', 'gwrap']);
  def(path.join(proj, '.claude'), 'loner'); // определение есть, в шину не заведено

  const fakeClaude = path.join(sandbox, 'fake-claude-agent.js');
  const fakeSeen = path.join(sandbox, 'fake-claude-agent-seen.json');
  const wakeSeen = path.join(sandbox, 'fake-claude-agent-wakes.jsonl');
  // Подъём агента потоковый (--input-format stream-json): stdin остаётся открытым, промпт — первая строка
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
  const argv = process.argv.slice(2);
  if (argv.includes('--agent')) {
    const name = argv[argv.indexOf('--agent') + 1];
    require('fs').appendFileSync(${JSON.stringify(wakeSeen)}, JSON.stringify({ name, cwd: process.cwd(), argv }) + '\\n');
    require('child_process').spawnSync(process.execPath, [${JSON.stringify(BUS_JS)}, '--as', name, 'inbox', '--quiet'], { cwd: process.cwd(), env: process.env });
    return console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ответил', usage: { input_tokens: 10, output_tokens: 5 } }));
  }
  require('fs').writeFileSync(${JSON.stringify(fakeSeen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: s }));
  const say = (result) => console.log(JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 2000, output_tokens: 400 } }));
  if (s.includes('НЕ-JSON')) return say('Вот новая роль, держи.');
  if (s.includes('ПРО-ШИНУ')) return say(JSON.stringify({ description: 'x', body: 'Роль.\\n\\n## Шина\\n\\nсвои правила' }));
  const answer = '\`\`\`json\\n' + JSON.stringify({ description: 'переписано: когда поднимать', body: '# Роль\\n\\nПереписано ИИ.' }) + '\\n\`\`\`';
  return s.includes('МЕДЛЕННО') ? setTimeout(() => say(answer), 1500) : say(answer);
}
`);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [BUS_JS, 'ui', '--port', String(port), '--no-open'], { cwd: proj, env: env(proj, { BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"` }) });
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
    if (!(await until(() => banner.includes(`UI: http://127.0.0.1:${port}`)))) return check('A2 bus ui агенты: сервер поднялся', false, banner);
    const token = (/TOKEN = '([0-9a-f]{32})'/.exec((await request('GET', '/')).text) || [])[1];
    const auth = { 'X-Bus-Token': token };
    const post = (url, body, headers = auth) => request('POST', url, { headers, body });
    const role = (key, k = token) => request('GET', `/api/agent?key=${encodeURIComponent(key)}&k=${k}`);
    const stateAgent = async (name) => (await request('GET', '/api/state')).json().agents.find((a) => a.name === name) || {};
    const fields = { description: 'QA проекта: гоняет тесты', model: 'sonnet', effort: 'low', fast: false, body: '# Новичок\n\nПроверяет код.' };

    const flags = async (name) => {
      const a = await stateAgent(name);
      return `${a.editable}/${a.deletable}`;
    };
    check('A2 bus ui state: у проекта нет ни правки, ни удаления; локальный и обёртка — правка и удаление; глобальный — только правка',
      (await flags('aga')) === 'false/false' && (await flags('gwrap')) === 'true/true' && (await flags('loner')) === 'true/true' && (await flags('ghelper')) === 'true/false', [await flags('aga'), await flags('gwrap'), await flags('ghelper')].join(' '));

    // ---------- создать ----------
    const noToken = await post('/api/agent/create', { name: 'newbie', ...fields }, {});
    const badName = await post('/api/agent/create', { name: 'Новичок', ...fields });
    const reserved = await post('/api/agent/create', { name: 'files', ...fields });
    const noRole = await post('/api/agent/create', { name: 'newbie', ...fields, body: '  ' });
    const badEffort = await post('/api/agent/create', { name: 'newbie', ...fields, effort: 'turbo' });
    const fastSonnet = await post('/api/agent/create', { name: 'newbie', ...fields, fast: true });
    check('A3 bus ui создать агента: без токена — 403; кривое и служебное имя, пустая роль, неизвестный effort, fast mode на sonnet — 400 с причиной, на диске ничего', noToken.status === 403 && badName.status === 400 && reserved.status === 400 && noRole.status === 400 && noRole.json().error.includes('Пустая роль') && badEffort.status === 400 && badEffort.json().error.includes('Effort') && fastSonnet.status === 400 && fastSonnet.json().error.includes('Opus') && !fs.existsSync(localDef('newbie')) && !fs.existsSync(localDef('files')), `${noToken.status} ${badName.status} ${reserved.status} ${noRole.text}`);

    const created = await post('/api/agent/create', { name: 'newbie', ...fields });
    const newbie = read(localDef('newbie'));
    const again = await post('/api/agent/create', { name: 'newbie', ...fields });
    const shadow = await post('/api/agent/create', { name: 'loner', ...fields });
    const listed = await stateAgent('newbie');
    check('A4 bus ui создать агента: файл роли с name, описанием, моделью и effort; строк tools и memory нет (memory — до ≈3.7к токенов на подъём, дописывается руками) — агенту доступны все инструменты; блок «Шина» с его --as; запись в реестре, ящик, в списке — заведён; то же имя и имя готового определения — отказ',
      created.status === 200 && created.json().key === `newbie@${proj}`
      // «: » в описании YAML прочёл бы как ключ — такая строка уходит в кавычках
      && newbie.startsWith('---\nname: newbie\ndescription: "QA проекта: гоняет тесты"\nmodel: sonnet\neffort: low\n---\n\n# Новичок\n\nПроверяет код.\n\n## Шина') && newbie.includes('--as newbie') && !newbie.includes('tools:') && !newbie.includes('memory:')
      && registry().newbie && registry().newbie.def === '.claude/agents/newbie.md' && fs.existsSync(box('newbie', 'inbox.md')) && listed.registered === true && listed.kind === 'local'
      && again.status === 400 && again.json().error.includes('уже есть') && shadow.status === 400 && read(localDef('loner')).includes('субагент loner'), created.text + newbie.slice(0, 200) + again.text);

    // ---------- прочитать роль ----------
    const closed = await role(`newbie@${proj}`, 'nope');
    const opened = (await role(`newbie@${proj}`)).json();
    const project = await role('aga');
    check('A5 bus ui роль: без токена в адресе — 403; поля формы отдельно, описание без кавычек YAML, тело без блока «Шина», блок — отдельно; у проекта роли нет — 400',
      closed.status === 403 && opened.name === 'newbie' && opened.description === 'QA проекта: гоняет тесты' && opened.model === 'sonnet' && opened.effort === 'low' && opened.fast === false && opened.registered === true && !('tools' in opened) && opened.body === '# Новичок\n\nПроверяет код.'
      && opened.busBlock.startsWith('## Шина') && opened.deletable === true && opened.warning === '' && project.status === 400, JSON.stringify(opened).slice(0, 300) + project.text);

    // ---------- править ----------
    const key = `newbie@${proj}`;
    fs.writeFileSync(localDef('newbie'), read(localDef('newbie')).replace('model: sonnet\n', 'tools: Read, Grep, Bash\nmodel: sonnet\n').replace('effort: low\n', 'effort: low\nmemory: project\n')); // строки tools и memory вписали руками — форма их не трогает
    const saved = await post('/api/agent/save', { key, description: 'новое описание', model: '', effort: 'max', fast: false, body: '# Новичок\n\nТеперь ещё и правит.' });
    const afterSave = read(localDef('newbie'));
    const noBash = await post('/api/agent/save', { key, ...fields, effort: 'ultra' });
    const ownBus = await post('/api/agent/save', { key, ...fields, body: 'Роль.\n\n## Шина\n\nсвои правила' });
    const emptyBody = await post('/api/agent/save', { key, ...fields, body: '' });
    const ghost = await post('/api/agent/save', { key: 'nobody@/x', ...fields });
    const pathKey = await post('/api/agent/save', { key: '../../etc/passwd', file: path.join(sandbox, 'x.md'), ...fields });
    check('A6 bus ui править роль: меняются описание, effort и тело; пустая модель убирает поле; name, tools, memory и блок «Шина» целы; с кривым effort, со своим «## Шина», с пустой ролью и чужим ключом — 400, файл не тронут; путь из запроса не читается',
      saved.status === 200 && afterSave.startsWith('---\nname: newbie\ndescription: новое описание\ntools: Read, Grep, Bash\neffort: max\nmemory: project\n---\n\n# Новичок\n\nТеперь ещё и правит.\n\n## Шина') && afterSave.includes('--as newbie') && !afterSave.includes('model:')
      && noBash.status === 400 && noBash.json().error.includes('Effort') && ownBus.status === 400 && emptyBody.status === 400 && ghost.status === 400 && pathKey.status === 400 && read(localDef('newbie')) === afterSave && !fs.existsSync(path.join(sandbox, 'x.md')), saved.text + afterSave.slice(0, 160) + noBash.text);

    // ---------- описание необязательно ----------
    const noAbout = await post('/api/agent/create', { name: 'silent', ...fields, description: '  ', body: '# Молчун\n\n- **Гоняет** `тесты` и молчит.\n\nОстальное.' });
    const silent = read(localDef('silent'));
    const onlyHeading = await post('/api/agent/save', { key: `silent@${proj}`, ...fields, description: '', body: '## Только заголовок' });
    const headingAbout = read(localDef('silent')).includes('\ndescription: Только заголовок\n');
    const longLine = await post('/api/agent/save', { key: `silent@${proj}`, ...fields, description: '', body: 'я'.repeat(400) });
    const cutAbout = /^description: (.*)$/m.exec(read(localDef('silent')))[1];
    await post('/api/agent/delete', { key: `silent@${proj}` });
    check('A6a bus ui пустое описание: берётся первая строка роли с текстом — заголовок пропущен, маркер списка и выделение сняты; роль из одних заголовков — текст заголовка; длинная строка режется до 160 с многоточием',
      noAbout.status === 200 && silent.includes('\ndescription: Гоняет тесты и молчит.\n') && onlyHeading.status === 200 && headingAbout && longLine.status === 200 && cutAbout.length === 160 && cutAbout.endsWith('…'), noAbout.text + silent.slice(0, 120) + onlyHeading.text + cutAbout.length);

    // ---------- глобальный и обёртка ----------
    const globalOpened = (await role('ghelper')).json();
    const globalSaved = await post('/api/agent/save', { key: 'ghelper', description: 'глобальный помощник', model: 'haiku', effort: '', fast: false, body: 'Глобальная роль, правка из UI.' });
    const globalDeleted = await post('/api/agent/delete', { key: 'ghelper' });
    const projectDeleted = await post('/api/agent/delete', { key: 'aga' });
    check('A7 bus ui глобальный агент: роль правится с предупреждением «общая на все проекты», удалить нельзя — 400, файл и регистрация на месте; проект — тоже 400',
      globalOpened.warning.includes('все проекты') && globalOpened.deletable === false && globalSaved.status === 200 && read(globalRole).includes('правка из UI') && read(globalRole).includes('model: haiku')
      && globalDeleted.status === 400 && globalDeleted.json().error.includes('нельзя') && fs.existsSync(globalRole) && (await stateAgent('ghelper')).registered === true && projectDeleted.status === 400 && (await stateAgent('aga')).orchestrator === true, globalDeleted.text + projectDeleted.text);

    const wrapKey = `gwrap@${proj}`;
    const wrapOpened = (await role(wrapKey)).json();
    const wrapSaved = await post('/api/agent/save', { key: wrapKey, description: 'роль под обёрткой', model: 'opus', effort: 'high', fast: true, body: 'Роль под обёрткой, поправлена.' });
    const wrapperText = read(localDef('gwrap'));
    const wrapFast = read(box('gwrap', 'claude-settings.json'));
    const wrapFields = { key: wrapKey, description: 'роль под обёрткой', model: 'opus', effort: 'high', fast: true, body: 'Роль под обёрткой, поправлена.' };
    const manualRefused = await post('/api/agent/save', { ...wrapFields, denied: ['agents'] });
    const manualKept = read(wrappedRole);
    const converted = await post('/api/agent/save', { ...wrapFields, denied: ['agents', 'mcp:plane'], convertTools: true });
    const convertedOpened = (await role(wrapKey)).json();
    check('A21 bus ui доступ, рукописная tools: роль отдаёт строку как есть (toolsLine); галочки без «Перевести» — 400, файл цел; с convertTools строка tools уходит, встаёт disallowedTools — и в роли, и в обёртке, по которой агента поднимают',
      wrapOpened.toolsLine === 'Read, Bash' && manualRefused.status === 400 && manualRefused.json().error.includes('Перевести') && manualKept.includes('tools: Read, Bash') && !manualKept.includes('disallowedTools')
      && converted.status === 200 && !/^tools:/m.test(read(wrappedRole)) && read(wrappedRole).includes('disallowedTools: Agent, Workflow, SendMessage, ListAgents, mcp__plane') && !/^tools:/m.test(read(localDef('gwrap'))) && read(localDef('gwrap')).includes('disallowedTools: Agent, Workflow, SendMessage, ListAgents, mcp__plane')
      && convertedOpened.toolsLine === '' && convertedOpened.denied.join() === 'agents,mcp:plane', manualRefused.text + converted.text + read(localDef('gwrap')).slice(0, 300));
    const wrapDeleted = await post('/api/agent/delete', { key: wrapKey });
    check('A8 bus ui обёртка над глобальной ролью: редактор открывает и правит саму глобальную роль; в обёртку едут только модель и effort (агента поднимают по её frontmatter), fast mode — в её ящик; удаление сносит обёртку, регистрацию и ящик, роль в ~/.claude/agents остаётся',
      wrapOpened.where === wrappedRole && wrapOpened.body === 'Роль под обёрткой.' && wrapOpened.warning.includes('все проекты') && wrapOpened.deletable === true && wrapSaved.status === 200 && read(wrappedRole).includes('поправлена')
      && wrapperText.includes('Роль прочитай') && wrapperText.includes('model: opus') && wrapperText.includes('effort: high') && wrapperText.includes('description: обёртка') && read(wrappedRole).includes('effort: high') && JSON.parse(wrapFast).fastMode === true && wrapDeleted.status === 200 && !fs.existsSync(localDef('gwrap')) && !fs.existsSync(box('gwrap')) && !registry().gwrap && fs.existsSync(wrappedRole), JSON.stringify(wrapOpened).slice(0, 200) + wrapDeleted.text);

    const huge = await post('/api/agent/save', { key, ...fields, body: 'я'.repeat(40 * 1024) });
    const fastText = await post('/api/agent/save', { key, ...fields, model: 'opus', fast: 'false' });
    check('A18 bus ui агенты: тело больше 64 КБ — 400 с причиной, а не оборванное соединение; fast строкой "false" — 400, режим не включился', huge.status === 400 && huge.json().error.includes('64 КБ') && fastText.status === 400 && !fs.existsSync(box('newbie', 'claude-settings.json')) && read(localDef('newbie')) === afterSave, huge.text + fastText.text);

    // ---------- fast mode ----------
    const lonerFast = await post('/api/agent/save', { key: `loner@${proj}`, description: 'одиночка', model: 'opus', effort: '', fast: true, body: 'Роль.' });
    const fastOn = await post('/api/agent/save', { key, description: 'новое описание', model: 'opus', effort: 'max', fast: true, body: '# Новичок\n\nТеперь ещё и правит.' });
    const fastShown = (await role(key)).json().fast;
    const wakeEnv = env(proj, { BUS_AUTOWAKE: '1', BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"` });
    spawnSync(process.execPath, [BUS_JS, '--as', 'ghelper', 'send', 'newbie', 'TASK', 'проверь fast'], { cwd: proj, encoding: 'utf8', env: wakeEnv });
    const woken = await until(() => read(wakeSeen).includes('"newbie"') && !fs.existsSync(box('newbie', 'wake.lock')), 20000);
    const wakeArgv = (read(wakeSeen).split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((w) => w.name === 'newbie') || { argv: [] }).argv;
    const wakeSettings = JSON.parse(read(box('newbie', 'wake-settings.json')) || '{"claudeMdExcludes":[]}');
    const fastOff = await post('/api/agent/save', { key, description: 'новое описание', model: 'opus', effort: 'max', fast: false, body: '# Новичок\n\nТеперь ещё и правит.' });
    check('A16 bus ui fast mode: у агента «не в шине» — отказ с причиной; у заведённого флаг ложится в ящик файлом настроек, роль его показывает; фоновый подъём получает --settings с относительным путём к настройкам сессии — в них fastMode и claudeMdExcludes на глобальные CLAUDE.md и rules/; снятая галочка файл убирает',
      lonerFast.status === 400 && lonerFast.json().error.includes('не заведён') && fastOn.status === 200 && fastShown === true && woken && wakeArgv[wakeArgv.indexOf('--settings') + 1] === '.claude/bus/newbie/wake-settings.json' && wakeSettings.fastMode === true && wakeSettings.claudeMdExcludes.length === 2 && wakeSettings.claudeMdExcludes[0].endsWith('/CLAUDE.md') && wakeSettings.claudeMdExcludes[1].endsWith('/rules/**')
      && fastOff.status === 200 && !fs.existsSync(box('newbie', 'claude-settings.json')) && (await role(key)).json().fast === false, lonerFast.text + JSON.stringify(wakeArgv));

    // ---------- глобальные правила: галочка снимает claudeMdExcludes с фонового подъёма ----------
    const roleBody = { key, description: 'новое описание', model: 'opus', effort: 'max', body: '# Новичок\n\nТеперь ещё и правит.' };
    const rulesText = await post('/api/agent/save', { ...roleBody, fast: false, rules: 'true' });
    const rulesOn = await post('/api/agent/save', { ...roleBody, fast: true, rules: true });
    const bothFlags = JSON.parse(read(box('newbie', 'claude-settings.json')) || '{}');
    const rulesShown = (await role(key)).json().rules;
    const wakesBefore = read(wakeSeen).split('\n').filter((line) => line.includes('"newbie"')).length;
    spawnSync(process.execPath, [BUS_JS, '--as', 'ghelper', 'send', 'newbie', 'TASK', 'проверь правила'], { cwd: proj, encoding: 'utf8', env: wakeEnv });
    const wokenRules = await until(() => read(wakeSeen).split('\n').filter((line) => line.includes('"newbie"')).length > wakesBefore && !fs.existsSync(box('newbie', 'wake.lock')), 20000);
    const rulesSettings = JSON.parse(read(box('newbie', 'wake-settings.json')) || '{"claudeMdExcludes":[]}');
    const fastOnly = await post('/api/agent/save', { ...roleBody, fast: true, rules: false });
    const fastOnlyFlags = JSON.parse(read(box('newbie', 'claude-settings.json')) || '{}');
    const rulesOff = await post('/api/agent/save', { ...roleBody, fast: false, rules: false });
    check('A16a bus ui глобальные правила: rules строкой — 400; галочка кладёт globalRules рядом с fastMode, роль её показывает; фоновый подъём идёт без claudeMdExcludes, fastMode на месте; снята одна галочка — вторая цела, сняты обе — файла нет',
      rulesText.status === 400 && rulesOn.status === 200 && bothFlags.fastMode === true && bothFlags.globalRules === true && rulesShown === true && wokenRules && !('claudeMdExcludes' in rulesSettings) && rulesSettings.fastMode === true
      && fastOnly.status === 200 && fastOnlyFlags.fastMode === true && !('globalRules' in fastOnlyFlags) && rulesOff.status === 200 && !fs.existsSync(box('newbie', 'claude-settings.json')) && (await role(key)).json().rules === false, rulesText.text + rulesOn.text + JSON.stringify(bothFlags) + JSON.stringify(rulesSettings));

    // ---------- ИИ ----------
    const onDisk = read(localDef('newbie'));
    const rewritten = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'добавь правило про тесты', description: 'новое описание', body: '# Новичок\n\nТеперь ещё и правит.' });
    const seen = JSON.parse(read(fakeSeen) || '{}');
    const notJson = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'ответь НЕ-JSON', description: 'x', body: 'Роль.' });
    const intoBus = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'ПРО-ШИНУ напиши', description: 'x', body: 'Роль.' });
    const noAsk = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: '  ', description: 'x', body: 'Роль.' });
    const fromScratch = await post('/api/agent/rewrite', { key: null, name: 'новый агент', instruction: 'фронтенд на Vue', description: '', body: '' });
    check('A9 bus ui правка роли через ИИ: ответ в ограде ```json разобран, в форму едут описание, тело и токены; на диск ничего не пишется; claude — opus (не слабая модель) без инструментов, из временной папки, блок «Шина» в промпт не идёт; роль с нуля — тоже',
      rewritten.status === 200 && rewritten.json().body === '# Роль\n\nПереписано ИИ.' && rewritten.json().description === 'переписано: когда поднимать' && rewritten.json().tokens === 2400 && read(localDef('newbie')) === onDisk
      && seen.argv.join(' ').includes('--model opus') && seen.argv.includes('--tools') && seen.argv.includes('--no-session-persistence') && !seen.cwd.includes('agent-a') && seen.stdin.includes('Просьба пользователя: добавь правило про тесты') && !seen.stdin.includes('--as newbie')
      && fromScratch.status === 200 && fromScratch.json().body.includes('Переписано'), rewritten.text + JSON.stringify(seen.argv));
    check('A10 bus ui правка роли через ИИ: ответ не по форме, ответ с разделом «## Шина» и пустая просьба — 400 с причиной', notJson.status === 400 && notJson.json().error.includes('не по форме') && intoBus.status === 400 && intoBus.json().error.includes('Шина') && noAsk.status === 400, notJson.text + intoBus.text + noAsk.text);
    const slow = post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'МЕДЛЕННО подумай', description: 'x', body: 'Роль.' });
    await wait(400);
    const second = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'ещё одна', description: 'x', body: 'Роль.' });
    check('A11 bus ui правка роли через ИИ: одна за раз — вторая просьба во время первой получает отказ, первая доходит', second.status === 400 && second.json().error.includes('уже') && (await slow).status === 200, second.text);
    const longAsk = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: `добавь правило про тесты ${'и ещё деталь '.repeat(400)}`, description: 'о'.repeat(3000), body: 'Роль.' });
    const longAbout = await post('/api/agent/save', { key, description: `длинное описание ${'я'.repeat(3000)}`, model: 'opus', effort: 'max', fast: false, body: '# Новичок\n\nТеперь ещё и правит.' });
    check('A19 bus ui агенты: длину просьбы к ИИ и описания форма и сервер не режут — просьба на 5к символов и описание на 3к проходят целиком', longAsk.status === 200 && JSON.parse(read(fakeSeen)).stdin.includes('о'.repeat(3000)) && longAbout.status === 200 && read(localDef('newbie')).includes('я'.repeat(3000)), longAsk.text + longAbout.text);

    // ---------- доступ ----------
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { plane: { command: 'x', env: { KEY: 'MCP-KEY-NE-DOLZHEN-UEHAT' } }, 'плохое имя': {} } }));
    const limited = await post('/api/agent/create', { name: 'limited', description: 'агент с урезанным доступом', model: 'haiku', effort: '', fast: false, body: 'Роль.', denied: ['agents', 'service', 'mcp:plane'] });
    const limitedKey = `limited@${proj}`;
    const limitedText = read(localDef('limited'));
    const limitedOpened = (await role(limitedKey)).json();
    const limitedFields = { key: limitedKey, description: 'агент с урезанным доступом', model: 'haiku', effort: '', fast: false, body: 'Роль.' };
    const wideOpen = await post('/api/agent/save', { ...limitedFields, denied: [] });
    const wideOpenText = read(localDef('limited'));
    fs.writeFileSync(localDef('limited'), wideOpenText.replace('model: haiku', 'model: haiku\ndisallowedTools: mcp__plane, Bash(rm *), mcp__plane__get_user'));
    const reopened = await post('/api/agent/save', { ...limitedFields, denied: ['skills', 'mcp:*'] });
    const withExtra = read(localDef('limited'));
    const untouched = await post('/api/agent/save', limitedFields);
    const afterUntouched = read(localDef('limited'));
    const extraOnly = await post('/api/agent/save', { ...limitedFields, denied: [] });
    const extraOnlyText = read(localDef('limited'));
    const junk = await post('/api/agent/save', { ...limitedFields, denied: ['agents', 'mcp:../x'] });
    const notList = await post('/api/agent/create', { name: 'limited2', description: 'x', model: '', effort: '', fast: false, body: 'Роль.', denied: 'agents' });
    const stateAccess = (await request('GET', `/api/state?k=${token}`)).json().access;
    check('A22 bus ui доступ: снятые группы ложатся строкой disallowedTools (Bash в неё не попадает), роль отдаёт их обратно ключами и имена MCP-серверов каталога — только имена; дописанное руками сохраняется; без denied строка не трогается; пустой denied строку убирает, рукописное оставляет; мусор — 400',
      limited.status === 200 && limitedText.includes('disallowedTools: Agent, Workflow, SendMessage, ListAgents, CronCreate') && limitedText.includes('DesignSync, mcp__plane\n') && !/disallowedTools:.*\bBash\b/.test(limitedText) && !/^tools:/m.test(limitedText)
      && limitedOpened.denied.join() === 'agents,service,mcp:plane' && limitedOpened.extra.length === 0 && limitedOpened.servers.join() === 'plane' && !JSON.stringify(limitedOpened).includes('MCP-KEY') && !JSON.stringify(stateAccess).includes('MCP-KEY')
      && reopened.status === 200 && withExtra.includes('disallowedTools: Skill, mcp__*, ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, Bash(rm *), mcp__plane__get_user') && untouched.status === 200 && afterUntouched === withExtra
      && wideOpen.status === 200 && !wideOpenText.includes('disallowedTools') && extraOnly.status === 200 && extraOnlyText.includes('disallowedTools: Bash(rm *), mcp__plane__get_user\n')
      && junk.status === 400 && junk.json().error.includes('Доступ') && notList.status === 400 && !fs.existsSync(localDef('limited2'))
      && !('groups' in stateAccess) && stateAccess.servers.join() === 'plane' && 'weights' in stateAccess, limited.text + limitedText.slice(0, 400) + reopened.text + junk.text);
    await post('/api/agent/delete', { key: limitedKey });
    fs.rmSync(path.join(proj, '.mcp.json'), { force: true });

    // Замер доступа: настоящий claude не зовём — подмена «весит» 20000 минус сотня за каждый запрещённый тул и видит только своего агента
    const fakeMeter = path.join(sandbox, 'fake-claude-meter.js');
    fs.writeFileSync(fakeMeter, `if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const fs = require('fs');
const defs = fs.readdirSync('.claude/agents');
const line = (/^disallowedTools: (.*)$/m.exec(fs.readFileSync('.claude/agents/access.md', 'utf8')) || [0, ''])[1];
const denied = line ? line.split(',').length : 0;
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ок', usage: { input_tokens: 10, cache_creation_input_tokens: 9990 - denied * 100, cache_read_input_tokens: 10000 * defs.length, output_tokens: 1 } }));
`);
    const weightsOut = path.join(sandbox, 'access-weights-test.json');
    const measured = spawnSync(process.execPath, [path.join(path.dirname(BUS_JS), 'access-measure.js'), '--out', weightsOut, '--parallel', '16'], { cwd: sandbox, encoding: 'utf8', env: env(proj, { BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeMeter}"` }) });
    const table = JSON.parse(read(weightsOut) || '{"contexts":{},"order":[]}');
    check('A23 access-measure: 128 сочетаний групп, у каждого свой каталог с одним определением (соседи не раздувают тул Agent); ключ — снятые группы через «+» в порядке order; в таблице дата, версия CLI и модель; временный каталог убран',
      measured.status === 0 && Object.keys(table.contexts).length === 128 && table.order.join() === 'read,edit,web,agents,service,skills,mcp' && table.contexts[''] === 20000 && table.contexts.skills === 19900 && table.contexts['read+edit'] === 19400
      && table.contexts['skills+mcp'] === 19500 && table.cli === '9.9.9' && table.model === 'haiku' && /^\d{4}-\d{2}-\d{2}$/.test(table.measured) && !fs.readdirSync(require('os').tmpdir()).some((name) => name.startsWith('bus-access-')), measured.stdout.slice(-200) + measured.stderr.slice(-300));

    // ---------- диалоги с агентом: «+» и «×» ----------
    await post('/api/send', { to: key, type: 'DONE', text: 'первое новичку' });
    await post('/api/send', { to: 'ghelper', type: 'DONE', text: 'глобальному — остаётся' });
    const journal = path.join(proj, '.claude', 'bus', 'history.jsonl');
    const history = () => bus(proj, ['--as', 'newbie', 'history', 'aga']).out;
    const dialogMade = await post('/api/dialog/new', { a: 'aga', b: key });
    const d = dialogMade.json().d;
    const freshHistory = history();
    await post('/api/send', { to: key, type: 'DONE', text: 'во втором диалоге', dialog: d });
    bus(proj, ['--as', 'newbie', 'send', 'aga', 'DONE', 'ответ во втором']);
    const secondHistory = history();
    const records = () => read(journal).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const stamped = records().filter((r) => ['во втором диалоге', 'ответ во втором'].includes(r.text)).every((r) => r.d === d);
    const stateDialogs = (await request('GET', `/api/state?k=${token}`)).json().dialogs || [];
    await post('/api/send', { to: key, type: 'DONE', text: 'снова в первом', dialog: '' });
    const firstAgain = history();
    const notPair = await post('/api/dialog/new', { a: 'ghelper', b: key });
    const badId = await post('/api/send', { to: key, type: 'DONE', text: 'кривой диалог', dialog: 'Bad Id!' });
    // «×» закрывает: метка в closed.json проекта, журнал цел; снять — reopen; удаление метку тоже снимает
    const closedFile = path.join(proj, '.claude', 'bus', 'closed.json');
    const closedOne = await post('/api/dialog/close', { a: 'aga', b: key, d });
    const thread = `aga|${key}#${d}`;
    const marked = JSON.parse(read(closedFile))[thread] === closedOne.json().at;
    const stateClosed = ((await request('GET', `/api/state?k=${token}`)).json().closed || {})[thread] === closedOne.json().at;
    const journalKept = read(journal).includes('во втором диалоге');
    const reopenedDialog = await post('/api/dialog/reopen', { a: 'aga', b: key, d });
    const unmarked = !(thread in JSON.parse(read(closedFile)));
    const closeNotPair = await post('/api/dialog/close', { a: 'ghelper', b: key, d });
    const closeBadId = await post('/api/dialog/close', { a: 'aga', b: key, d: 'Bad Id!' });
    await post('/api/dialog/close', { a: 'aga', b: key, d });
    const dropped = await post('/api/dialog/delete', { a: 'aga', b: key, d });
    const unmarkedByDelete = !(thread in JSON.parse(read(closedFile)));
    check('A12b bus ui закрытие диалога: close кладёт метку в <проект>/.claude/bus/closed.json и в state, журнал цел; reopen и delete метку снимают; не пара и кривой id — 400',
      closedOne.status === 200 && /^[a-z0-9]+-zzzz$/.test(closedOne.json().at) && marked && stateClosed && journalKept && reopenedDialog.status === 200 && unmarked && closeNotPair.status === 400 && closeBadId.status === 400 && unmarkedByDelete,
      [closedOne.text, reopenedDialog.text, closeNotPair.text, closeBadId.text].join(' ¦ '));
    check('A12 bus ui диалоги: «+» пишет маркер и агент начинает с чистой истории; сообщение вкладки и ответ агента из CLI несут d, history агента — только текущий диалог; удаление из истории стирает диалог с маркером, первый диалог и прочая переписка целы; не пара «проект ↔ субагент» и кривой id — 400',
      dialogMade.status === 200 && /^[a-z0-9-]+$/.test(d) && freshHistory.includes('Переписки с «aga» нет') && secondHistory.includes('во втором диалоге') && secondHistory.includes('ответ во втором') && !secondHistory.includes('первое новичку') && stamped
      && stateDialogs.some((x) => x.d === d && x.pair === `aga|${key}`) && firstAgain.includes('первое новичку') && firstAgain.includes('снова в первом') && !firstAgain.includes('во втором')
      && notPair.status === 400 && badId.status === 400 && !read(journal).includes('кривой диалог')
      && dropped.status === 200 && dropped.json().removed === 2 && !read(journal).includes('во втором') && !records().some((r) => r.d === d) && read(journal).includes('первое новичку') && read(journal).includes('глобальному — остаётся'),
      [dialogMade.text, freshHistory, secondHistory, firstAgain, notPair.text, badId.text, dropped.text].join(' ¦ '));

    // Ротацию журнала вызывает сообщение другой пары: перенесённые маркеры не должны перебить текущий диалог
    const d2 = (await post('/api/dialog/new', { a: 'aga', b: key })).json().d;
    await post('/api/send', { to: key, type: 'DONE', text: 'текущий — первый', dialog: '' });
    const ghostDialog = await post('/api/send', { to: key, type: 'DONE', text: 'фантом', dialog: 'no-such-dialog' });
    const notString = await post('/api/send', { to: key, type: 'DONE', text: 'фантом', dialog: 123 });
    fs.appendFileSync(journal, JSON.stringify({ id: '0-pad', t: '2026-01-01 00:00:00', from: 'x', fk: 'p', to: 'y', tk: 'p', type: 'DONE', text: 'x'.repeat(2.1 * 1024 * 1024) }) + '\n');
    await post('/api/send', { to: 'ghelper', type: 'DONE', text: 'ротация чужой парой' });
    bus(proj, ['--as', 'newbie', 'send', 'aga', 'DONE', 'ответ после ротации']);
    const afterRotation = records().find((r) => r.text === 'ответ после ротации') || {};
    const rotatedTabs = ((await request('GET', `/api/state?k=${token}`)).json().dialogs || []).some((x) => x.d === d2);
    bus(proj, ['--as', 'newbie', 'inbox']); // ящик новичка забран — A13 считает только то, шо придёт дальше
    check('A12a bus диалоги и ротация: журнал уехал в .1 от сообщения другой пары — ответ агента идёт в тот же текущий диалог, пустой диалог остаётся вкладкой; несуществующий или не строковый dialog — 400',
      fs.existsSync(`${journal}.1`) && afterRotation.text && !afterRotation.d && rotatedTabs && ghostDialog.status === 400 && notString.status === 400 && !read(journal).includes('фантом'),
      JSON.stringify({ afterRotation, rotatedTabs, ghostDialog: ghostDialog.text, notString: notString.text }));

    // Агент прочитал задачу в A, пользователь нажал «+» (B) — ответ и history агента остаются в A; прочитал задачу из B — дальше B
    const dA = (await post('/api/dialog/new', { a: 'aga', b: key })).json().d;
    await post('/api/send', { to: key, type: 'TASK', text: 'задача в A', dialog: dA });
    bus(proj, ['--as', 'newbie', 'inbox']);
    const dB = (await post('/api/dialog/new', { a: 'aga', b: key })).json().d;
    const historyA = history();
    bus(proj, ['--as', 'newbie', 'send', 'aga', 'DONE', 'ответ на A']);
    const replyA = records().find((r) => r.text === 'ответ на A') || {};
    await post('/api/send', { to: key, type: 'TASK', text: 'задача в B', dialog: dB });
    const beforeRead = bus(proj, ['--as', 'newbie', 'send', 'aga', 'DONE', 'ещё про A']).out;
    const stillA = records().find((r) => r.text === 'ещё про A') || {};
    bus(proj, ['--as', 'newbie', 'inbox']);
    bus(proj, ['--as', 'newbie', 'send', 'aga', 'DONE', 'ответ на B']);
    const replyB = records().find((r) => r.text === 'ответ на B') || {};
    check('A12c bus диалог агента: ответ и history идут в диалог, из которого агент читал inbox, — «+» посреди работы и непрочитанное из другого диалога их не переносят; прочитал — дальше новый',
      replyA.d === dA && historyA.includes('задача в A') && stillA.d === dA && replyB.d === dB,
      JSON.stringify({ dA, dB, replyA: replyA.d, stillA: stillA.d, replyB: replyB.d, historyA, beforeRead }));

    // ---------- длинное сообщение ----------
    const longText = `Первая строка задачи.\n\n${'Дальше идёт длинное описание. '.repeat(200)}\nхвост сообщения`;
    const longSent = await post('/api/send', { to: 'ghelper', type: 'DONE', text: longText });
    const longMsg = read(path.join(proj, '.claude', 'bus', 'history.jsonl')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((m) => m.to === 'ghelper' && m.type === 'DONE').pop() || {};
    const longFile = (longMsg.files || [])[0] || {};
    check('A20 bus ui длинное сообщение: текст длиннее лимита строки шины не обрезается — уходит вложением message.md целиком и с абзацами, в строке первая фраза и отсылка к файлу',
      longSent.status === 200 && longMsg.text.includes('Первая строка задачи.') && longMsg.text.includes('во вложении message.md') && longFile.name === 'message.md' && read(longFile.path).includes('хвост сообщения') && read(longFile.path).includes('задачи.\n\nДальше'), longSent.text + JSON.stringify(longMsg).slice(0, 300));

    // ---------- удалить ----------
    await post('/api/send', { to: key, type: 'DONE', text: 'останется в журнале' });
    fs.mkdirSync(path.join(proj, '.claude', 'bus', 'scheduler'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'bus', 'scheduler', 'morning.md'), '---\ncron: 0 9 * * *\nto: newbie\nenabled: false\n---\n\nпроверь задачи\n');
    fs.writeFileSync(box('newbie', 'wake.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const busyDelete = await post('/api/agent/delete', { key });
    fs.rmSync(box('newbie', 'wake.lock'));
    const deleted = await post('/api/agent/delete', { key });
    const lonerDeleted = await post('/api/agent/delete', { key: `loner@${proj}` });
    check('A13 bus ui удалить агента: пока он работает в фоне (wake.lock) — отказ; потом уходят файл роли, ящик и запись реестра, переписка в журнале остаётся; в ответе — непрочитанное и задачи расписания на него; незаведённое определение — уходит файл',
      busyDelete.status === 400 && busyDelete.json().error.includes('работает') && deleted.status === 200 && deleted.json().left === 1 /* ящик забран после A12a — в нём только «останется в журнале» */ && deleted.json().jobs.join() === 'morning' && !fs.existsSync(localDef('newbie')) && !fs.existsSync(box('newbie'))
      && !registry().newbie && read(journal).includes('останется в журнале') && !(await stateAgent('newbie')).name && lonerDeleted.status === 200 && !fs.existsSync(localDef('loner')), busyDelete.text + deleted.text + lonerDeleted.text);

    // Реестр правили руками: определение «локального агента» лежит вне .claude/agents — ни читать, ни удалять его UI не должен
    const outside = path.join(proj, 'outside.md');
    fs.writeFileSync(outside, '---\nname: evil\ndescription: не роль\n---\n\nсекрет\n');
    fs.writeFileSync(path.join(proj, '.claude', 'bus', 'agents.json'), JSON.stringify({ agents: { evil: { scope: 'local', def: 'outside.md' } } }));
    const evilRead = await role(`evil@${proj}`);
    const evilSave = await post('/api/agent/save', { key: `evil@${proj}`, ...fields });
    const evilDelete = await post('/api/agent/delete', { key: `evil@${proj}` });
    check('A14 bus ui агенты: определение вне .claude/agents (реестр правили руками) — роль не отдаётся, не правится и не удаляется', evilRead.status === 400 && !evilRead.text.includes('секрет') && evilSave.status === 400 && evilDelete.status === 400 && read(outside).includes('секрет'), evilRead.text + evilDelete.text);

    const audit = read(path.join(busDir, 'audit.log'));
    check('A15 bus ui агенты: создание, правка, удаление и ИИ-правка видны в audit.log', ['ui agent create | newbie', 'ui agent save | newbie@', 'ui agent delete | newbie@', 'ui agent rewrite | newbie@'].every((mark) => audit.includes(mark)), audit.slice(-600));
  } finally {
    server.kill();
    try {
      fs.rmSync(path.join(os.tmpdir(), `bus-ui-${server.pid}`), { recursive: true, force: true }); // kill не даёт серверу убрать загрузки самому
    } catch {
      // подметёт следующий сервер на старте
    }
  }
};
