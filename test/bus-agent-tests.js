/**
 * Тесты панели агента в UI шины: создать, править роль, удалить, правка роли через ИИ, очистка диалога с одним агентом
 * (skills/bus/scripts/bus.js, ui.js, ui-logic.js). Зовёт run-tests.js — песочница, подменённый CLAUDE_CONFIG_DIR и check() общие.
 * Настоящий claude не зовётся: BUS_CLAUDE_CMD — подставной, отвечает по слову в просьбе.
 */

const fs = require('fs');
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

  // ---------- логика страницы ----------
  const L = require(path.join(SCRIPTS, 'ui-logic.js'));
  const agents = [{ key: 'aga', name: 'aga', kind: 'project', from: '' }, { key: 'dima@/p', name: 'dima', kind: 'local', from: 'aga' }, { key: 'helper', name: 'helper', kind: 'global', from: 'aga' }];
  const target = (...keys) => L.clearTarget({ agents: new Set(keys) }, agents);
  check('L50 очистка в UI: никто не выбран — весь журнал; пара — её диалог; один агент — диалог оркестратора с ним; сам оркестратор и трое — подсказка, а не снос журнала',
    target().mode === 'all' && target('dima@/p', 'helper').mode === 'pair' && target('dima@/p', 'helper').names === 'dima ↔ helper'
    && target('dima@/p').mode === 'single' && target('dima@/p').a === 'dima@/p' && target('dima@/p').b === 'aga' && target('helper').b === 'aga'
    && target('aga').mode === 'none' && target('aga').hint.includes('aga') && target('aga', 'helper', 'dima@/p').mode === 'none', JSON.stringify([target('dima@/p'), target('aga')]));
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
  fs.writeFileSync(fakeClaude, `let s = '';
process.stdin.on('data', (c) => (s += c)).on('end', () => {
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
});
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

    // ---------- ИИ ----------
    const onDisk = read(localDef('newbie'));
    const rewritten = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'добавь правило про тесты', description: 'новое описание', body: '# Новичок\n\nТеперь ещё и правит.' });
    const seen = JSON.parse(read(fakeSeen) || '{}');
    const notJson = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'ответь НЕ-JSON', description: 'x', body: 'Роль.' });
    const intoBus = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'ПРО-ШИНУ напиши', description: 'x', body: 'Роль.' });
    const noAsk = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: '  ', description: 'x', body: 'Роль.' });
    const fromScratch = await post('/api/agent/rewrite', { key: null, name: 'новый агент', instruction: 'фронтенд на Vue', description: '', body: '' });
    check('A9 bus ui правка роли через ИИ: ответ в ограде ```json разобран, в форму едут описание, тело и токены; на диск ничего не пишется; claude — sonnet без инструментов, из временной папки, блок «Шина» в промпт не идёт; роль с нуля — тоже',
      rewritten.status === 200 && rewritten.json().body === '# Роль\n\nПереписано ИИ.' && rewritten.json().description === 'переписано: когда поднимать' && rewritten.json().tokens === 2400 && read(localDef('newbie')) === onDisk
      && seen.argv.join(' ').includes('--model sonnet') && seen.argv.includes('--tools') && seen.argv.includes('--no-session-persistence') && !seen.cwd.includes('agent-a') && seen.stdin.includes('Просьба пользователя: добавь правило про тесты') && !seen.stdin.includes('--as newbie')
      && fromScratch.status === 200 && fromScratch.json().body.includes('Переписано'), rewritten.text + JSON.stringify(seen.argv));
    check('A10 bus ui правка роли через ИИ: ответ не по форме, ответ с разделом «## Шина» и пустая просьба — 400 с причиной', notJson.status === 400 && notJson.json().error.includes('не по форме') && intoBus.status === 400 && intoBus.json().error.includes('Шина') && noAsk.status === 400, notJson.text + intoBus.text + noAsk.text);
    const slow = post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'МЕДЛЕННО подумай', description: 'x', body: 'Роль.' });
    await wait(400);
    const second = await post('/api/agent/rewrite', { key, name: 'newbie', instruction: 'ещё одна', description: 'x', body: 'Роль.' });
    check('A11 bus ui правка роли через ИИ: одна за раз — вторая просьба во время первой получает отказ, первая доходит', second.status === 400 && second.json().error.includes('уже') && (await slow).status === 200, second.text);

    // ---------- очистка диалога с одним агентом ----------
    await post('/api/send', { to: key, type: 'DONE', text: 'первое новичку' });
    await post('/api/send', { to: 'ghelper', type: 'DONE', text: 'глобальному — остаётся' });
    const journal = path.join(proj, '.claude', 'bus', 'history.jsonl');
    const cleared = await post('/api/clear', { a: key, b: 'aga' });
    check('A12 bus ui очистка: пара «оркестратор ↔ выбранный агент» чистит только их диалог, остальная переписка каталога цела', cleared.status === 200 && cleared.json().removed === 1 && !read(journal).includes('первое новичку') && read(journal).includes('глобальному — остаётся'), cleared.text);

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
      busyDelete.status === 400 && busyDelete.json().error.includes('работает') && deleted.status === 200 && deleted.json().left === 2 /* очистка диалога ящик не трогает: в нём оба DONE */ && deleted.json().jobs.join() === 'morning' && !fs.existsSync(localDef('newbie')) && !fs.existsSync(box('newbie'))
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
  }
};
