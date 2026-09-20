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
fs.writeFileSync(fakeClaude, `let s = '';
process.stdin.on('data', (c) => (s += c)).on('end', () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--agent')) require('child_process').spawnSync(process.execPath, [${JSON.stringify(BUS_JS)}, '--as', argv[argv.indexOf('--agent') + 1], 'inbox', '--quiet'], { cwd: process.cwd(), env: process.env });
  // Правка роли в панели агента: ИИ отвечает JSON-ом с описанием и телом
  const rewrite = JSON.stringify({ description: 'описание от ИИ', body: '# Роль\\n\\nПереписано ИИ.' });
  console.log(JSON.stringify({ type: 'result', is_error: false, result: argv.includes('--agent') ? 'ответил' : s.includes('Просьба пользователя:') ? rewrite : 'сводка от подставного claude', usage: { input_tokens: 1200, output_tokens: 300 } }));
});
`);

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir, BUS_CLAUDE_CMD: `"${process.execPath}" "${fakeClaude}"`, TG_NOTIFY_DRY_RUN: '1', BUS_PM2_CMD: 'rem', BUS_STARTUP_DIR: path.join(home, 'startup'), BUS_SCHEDULER_START_WAIT_MS: '0' }; // расписание: ни настоящего pm2, ни автозагрузки Windows
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

    const agentButton = (name) => page.locator(`.agent[data-key="${name}"], .agent[data-key^="${name}@"]`);
    const texts = () => page.locator('.msg .text').allTextContents();
    const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await scenario('E1 страница: грузится без ошибок в консоли, все агенты машины в списке (и «не в шине»), лента с перепиской, цвета проводов у агентов разные', async () => {
      const names = await page.locator('.agent .name').allTextContents();
      const hues = await page.locator('.agent').evaluateAll((list) => list.map((n) => n.style.getPropertyValue('--h')));
      const off = await page.locator('.agent.off .name').allTextContents();
      return [errors.length === 0 && ['shop', 'dima', 'masha', 'loner', 'qa', 'landing'].every((n) => names.includes(n)) && !names.includes('vlad') && new Set(hues).size === hues.length && off.join() === 'loner' && (await page.locator('.msg').count()) >= 10 && (await overflow(page)) <= 0, JSON.stringify({ errors, names, hues })];
    });

    await scenario('E1b порядок загрузки: сначала подписка на события, потом состояние — иначе сообщение, разосланное в этот зазор, до вкладки не доходит', async () => {
      const [events, state] = [calls.indexOf('/api/events'), calls.indexOf('/api/state')];
      return [events >= 0 && state > events, calls.join(' ')];
    });

    await scenario('E2 XSS: текст сообщения с <img onerror> показан текстом, тег не создан и скрипт не сработал', async () => {
      const list = await texts();
      return [list.includes(XSS) && (await page.locator('.msg .text img, .msg .text b').count()) === 0 && (await page.evaluate(() => window.__xss)) === undefined, JSON.stringify(list.slice(0, 3))];
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
      const pairByDbl = await page.locator('#pairNames').textContent();
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

    await scenario('E7 «Сжать диалог»: без пары — подсказка, как её выбрать; с парой — сводка от claude встаёт карточкой, исходные сворачиваются', async () => {
      await page.click('#squeeze');
      const hint = await page.locator('#pairNote').textContent();
      await agentButton('masha').click();
      await agentButton('dima').dblclick();
      const before = await page.locator('.msg').count();
      await page.click('#squeeze');
      await page.waitForSelector('.summary', { timeout: 20000 });
      const note = await page.locator('#pairNote').textContent();
      const after = await page.locator('.msg').count();
      await page.click('#unpick');
      return [hint.includes('Выбери пару') && before === 9 && after === 0 && note.includes('Сжато сообщений: 9') && (await page.locator('.summary p').first().textContent()) !== '', JSON.stringify({ hint: hint.slice(0, 30), before, after, note })];
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
        && !(await page.evaluate(() => document.getElementById('text').classList.contains('listening'))) && typed === 'a  b' && cancelled === 'черновик' && !(await page.isHidden('#voiceHint'));
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
      const result = await page.locator('#result').textContent();
      return [bar === 'Выделено: 1' && hiddenAfterSecond && hiddenAfterEsc && keptAfterDismiss && !read(journal).includes('удали из браузера') && read(journal).includes('привет из браузера') && result.includes('Удалено сообщений: 1') && (await page.locator('#marked').isHidden()), JSON.stringify({ bar, hiddenAfterSecond, hiddenAfterEsc, keptAfterDismiss, result })];
    });

    await scenario('E21 очистка диалога: без пары кнопка зовётся «Очистить всё», с парой — «Очистить диалог» и после confirm убирает только переписку этих двоих', async () => {
      const labelAll = await page.locator('#clear').textContent();
      bus(shop, ['send', 'masha', 'done', 'диалог на снос']);
      const target = page.locator('.msg', { hasText: 'диалог на снос' });
      await target.waitFor();
      await target.locator('.arrow').click();
      const labelPair = await page.locator('#clear').textContent();
      page.once('dialog', (d) => d.accept());
      await page.click('#clear');
      await target.waitFor({ state: 'detached', timeout: 10000 });
      await unpick();
      const others = await page.locator('.msg .text', { hasText: 'привет из браузера' }).count();
      return [labelAll.trim() === 'Очистить всё' && labelPair.trim() === 'Очистить диалог' && !read(journal).includes('диалог на снос') && !read(journal).includes('сделай из браузера') && others === 1, JSON.stringify({ labelAll, labelPair, others })];
    });

    await scenario('E32 очистка с одним агентом: кнопка зовётся «Очистить диалог» и после confirm убирает только диалог оркестратора с ним — переписка агента с другими и весь журнал целы', async () => {
      bus(shop, ['send', 'masha', 'done', 'мой диалог с машей'], quiet);
      bus(shop, ['--as', 'masha', 'send', 'dima', 'done', 'маша диме — не трогать'], quiet);
      const mine = page.locator('.msg .text', { hasText: 'мой диалог с машей' });
      await mine.waitFor();
      await page.locator('.agent', { hasText: 'masha' }).first().click();
      const label = (await page.locator('#clear').textContent()).trim();
      page.once('dialog', (d) => d.accept());
      await page.click('#clear');
      await mine.waitFor({ state: 'detached', timeout: 10000 });
      await page.locator('.agent', { hasText: 'masha' }).first().click(); // повторный клик снимает выбор
      const kept = await page.locator('.msg .text', { hasText: 'маша диме — не трогать' }).count();
      return [label === 'Очистить диалог' && kept === 1 && !read(journal).includes('мой диалог с машей') && read(journal).includes('маша диме — не трогать'), JSON.stringify({ label, kept })];
    });

    const roleFile = (name) => path.join(shop, '.claude', 'agents', `${name}.md`);
    await scenario('E33 новый агент: кнопка в «Эта директория» открывает панель, кривое имя — ошибка в форме, «Создать» пишет роль с блоком «Шина», агент встаёт в список и в «Кому»', async () => {
      await page.click('#agentNew');
      await page.locator('#agentPanel').waitFor();
      const title = await page.locator('#agentTitle').textContent();
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
      return [title === 'Новый агент' && nameError.includes('латиница') && text.includes('name: tester') && text.includes('model: sonnet') && text.includes('## Шина') && text.includes('--as tester') && to === `tester@${shop}`, JSON.stringify({ title, nameError, to, text: text.slice(0, 120) })];
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

    await scenario('E35 «Переписать с ИИ»: ответ ложится в форму, а не на диск; «Показать, как было» и обратно переключают текст, «Вернуть как было» отменяет правку; пустая просьба — подсказка', async () => {
      await page.locator('.agent-row', { hasText: 'tester' }).locator('.agent-edit').click();
      await page.locator('#agentPanel').waitFor();
      await page.click('#agentRewrite');
      const emptyNote = await page.locator('#agentAiNote').textContent();
      const onDisk = read(roleFile('tester'));
      await page.fill('#agentAsk', 'добавь правило про отчёты');
      await page.click('#agentRewrite');
      await page.locator('#agentAiUndo').waitFor({ timeout: 15000 });
      const after = await page.locator('#agentBody').inputValue();
      const about = await page.locator('#agentAbout').inputValue();
      const note = await page.locator('#agentAiNote').textContent();
      await page.click('#agentAiSwap');
      const old = await page.locator('#agentBody').inputValue();
      await page.click('#agentAiSwap');
      const again = await page.locator('#agentBody').inputValue();
      await page.click('#agentAiUndo');
      const undone = await page.locator('#agentBody').inputValue();
      const undoHidden = await page.locator('#agentAiUndo').isHidden();
      await page.click('#agentCancel');
      return [emptyNote.includes('Напиши') && after === '# Роль\n\nПереписано ИИ.' && about === 'описание от ИИ' && note.includes('ИИ переписал') && old.includes('Проверяет и отчитывается.') && again === after && undone === old && undoHidden && read(roleFile('tester')) === onDisk, JSON.stringify({ emptyNote, after, about, note })];
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

    // ---------- расписание: свой сервер с заглушками pm2 и автозагрузки, шобы не тронуть настоящую систему ----------
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
        const texts = [...document.querySelectorAll('header.top, .filters, #agents, #composer, #schedule, #agentPanel, .msg .meta, .day')].map((root) => {
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
