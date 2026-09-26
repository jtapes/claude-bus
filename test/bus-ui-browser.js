#!/usr/bin/env node
/**
 * Страница шины (skills/bus/scripts/ui.html) в настоящем браузере: песочница с проектами и перепиской, UI-сервер, Chromium.
 * Запуск: node test/bus-ui-browser.js
 *
 * playwright-core в репо не едет: берётся из BUS_PLAYWRIGHT (путь к пакету), из node_modules или из кэша npx, где его держит
 * Playwright MCP, — подходит та копия, под которую скачан Chromium. Не нашлось — тесты пропускаются с кодом 0:
 * логика страницы и сервер покрыты в run-tests.js без браузера. Настоящий claude не зовётся — BUS_CLAUDE_CMD подменён.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BUS_JS = path.resolve(__dirname, '..', 'skills', 'bus', 'scripts', 'bus.js');

function findPlaywright() {
  const usable = (id) => {
    try {
      const pw = require(id);
      return fs.existsSync(pw.chromium.executablePath()) ? pw : null;
    } catch {
      return null;
    }
  };
  const npxCaches = [path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'), path.join(os.homedir(), '.npm', '_npx')].filter((dir) => fs.existsSync(dir));
  const cached = npxCaches.flatMap((dir) => fs.readdirSync(dir).map((name) => path.join(dir, name, 'node_modules', 'playwright-core')));
  for (const id of [process.env.BUS_PLAYWRIGHT, 'playwright-core', 'playwright', ...cached].filter(Boolean)) {
    const pw = usable(id);
    if (pw) return pw;
  }
  return null;
}

const playwright = findPlaywright();
if (!playwright) {
  console.log('ПРОПУЩЕНО: нет playwright-core со скачанным Chromium (npx playwright install chromium или BUS_PLAYWRIGHT=<путь к пакету>).');
  process.exit(0);
}

// ---------- песочница ----------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-browser-test-'));
const home = path.join(sandbox, 'home');
const configDir = path.join(home, '.claude');
fs.mkdirSync(configDir, { recursive: true });

// Подставной claude: «поднятый агент» забирает свой inbox и отчитывается, сводка — одна строка
const fakeClaude = path.join(sandbox, 'fake-claude.js');
const fakeMode = path.join(sandbox, 'fake-claude-mode.txt');
// Подъём агента потоковый (--input-format stream-json): stdin остаётся открытым, промпт — первая строка. hang в файле режима — агент «завис», пока его не остановят
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
  if (argv.includes('--input-format')) console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session-ui' }));
  // Ход модели для живого блока под отметкой «работает»
  if (argv.includes('--agent') && argv.includes('--input-format')) {
    console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'смотрю форму логина' }] } }));
    console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'loginForm' } }] } }));
  }
  if (argv.includes('--agent') && require('fs').existsSync(${JSON.stringify(fakeMode)}) && require('fs').readFileSync(${JSON.stringify(fakeMode)}, 'utf8').trim() === 'hang') return setTimeout(() => {}, 120000);
  if (argv.includes('--agent')) require('child_process').spawnSync(process.execPath, [${JSON.stringify(BUS_JS)}, '--as', argv[argv.indexOf('--agent') + 1], 'inbox', '--quiet'], { cwd: process.cwd(), env: process.env });
  // Правка роли в панели агента: ИИ отвечает JSON-ом с описанием и телом
  const rewrite = JSON.stringify({ description: 'описание от ИИ', body: '# Роль\\n\\nПереписано ИИ.' });
  console.log(JSON.stringify({ type: 'result', is_error: false, result: argv.includes('--agent') ? 'ответил' : s.includes('Просьба пользователя:') ? rewrite : 'сводка от подставного claude', usage: { input_tokens: 1200, output_tokens: 300 } }));
}
`);

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir, BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"`, TG_NOTIFY_DRY_RUN: '1', BUS_PM2_CMD: 'rem', BUS_STARTUP_DIR: path.join(home, 'startup'), BUS_SCHEDULER_START_WAIT_MS: '0', BUS_UPDATE_CHECK: '0', BUS_SHORTCUT: '0', BUS_APP_BROWSER: 'none' }; // ярлык на настоящий рабочий стол не ставится; расписание: ни настоящего pm2, ни автозагрузки Windows; обновление на GitHub не проверяется
for (const key of ['BUS_WAKE', 'BUS_AUTOWAKE', 'CLAUDE_PROJECT_DIR']) delete baseEnv[key];

const mkProject = (name) => {
  const dir = path.join(sandbox, 'work', name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
};
const bus = (dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [BUS_JS, ...args], { cwd: dir, encoding: 'utf8', env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir, ...env } });
  if (r.status !== 0) throw new Error(`bus ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const quiet = { BUS_AUTOWAKE: '0' }; // посев переписки никого не будит
const defFile = (root, name) => {
  const file = path.join(root, 'agents', `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: тестовый субагент ${name}\n---\n\nРоль.\n`);
};
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

// Настройки проекта (шестерёнка): та же свёртка каталога в ключ, что rootKey в settings.js — иначе тест смотрит не туда
const settingsFile = path.join(configDir, 'bus', 'settings.json');
const settingsKey = (root) => {
  const resolved = path.resolve(root).split(path.sep).join('/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const projectSettings = (root) => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).projects[settingsKey(root)] || {};
  } catch {
    return {};
  }
};

const shop = mkProject('shop');
const landing = mkProject('landing');
bus(shop, ['init', 'shop']);
bus(landing, ['init', 'landing']);
for (const name of ['dima', 'masha', 'loner']) defFile(path.join(shop, '.claude'), name);
defFile(configDir, 'qa');
bus(shop, ['add', 'dima']);
bus(shop, ['add', 'masha']);
bus(shop, ['add', 'qa', '--global']);

// Старый диалог shop ↔ dima: два сообщения ушли в сводку, третье — после неё
const journal = path.join(shop, '.claude', 'bus', 'history.jsonl');
const old = (n, from, fk, to, tk, type, text) => ({ id: `${(Date.now() - 86400000 + n * 1000).toString(36)}-old${n}`, t: `2026-01-0${n} 10:00:0${n}`, from, fk, to, tk, type, text });
const oldRecords = [old(1, 'shop', 'p', 'dima', 'l', 'TASK', 'старая задача'), old(2, 'dima', 'l', 'shop', 'p', 'DONE', 'старый ответ'), old(3, 'shop', 'p', 'dima', 'l', 'FYI', 'после сводки')];
fs.appendFileSync(journal, oldRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.appendFileSync(journal, JSON.stringify({ id: `${oldRecords[1].id}s`, t: '2026-01-02 11:00:00', kind: 'summary', a: 'shop', ak: 'p', b: 'dima', bk: 'l', upto: oldRecords[1].id, count: 2, text: 'сводка старого диалога' }) + '\n');

const XSS = '<img src=x onerror="window.__xss=1"> <b>не тег</b>';
bus(shop, ['send', 'masha', 'task', XSS], quiet);
const MD = '## Разметка в ленте\nабзац с **жирным** и `кодом`\n\n- пункт один\n- пункт <i>два</i>\n\n```\n<script>window.__xss = 2</script>\n```\n[зло](javascript:window.__xss=3)';
bus(shop, ['send', 'masha', 'task', MD], quiet);
bus(shop, ['--as', 'masha', 'send', 'dima', 'question', 'какое поле в ответе?'], quiet);
bus(shop, ['send', 'landing', 'done', 'апи переехал'], quiet);
bus(landing, ['send', 'qa', 'done', 'чужой каталог'], quiet);
for (let n = 1; n <= 8; n++) bus(shop, ['--as', 'dima', 'send', 'masha', 'done', `шаг ${n} из 8`], quiet);

// Настоящий PNG 320×180: превью обязано загрузиться картинкой, а его высота — сдвинуть низ ленты уже после прокрутки
const png = (() => {
  const zlib = require('zlib');
  const [W, H] = [320, 180];
  const raw = Buffer.alloc((W * 3 + 1) * H, 0xcc);
  for (let y = 0; y < H; y++) raw[y * (W * 3 + 1)] = 0; // байт фильтра строки
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const x of bytes) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    const sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(W, 0);
  header.writeUInt32BE(H, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();
const shot = path.join(sandbox, 'скрин формы.png');
const notes = path.join(sandbox, 'notes.txt');
fs.writeFileSync(shot, png);
fs.writeFileSync(notes, 'заметки');

// ---------- прогон ----------

let failed = 0;
const check = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '\n      → ' + detail : ''}`);
};
/** Исключение внутри сценария — провал этого теста, а не всего прогона. */
const scenario = async (name, fn) => {
  try {
    const result = await fn();
    check(name, result === true || (Array.isArray(result) && result[0] === true), Array.isArray(result) ? result[1] : String(result));
  } catch (e) {
    check(name, false, e.message.split('\n')[0]);
  }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [BUS_JS, 'ui', '--port', String(port), '--no-open'], { cwd: shop, env: { ...baseEnv, CLAUDE_PROJECT_DIR: shop } });
  let banner = '';
  server.stdout.on('data', (c) => (banner += c));
  server.stderr.on('data', (c) => (banner += c));
  for (let n = 0; n < 100 && !banner.includes('UI: http'); n++) await wait(100);
  const url = ((/http:\/\/127\.0\.0\.1:\d+/.exec(banner) || [])[0]);
  if (!url) throw new Error(`сервер UI не поднялся: ${banner}`);

  const browser = await playwright.chromium.launch();
  // Страница по умолчанию английская, а сценарии ниже написаны под русские подписи: каждому контексту закрепляем русский.
  // Сценарий про язык (E20) берёт контекст без закрепления — rawContext
  const rawContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const pinned = await rawContext(options);
    await pinned.addInitScript(() => localStorage.getItem('bus-lang') || localStorage.setItem('bus-lang', 'ru'));
    return pinned;
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const calls = [];
    page.on('request', (req) => calls.push(new URL(req.url()).pathname));
    // Подставное распознавание речи: настоящего микрофона и сервиса в тестах нет. emit([[текст, isFinal], …]) — «услышал»
    await context.addInitScript(() => {
      window.__recStarts = 0;
      window.SpeechRecognition = class {
        start() {
          window.__rec = this;
          window.__recStarts++;
          this.live = true;
          this.results = [];
        }
        emit(parts) {
          const resultIndex = this.results.length;
          for (const [transcript, isFinal] of parts) this.results.push(Object.assign([{ transcript }], { isFinal }));
          this.onresult({ resultIndex, results: this.results });
          this.results = this.results.filter((r) => r.isFinal); // промежуточный результат сервис потом заменяет
        }
        finish(error) {
          if (!this.live) return;
          this.live = false;
          if (error) this.onerror({ error });
          this.onend();
        }
        stop() { setTimeout(() => this.finish(), 0); }
        abort() { setTimeout(() => this.finish('aborted'), 0); }
      };
    });
    await page.goto(url);
    await page.waitForSelector('.msg');

    // SSE перерисует ленту раньше, чем ответ POST допишет итог в #result: читать его — дождавшись нужной строки
    const resultWith = async (text) => { await page.locator('#result', { hasText: text }).waitFor({ timeout: 10000 }).catch(() => {}); return page.locator('#result').textContent(); };
    const agentButton = (name) => page.locator(`.agent[data-key="${name}"], .agent[data-key^="${name}@"]`);
    const texts = () => page.locator('.msg .text').allTextContents();
    const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await scenario('E1 страница: грузится без ошибок в консоли, все агенты машины в списке (и «не в шине»), лента с перепиской, цвета проводов у агентов разные, оркестраторы жёлтые', async () => {
      const names = await page.locator('.agent .name').allTextContents();
      const hues = await page.locator('.agent').evaluateAll((list) => list.map((n) => ({ hue: n.style.getPropertyValue('--hue'), boss: n.dataset.kind === 'project' })));
      const wires = hues.filter((h) => !h.boss).map((h) => h.hue);
      const bosses = hues.filter((h) => h.boss).map((h) => h.hue);
      const off = await page.locator('.agent.off .name').allTextContents();
      return [errors.length === 0 && ['shop', 'dima', 'masha', 'loner', 'qa', 'landing'].every((n) => names.includes(n)) && !names.includes('user') && new Set(wires).size === wires.length && bosses.length > 0 && bosses.every((h) => h === '52') && !wires.includes('52') && off.join() === 'loner' && (await page.locator('.msg').count()) >= 10 && (await overflow(page)) <= 0, JSON.stringify({ errors, names, hues })];
    });

    await scenario('E1c как в мессенджере: сообщения оркестратора этого каталога — справа, агентов — слева; свои сдвинуты не больше чем на 60px', async () => {
      const got = await page.evaluate(() => {
        const feed = document.querySelector('#feed');
        const left = feed.getBoundingClientRect().left + parseFloat(getComputedStyle(feed).paddingLeft);
        return [...feed.querySelectorAll('.msg')].map((m) => { const r = m.getBoundingClientRect(); return { mine: m.classList.contains('from-me'), from: m.querySelector('.who').textContent, x: Math.round(r.left - left), right: Math.round(r.right - left) }; });
      });
      const mine = got.filter((m) => m.mine), agents = got.filter((m) => !m.mine);
      const boss = new Set(mine.map((m) => m.from));
      return [mine.length > 0 && agents.length > 0 && boss.size === 1 && agents.every((m) => !boss.has(m.from) && m.x === 0) && mine.every((m) => m.x > 0 && m.x <= 61), JSON.stringify(got.slice(0, 6))];
    });

    await scenario('E1b порядок загрузки: сначала подписка на события, потом состояние — иначе сообщение, разосланное в этот зазор, до вкладки не доходит', async () => {
      const [events, state] = [calls.indexOf('/api/events'), calls.indexOf('/api/state')];
      return [events >= 0 && state > events, calls.join(' ')];
    });

    await scenario('E2 XSS: текст сообщения с <img onerror> показан текстом, тег не создан и скрипт не сработал', async () => {
      const list = await texts();
      return [list.includes(XSS) && (await page.locator('.msg .text img, .msg .text b').count()) === 0 && (await page.evaluate(() => window.__xss)) === undefined, JSON.stringify(list.slice(0, 3))];
    });

    await scenario('E2a markdown: заголовок, жирный, код и список в сообщении отрисованы узлами; HTML и javascript:-ссылка внутри разметки остались текстом', async () => {
      const card = page.locator('.msg', { hasText: 'Разметка в ленте' });
      const [heading, bold, code, items, pre] = await Promise.all([card.locator('.text h4').textContent(), card.locator('.text strong').textContent(), card.locator('.text p code').textContent(), card.locator('.text li').count(), card.locator('.text pre').textContent()]);
      const live = await card.locator('.text i, .text script, .text a').count();
      return [heading === 'Разметка в ленте' && bold === 'жирным' && code === 'кодом' && items === 2 && pre.includes('<script>') && live === 0 && (await page.evaluate(() => window.__xss)) === undefined, JSON.stringify({ heading, bold, code, items, pre, live })];
    });

    // Снять выбор агентов: пару и группу — кнопкой в списке, одного — повторным кликом по нему
    const unpick = async () => {
      if (await page.isVisible('#unpick')) return page.click('#unpick');
      for (const pressed of await page.locator('.agent[aria-pressed="true"]').all()) {
        await pressed.click();
        await wait(450);
      }
    };

    await scenario('E3 общая лента — только каталог UI: переписка чужого каталога скрыта, клик по его агенту её открывает; «Сбросить фильтры» из пустой выдачи чистит поиск', async () => {
      const hiddenFirst = !(await texts()).includes('чужой каталог');
      await page.click('#agents summary');
      await agentButton('landing').click();
      await wait(450);
      const shownByAgent = (await texts()).includes('чужой каталог');
      await agentButton('landing').click();
      await wait(450);
      const hiddenAgain = !(await texts()).includes('чужой каталог');
      await page.fill('#q', 'такого-текста-нет-нигде');
      await page.waitForSelector('.empty');
      const emptyShown = (await page.locator('.msg').count()) === 0;
      await page.click('.empty button');
      await page.waitForSelector('.msg');
      return [hiddenFirst && shownByAgent && hiddenAgain && emptyShown && (await page.inputValue('#q')) === '' && (await page.locator('#onlyHere').count()) === 0, JSON.stringify({ hiddenFirst, shownByAgent, hiddenAgain, emptyShown })];
    });

    await scenario('E3b поиск подсвечивает найденное без учёта регистра — в тексте и в именах; очистил поле — подсветки нет', async () => {
      await page.fill('#q', 'ШАГ');
      await page.waitForSelector('.msg .text mark');
      const inText = await page.locator('.msg .text mark').allTextContents();
      const rows = await page.locator('.msg').count();
      await page.fill('#q', 'dima');
      await page.waitForSelector('.msg .who mark');
      const inNames = await page.locator('.msg .who mark').allTextContents();
      await page.fill('#q', '');
      await page.waitForFunction(() => !document.querySelector('.msg mark'));
      return [inText.length === rows && rows === 8 && inText.every((t) => t === 'шаг') && inNames.length > 0 && inNames.every((t) => t === 'dima'), JSON.stringify({ inText, rows, inNames: inNames.length })];
    });

    await scenario('E4 клик по агенту: в ленте только его переписка, он подставлен в «Кому», «Снять выбор» для одного не показана; повторный клик снимает фильтр', async () => {
      await agentButton('dima').click();
      await wait(450); // двойной клик отсчитан — следующий клик снова одиночный
      const pressed = await agentButton('dima').getAttribute('aria-pressed');
      const meta = await page.locator('.msg .meta').allTextContents();
      const to = await page.inputValue('#to');
      const unpickShown = await page.isVisible('#unpick');
      await agentButton('dima').click();
      await wait(450);
      return [pressed === 'true' && meta.length > 0 && meta.every((m) => m.includes('dima')) && to.startsWith('dima@') && !unpickShown && (await agentButton('dima').getAttribute('aria-pressed')) === 'false', JSON.stringify({ pressed, to, unpickShown, n: meta.length })];
    });

    await scenario('E4b агент «не в шине»: клик выбирает его и ставит в «Кому» с пометкой, первое сообщение само заводит его в шину — страница называет правленый файл, строка в списке перестаёт быть серой', async () => {
      await agentButton('loner').click();
      await wait(450);
      const to = await page.inputValue('#to');
      const offered = await page.locator('#to option').allTextContents();
      const greyBefore = (await agentButton('loner').getAttribute('class')).includes('off');
      await page.selectOption('#type', 'DONE');
      await page.fill('#text', 'первое сообщение loner из браузера');
      await page.click('#sendBtn');
      await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Отправлено'), null, { timeout: 5000 });
      const result = await page.locator('#result').textContent();
      await page.waitForFunction(() => ![...document.querySelectorAll('.agent')].find((b) => b.querySelector('.name').textContent === 'loner').className.includes('off'), null, { timeout: 5000 });
      const options = await page.locator('#to option').allTextContents();
      const ok = to.startsWith('loner@') && offered.includes('loner — заведётся в шину') && greyBefore && result.includes('loner заведён в шину') && result.includes('дописан блок «Шина»') && !(await page.locator('#result').getAttribute('class')).includes('bad')
        && options.includes('loner') && (await page.inputValue('#to')).startsWith('loner@') && (await page.locator('.msg', { hasText: 'первое сообщение loner из браузера' }).count()) === 1;
      await agentButton('loner').click(); // снять выбор: дальше сценарии ждут общую ленту
      await wait(450);
      return [ok && (await page.locator('.agent[aria-pressed="true"]').count()) === 0, JSON.stringify({ to, offered, result, options })];
    });

    await scenario('E5 двойной клик по второму агенту и Ctrl+клик собирают пару; «Снять выбор · 2» в списке агентов снимает её; фишка типа фильтрует ленту', async () => {
      await agentButton('masha').click();
      await agentButton('dima').dblclick();
      // Имён над лентой нет — пару видно выбором слева
      const pairByDbl = (await page.isVisible('#pair')) ? (await page.locator('.agent[aria-pressed="true"] .name').allTextContents()).join(' ') : '';
      const unpickLabel = (await page.locator('#agents #unpick').textContent()).trim();
      await page.click('#unpick');
      const unpicked = (await page.locator('.agent[aria-pressed="true"]').count()) === 0 && !(await page.isVisible('#unpick'));
      await agentButton('masha').click();
      await wait(450);
      await agentButton('dima').click({ modifiers: ['Control'] });
      const pairByCtrl = await page.isVisible('#pair');
      await page.click('#unpick');
      if (unpickLabel !== 'Снять выбор · 2' || !unpicked) return [false, JSON.stringify({ unpickLabel, unpicked })];
      await page.click('.chip.QUESTION');
      const types = await page.locator('.msg .type').allTextContents();
      await page.click('.chip.QUESTION');
      return [pairByDbl.includes('dima') && pairByDbl.includes('masha') && pairByCtrl && types.length === 1 && types[0] === 'QUESTION' && (await page.locator('.msg').count()) > 1, pairByDbl + ' ' + types.join()];
    });

    await scenario('E6 сводка: в общей ленте карточка стоит за покрытыми сообщениями и ведёт в диалог; там исходные свёрнуты и раскрываются, вес хвоста посчитан, «Сжать» выключена на одном сообщении; стрелка выходит из диалога', async () => {
      const coveredInFeed = await page.locator('.msg.covered').count();
      await page.click('.summary button');
      await page.waitForSelector('#pair:not([hidden])');
      const folded = await page.locator('.msg').count();
      const weight = await page.locator('#pairWeight').textContent();
      const squeezeOff = await page.isDisabled('#squeeze');
      await page.click('.summary button');
      const unfolded = await page.locator('.msg.covered').count();
      await page.locator('.arrow[aria-pressed="true"]').first().click();
      return [coveredInFeed === 2 && folded === 1 && weight.includes('агент прочтёт 1') && squeezeOff && unfolded === 2 && !(await page.isVisible('#pair')), JSON.stringify({ coveredInFeed, folded, weight, squeezeOff, unfolded })];
    });

    await scenario('E7 «Сжать диалог»: без пары кнопки нет — она в панели пары рядом с весом; с парой — сначала подтверждение с числом сообщений, отказ ничего не сжимает, согласие — сводка от claude встаёт карточкой, исходные сворачиваются', async () => {
      const hiddenWithoutPair = !(await page.isVisible('#squeeze'));
      await agentButton('masha').click();
      await agentButton('dima').dblclick();
      const before = await page.locator('.msg').count();
      let ask = '';
      page.once('dialog', (d) => { ask = d.message(); d.dismiss(); });
      await page.click('#squeeze');
      await wait(300);
      const keptOnDismiss = (await page.locator('.summary').count()) === 0 && (await page.locator('.msg').count()) === before;
      if (!ask.includes('Сообщений: 9') || !keptOnDismiss) return [false, JSON.stringify({ ask, keptOnDismiss })];
      page.once('dialog', (d) => d.accept());
      await page.click('#squeeze');
      await page.waitForSelector('.summary', { timeout: 20000 });
      const note = await page.locator('#pairNote').textContent();
      const after = await page.locator('.msg').count();
      await page.click('#unpick');
      const inPair = await page.locator('#pair #squeeze').count();
      return [hiddenWithoutPair && inPair === 1 && before === 9 && after === 0 && note.includes('Сжато сообщений: 9') && (await page.locator('.summary p').first().textContent()) !== '', JSON.stringify({ hiddenWithoutPair, inPair, before, after, note })];
    });

    // Подпись, которую код уже менял («Сжимаю…», «Переписываю…»), из статичной разметки выпала — язык ей ставит сам код
    const labelInBothLangs = async (selector) => {
      await page.click('#lang');
      const en = (await page.locator(selector).textContent()).trim();
      await page.click('#lang');
      return `${en} | ${(await page.locator(selector).textContent()).trim()}`;
    };
    await scenario('E7a после сжатия кнопка «Сжать диалог» переводится вместе со страницей, а не застревает на языке, на котором сжимали', async () => {
      const labels = await labelInBothLangs('#squeeze');
      return [labels === 'Compress dialog | Сжать диалог', labels];
    });

    const inboxOf = (name) => read(path.join(shop, '.claude', 'bus', name, 'inbox.md'));
    await scenario('E8 отправка: Enter шлёт от имени оркестратора каталога (он подписан у «Кому»), Shift+Enter — перенос строки без отправки, сообщение приезжает в ленту по SSE, поле очищается, пустое не уходит', async () => {
      await page.selectOption('#to', { label: 'dima' });
      await page.selectOption('#type', 'DONE');
      await page.click('#sendBtn');
      const refusal = await page.locator('#result').textContent();
      await page.fill('#text', 'привет');
      await page.press('#text', 'Shift+Enter');
      const held = await page.inputValue('#text');
      const sentEarly = inboxOf('dima').includes('from:shop | привет');
      await page.fill('#text', 'привет из браузера');
      await page.press('#text', 'Enter');
      await page.locator('.msg .text', { hasText: 'привет из браузера' }).waitFor();
      const result = await page.locator('#result').textContent();
      const hint = await page.locator('#fromHint').textContent();
      return [refusal.includes('Пустое') && held === 'привет\n' && !sentEarly && hint === 'от имени shop' && result.startsWith('Отправлено от имени shop.') && result.includes('поднят в фоне') /* DONE будит, как и любой тип; ящик забирает подставной claude — смотрим журнал */ && (await page.inputValue('#text')) === '' && read(path.join(shop, '.claude', 'bus', 'history.jsonl')).includes('"type":"DONE","text":"привет из браузера"'), refusal + ' | ' + JSON.stringify(held) + ' | ' + result];
    });

    await scenario('E9 автоподъём: TASK из формы поднимает субагента в фоне (подставной claude), в списке у него появляется итог; рубильника в шапке нет — он живёт в CLI', async () => {
      await page.selectOption('#to', { label: 'masha' });
      await page.selectOption('#type', 'TASK');
      await page.fill('#text', 'сделай из браузера');
      await page.click('#sendBtn');
      await page.locator('#result', { hasText: 'поднят в фоне' }).waitFor();
      await agentButton('masha').locator('.note.ok').waitFor({ timeout: 20000 });
      const done = await agentButton('masha').locator('.note.ok').textContent();
      bus(shop, ['autowake', 'off']); // дальше сценарии шлют TASK и QUESTION — фон им не нужен
      return [done.includes('ответил') && done.includes('≈1.5к') && (await page.locator('#autowake').count()) === 0 && inboxOf('masha') === '', JSON.stringify({ done })];
    });

    await scenario('E40 отметка запуска: на сообщении, с которого агент начал, — «работает» с часами и «Остановить», под ней живой ход агента (клик раскрывает, в списке слева — последняя строка); занятому агенту форма предлагает btw, оно уходит вбросом; стоп → «остановлен» и «Продолжить»; продолжение поднимает ту же сессию → «отработал»', async () => {
      bus(shop, ['autowake', 'on']);
      fs.writeFileSync(fakeMode, 'hang');
      await page.selectOption('#to', { label: 'masha' });
      const btwHiddenIdle = await page.locator('#btwWrap').isHidden();
      await page.selectOption('#type', 'TASK');
      await page.fill('#text', 'долгая работа из браузера');
      await page.click('#sendBtn');
      const card = page.locator('.msg', { hasText: 'долгая работа из браузера' });
      await card.locator('.run-mark.run').waitFor({ timeout: 20000 });
      const running = await card.locator('.run-mark > span').first().textContent() + await card.locator('.run-mark .clock').textContent();
      // Живой ход: блок под отметкой (тул — моноширинно), последняя строка — в списке слева; клик раскрывает блок и карточку не выделяет
      await card.locator('.live li.tool', { hasText: 'Grep loginForm' }).waitFor({ timeout: 20000 });
      const liveRows = await card.locator('.live li').count();
      const liveText = await card.locator('.live li.text').textContent();
      const liveMono = await card.locator('.live li.tool').evaluate((n) => getComputedStyle(n).fontFamily.includes('Cascadia'));
      const liveLast = await agentButton('masha').locator('.live-last').textContent();
      await card.locator('.live').click();
      const liveOpen = await card.locator('.live.open').count();
      const livePicked = await card.evaluate((n) => n.classList.contains('picked'));
      await page.locator('#btwWrap').waitFor({ state: 'visible' });

      await page.check('#btw');
      await page.selectOption('#type', 'QUESTION');
      await page.fill('#text', 'попутно из браузера');
      await page.click('#sendBtn');
      await page.locator('#result', { hasText: 'вброшено' }).waitFor();
      await page.locator('.msg', { hasText: 'попутно из браузера' }).locator('.btw-tag').waitFor();
      const btwReset = !(await page.isChecked('#btw'));
      const notInInbox = !inboxOf('masha').includes('попутно из браузера');

      await card.locator('.run-mark button', { hasText: 'Остановить' }).click();
      await card.locator('.run-mark.wait', { hasText: 'остановлен' }).waitFor({ timeout: 20000 });
      await card.locator('.live').waitFor({ state: 'detached' });
      await agentButton('masha').locator('.live-last').waitFor({ state: 'detached' });
      const stopNote = await resultWith('masha остановлен');
      await page.locator('#btwWrap').waitFor({ state: 'hidden' });

      fs.writeFileSync(fakeMode, 'ok');
      const session = path.join(configDir, 'projects', 'C--shop', 'fake-session-ui.jsonl');
      fs.mkdirSync(path.dirname(session), { recursive: true });
      fs.writeFileSync(session, '{}\n');
      await card.locator('.run-mark button', { hasText: 'Продолжить' }).click();
      await card.locator('.run-mark.ok', { hasText: 'отработал' }).waitFor({ timeout: 20000 });
      const resumeNote = await resultWith('продолжает прежнюю сессию');
      bus(shop, ['autowake', 'off']);
      return [btwHiddenIdle && /masha работает\d+:\d\d/.test(running) && btwReset && notInInbox && stopNote.includes('masha остановлен') && resumeNote.includes('продолжает прежнюю сессию') && inboxOf('masha') === ''
        && liveRows === 2 && liveText.includes('смотрю форму логина') && liveMono && liveLast === 'Grep loginForm' && liveOpen === 1 && !livePicked, JSON.stringify({ btwHiddenIdle, running, btwReset, notInInbox, stopNote, resumeNote, liveRows, liveText, liveMono, liveLast, liveOpen, livePicked })];
    });

    await scenario('E10 ответ оркестратору каталога UI: приходит без перезагрузки, подсвечен «новое», счётчик в шапке и в заголовке вкладки, медный бейдж — на ответившем, у оркестратора ни бейджа, ни подписи про промпт; открыл диалог агента — его ответы прочитаны, ответ другого агента остался', async () => {
      const shopInbox = path.join(shop, '.claude', 'bus', 'shop', 'inbox.md');
      await unpick(); // общая лента: сама она ничего не читает
      bus(shop, ['--as', 'dima', 'send', 'shop', 'done', 'ответ пользователю'], quiet);
      await page.locator('.msg.unread .text', { hasText: 'ответ пользователю' }).waitFor();
      fs.appendFileSync(shopInbox, '[STATUS 09-20 10:00 ui] from:masha | ответ маши\n');
      await page.waitForFunction(() => document.title === '(2) Шина');
      const mine = await page.locator('#mineText').textContent();
      const badge = await agentButton('dima').locator('.badge:not(.wait)').textContent();
      const bossBadges = await agentButton('shop').locator('.badge').count();
      const bossNotes = await agentButton('shop').locator('.note.wait').count();
      const fresh = await page.locator('.msg.unread.to-me').count();
      const button = await page.locator('#markRead').count();
      await agentButton('dima').click();
      await page.waitForFunction(() => !document.querySelector('.msg.unread') && document.title === '(1) Шина');
      const left = read(shopInbox);
      const dimaBadges = await agentButton('dima').locator('.badge:not(.wait)').count();
      const mashaBadges = await agentButton('masha').locator('.badge:not(.wait)').count();
      // Следующим сценариям — общая лента и пустой счётчик
      await agentButton('dima').click();
      fs.writeFileSync(shopInbox, left.split('\n').filter((l) => l && !l.includes('ответ маши')).map((l) => `${l}\n`).join(''));
      await page.waitForFunction(() => document.title === 'Шина');
      return [mine === 'Ответили shop: 2' && badge === '1' && bossBadges === 0 && bossNotes === 0 && fresh === 1 && button === 0 && dimaBadges === 0
        && mashaBadges === 1 &&!left.includes('ответ пользователю') && left.includes('ответ маши'), `${mine} ${badge} ${bossBadges} ${bossNotes} ${fresh} ${button} ${left}`];
    });

    await scenario('E11 вложения: файл прикладывается и убирается крестиком; картинка уходит с сообщением и показывается превью, файл — ссылкой на скачивание; догрузившееся превью не отрывает ленту от нижнего края', async () => {
      await page.setInputFiles('#pick', [shot, notes]);
      await page.locator('#picked .filechip').nth(1).waitFor();
      const hintHidden = !(await page.isVisible('#attachHint'));
      await page.setInputFiles('#pick', [notes]);
      await page.locator('#picked .filechip').nth(2).waitFor();
      await page.locator('#picked .filechip button').nth(2).click();
      const left = await page.locator('#picked .filechip').count();
      await page.selectOption('#to', { label: 'dima' });
      await page.selectOption('#type', 'DONE');
      await page.click('#sendBtn');
      const message = page.locator('.msg', { has: page.locator('img.thumb') }).last();
      await message.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('img.thumb')].every((img) => img.complete && img.naturalWidth > 0));
      const text = await message.locator('.text').textContent();
      const link = await message.locator('a.filechip').getAttribute('download');
      // Превью догружается после прокрутки и растит ленту на свою высоту — она обязана остаться у нижнего края, и после перезагрузки тоже
      const gap = () => page.evaluate(() => { const w = document.getElementById('wrap'); return w.scrollHeight - w.scrollTop - w.clientHeight; });
      const gapLive = await gap();
      await page.reload();
      await page.waitForFunction(() => document.querySelector('img.thumb') && [...document.querySelectorAll('img.thumb')].every((img) => img.complete && img.naturalWidth > 0));
      const gapReload = await gap();
      if (gapLive > 5 || gapReload > 5) return [false, `лента не у нижнего края: ${gapLive} / ${gapReload}`];
      return [hintHidden && left === 2 && text === '(вложение)' && link === 'notes.txt' && (await page.locator('#picked .filechip').count()) === 0 && inboxOf('dima').includes('файлы: .claude/bus/files/'), JSON.stringify({ hintHidden, left, text, link })];
    });

    await scenario('E12 тема: кнопка переключает светлую и тёмную, выбор переживает перезагрузку', async () => {
      await page.click('#theme');
      const first = await page.evaluate(() => document.documentElement.dataset.theme);
      const bgFirst = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.click('#theme');
      const second = await page.evaluate(() => document.documentElement.dataset.theme);
      const bgSecond = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.reload();
      await page.waitForSelector('.msg');
      return [['light', 'dark'].includes(first) && ['light', 'dark'].includes(second) && first !== second && bgFirst !== bgSecond && (await page.evaluate(() => document.documentElement.dataset.theme)) === second, `${first} ${second}`];
    });

    await scenario('E13 читаешь старое — лента не прыгает: о новом сообщении говорит кнопка «Новые сообщения», она и ведёт вниз', async () => {
      const low = await (await browser.newContext({ viewport: { width: 1280, height: 520 } })).newPage();
      await low.goto(url);
      await low.waitForSelector('.msg');
      await low.evaluate(() => (document.getElementById('wrap').scrollTop = 0));
      bus(shop, ['--as', 'dima', 'send', 'masha', 'done', 'пришло, пока читал старое'], quiet);
      await low.locator('#toBottom:not([hidden])').waitFor();
      const stayed = await low.evaluate(() => document.getElementById('wrap').scrollTop < 40);
      await low.click('#toBottom');
      await low.waitForFunction(() => { const w = document.getElementById('wrap'); return w.scrollHeight - w.scrollTop - w.clientHeight < 80; });
      const hiddenAgain = !(await low.isVisible('#toBottom'));
      await low.close();
      return [stayed && hiddenAgain, `${stayed} ${hiddenAgain}`];
    });

    await scenario('E14 телефон 390px: страница не шире экрана, форма целиком на экране, список агентов открывается поверх ленты и закрывается после выбора', async () => {
      const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
      await mobile.goto(url);
      await mobile.waitForSelector('.msg');
      const wide = await overflow(mobile);
      const send = await mobile.locator('#sendBtn').boundingBox();
      const asideHidden = !(await mobile.isVisible('#agents'));
      await mobile.click('#toggleAgents');
      const opened = (await mobile.isVisible('#agents')) && (await mobile.getAttribute('#toggleAgents', 'aria-expanded')) === 'true';
      await mobile.locator('.agent[data-key^="dima@"]').click();
      await mobile.waitForFunction(() => !document.getElementById('agents').classList.contains('open'));
      const expanded = await mobile.getAttribute('#toggleAgents', 'aria-expanded');
      const small = await mobile.locator('button:visible').evaluateAll((list) => list.filter((b) => !b.closest('.meta') && !b.closest('.filechip') && !b.closest('select') && b.getBoundingClientRect().height < 32).map((b) => b.id || b.className));
      await mobile.close();
      return [wide <= 0 && send && send.y + send.height <= 844 && send.x + send.width <= 390 && asideHidden && opened && expanded === 'false' && small.length === 0, JSON.stringify({ wide, send, asideHidden, opened, expanded, small })];
    });

    await scenario('E15 с клавиатуры: до агента, фильтров и отправки доходит Tab, у фокуса видна рамка; стрелка пары и крестик файла подписаны для скринридера', async () => {
      await page.focus('#q');
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({ cls: document.activeElement.className, outline: getComputedStyle(document.activeElement).outlineStyle }));
      const unnamed = await page.locator('button:visible').evaluateAll((list) => list.filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).map((b) => b.id || b.className));
      return [focused.cls.includes('chip') && focused.outline !== 'none' && unnamed.length === 0, JSON.stringify({ focused, unnamed })];
    });

    await scenario('E17 голосовой ввод: удержание пробела пишет распознанное в место курсора по ходу речи, недослышанный хвост после отпускания не остаётся; тап — обычный пробел, и при быстром наборе он встаёт перед следующей буквой; Esc возвращает текст', async () => {
      const hold = async (during) => {
        await page.keyboard.down('Space');
        await page.waitForFunction(() => window.__rec && window.__rec.live, null, { timeout: 3000 });
        const out = await during();
        await page.keyboard.up('Space');
        return out;
      };
      const emit = (parts) => page.evaluate((list) => window.__rec.emit(list), parts);
      await page.fill('#text', 'привет мир');
      await page.evaluate(() => document.getElementById('text').setSelectionRange(6, 6));
      const live = await hold(async () => {
        await emit([['это', true], ['тест дик', false]]);
        return { value: await page.inputValue('#text'), listening: await page.evaluate(() => document.getElementById('text').classList.contains('listening')), status: await page.locator('#result').textContent() };
      });
      await wait(100);
      const afterHold = await page.inputValue('#text');
      const doneStatus = await page.locator('#result').textContent();

      await page.fill('#text', '');
      await page.keyboard.press('KeyA');
      await page.keyboard.press('Space'); // тап
      await page.keyboard.down('Space'); // быстрый набор: буква нажата раньше, чем отпущен пробел
      await page.keyboard.press('KeyB');
      await page.keyboard.up('Space');
      const typed = await page.inputValue('#text');

      await page.fill('#text', 'черновик');
      const cancelled = await hold(async () => {
        await emit([['лишнее', true]]);
        await page.keyboard.press('Escape');
        await wait(100);
        return page.inputValue('#text');
      });
      const ok = live.value === 'привет это тест дик мир' && live.listening && live.status.includes('Слушаю') && afterHold === 'привет это мир' && doneStatus.includes('Надиктовано')
        && !(await page.evaluate(() => document.getElementById('text').classList.contains('listening'))) && typed === 'a  b' && cancelled === 'черновик';
      await page.fill('#text', '');
      return [ok, JSON.stringify({ live, afterHold, doneStatus, typed, cancelled })];
    });

    await scenario('E18 голосовой ввод вне поля: фокус на кнопке агента — удержание диктует в поле сообщения и кнопку не нажимает, тап нажимает её один раз; на списке «Кому» пробел не перехватывается', async () => {
      await agentButton('masha').focus();
      const pressedBefore = await agentButton('masha').getAttribute('aria-pressed');
      await page.keyboard.down('Space');
      await page.waitForFunction(() => window.__rec && window.__rec.live, null, { timeout: 3000 });
      await page.evaluate(() => window.__rec.emit([['сделай отчёт', true]]));
      await page.keyboard.up('Space');
      await wait(450);
      const dictated = await page.inputValue('#text');
      const pressedAfterHold = await agentButton('masha').getAttribute('aria-pressed');
      await agentButton('masha').focus();
      await page.keyboard.press('Space');
      await wait(450);
      const pressedAfterTap = await agentButton('masha').getAttribute('aria-pressed');
      await agentButton('masha').click(); // снять выбор
      await wait(450);
      await page.focus('#to');
      const starts = await page.evaluate(() => window.__recStarts);
      await page.keyboard.down('Space');
      await wait(600);
      await page.keyboard.up('Space');
      await page.keyboard.press('Escape');
      const startsAfterSelect = await page.evaluate(() => window.__recStarts);
      await page.fill('#text', '');
      return [dictated === 'сделай отчёт' && pressedAfterHold === pressedBefore && pressedAfterTap !== pressedBefore && startsAfterSelect === starts, JSON.stringify({ dictated, pressedBefore, pressedAfterHold, pressedAfterTap, starts, startsAfterSelect })];
    });

    await scenario('E20 удаление выделенных: клик по сообщению выделяет его и показывает панель с кнопкой удаления, повторный клик и Esc снимают; отказ в confirm ничего не удаляет, согласие — сообщение уходит из ленты и журнала', async () => {
      bus(shop, ['send', 'dima', 'done', 'удали из браузера']);
      const target = page.locator('.msg', { hasText: 'удали из браузера' });
      await target.waitFor();
      await target.locator('.text').click();
      const bar = await page.locator('#markedCount').textContent();
      await target.locator('.text').click();
      const hiddenAfterSecond = await page.locator('#marked').isHidden();
      await target.locator('.pick').click();
      await page.keyboard.press('Escape');
      const hiddenAfterEsc = await page.locator('#marked').isHidden();
      await target.locator('.text').click();
      if (process.env.BUS_SHOT) await page.screenshot({ path: path.join(process.env.BUS_SHOT, 'e20-marked.png') }); // глянуть глазами: BUS_SHOT=<папка>
      page.once('dialog', (d) => d.dismiss());
      await page.click('#markedDelete');
      const keptAfterDismiss = (await target.count()) === 1 && read(journal).includes('удали из браузера');
      page.once('dialog', (d) => d.accept());
      await page.click('#markedDelete');
      await target.waitFor({ state: 'detached', timeout: 10000 });
      const result = await resultWith('Удалено сообщений');
      return [bar === 'Выделено: 1' && hiddenAfterSecond && hiddenAfterEsc && keptAfterDismiss && !read(journal).includes('удали из браузера') && read(journal).includes('привет из браузера') && result.includes('Удалено сообщений: 1') && (await page.locator('#marked').isHidden()), JSON.stringify({ bar, hiddenAfterSecond, hiddenAfterEsc, keptAfterDismiss, result })];
    });

    const journalRecords = () => read(journal).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    await scenario('E48 выделенное — агенту цитатой: есть выделение — в форме медный чип «К выделенным: N»; отправка несёт текст и блок «К этим сообщениям:» с автором, временем и текстом, выделение снимается; «×» на чипе — уходит без цитат, выделение остаётся; удалённое выделенное — отказ', async () => {
      bus(shop, ['send', 'dima', 'done', 'цитата раз'], quiet);
      bus(shop, ['--as', 'dima', 'send', 'shop', 'question', 'цитата два\nвторая строка'], quiet);
      const byId = async (text) => { const node = page.locator('.msg', { hasText: text }); await node.waitFor(); return page.locator(`.msg[data-id="${await node.getAttribute('data-id')}"]`); }; // после отправки тот же текст есть и в цитате
      const two = await byId('цитата два');
      const one = await byId('цитата раз');
      const chipBefore = await page.locator('#refsChip').isHidden();
      await two.locator('.text').click();
      await one.locator('.text').click();
      const chip = (await page.locator('#refsChip').textContent()).trim();
      await page.selectOption('#to', { label: 'dima' });
      await page.selectOption('#type', 'TASK');
      await page.fill('#text', 'глянь сюда');
      await page.press('#text', 'Enter');
      await page.locator('.msg .text', { hasText: 'глянь сюда' }).waitFor();
      const sent = journalRecords().find((r) => String(r.text).startsWith('глянь сюда'));
      const want = /^глянь сюда\n\nК этим сообщениям:\n\n> \*\*shop → dima\*\* · \d{4}-\d\d-\d\d \d\d:\d\d · DONE\n> цитата раз\n\n> \*\*dima → shop\*\* · \d{4}-\d\d-\d\d \d\d:\d\d · QUESTION\n> цитата два\n> вторая строка$/;
      const clearedAfterSend = (await page.locator('#marked').isHidden()) && (await page.locator('#refsChip').isHidden()) && (await page.locator('.msg.picked').count()) === 0;

      await one.locator('.text').click();
      await page.click('#refsChip button');
      const offKeepsMark = (await page.locator('#refsChip').isHidden()) && (await page.locator('#marked').isVisible());
      await page.fill('#text', 'без цитат');
      await page.press('#text', 'Enter');
      await page.locator('.msg .text', { hasText: 'без цитат' }).waitFor();
      const plain = journalRecords().find((r) => r.text === 'без цитат');
      const markStays = await page.locator('.msg.picked').count();
      await page.keyboard.press('Escape');

      const refused = await page.evaluate(() => post('/api/send', { to: document.getElementById('to').value, type: 'TASK', text: 'x', refs: ['нет-такого'] }).then(() => 'ушло', (e) => e.message));
      return [chipBefore && chip === 'К выделенным: 2' && Boolean(sent) && want.test(sent.text) && clearedAfterSend && offKeepsMark && Boolean(plain) && markStays === 1 && refused === 'Выделенное сообщение уже удалено — обнови выделение.',
        JSON.stringify({ chipBefore, chip, sent: sent && sent.text, clearedAfterSend, offKeepsMark, plain: Boolean(plain), markStays, refused })];
    });

    await scenario('E21 диалоги: «Очистить всё» больше нет; у выбранного агента вкладки над лентой, «+» открывает пустой диалог, отправка уходит в него с d, агент в history видит только его; клик по первой вкладке возвращает старую переписку', async () => {
      await unpick();
      const clearGone = (await page.locator('#clear').count()) === 0 && (await page.locator('#dialogTabs').isHidden());
      bus(shop, ['send', 'masha', 'done', 'старый диалог с машей'], quiet);
      bus(shop, ['--as', 'masha', 'send', 'dima', 'done', 'маша диме — не трогать'], quiet);
      const old = page.locator('.msg .text', { hasText: 'старый диалог с машей' });
      await old.waitFor();
      await agentButton('masha').click();
      await page.locator('#dialogTabs .tab').first().waitFor();
      const tabsBefore = await page.locator('#dialogTabs .tab').count();
      await page.click('#dialogNew');
      await page.locator('#dialogTabs .tab.on', { hasText: 'Новый диалог' }).waitFor();
      await old.waitFor({ state: 'detached', timeout: 10000 });
      const tabsAfter = await page.locator('#dialogTabs .tab').count();
      const othersVisible = await page.locator('.msg .text', { hasText: 'маша диме — не трогать' }).count();
      if (process.env.BUS_SHOT) await page.screenshot({ path: path.join(process.env.BUS_SHOT, 'e21-dialogs.png') });
      await page.selectOption('#type', 'DONE');
      await page.fill('#text', 'в новом диалоге');
      await page.click('#sendBtn');
      await page.locator('.msg .text', { hasText: 'в новом диалоге' }).waitFor();
      await page.locator('#dialogTabs .tab.on', { hasText: 'в новом диалоге' }).waitFor();
      const sent = journalRecords().find((r) => r.text === 'в новом диалоге') || {};
      bus(shop, ['--as', 'masha', 'inbox'], quiet); // как по роли: сначала inbox — он переводит агента в диалог прочитанного
      const history = bus(shop, ['--as', 'masha', 'history', 'shop']);
      await page.locator('#dialogTabs .tab').first().locator('.open').click();
      await old.waitFor();
      const newHidden = (await page.locator('.msg .text', { hasText: 'в новом диалоге' }).count()) === 0;
      return [clearGone && tabsAfter === tabsBefore + 1 && othersVisible === 1 && Boolean(sent.d) && history.includes('в новом диалоге') && !history.includes('старый диалог с машей') && newHidden,
        JSON.stringify({ clearGone, tabsBefore, tabsAfter, othersVisible, d: sent.d, history, newHidden })];
    });

    await scenario('E52 лимиты аккаунта в шапке — плашка с окнами 5ч/7д из снимка rate-limits.json; на вкладке диалога — кольцо и процент окна контекста последнего запуска агента, от 300к — медная плашка; без запуска — пусто; на ответе агента из фонового запуска — плашка расхода перед временем, у сообщения пользователя — нет', async () => {
      const now = Math.floor(Date.now() / 1000);
      fs.mkdirSync(path.join(configDir, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(configDir, 'cache', 'rate-limits.json'), JSON.stringify({ five_hour: { used_percentage: 42, resets_at: now + 7800 }, seven_day: { used_percentage: 91, resets_at: now + 200000 } }));
      const d = (journalRecords().find((r) => r.text === 'в новом диалоге') || {}).d;
      const mashaBox = path.join(shop, '.claude', 'bus', 'masha');
      fs.writeFileSync(path.join(mashaBox, 'wake-context.json'), JSON.stringify({ 'shop#': { tokens: 45000, window: 200000, at: Date.now() }, [`shop#${d}`]: { tokens: 320000, window: 1000000, at: Date.now() } }));
      await page.locator('#limits .win').nth(1).waitFor({ timeout: 10000 });
      await page.locator('#dialogTabs .tab .ctx').nth(1).waitFor({ timeout: 10000 });
      const wins = await page.locator('#limits .win').allTextContents();
      const high = await page.locator('#limits .win').nth(1).locator('.meter.lvl-high').count();
      const ctx = await page.locator('#dialogTabs .tab .ctx').allTextContents();
      const warn = await page.locator('#dialogTabs .tab .ctx.warn').count();
      const title = await page.locator('#dialogTabs .tab .ctx').first().getAttribute('title');
      if (process.env.BUS_SHOT) await page.waitForTimeout(600).then(() => page.screenshot({ path: path.join(process.env.BUS_SHOT, 'e52-limits.png') })); // после pop-in плашки
      // Плашка расхода на ответе агента: сообщение из фонового запуска (BUS_RUN) и его цифры в wake-runs.json ящика
      fs.writeFileSync(path.join(mashaBox, 'wake-runs.json'), JSON.stringify({ 'abcd1234-ab12': { tokens: 23300, input: 12, cacheWrite: 21000, cacheRead: 160000, output: 2288, context: 22600, window: 200000, cost: 0.0421, ms: 13000, at: Date.now() } }));
      bus(shop, ['--as', 'masha', 'send', 'shop', 'done', 'ответ из фона с расходом'], { ...quiet, BUS_RUN: 'masha:abcd1234-ab12' });
      await page.locator('#dialogTabs .tab', { hasText: 'в новом диалоге' }).locator('.open').click(); // ответ ушёл в диалог, из которого masha читала
      const replyCard = page.locator('.msg', { hasText: 'ответ из фона с расходом' });
      await replyCard.locator('.usage').waitFor({ timeout: 10000 });
      const usageText = await replyCard.locator('.usage').textContent();
      const usageTitle = await replyCard.locator('.usage').getAttribute('title');
      const userCardUsage = await page.locator('.msg', { hasText: 'в новом диалоге' }).first().locator('.usage').count();
      const beforeTime = await replyCard.locator('.meta').evaluate((meta) => { const u = meta.querySelector('.usage'); const t = meta.querySelector('time'); return Boolean(u && t && u.nextElementSibling === t); });
      if (process.env.BUS_SHOT) await replyCard.screenshot({ path: path.join(process.env.BUS_SHOT, 'e52-usage.png') });
      fs.rmSync(path.join(mashaBox, 'wake-context.json'), { force: true });
      await page.locator('#dialogTabs .tab').first().locator('.open').click();
      await page.locator('#dialogTabs .tab .ctx').first().waitFor({ state: 'detached', timeout: 10000 });
      return [wins.length === 2 && /^5ч42%2ч\d+м$/.test(wins[0]) && wins[1].startsWith('7д91%') && high === 1 && ctx.join() === '23%,32%' && warn === 1 && title.includes('≈45к из 200к')
        && usageText === '≈23.3к' && usageTitle.includes('контекст ≈22.6к из 200к (11%)') && usageTitle.includes('$0.042') && userCardUsage === 0 && beforeTime,
        JSON.stringify({ wins, high, ctx, warn, title, usageText, usageTitle, userCardUsage, beforeTime })];
    });

    await scenario('E32 «×» закрывает вкладку в историю, журнал цел; ответ агента в закрытый диалог открывает его сам; из истории — открыть и стереть (после confirm): стёрт только этот диалог, ответы снова идут в первый', async () => {
      const second = page.locator('#dialogTabs .tab', { hasText: 'в новом диалоге' });
      await second.locator('.close').click();
      await second.waitFor({ state: 'detached', timeout: 10000 });
      const closedNote = await resultWith('закрыт');
      const keptInJournal = read(journal).includes('в новом диалоге');
      const counter = await page.locator('#dialogHistoryBtn small').textContent();
      bus(shop, ['--as', 'masha', 'send', 'shop', 'done', 'ответ в закрытый'], quiet);
      await second.waitFor({ timeout: 10000 });
      const reopenedByReply = (await page.locator('#dialogHistoryBtn').count()) === 0;
      await second.locator('.close').click();
      await second.waitFor({ state: 'detached', timeout: 10000 });
      await page.click('#dialogHistoryBtn');
      const row = page.locator('#dialogHistory li', { hasText: 'в новом диалоге' });
      await row.waitFor();
      if (process.env.BUS_SHOT) await page.screenshot({ path: path.join(process.env.BUS_SHOT, 'e32-history.png') });
      await row.locator('button.ghost', { hasText: 'Открыть' }).click();
      await page.locator('#dialogTabs .tab.on', { hasText: 'в новом диалоге' }).waitFor();
      const historyHidden = await page.locator('#dialogHistory').isHidden();
      await second.locator('.close').click();
      await second.waitFor({ state: 'detached', timeout: 10000 });
      await page.click('#dialogHistoryBtn');
      page.once('dialog', (d) => d.dismiss());
      await row.locator('button.danger').click();
      const keptAfterDismiss = (await row.count()) === 1 && read(journal).includes('в новом диалоге');
      page.once('dialog', (d) => d.accept());
      await row.locator('button.danger').click();
      await row.waitFor({ state: 'detached', timeout: 10000 });
      const result = await resultWith('удалён');
      const noHistory = (await page.locator('#dialogHistoryBtn').count()) === 0 && (await page.locator('#dialogHistory').isHidden());
      bus(shop, ['--as', 'masha', 'send', 'shop', 'done', 'ответ после удаления'], quiet);
      await page.locator('.msg .text', { hasText: 'ответ после удаления' }).waitFor();
      const back = journalRecords().find((r) => r.text === 'ответ после удаления') || {};
      bus(shop, ['inbox'], quiet); // ответ оркестратору забран — счётчик «Ответили» в заголовке не сбивает дальнейшие сценарии
      await agentButton('masha').click(); // повторный клик снимает выбор
      return [closedNote.includes('закрыт') && keptInJournal && counter === '1' && reopenedByReply && historyHidden && keptAfterDismiss && noHistory && !read(journal).includes('в новом диалоге') && read(journal).includes('старый диалог с машей') && read(journal).includes('маша диме — не трогать') && result.includes('удалён') && !back.d,
        JSON.stringify({ closedNote, keptInJournal, counter, reopenedByReply, historyHidden, keptAfterDismiss, noHistory, result, back })];
    });

    const roleFile = (name) => path.join(shop, '.claude', 'agents', `${name}.md`);
    await scenario('E33 новый агент: кнопка в «Эта директория» открывает панель, кривое имя — ошибка в форме, «Создать» пишет роль с блоком «Шина», агент встаёт в список и в «Кому»', async () => {
      await page.click('#agentNew');
      await page.locator('#agentPanel').waitFor();
      const title = await page.locator('#agentTitle').textContent();
      const aboutOptional = await page.evaluate(() => !document.getElementById('agentAbout').required); // пустое описание сервер берёт из роли
      await page.fill('#agentName', 'Кривое');
      await page.fill('#agentAbout', 'тестировщик из браузера');
      await page.fill('#agentBody', '# Тестер\n\nПроверяет.');
      await page.evaluate(() => document.getElementById('agentName').removeAttribute('pattern')); // мимо проверки браузера: ловит сама страница
      await page.click('#agentSave');
      const nameError = await page.locator('#agentError').textContent();
      await page.fill('#agentName', 'tester');
      await page.click('#agentSave');
      await page.locator('#agentPanel').waitFor({ state: 'hidden' });
      await page.locator('.agent .name', { hasText: /^tester$/ }).waitFor({ timeout: 10000 });
      const text = read(roleFile('tester'));
      const to = await page.locator('#to').inputValue();
      return [title === 'Новый агент' && aboutOptional && nameError.includes('латиница') && text.includes('name: tester') && text.includes('model: sonnet') && text.includes('## Шина') && text.includes('--as tester') && to === `tester@${shop}`, JSON.stringify({ title, nameError, to, text: text.slice(0, 120) })];
    });

    await scenario('E34 правка роли: карандаш у агента виден без наведения и открывает панель; поля «Инструменты» нет, effort пишется в роль, fast mode на sonnet — ошибка в форме; с ролью без блока «Шина» (блок — отдельно, только чтение), имя не меняется, «Сохранить» пишет на диск, блок цел', async () => {
      const pencil = page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit');
      const pencilSeen = (await pencil.isVisible()) && (await pencil.evaluate((node) => getComputedStyle(node).opacity)) === '1';
      await pencil.click();
      await page.locator('#agentPanel').waitFor();
      const body = await page.locator('#agentBody').inputValue();
      const noTools = (await page.locator('#agentTools').count()) === 0;
      await page.selectOption('#agentEffort', 'high');
      await page.check('#agentFast');
      await page.click('#agentSave');
      const fastError = await page.locator('#agentError').textContent(); // модель — sonnet: fast mode не для неё
      await page.uncheck('#agentFast');
      const nameLocked = await page.locator('#agentName').isDisabled();
      const busShown = await page.locator('#agentBus').textContent();
      await page.fill('#agentBody', '# Тестер\n\nПроверяет и отчитывается.');
      await page.click('#agentSave');
      await page.locator('#agentPanel').waitFor({ state: 'hidden' });
      const text = read(roleFile('tester'));
      return [pencilSeen && noTools && fastError.includes('Opus') && text.includes('effort: high') && body === '# Тестер\n\nПроверяет.' && nameLocked && busShown.includes('--as tester') && text.includes('Проверяет и отчитывается.') && text.includes('## Шина') && !text.includes('memory:'), JSON.stringify({ body, nameLocked })];
    });

    await scenario('E38 доступ агента: по умолчанию «Всё» и строки в роли нет; набор «Код» снимает субагентов и служебные и показывает экономию; снятая руками галочка — «Свой набор»; Bash не снимается; «Сохранить» пишет disallowedTools без Bash, панель открывается с теми же галочками; «Всё» строку убирает', async () => {
      const pencil = page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit');
      const box = (key) => page.locator(`#accessGroups input[data-access="${key}"]`);
      await pencil.click();
      await page.locator('#agentPanel').waitFor();
      const before = { preset: await page.locator('#accessPreset').inputValue(), total: await page.locator('#accessTotal').textContent(), bashLocked: await page.locator('#accessGroups input:not([data-access])').isDisabled(), line: read(roleFile('tester')).includes('disallowedTools') };
      await page.selectOption('#accessPreset', 'code');
      const code = { agents: await box('agents').isChecked(), service: await box('service').isChecked(), read: await box('read').isChecked(), total: await page.locator('#accessTotal').textContent(), delta: await page.locator('#accessGroups output[data-delta="agents"]').textContent() };
      await box('web').uncheck();
      const custom = await page.locator('#accessPreset').inputValue();
      await page.click('#agentSave');
      await page.locator('#agentPanel').waitFor({ state: 'hidden' });
      const saved = (/^disallowedTools: (.*)$/m.exec(read(roleFile('tester'))) || ['', ''])[1];
      await pencil.click();
      await page.locator('#agentPanel').waitFor();
      const reopened = { preset: await page.locator('#accessPreset').inputValue(), web: await box('web').isChecked(), agents: await box('agents').isChecked(), edit: await box('edit').isChecked() };
      await page.selectOption('#accessPreset', 'all');
      await page.click('#agentSave');
      await page.locator('#agentPanel').waitFor({ state: 'hidden' });
      const cleared = !read(roleFile('tester')).includes('disallowedTools');
      return [before.preset === 'all' && before.total.includes('≈') && before.bashLocked && !before.line && !code.agents && !code.service && code.read && code.total.includes('экономия') && code.delta.startsWith('вернуть: +')
        && custom === 'custom' && saved === 'WebFetch, WebSearch, Agent, Workflow, SendMessage, ListAgents, CronCreate, CronDelete, CronList, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, EnterWorktree, ExitWorktree, Monitor, PowerShell, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, DesignSync'
        && reopened.preset === 'custom' && !reopened.web && !reopened.agents && reopened.edit && cleared, JSON.stringify({ before, code, custom, saved, reopened, cleared })];
    });

    await scenario('E39 доступ на 390px: секция с галочками не даёт горизонтального скролла', async () => {
      const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const mobile = await mobileCtx.newPage();
      await mobile.goto(page.url());
      await mobile.waitForSelector('.msg, .empty');
      await mobile.evaluate(() => openAgentPanel(null)); // на узком экране список агентов в шторке — панель открываем её же функцией
      await mobile.locator('#agentPanel').waitFor();
      await mobile.selectOption('#accessPreset', 'chat');
      const wide = await overflow(mobile);
      await mobile.close();
      return [wide <= 0, String(wide)];
    });

    await scenario('E35 «Переписать с ИИ»: ответ ложится в форму, а не на диск; под кнопками diff как в git — «−» и «+» строки описания и роли, правка руками его пересчитывает; в заметке время работы ИИ; «Откатить» возвращает текст и прячет diff; пустая просьба — подсказка', async () => {
      await page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit').click();
      await page.locator('#agentPanel').waitFor();
      await page.click('#agentRewrite');
      const emptyNote = await page.locator('#agentAiNote').textContent();
      const onDisk = read(roleFile('tester'));
      const old = await page.locator('#agentBody').inputValue();
      await page.fill('#agentAsk', 'добавь правило про отчёты');
      await page.click('#agentRewrite');
      await page.locator('#agentAiUndo').waitFor({ timeout: 15000 });
      const after = await page.locator('#agentBody').inputValue();
      const about = await page.locator('#agentAbout').inputValue();
      const note = await page.locator('#agentAiNote').textContent();
      const signs = (kind) => page.locator(`#agentAiDiff .role-diff-line.${kind}`).allTextContents();
      const dels = await signs('del');
      const adds = await signs('add');
      const heads = await page.locator('#agentAiDiff .role-diff-head').allTextContents();
      await page.fill('#agentBody', `${after}\nДописал руками.`);
      const addsAfterEdit = await signs('add');
      await page.click('#agentAiUndo');
      const undone = await page.locator('#agentBody').inputValue();
      const undoHidden = await page.locator('#agentAiUndo').isHidden();
      const diffHidden = await page.locator('#agentAiDiff').isHidden();
      const swapGone = (await page.locator('#agentAiSwap').count()) === 0;
      await page.click('#agentCancel');
      return [emptyNote.includes('Напиши') && after === '# Роль\n\nПереписано ИИ.' && about === 'описание от ИИ' && /ИИ переписал за \d+:\d\d/.test(note) && old.includes('Проверяет и отчитывается.')
        && heads.length === 2 && dels.some((t) => t.includes('Проверяет и отчитывается.')) && adds.includes('Переписано ИИ.') && adds.includes('описание от ИИ') && addsAfterEdit.includes('Дописал руками.')
        && undone === old && undoHidden && diffHidden && swapGone && read(roleFile('tester')) === onDisk, JSON.stringify({ emptyNote, after, about, note, heads, dels, adds, addsAfterEdit })];
    });

    await scenario('E35b после правки ИИ кнопка «Переписать с ИИ» переводится вместе со страницей', async () => {
      const open = async () => {
        await page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit').click();
        await page.locator('#agentPanel').waitFor();
        const label = (await page.locator('#agentRewrite').textContent()).trim();
        await page.click('#agentCancel');
        return label;
      };
      await page.click('#lang');
      const en = await open();
      await page.click('#lang');
      const ru = await open();
      return [en === 'Rewrite with AI' && ru === 'Переписать с ИИ', `${en} | ${ru}`];
    });

    await scenario('E35c самоправка роли: галочка в форме — только субагенту, сообщение с ней помечено в ленте, галочка не снимается ни отправкой, ни сменой получателя, а проекту не уходит; агент с черновиком подписан в списке; редактор открывается с черновиком в форме, diff и пояснением агента; «Отклонить правку агента» возвращает роль с диска и сносит черновик', async () => {
      await page.selectOption('#to', { label: 'landing' });
      const hiddenForProject = await page.locator('#evolveWrap').isHidden();
      await page.selectOption('#to', { label: 'tester' });
      await page.locator('#evolveWrap').waitFor({ state: 'visible' });
      await page.check('#evolve');
      await page.selectOption('#type', 'TASK');
      await page.fill('#text', 'задача с самоправкой из браузера');
      await page.click('#sendBtn');
      await page.locator('.msg', { hasText: 'задача с самоправкой из браузера' }).locator('.btw-tag', { hasText: 'самоправка' }).waitFor();
      await page.selectOption('#to', { label: 'landing' });
      await page.selectOption('#to', { label: 'tester' });
      const kept = await page.isChecked('#evolve');
      await page.uncheck('#evolve'); // дальше сообщения tester-у — без самоправки
      const testerBox = path.join(shop, '.claude', 'bus', 'tester');
      const marked = fs.existsSync(path.join(testerBox, 'wake-evolve.json'));
      fs.rmSync(path.join(testerBox, 'wake-evolve.json'), { force: true });

      const onDisk = read(roleFile('tester'));
      fs.writeFileSync(path.join(testerBox, 'role-proposal.json'), JSON.stringify({ at: Date.now(), id: 'x', from: 'shop', base: '', description: 'черновик: когда поднимать', body: '# Роль\n\nВыучил новое правило.', note: 'Добавил правило: пользователь поправил дважды.' }));
      const row = page.locator('.agent-row', { hasText: 'tester' });
      await row.locator('.note', { hasText: 'предлагает правку роли' }).waitFor({ timeout: 15000 });
      await row.locator('.agent-edit').click();
      await page.locator('#agentPanel').waitFor();
      const body = await page.locator('#agentBody').inputValue();
      const about = await page.locator('#agentAbout').inputValue();
      const note = await page.locator('#agentAiNote').textContent();
      const adds = await page.locator('#agentAiDiff .role-diff-line.add').allTextContents();
      await page.click('#agentReject');
      await page.locator('#agentReject').waitFor({ state: 'hidden' });
      const back = await page.locator('#agentBody').inputValue();
      const diffHidden = await page.locator('#agentAiDiff').isHidden();
      await page.click('#agentCancel');
      await row.locator('.note', { hasText: 'предлагает правку роли' }).waitFor({ state: 'detached', timeout: 15000 });
      return [hiddenForProject && kept && marked && body === '# Роль\n\nВыучил новое правило.' && about === 'черновик: когда поднимать' && note.includes('Агент предлагает правку своей роли') && note.includes('поправил дважды') && adds.includes('Выучил новое правило.')
        && !onDisk.includes('Выучил новое правило.') && onDisk.includes(back.split('\n').pop()) && diffHidden && !fs.existsSync(path.join(testerBox, 'role-proposal.json')) && read(roleFile('tester')) === onDisk, JSON.stringify({ hiddenForProject, kept, marked, body, about, note, adds, back })];
    });

    await scenario('E35a диктовка в панели агента: фокус на кнопке — удержание пробела диктует в просьбу к ИИ, а не в сообщение за панелью; статус — в заметке панели; подсказка про пробел видна', async () => {
      await page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit').click();
      await page.locator('#agentPanel').waitFor();
      await page.focus('#agentRewrite');
      await page.keyboard.down('Space');
      await page.waitForFunction(() => window.__rec && window.__rec.live, null, { timeout: 3000 });
      const listening = await page.locator('#agentAiNote').textContent();
      await page.evaluate(() => window.__rec.emit([['добавь правило про отчёты', true]]));
      await page.keyboard.up('Space');
      await wait(450);
      const ask = await page.inputValue('#agentAsk');
      const message = await page.inputValue('#text');
      const done = await page.locator('#agentAiNote').textContent();
      const hint = await page.locator('#agentVoiceHint').isVisible();
      const busy = await page.locator('#agentRewrite').isDisabled(); // удержание кнопку не нажало
      await page.click('#agentCancel');
      return [ask === 'добавь правило про отчёты' && message === '' && listening.includes('Слушаю') && done.includes('Надиктовано') && hint && !busy, JSON.stringify({ ask, message, listening, done, hint, busy })];
    });

    await scenario('E36 удаление агента: у глобального кнопки «Удалить агента» нет, есть подпись почему; у локального после confirm уходят файл роли и ящик, строка пропадает из списка; Esc закрывает панель', async () => {
      await page.locator('.agent-row', { hasText: 'qa' }).locator('.agent-edit').click();
      await page.locator('#agentPanel').waitFor();
      const globalWarn = await page.locator('#agentWarn').textContent();
      const globalDelete = await page.locator('#agentDelete').isVisible();
      const globalWhy = await page.locator('#agentNoDelete').isVisible();
      await page.keyboard.press('Escape');
      await page.locator('#agentPanel').waitFor({ state: 'hidden' });
      await page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit').click();
      await page.locator('#agentPanel').waitFor();
      page.once('dialog', (d) => d.accept());
      await page.click('#agentDelete');
      await page.locator('#agentPanel').waitFor({ state: 'hidden' });
      await page.locator('.agent .name', { hasText: /^tester$/ }).waitFor({ state: 'detached', timeout: 10000 });
      const projectEdit = await page.locator('.agent-row', { hasText: 'shop' }).count();
      return [globalWarn.includes('все проекты') && !globalDelete && globalWhy && !fs.existsSync(roleFile('tester')) && !fs.existsSync(path.join(shop, '.claude', 'bus', 'tester')) && fs.existsSync(path.join(configDir, 'agents', 'qa.md')), JSON.stringify({ globalWarn, globalDelete, globalWhy, projectEdit })];
    });

    await scenario('E37 вес переписки: кнопка в шапке показывает сумму несжатого; панель — диалоги с весом и итог по директории; Esc закрывает; клик по диалогу открывает его пару; на 390px без горизонтального скролла', async () => {
      const sum = await page.locator('#weightSum').textContent();
      await page.click('#weightBtn');
      await page.locator('#weightPanel').waitFor();
      const total = await page.locator('#weightTotal').textContent();
      const rows = await page.locator('.weight-row').count();
      const rowText = await page.locator('.weight-row').first().textContent();
      await page.keyboard.press('Escape');
      await page.locator('#weightPanel').waitFor({ state: 'hidden' });
      const size = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 800 });
      await page.click('#weightBtn');
      await page.locator('#weightPanel').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      await page.setViewportSize(size);
      await page.locator('.weight-row').first().click();
      await page.locator('#weightPanel').waitFor({ state: 'hidden' });
      const pairShown = await page.locator('#pair').isVisible();
      const picked = await page.locator('.agent[aria-pressed="true"]').count();
      if (await page.locator('#unpick').count()) await page.click('#unpick');
      return [/^≈\S+ ток\.$/.test(sum) && total.includes('Эта директория: диалогов') && rows >= 1 && /сообщ\. · несжатых \d+/.test(rowText) && rowText.includes('↔') && !overflow && pairShown && picked === 2, JSON.stringify({ sum, total, rows, rowText, overflow, pairShown, picked })];
    });

    await scenario('E41 настройки проекта: шестерёнка открывает панель над лентой; кнопка «Ярлык приложения» — на Windows, macOS и Linux; правка поля помечает его «изменено» и включает «Сохранить»; сохранение пишет ключ в settings.json проекта', async () => {
      await page.click('#settingsBtn');
      await page.waitForSelector('#settings:not([hidden])');
      const expanded = await page.getAttribute('#settingsBtn', 'aria-expanded');
      const field = page.locator('.settings-field[data-key="wake.perHour"]');
      await field.waitFor();
      const saveDisabledIdle = await page.isDisabled('#settingsSave');
      const shortcutShown = await page.locator('#shortcutBtn').isVisible(); // кнопку не жмём: ярлык лёг бы на настоящий рабочий стол
      await field.locator('input').fill('3');
      const changed = (await field.getAttribute('class')).includes('changed');
      const saveEnabled = !(await page.isDisabled('#settingsSave'));
      await page.click('#settingsSave');
      await page.waitForFunction(() => document.getElementById('settingsStatus').textContent.includes('Сохранено'));
      const saved = projectSettings(shop);
      return [expanded === 'true' && saveDisabledIdle && changed && saveEnabled && saved['wake.perHour'] === 3 && shortcutShown === ['win32', 'darwin', 'linux'].includes(process.platform), JSON.stringify({ expanded, saveDisabledIdle, changed, saveEnabled, saved, shortcutShown })];
    });

    await scenario('E42 настройки проекта: значение переживает перезагрузку страницы и видно как изменённое; «↺ по умолчанию» + «Сохранить» убирает ключ из файла; кривое число — ошибка у поля без запроса на сервер; Esc закрывает панель и возвращает фокус на шестерёнку', async () => {
      await page.reload();
      await page.waitForSelector('.msg, .empty');
      await page.click('#settingsBtn');
      await page.waitForSelector('#settings:not([hidden])');
      const field = page.locator('.settings-field[data-key="wake.perHour"]');
      await field.waitFor();
      const valueAfterReload = await field.locator('input').inputValue();
      const changedAfterReload = (await field.getAttribute('class')).includes('changed');
      await field.locator('.settings-revert').click();
      await page.click('#settingsSave');
      await page.waitForFunction(() => document.getElementById('settingsStatus').textContent.includes('Сохранено'));
      const clearedFromFile = projectSettings(shop)['wake.perHour'] === undefined;

      const callsBefore = calls.length; // calls — общий список путей запросов страницы, собирается с самого начала прогона (E1)
      await field.locator('input').fill('999');
      const fieldError = await field.locator('.settings-field-error').textContent();
      const noRequestSent = !calls.slice(callsBefore).includes('/api/settings');
      const untouched = projectSettings(shop)['wake.perHour'] === undefined;
      await field.locator('input').fill('6'); // назад к дефолту — иначе Esc наткнётся на подтверждение несохранённых правок

      await page.keyboard.press('Escape');
      await page.waitForSelector('#settings', { state: 'hidden' });
      const focused = await page.evaluate(() => document.activeElement.id);
      return [valueAfterReload === '3' && changedAfterReload && clearedFromFile && fieldError.includes('от 1 до 60') && noRequestSent && untouched && focused === 'settingsBtn', JSON.stringify({ valueAfterReload, changedAfterReload, clearedFromFile, fieldError, untouched, focused })];
    });

    await scenario('E42a настройки, промпт агентов: общий текст — textarea с пометкой «все проекты» и счётчиком; сохранённое лежит в global, а не в каталоге, и переживает перезагрузку; длиннее лимита — ошибка у поля, «Сохранить» погашена; «Сбросить всё» общий текст не трогает', async () => {
      await page.click('#settingsBtn');
      await page.waitForSelector('#settings:not([hidden])');
      const field = page.locator('.settings-field[data-key="agent.promptGlobal"]');
      await field.waitFor();
      const scope = await field.locator('.settings-scope').textContent();
      const localScopes = await page.locator('.settings-field[data-key="agent.prompt"] .settings-scope').count();
      await field.locator('textarea').fill('Коммить только по просьбе.\n  - вложенный пункт  ');
      const counter = await field.locator('.settings-count').textContent();
      const changed = (await field.getAttribute('class')).includes('changed');
      await page.click('#settingsSave');
      await page.waitForFunction(() => document.getElementById('settingsStatus').textContent.includes('Сохранено'));
      const file = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const savedGlobal = (file.global || {})['agent.promptGlobal'];
      const inProject = 'agent.promptGlobal' in projectSettings(shop);

      await page.reload();
      await page.waitForSelector('.msg, .empty');
      await page.click('#settingsBtn');
      await page.waitForSelector('#settings:not([hidden])');
      await field.waitFor();
      const afterReload = await field.locator('textarea').inputValue();

      await field.locator('textarea').fill('я'.repeat(2001));
      const tooLong = await field.locator('.settings-field-error').textContent();
      const over = (await field.locator('.settings-count').getAttribute('class')).includes('over');
      const saveBlocked = await page.isDisabled('#settingsSave');
      await field.locator('textarea').fill(afterReload);

      page.once('dialog', (d) => d.accept());
      await page.click('#settingsReset');
      await page.waitForFunction(() => document.getElementById('settingsStatus').textContent.includes('Сохранено'));
      const keptAfterReset = (JSON.parse(fs.readFileSync(settingsFile, 'utf8')).global || {})['agent.promptGlobal'];

      await field.locator('.settings-revert').click();
      await page.evaluate(() => (document.getElementById('settingsStatus').textContent = '')); // «Сохранено.» висит от сброса — ждём своё
      await page.click('#settingsSave');
      await page.waitForFunction(() => document.getElementById('settingsStatus').textContent.includes('Сохранено'));
      const cleared =!('global' in JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
      await page.keyboard.press('Escape');
      await page.waitForSelector('#settings', { state: 'hidden' });
      const expected = 'Коммить только по просьбе.\n  - вложенный пункт';
      return [scope === 'все проекты' && localScopes === 0 && counter === `${expected.length} / 2000` && changed && savedGlobal === expected && !inProject && afterReload === expected
        && tooLong.includes('не длиннее 2000') && over && saveBlocked && keptAfterReset === expected && cleared, JSON.stringify({ scope, localScopes, counter, changed, savedGlobal, inProject, afterReload, tooLong, over, saveBlocked, keptAfterReset, cleared })];
    });

    // ---------- расписание: свой сервер с заглушками pm2 и автозагрузки, чтобы не тронуть настоящую систему ----------
    const schedStartup = path.join(sandbox, 'sched-startup');
    fs.mkdirSync(schedStartup, { recursive: true });
    // pm2() зовёт `${PM2_CMD} ${args}` через shell:true — «rem» встроен в cmd.exe и делает вызов комментарием: код 0 без спавна нового процесса,
    // не зависит от скорости холодного старта node.exe под нагрузкой (спавн настоящего фейкового процесса на этой машине бывал нестабильно долгим)
    const schedPort = 30000 + Math.floor(Math.random() * 20000);
    const schedEnv = { ...baseEnv, CLAUDE_PROJECT_DIR: shop, BUS_PM2_CMD: 'rem', BUS_STARTUP_DIR: schedStartup, BUS_SCHEDULER_START_WAIT_MS: '0', BUS_AUTOWAKE: '0' };
    const schedServer = spawn(process.execPath, [BUS_JS, 'ui', '--port', String(schedPort), '--no-open'], { cwd: shop, env: schedEnv });
    let schedBanner = '';
    schedServer.stdout.on('data', (c) => (schedBanner += c));
    schedServer.stderr.on('data', (c) => (schedBanner += c));
    for (let n = 0; n < 100 && !schedBanner.includes('UI: http'); n++) await wait(100);
    const schedUrl = (/http:\/\/127\.0\.0\.1:\d+/.exec(schedBanner) || [])[0];
    if (!schedUrl) throw new Error(`сервер расписания не поднялся: ${schedBanner}`);
    const jobFile = (name) => path.join(shop, '.claude', 'bus', 'scheduler', `${name}.md`);
    let spage = null;

    try {
      spage = await context.newPage();
      const schedErrors = [];
      spage.on('pageerror', (e) => schedErrors.push(e.message));
      spage.on('console', (m) => m.type() === 'error' && schedErrors.push(m.text()));
      await spage.goto(schedUrl);
      await spage.waitForSelector('.msg, .empty');

      const openSchedule = async () => {
        await spage.click('#scheduleBtn');
        await spage.waitForSelector('#schedule:not([hidden])');
        await spage.waitForFunction(() => document.getElementById('scheduleDaemon').textContent !== ''); // дождаться ответа GET /api/schedule, а не оценивать пустое состояние до него
      };

      await scenario('E22 расписание: кнопка из шапки открывает панель поверх ленты, пустое состояние и статус демона', async () => {
        await openSchedule();
        const empty = await spage.locator('.sched-empty').textContent();
        const daemon = await spage.locator('#scheduleDaemon').textContent();
        const badgeHidden = await spage.isHidden('#scheduleBadge');
        return [empty.includes('пока нет') && daemon.includes('не нужен') && badgeHidden, JSON.stringify({ empty, daemon, badgeHidden })];
      });

      await scenario('E23 расписание: пресет «по будням в 09:00» — расшифровка и три ближайших запуска в форме, на диске файл задачи с нужным cron, строка списка показывает cron, адресата и след. запуск, счётчик в шапке — 1', async () => {
        await spage.click('#scheduleNew');
        await spage.waitForSelector('#scheduleForm:not([hidden])');
        await spage.fill('#schedName', 'morning');
        await spage.selectOption('#schedPreset', 'weekdays');
        await spage.fill('#schedWeekdaysTime', '09:00');
        const describe = await spage.locator('#schedDescribe').textContent();
        const upcoming = await spage.locator('#schedUpcoming li').count();
        await spage.selectOption('#schedTo', 'dima');
        await spage.fill('#schedPrompt', 'Проверь задачи');
        await spage.click('#schedSave');
        await spage.waitForSelector('#scheduleForm', { state: 'hidden', timeout: 15000 });
        const file = read(jobFile('morning'));
        const row = spage.locator('.job', { hasText: 'morning' });
        await row.waitFor();
        const about = await row.locator('.job-about').textContent();
        const line = await row.locator('.job-line').first().textContent();
        const badge = await spage.locator('#scheduleBadge').textContent();
        return [describe.includes('по будням') && upcoming === 3 && file.includes('cron: "0 9 * * 1-5"') && file.includes('to: dima') && about.includes('по будням в 09:00') && about.includes('0 9 * * 1-5') && line.includes('→ dima') && line.includes('след.:') && badge === '1', JSON.stringify({ describe, upcoming, file, about, line, badge })];
      });

      await scenario('E24 расписание: кривой «свой cron» показывает текст ошибки разбора и не даёт сохранить', async () => {
        await spage.click('#scheduleNew');
        await spage.waitForSelector('#scheduleForm:not([hidden])');
        await spage.fill('#schedName', 'broken');
        await spage.selectOption('#schedPreset', 'custom');
        await spage.fill('#schedCustomExpr', '99 99 * * *');
        const err = await spage.locator('#schedDescribe').textContent();
        await spage.fill('#schedPrompt', 'что-то');
        await spage.click('#schedSave');
        await wait(300);
        const stillOpen = await spage.isVisible('#scheduleForm');
        const notCreated = !fs.existsSync(jobFile('broken'));
        return [err.includes('вне') && stillOpen && notCreated, err];
      });

      await scenario('E25 расписание: тумблер выключает задачу — enabled: false в файле, повторный клик включает обратно', async () => {
        await spage.click('#schedCancel');
        const row = spage.locator('.job', { hasText: 'morning' });
        await row.locator('.job-toggle').click();
        await spage.waitForFunction(() => document.querySelector('.job-toggle[aria-checked="false"]'));
        const off = read(jobFile('morning'));
        await row.locator('.job-toggle').click();
        await spage.waitForFunction(() => document.querySelector('.job-toggle[aria-checked="true"]'));
        return [off.includes('enabled: false'), off];
      });

      await scenario('E26 расписание: задача, появившаяся на диске руками, прилетает по SSE без перезагрузки страницы', async () => {
        fs.writeFileSync(jobFile('manual'), '---\ncron: "0 10 * * *"\nenabled: true\n---\nручная задача\n');
        await spage.locator('.job', { hasText: 'manual' }).waitFor({ timeout: 10000 });
        return true;
      });

      await scenario('E27 XSS в кривом поле задачи (to: с тегом) показан текстом в ошибке, тег не создан и скрипт не сработал', async () => {
        fs.writeFileSync(jobFile('xss'), '---\ncron: "0 9 * * *"\nto: <img src=x onerror=window.__xss=1>\nenabled: true\n---\nп\n');
        const row = spage.locator('.job', { hasText: 'xss' });
        await row.waitFor({ timeout: 10000 });
        const text = await row.locator('.job-error').textContent();
        const imgCount = await row.locator('img').count();
        const xss = await spage.evaluate(() => window.__xss);
        return [text.includes('<img') && text.includes('не имя агента') && imgCount === 0 && xss === undefined, text];
      });

      await scenario('E28 расписание: удаление задачи с confirm — отказ оставляет файл и строку, согласие убирает файл и строку из списка', async () => {
        const row = spage.locator('.job', { hasText: 'manual' });
        spage.once('dialog', (d) => d.dismiss());
        await row.locator('.ghost', { hasText: 'Удалить' }).click();
        await wait(200);
        const keptAfterDismiss = fs.existsSync(jobFile('manual')) && (await row.count()) === 1;
        spage.once('dialog', (d) => d.accept());
        await row.locator('.ghost', { hasText: 'Удалить' }).click();
        await row.waitFor({ state: 'detached', timeout: 15000 });
        return [keptAfterDismiss && !fs.existsSync(jobFile('manual')), String(keptAfterDismiss)];
      });

      await scenario('E29 расписание: Esc закрывает панель', async () => {
        await spage.keyboard.press('Escape');
        await spage.waitForSelector('#schedule', { state: 'hidden', timeout: 3000 });
        return !(await spage.isVisible('#scheduleBackdrop'));
      });

      await scenario('E30 расписание на 390px: панель без горизонтального скролла страницы', async () => {
        const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const mobile = await mobileCtx.newPage();
        await mobile.goto(schedUrl);
        await mobile.waitForSelector('.msg, .empty');
        await mobile.click('#scheduleBtn');
        await mobile.waitForSelector('#schedule:not([hidden])');
        const wide = await overflow(mobile);
        await mobile.close();
        return [wide <= 0, String(wide)];
      });

      check('E31 расписание: за весь свой прогон страница не написала в консоль ни одной ошибки', schedErrors.length === 0, JSON.stringify(schedErrors));
    } finally {
      if (spage) await spage.close().catch(() => {});
      schedServer.kill();
    }

    await scenario('E43 сервер ответил 500 на /api/state и /api/schedule: причина — в строке статуса словами сервера, состояние страницы цело — смена языка и лента работают', async () => {
      const fail = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'сервер споткнулся' }) });
      const before = errors.length;
      const cards = await page.locator('.msg').count();
      await page.route('**/api/state', fail);
      await page.evaluate(() => load().catch((err) => say(err.message, true)));
      await wait(300);
      const stateNote = await page.locator('#result').textContent();
      const labels = await labelInBothLangs('#sendBtn'); // со сломанным state.types смена языка падала с TypeError до F5
      await page.unroute('**/api/state');
      await page.route('**/api/schedule', fail);
      await page.click('#scheduleBtn');
      await wait(300);
      const scheduleNote = await page.locator('#result').textContent();
      const broken = await page.evaluate(() => Boolean(state.schedule && state.schedule.error)); // { error } не должен лечь на место расписания
      await page.keyboard.press('Escape');
      await page.unroute('**/api/schedule');
      const pageErrors = errors.slice(before).filter((e) => !/Failed to load resource/.test(e)); // сам 500 браузер пишет в консоль — это не ошибка страницы
      errors.length = before;
      return [stateNote === 'сервер споткнулся' && labels === 'Send | Отправить' && scheduleNote.includes('сервер споткнулся') && !broken && (await page.locator('.msg').count()) === cards && !pageErrors.length, JSON.stringify({ stateNote, labels, scheduleNote, broken, pageErrors })];
    });

    await scenario('E44 два запроса состояния внахлёст: поздний ответ старого запроса ленту свежего не затирает', async () => {
      const cards = await page.locator('.msg').count();
      let seen = 0;
      await page.route('**/api/state', async (route) => {
        if (++seen > 1) return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        await wait(800);
        return route.fulfill({ response, json: { ...json, messages: [] } }); // старый снимок: приходит последним и пустой
      });
      await page.evaluate(() => { load(); load(); });
      await wait(1500);
      await page.unroute('**/api/state');
      const after = await page.locator('.msg').count();
      return [cards > 0 && after === cards, JSON.stringify({ cards, after })];
    });

    await scenario('E46 обновление: при available в шапке медная кнопка «Обновить до v…» и ссылка «что нового», после подтверждения — плашка «Обновлено…» с кнопкой «Перезапустить», кнопки обновления нет; сбой перезапуска — красная плашка и кнопка снова жива; при off кнопки нет', async () => {
      const offline = await page.locator('#updateBtn').isVisible();
      const offer = { state: 'available', current: '1.0.0', latest: '1.1.0', notes: 'кнопка обновления', url: 'https://github.com/o/r/releases/tag/v1.1.0' };
      let posted = 0;
      await page.route('**/api/state', async (route) => {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...(await response.json()), update: offer } });
      });
      await page.route('**/api/update', (route) => {
        posted++;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, from: '1.0.0', version: '1.1.0' }) });
      });
      await page.evaluate(() => load());
      await page.locator('#updateBtn').waitFor();
      const label = (await page.locator('#updateBtn').textContent()).trim();
      const title = await page.locator('#updateBtn').getAttribute('title');
      const news = await page.locator('#updateNews').getAttribute('href');
      page.once('dialog', (d) => d.dismiss());
      await page.click('#updateBtn');
      await wait(200);
      const afterDismiss = posted;
      page.once('dialog', (d) => d.accept());
      await page.click('#updateBtn');
      await page.locator('#updateNote').waitFor();
      const note = await page.locator('#updateNote').textContent();
      const hidden = !(await page.locator('#updateBtn').isVisible());
      const restartLabel = (await page.locator('#restartBtn').textContent()).trim();
      let restarts = 0;
      await page.route('**/api/restart', (route) => {
        restarts++;
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'идёт сводка' }) });
      });
      await page.click('#restartBtn');
      await page.locator('#updateNote.bad').waitFor();
      const failNote = await page.locator('#updateNote').textContent();
      const restartAgain = await page.locator('#restartBtn').isEnabled();
      await page.unroute('**/api/restart');
      await page.unroute('**/api/state');
      await page.unroute('**/api/update');
      await page.evaluate(() => load());
      await wait(300);
      const offAgain = !(await page.locator('#updateBtn').isVisible()) && !(await page.locator('#updateNote').isVisible());
      return [!offline && label === 'Обновить до v1.1.0' && title.includes('v1.0.0 → v1.1.0') && title.includes('кнопка обновления') && news === offer.url && afterDismiss === 0 && posted === 1
        && note.includes('Обновлено до v1.1.0') && restartLabel === 'Перезапустить' && hidden && restarts === 1 && failNote.includes('Не перезапустилось: идёт сводка') && failNote.includes('bus.js ui') && restartAgain && offAgain,
        JSON.stringify({ offline, label, title, news, afterDismiss, posted, note, restartLabel, hidden, restarts, failNote, restartAgain, offAgain })];
    });

    await scenario('E53 поле сообщения растёт с текстом: пустое — одна строка, 6 строк — выше, 60 строк — упирается в потолок и прокручивается, очистили — снова низкое', async () => {
      const box = () => page.evaluate(() => { const t = document.getElementById('text'); return { h: t.getBoundingClientRect().height, scroll: t.scrollHeight > t.clientHeight }; });
      await page.fill('#text', '');
      const empty = await box();
      await page.fill('#text', Array.from({ length: 6 }, (_, i) => 'строка ' + i).join(String.fromCharCode(10)));
      const six = await box();
      await page.fill('#text', Array.from({ length: 60 }, (_, i) => 'строка ' + i).join(String.fromCharCode(10)));
      const many = await box();
      await page.fill('#text', '');
      const cleared = await box();
      return [empty.h < 50 && six.h > empty.h + 60 && many.h > six.h && many.h <= 362 && many.scroll && !six.scroll && Math.abs(cleared.h - empty.h) < 2, JSON.stringify({ empty, six, many, cleared })];
    });

    await scenario('E45 «Кому» не пересобирается на каждое событие agents: опция с фокусом в раскрытом списке остаётся на месте, сменился состав — список новый', async () => {
      await page.evaluate(() => { window.__toOption = document.querySelector('#to option'); });
      bus(shop, ['--as', 'dima', 'send', 'masha', 'done', 'счётчик непрочитанного у masha'], quiet);
      await page.locator('.msg', { hasText: 'счётчик непрочитанного у masha' }).waitFor();
      await wait(1200); // снимок агентов приходит следом за сообщением
      const kept = await page.evaluate(() => window.__toOption.isConnected);
      defFile(path.join(shop, '.claude'), 'novice');
      bus(shop, ['add', 'novice']);
      await page.locator('#to option', { hasText: 'novice' }).waitFor({ state: 'attached', timeout: 10000 });
      return [kept, JSON.stringify({ kept })];
    });

    await scenario('E19 журнал удалили при открытой вкладке: сервер шлёт reset, сообщения уходят из ленты без перезагрузки страницы', async () => {
      const before = await page.locator('.msg .text', { hasText: 'привет из браузера' }).count();
      fs.rmSync(journal, { force: true });
      fs.rmSync(`${journal}.1`, { force: true });
      await page.locator('.msg .text', { hasText: 'привет из браузера' }).waitFor({ state: 'detached', timeout: 10000 });
      return [before === 1 && (await page.locator('.msg .text', { hasText: 'после сводки' }).count()) === 0, String(before)];
    });

    await scenario('E20 язык: новая вкладка — английская, кнопка переключает на русский без перезагрузки, черновик цел, выбор переживает F5, ошибка сервера — на языке вкладки', async () => {
      const en = await (await rawContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const pageErrors = [];
      en.on('pageerror', (e) => pageErrors.push(e.message));
      await en.goto(url);
      await en.waitForSelector('.msg');
      // Кириллица в обвязке страницы: шапка, фильтры, список агентов (кроме имён и описаний), форма, панели. Тексты сообщений и сама кнопка языка — не обвязка
      const chrome = () => en.evaluate(() => {
        const skip = '#lang, .msg .text, .summary p, .agent .name, #cwd, #project, textarea, select#to, .job-name, .job-line, .job-error'; // имя, адресат и ошибка задачи — данные, а не подписи
        const texts = [...document.querySelectorAll('header.top, .filters, #agents, #composer, #schedule, #agentPanel, #settings, .msg .meta, .day')].map((root) => {
          const copy = root.cloneNode(true);
          for (const node of copy.querySelectorAll(skip)) node.remove();
          return copy.textContent;
        });
        const attrs = [...document.querySelectorAll('[title], [placeholder], [aria-label]')].filter((node) => !node.closest('#lang, .agent')).flatMap((node) => ['title', 'placeholder', 'aria-label'].map((a) => node.getAttribute(a) || ''));
        return [...texts, ...attrs].join(' ~ ').replace(/## Шина/g, '');
      });
      const cyrillic = (text) => text.split(' ~ ').filter((line) => /[А-Яа-яЁё]/.test(line)).flatMap((line) => line.match(/[А-Яа-яЁё][^~]{0,60}/g)).map((hit) => hit.replace(/s+/g, ' '));
      const startEn = await en.evaluate(() => [document.documentElement.lang, document.getElementById('sendBtn').textContent.trim(), document.getElementById('lang').textContent, document.getElementById('text').placeholder, document.title].join(' | '));
      const leftEn = cyrillic(await chrome());
      const serverEn = await en.evaluate(() => post('/api/send', { to: 'nobody', type: 'TASK', text: 'x' }).catch((e) => e.message));

      await en.click('#scheduleBtn');
      await en.click('#scheduleNew');
      const describeEn = await en.locator('#schedDescribe').textContent();
      const presetEn = await en.evaluate(() => { const s = document.getElementById('schedPreset'); const face = s.querySelector('selectedcontent'); return `${s.selectedOptions[0].textContent}|${face ? face.textContent : s.selectedOptions[0].textContent}`; });
      const panelEn = cyrillic(await chrome());
      await en.click('#schedCancel');
      await en.click('#scheduleClose');

      await en.fill('#text', 'черновик не теряется');
      await en.click('#lang');
      const ru = await en.evaluate(() => [document.documentElement.lang, document.getElementById('sendBtn').textContent.trim(), document.getElementById('lang').textContent, document.getElementById('text').value, localStorage.getItem('bus-lang'), document.getElementById('type').selectedOptions[0].textContent].join(' | '));
      const serverRu = await en.evaluate(() => post('/api/send', { to: 'nobody', type: 'TASK', text: 'x' }).catch((e) => e.message));
      await en.click('#scheduleBtn');
      await en.click('#scheduleNew');
      const presetRu = await en.evaluate(() => { const s = document.getElementById('schedPreset'); const face = s.querySelector('selectedcontent'); return `${s.selectedOptions[0].textContent}|${face ? face.textContent : s.selectedOptions[0].textContent}|${document.getElementById('schedWeeklyDay').options[0].textContent}`; });
      await en.click('#schedCancel');
      await en.click('#scheduleClose');
      await en.reload();
      await en.waitForSelector('.msg');
      const ruAfterReload = await en.locator('#sendBtn').textContent();
      await en.click('#lang');
      await en.reload();
      await en.waitForSelector('.msg');
      const enAfterReload = await en.locator('#sendBtn').textContent();
      await en.close();
      const ok = startEn === `en | Send | RU | ${'What to do, where (file:line), why — the agent reads this without your context'} | Bus` && !leftEn.length && !panelEn.length && serverEn === 'No such agent on the bus.'
        && describeEn === 'every day at 09:00' && presetEn === 'every day at …|every day at …'
        && ru.startsWith('ru | Отправить | EN | черновик не теряется | ru | ') && ru.includes('просьба сделать') && serverRu === 'Такого агента в шине нет.' && presetRu === 'каждый день в …|каждый день в …|понедельник'
        && ruAfterReload.trim() === 'Отправить' && enAfterReload.trim() === 'Send' && !pageErrors.length;
      return [ok, JSON.stringify({ startEn, leftEn, panelEn, serverEn, describeEn, presetEn, ru, serverRu, presetRu, ruAfterReload, enAfterReload, pageErrors })];
    });

    await scenario('E47 видеофон: сервер отдаёт только ролики из assets/bg и режет их по Range; в ⚙ плитки «Без видео» + ролики, выбор ставит видео сразу и переживает F5, «Без видео» возвращает пятна', async () => {
      const bg = await (await rawContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const pageErrors = [];
      bg.on('pageerror', (e) => pageErrors.push(e.message));
      await bg.goto(url);
      await bg.waitForSelector('.msg');
      const server = await bg.evaluate(async () => {
        const status = async (path, headers) => { const r = await fetch(path, { headers }); return `${r.status} ${r.headers.get('content-range') || ''}`.trim(); };
        return {
          list: (await (await fetch('/api/bg')).json()).items.join(','),
          range: await status('/bg/2.mp4', { Range: 'bytes=0-99' }),
          past: await status('/bg/2.mp4', { Range: 'bytes=999999999-' }),
          foreign: [await status('/bg/10.mp4'), await status('/bg/..%2F2.mp4'), await status('/bg/2.mp4.bak')].join(','),
        };
      });
      // Chromium из Playwright может не уметь H.264: тогда ролик не грузится, и страница обязана тихо вернуться к пятнам
      const h264 = await bg.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '');
      await bg.click('#settingsBtn');
      await bg.waitForSelector('.bg-opt input[value="2"]');
      const tiles = await bg.evaluate(() => [...document.querySelectorAll('#bgGrid input')].map((i) => i.value + (i.checked ? '*' : '')).join(','));
      await bg.click('.bg-opt:has(input[value="2"])');
      const videoOn = () => bg.evaluate(() => ({ has: document.documentElement.classList.contains('has-video'), on: [...document.querySelectorAll('#bgVideo video.on')].map((v) => v.getAttribute('src')).join(',') }));
      const settle = async (want) => { for (let i = 0; i < 40 && (await videoOn()).has !== want; i++) await wait(100); await wait(1000); return videoOn(); };
      const picked = await settle(h264);
      const saved = await bg.evaluate(() => localStorage.getItem('bus-bg'));
      await bg.reload();
      await bg.waitForSelector('.msg');
      const reloaded = await settle(h264);
      await bg.click('#settingsBtn');
      await bg.waitForSelector('.bg-opt input[value="0"]');
      const checkedAfterReload = await bg.evaluate(() => document.querySelector('#bgGrid input:checked').value);
      await bg.click('.bg-opt:has(input[value="0"])');
      const off = await settle(false);
      const offSaved = await bg.evaluate(() => localStorage.getItem('bus-bg'));
      await bg.close();
      const want = h264 ? { has: true, on: '/bg/2.mp4' } : { has: false, on: '' };
      const ok = server.list === '2,3,5,6,7,9' && server.range === '206 bytes 0-99/816705' && server.past === '416 bytes */816705' && server.foreign === '404,404,404'
        && tiles === '0,2,3,5,6,7*,9' && saved === (h264 ? '2' : '0') && JSON.stringify(picked) === JSON.stringify(want) && JSON.stringify(reloaded) === JSON.stringify(want)
        && checkedAfterReload === (h264 ? '2' : '0') && JSON.stringify(off) === JSON.stringify({ has: false, on: '' }) && offSaved === '0' && !pageErrors.length;
      return [ok, JSON.stringify({ server, h264, tiles, picked, saved, reloaded, checkedAfterReload, off, offSaved, pageErrors })];
    });

    await scenario('E47a затемнение: ползунок в ⚙ виден только с видеофоном, двигает плотность стекла сразу, переживает F5; по умолчанию 40 %, «↺ по умолчанию» возвращает его и чистит localStorage', async () => {
      const bg = await (await rawContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const pageErrors = [];
      bg.on('pageerror', (e) => pageErrors.push(e.message));
      await bg.goto(url);
      await bg.waitForSelector('.msg');
      await wait(1500); // ролик по умолчанию успел загрузиться или откатиться к пятнам
      await bg.click('#settingsBtn');
      await bg.waitForSelector('.bg-opt');
      const state = () => bg.evaluate(() => ({
        video: document.documentElement.classList.contains('has-video'),
        shown: !document.querySelector('#bgDimWrap').hidden,
        dim: getComputedStyle(document.documentElement).getPropertyValue('--dim').trim(),
        out: document.querySelector('#bgDimValue').textContent,
        reset: !document.querySelector('#bgDimReset').hidden,
        saved: localStorage.getItem('bus-dim'),
        alpha: getComputedStyle(document.querySelector('.top')).backgroundColor.match(/\/ ([\d.]+)\)$/)?.[1] || '',
      }));
      const before = await state();
      await bg.evaluate(() => { const i = document.querySelector('#bgDim'); i.value = 60; i.dispatchEvent(new Event('input')); });
      const moved = await state();
      await bg.reload();
      await bg.waitForSelector('.msg');
      await wait(1500);
      const reloaded = await state();
      await bg.click('#settingsBtn');
      if (reloaded.shown) await bg.click('#bgDimReset');
      else await bg.evaluate(() => document.querySelector('#bgDimReset').click());
      const reset = await state();
      await bg.close();
      const ok = before.shown === before.video && before.dim.startsWith('0.615') && before.out === '40 %' && (!before.video || before.alpha === '0.4') && !before.reset && before.saved === null
        && moved.dim.startsWith('0.923') && moved.out === '60 %' && moved.reset && moved.saved === '60' && (!moved.video || moved.alpha === '0.6')
        && reloaded.dim === moved.dim && reloaded.out === '60 %' && reset.dim.startsWith('0.615') && !reset.reset && reset.saved === null && !pageErrors.length;
      return [ok, JSON.stringify({ before, moved, reloaded, reset, pageErrors })];
    });

    await scenario('E49 рабочий каталог: клик по пути в шапке — панель; звезда закрепляет; клик по проекту шины переключает шапку; «Обзор» — вверх и в подпапку, «Выбрать эту папку»; × открепляет; Esc закрывает; на 390px без горизонтального скролла', async () => {
      const head = () => page.locator('#project').textContent();
      await page.click('#whereBtn');
      await page.locator('#dirsPanel').waitFor();
      await page.locator('#dirsList .dir-row').first().waitFor();
      const current = await page.locator('#dirsCurrent').textContent();
      await page.click('#dirsPin');
      await page.locator('#dirsPin[aria-pressed="true"]').waitFor();
      const pinnedLabel = await page.locator('#dirsList .sched-group').first().locator('.label').textContent();
      const size = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      await page.setViewportSize(size);
      await page.locator('.dir-row', { hasText: landing }).first().click();
      await page.locator('#dirsPanel').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('#project').textContent.startsWith('landing'));
      const afterSwitch = await head();
      await page.click('#whereBtn');
      await page.click('#dirsBrowse');
      await page.locator('.dirs-browse-head').waitFor();
      await page.locator('.dirs-browse-head button', { hasText: 'Вверх' }).click();
      await page.locator('#dirsList .dir-row', { hasText: /^shopshop$/ }).waitFor();
      await page.locator('#dirsList .dir-row', { hasText: /^shopshop$/ }).click();
      await page.waitForFunction((dir) => document.querySelector('.dirs-browse-head span').title === dir, shop);
      await page.locator('.dirs-browse-head button', { hasText: 'Выбрать эту папку' }).click();
      await page.locator('#dirsPanel').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('#project').textContent.startsWith('shop'));
      await page.click('#whereBtn');
      await page.locator('.dir-line .iconbtn').first().click();
      await page.locator('#dirsPin[aria-pressed="false"]').waitFor();
      const pinnedLeft = await page.locator('.dir-line').count();
      await page.keyboard.press('Escape');
      await page.locator('#dirsPanel').waitFor({ state: 'hidden' });
      const saved = JSON.parse(read(path.join(configDir, 'bus', 'ui-dirs.json')) || '{}');
      return [current.includes(shop) && pinnedLabel === 'Закреплённые' && !overflow && afterSwitch.startsWith('landing') && pinnedLeft === 0 && saved.last === shop && saved.recent.includes(landing) && saved.pinned.length === 0,
        JSON.stringify({ current, pinnedLabel, overflow, afterSwitch, pinnedLeft, saved })];
    });

    await scenario('E50 «@» в поле сообщения: над полем файлы проекта; клик по папке — внутрь, → — глубже, ← — вверх; печать — поиск; Enter вставляет путь и не отправляет; ничего не нашлось — Enter закрывает список и не отправляет; Esc закрывает, и это слово больше не предлагает, стёр @ и набрал снова — открыт; кнопка-папка у скрепки — то же, что @; на 390px без горизонтального скролла', async () => {
      for (const file of ['src/api/users.js', 'src/main.js', 'README.md']) {
        fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true });
        fs.writeFileSync(path.join(shop, file), '');
      }
      const text = () => page.locator('#text').inputValue();
      const rows = () => page.locator('#mentionList .mention-row b').allTextContents();
      const rowsAre = (list) => page.waitForFunction((want) => [...document.querySelectorAll('#mentionList .mention-row b')].map((b) => b.textContent).join() === want, list.join());
      const sentBefore = (await page.locator('#feed > li').count());
      await page.fill('#text', '');
      await page.locator('#text').pressSequentially('глянь @');
      await page.locator('#mention').waitFor();
      const root = await rows();
      await page.locator('#mentionList .mention-row', { hasText: /^src\/$/ }).click();
      await rowsAre(['api/', 'main.js']);
      const inSrc = await text();
      await page.keyboard.press('ArrowRight');
      await rowsAre(['users.js']);
      const inApi = await text();
      await page.keyboard.press('ArrowLeft');
      await rowsAre(['api/', 'main.js']);
      const size = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      await page.setViewportSize(size);
      await page.keyboard.type('mai');
      await page.waitForFunction(() => (document.querySelector('#mentionList .mention-row') || {}).title === 'src/main.js');
      await page.keyboard.press('Enter');
      await page.locator('#mention').waitFor({ state: 'hidden' });
      const inserted = await text();
      await page.keyboard.type('@usr');
      await page.locator('#mention').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#mention').waitFor({ state: 'hidden' });
      await page.keyboard.type('s');
      await page.waitForTimeout(300);
      const reopened = await page.locator('#mention').isVisible();
      for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace'); // «@usrs» стёрто целиком — на том же месте новое @
      await page.keyboard.type('@');
      const again = await page.locator('#mention').waitFor().then(() => true, () => false);
      await page.keyboard.type('zzqqj');
      await page.locator('#mentionList .mention-note').waitFor();
      await page.keyboard.press('Enter');
      await page.locator('#mention').waitFor({ state: 'hidden' });
      const afterEmptyEnter = await text();
      // Папка у скрепки — то же, что @: дописывает « @» в конец и открывает список, второй клик закрывает; фокус остаётся в поле
      await page.keyboard.type(' '); // курсор на слове @… кнопка открыла бы его, а не новое
      await page.click('#filesBtn');
      await page.locator('#mention').waitFor();
      const byButton = await text();
      const byButtonFocus = await page.evaluate(() => document.activeElement.id);
      await page.click('#filesBtn');
      await page.locator('#mention').waitFor({ state: 'hidden' });
      const sentAfter = await page.locator('#feed > li').count();
      await page.fill('#text', '');
      return [root.includes('src/') && root.indexOf('src/') < root.findIndex((r) => !r.endsWith('/')) && inSrc === 'глянь @src/' && inApi === 'глянь @src/api/' && !overflow
        && /^глянь @(\S*[\\/])?src[\\/]main\.js $/.test(inserted) && !reopened && again && afterEmptyEnter.endsWith(' @zzqqj') && byButton === `${afterEmptyEnter} @` && byButtonFocus === 'text' && sentAfter === sentBefore,
        JSON.stringify({ root, inSrc, inApi, overflow, inserted, reopened, again, afterEmptyEnter, byButton, byButtonFocus, sentBefore, sentAfter })];
    });

    await scenario('E51 окно приложения: страница с ?app=1 шлёт свой размер и место в app-window.json каталога шины, обычная вкладка — нет', async () => {
      const windowFile = path.join(configDir, 'bus', 'app-window.json');
      fs.rmSync(windowFile, { force: true });
      await page.waitForTimeout(2500); // вкладка без ?app=1 открыта всё это время
      const byTab = fs.existsSync(windowFile);
      const win = await (await rawContext({ viewport: { width: 1180, height: 760 } })).newPage();
      await win.goto(`${url}/?app=1`);
      await win.waitForSelector('.msg');
      const geometry = await win.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight }));
      const saved = await (async () => {
        for (let i = 0; i < 40; i++) {
          if (fs.existsSync(windowFile)) return JSON.parse(fs.readFileSync(windowFile, 'utf8'));
          await win.waitForTimeout(100);
        }
        return null;
      })();
      await win.context().close();
      return [!byTab && saved && JSON.stringify(saved) === JSON.stringify(geometry), JSON.stringify({ byTab, geometry, saved })];
    });

    await scenario('E16 сервер погас: над лентой встаёт красная полоса с тем, как поднять его заново', async () => {
      server.kill();
      await page.locator('#link.down').waitFor({ timeout: 15000 });
      return [(await page.locator('#link').textContent()).includes('bus.js ui'), ''];
    });

    check('E17 за весь прогон страница не написала в консоль ни одной ошибки, кроме обрыва связи с погашенным сервером', errors.every((e) => /ERR_CONNECTION|Failed to load resource|EventSource/i.test(e)), JSON.stringify(errors));
  } finally {
    await browser.close();
    server.kill();
    await wait(300);
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})()
  .catch((e) => check('bus ui browser: прогон не упал с исключением', false, e.stack))
  .then(() => {
    console.log(`\n${failed ? 'ПРОВАЛЕНО: ' + failed : 'Все тесты прошли'}`);
    process.exit(failed ? 1 : 0);
  });
