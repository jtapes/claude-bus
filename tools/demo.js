#!/usr/bin/env node
/**
 * Демо-стенд шины: песочница с подменённой домашней папкой, проект shop, агенты и переписка — и UI поверх неё.
 * Настоящие ~/.claude, claude и pm2 не трогаются: CLAUDE_CONFIG_DIR и HOME смотрят в песочницу, claude и pm2 — заглушки.
 * На нём сняты скрины для README.
 *
 *   node tools/demo.js [--lang ru|en] [--port 4790] [--dir <каталог песочницы>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const BUS_JS = path.resolve(__dirname, '..', 'skills', 'bus', 'scripts', 'bus.js');
const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const lang = flag('--lang', 'en') === 'ru' ? 'ru' : 'en';
const port = flag('--port', '4790');
const sandbox = path.resolve(flag('--dir', path.join(os.tmpdir(), `bus-demo-${lang}`)));

const TEXT = {
  en: {
    dima: ['Backend developer: API, database, business logic.', '# Role\n\nYou own the `server/` folder: REST API, migrations, order and stock logic.\nReport contract changes to masha.'],
    masha: ['Frontend developer: UI, components, types.', '# Role\n\nYou own the `web/` folder: pages, components, API types.\nAsk dima about endpoints instead of guessing.'],
    qa: ['QA engineer: writes and runs tests, reports regressions.', '# Role\n\nYou write tests for the code you are pointed at, run them and report what failed.'],
    talk: [
      ['shop', 'dima', 'TASK', 'POST /orders accepts an order even when the item is out of stock. Add a stock check in server/orders/create.js and return 409 with the item id.'],
      ['dima', 'masha', 'QUESTION', 'I am adding a 409 to POST /orders: { error: "out_of_stock", itemId }. Does the checkout page handle non-200 answers, or do you need a separate field?'],
      ['masha', 'dima', 'DONE', 'Checkout reads `error` from any non-2xx answer, 409 works as is. I will show "Out of stock" next to the item by itemId — web/pages/checkout.vue:88.'],
      ['masha', 'dima', 'QUESTION', 'One more thing: can the 409 list every missing item at once? The cart may hold several, and I would rather mark them all in one pass.'],
      ['dima', 'masha', 'DONE', 'Yes: the body is now { error: "out_of_stock", items: [{ itemId, left }] }. itemId on the top level stays for a week so the current page does not break.'],
      ['dima', 'shop', 'DONE', 'Stock check added: server/orders/create.js:41, returns 409 { error, itemId }. Tests: server/orders/create.test.js, 6 passed. masha confirmed the checkout page handles it.'],
      ['shop', 'masha', 'TASK', 'The cart badge is cut off on a 390px screen — see the screenshot. Fix the header layout in web/components/AppHeader.vue.', true],
      ['masha', 'shop', 'DONE', 'Fixed: the badge moved inside the icon button, header no longer wraps. web/components/AppHeader.vue:23, checked at 390px and 768px.'],
      ['landing', 'shop', 'QUESTION', 'Landing needs the public price list. Is GET /api/prices stable, or should we wait for v2?'],
      ['shop', 'qa', 'TASK', 'Write regression tests for the 409 case in POST /orders and run the whole server suite.'],
    ],
    jobs: [
      ['morning-review', '0 9 * * 1-5', 'dima', 'Check open TODOs in server/, list the three most urgent ones with file:line.'],
      ['weekly-report', '0 18 * * 5', '', 'Summarize this week\'s commits in CHANGELOG style. Do not push, do not deploy.'],
    ],
    reply: 'Rate limit added: server/middleware/rateLimit.js:1, 10 requests per minute per user, 429 with Retry-After. Wired into POST /orders — server/orders/routes.js:14. Tests: 4 passed.',
    summary: 'dima added a stock check to POST /orders (409 with the list of missing items, top-level itemId kept for a week); masha confirmed the checkout page handles it and shows "Out of stock" next to the item.',
    rewrite: ['Backend developer: API, database, business logic. Reviews SQL migrations before they run.', '# Role\n\nYou own the `server/` folder: REST API, migrations, order and stock logic.\n\nBefore running any migration, review it: locks on large tables, missing indexes, irreversible steps. Report risks first, run second.\nReport contract changes to masha.'],
  },
  ru: {
    dima: ['Бэкенд-разработчик: API, база данных, бизнес-логика.', '# Роль\n\nТвоя зона — папка `server/`: REST API, миграции, логика заказов и остатков.\nО смене контракта сообщай masha.'],
    masha: ['Фронтенд-разработчик: UI, компоненты, типы.', '# Роль\n\nТвоя зона — папка `web/`: страницы, компоненты, типы API.\nПро эндпоинты спрашивай у dima, а не гадай.'],
    qa: ['QA-инженер: пишет и гоняет тесты, сообщает о регрессиях.', '# Роль\n\nПишешь тесты на указанный код, запускаешь и сообщаешь, что упало.'],
    talk: [
      ['shop', 'dima', 'TASK', 'POST /orders принимает заказ, даже когда товара нет на складе. Добавь проверку остатка в server/orders/create.js и верни 409 с id товара.'],
      ['dima', 'masha', 'QUESTION', 'Добавляю 409 в POST /orders: { error: "out_of_stock", itemId }. Страница оформления переварит не-200 или нужно отдельное поле?'],
      ['masha', 'dima', 'DONE', 'Оформление читает `error` из любого не-2xx, 409 заработает как есть. «Нет в наличии» покажу у товара по itemId — web/pages/checkout.vue:88.'],
      ['masha', 'dima', 'QUESTION', 'И ещё: может 409 отдавать сразу все закончившиеся товары? В корзине их бывает несколько, хочу подсветить все за один проход.'],
      ['dima', 'masha', 'DONE', 'Да: тело теперь { error: "out_of_stock", items: [{ itemId, left }] }. itemId на верхнем уровне оставлю на неделю, чтобы текущая страница не сломалась.'],
      ['dima', 'shop', 'DONE', 'Проверка остатка добавлена: server/orders/create.js:41, отдаёт 409 { error, itemId }. Тесты: server/orders/create.test.js, 6 прошли. masha подтвердила, что страница оформления это обрабатывает.'],
      ['shop', 'masha', 'TASK', 'Бейдж корзины обрезается на экране 390px — см. скрин. Поправь раскладку шапки в web/components/AppHeader.vue.', true],
      ['masha', 'shop', 'DONE', 'Поправила: бейдж переехал внутрь кнопки-иконки, шапка больше не переносится. web/components/AppHeader.vue:23, проверено на 390px и 768px.'],
      ['landing', 'shop', 'QUESTION', 'Лендингу нужен публичный прайс. GET /api/prices стабилен или ждать v2?'],
      ['shop', 'qa', 'TASK', 'Напиши регрессионные тесты на 409 в POST /orders и прогони весь серверный набор.'],
    ],
    jobs: [
      ['morning-review', '0 9 * * 1-5', 'dima', 'Проверь открытые TODO в server/, назови три самых срочных с файл:строка.'],
      ['weekly-report', '0 18 * * 5', '', 'Собери коммиты за неделю в стиле CHANGELOG. Не пушь и не деплой.'],
    ],
    reply: 'Лимит добавлен: server/middleware/rateLimit.js:1, 10 запросов в минуту на пользователя, 429 с Retry-After. Подключён к POST /orders — server/orders/routes.js:14. Тесты: 4 прошли.',
    summary: 'dima добавил проверку остатка в POST /orders (409 со списком закончившихся товаров, itemId на верхнем уровне остаётся на неделю); masha подтвердила, что страница оформления это обрабатывает и покажет «Нет в наличии» у товара.',
    rewrite: ['Бэкенд-разработчик: API, база данных, бизнес-логика. Проверяет SQL-миграции перед запуском.', '# Роль\n\nТвоя зона — папка `server/`: REST API, миграции, логика заказов и остатков.\n\nПеред запуском миграции проверь её: блокировки больших таблиц, индексы, необратимые шаги. Сначала риски, потом запуск.\nО смене контракта сообщай masha.'],
  },
}[lang];

// ---------- песочница ----------

fs.rmSync(sandbox, { recursive: true, force: true });
const home = path.join(sandbox, 'home');
const configDir = path.join(home, '.claude');
fs.mkdirSync(configDir, { recursive: true });

// Подставной claude: «поднятый агент» забирает inbox и отвечает DONE, сводка и правка роли — заготовки
const fakeClaude = path.join(sandbox, 'fake-claude.js');
fs.writeFileSync(fakeClaude, `let s = '';
process.stdin.on('data', (c) => (s += c)).on('end', () => {
  const argv = process.argv.slice(2);
  const run = (args) => require('child_process').spawnSync(process.execPath, [${JSON.stringify(BUS_JS)}, ...args], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  let result = ${JSON.stringify(TEXT.summary)};
  if (argv.includes('--agent')) {
    const name = argv[argv.indexOf('--agent') + 1];
    const from = (/from:([a-z0-9-]+)/.exec(run(['--as', name, 'inbox']).stdout) || [])[1];
    if (from) run(['--as', name, 'send', from, 'DONE', ${JSON.stringify(TEXT.reply)}]);
    result = ${JSON.stringify(TEXT.reply)};
  } else if (argv.includes('sonnet')) result = ${JSON.stringify(JSON.stringify({ description: TEXT.rewrite[0], body: TEXT.rewrite[1] }))};
  setTimeout(() => console.log(JSON.stringify({ type: 'result', is_error: false, result, total_cost_usd: 0.04, usage: argv.includes('--agent') ? { input_tokens: 9200, cache_creation_input_tokens: 4100, output_tokens: 700 } : { input_tokens: 2900, output_tokens: 400 } })), 1500);
});
`);

const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir, BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"`, BUS_PM2_CMD: `"${process.execPath}" -e ""`, BUS_STARTUP_DIR: path.join(home, 'startup'), BUS_SCHEDULER_START_WAIT_MS: '0' };
for (const key of ['BUS_WAKE', 'BUS_AUTOWAKE', 'CLAUDE_PROJECT_DIR', 'pm_id']) delete env[key];

const bus = (dir, args, extra = {}) => {
  const r = spawnSync(process.execPath, [BUS_JS, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: dir, BUS_AUTOWAKE: '0', ...extra } });
  if (r.status !== 0) throw new Error(`bus ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const project = (name) => {
  const dir = path.join(sandbox, 'work', name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/bus/\n.claude/settings.local.json\n');
  bus(dir, ['init', name]);
  return dir;
};
const agent = (agentsDir, name, model) => {
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${TEXT[name][0]}\ntools: Read, Edit, Write, Grep, Glob, Bash\nmodel: ${model}\n---\n\n${TEXT[name][1]}\n`);
};

/** Картинка-вложение: «шапка сайта» с обрезанным бейджем, без внешних файлов. */
function png(file, width = 390, height = 120) {
  const px = (x, y) => {
    if (y < 64) return x > 330 && x < 366 && y > 16 && y < 48 ? [184, 115, 51] : x > 352 && y > 8 && y < 26 ? [220, 60, 60] : [32, 36, 44];
    return (x + y) % 40 < 20 ? [244, 245, 247] : [236, 238, 241];
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(px(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head.set([8, 2, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ---------- посев ----------

const shop = project('shop');
const landing = project('landing');
const dirs = { shop, landing };
agent(path.join(shop, '.claude', 'agents'), 'dima', 'sonnet');
agent(path.join(shop, '.claude', 'agents'), 'masha', 'sonnet');
agent(path.join(configDir, 'agents'), 'qa', 'haiku');
bus(shop, ['add', 'dima']);
bus(shop, ['add', 'masha']);
bus(shop, ['add', 'qa', '--global']);

const shot = path.join(sandbox, 'header-390px.png');
png(shot);
for (const [from, to, type, text, withFile] of TEXT.talk) {
  const as = dirs[from] ? [] : ['--as', from];
  bus(dirs[from] || shop, [...as, 'send', to, type, ...(withFile ? ['--file', shot] : []), text]);
}
for (const [name, cron, to, prompt] of TEXT.jobs) bus(shop, ['schedule', 'add', name, cron, ...(to ? ['--to', to] : []), prompt]);

// Как будто dima уже поднимался фоном: строка «ответил 09:41 · ≈14к ток.» под его именем
fs.writeFileSync(path.join(shop, '.claude', 'bus', 'dima', 'wake.json'), JSON.stringify({ state: 'ok', at: Date.now() - 12 * 60 * 1000, by: 'shop', ms: 11400, tokens: 14000, cost: 0.04, reason: '' }));

// Настоящего демона расписания в песочнице нет (pm2 — заглушка): heartbeat пишет сам стенд, иначе панель ругается «демон не работает»
const beat = () => fs.writeFileSync(path.join(configDir, 'bus', 'scheduler.json'), JSON.stringify({ pid: process.pid, at: Date.now(), lastTick: Date.now() }));
beat();
setInterval(beat, 30 * 1000);

console.log(`Песочница: ${sandbox}`);
const ui = spawn(process.execPath, [BUS_JS, 'ui', '--port', port, '--no-open'], { cwd: shop, stdio: 'inherit', env: { ...env, CLAUDE_PROJECT_DIR: shop } });
ui.on('exit', (code) => process.exit(code || 0));
