/**
 * Словарь интерфейса шины (skills/bus/scripts/ui-i18n.js) против кода. Ключ перевода — русская строка, поэтому правка русского текста
 * молча отрывает перевод: тест собирает все tr('…') / N('…') из ui.html, ui-logic.js, cron.js, ui.js, settings.js, update.js и русские тексты статичной
 * разметки и сверяет со словарём EN. Зовёт run-tests.js; сам по себе — node test/bus-i18n-tests.js [--missing].
 */

const fs = require('fs');
const path = require('path');

const CYRILLIC = /[А-Яа-яЁё]/;
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** → { keys: Map ключ → где встретился, templates: [где tr(`…`) — такие ключи тест не видит] } */
function collectKeys(SCRIPTS) {
  const keys = new Map();
  const templates = [];
  const add = (key, where) => keys.has(key) || keys.set(key, where);
  for (const name of ['ui.html', 'ui-logic.js', 'cron.js', 'ui.js', 'settings.js', 'update.js']) {
    const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    for (const m of text.matchAll(/(?<![\w.$])(?:tr|N)\(\s*'((?:[^'\\\n]|\\.)*)'/g)) add(m[1].replace(/\\(.)/g, '$1'), name);
    for (const m of text.matchAll(/(?<![\w.$])(?:tr|N)\(\s*[`"]/g)) templates.push(`${name}: ${text.slice(m.index, m.index + 60)}`);
    if (name !== 'ui.html') continue;
    // Статичная разметка: те же узлы и атрибуты, что собирает страница на старте (staticTexts, staticAttrs)
    const body = text.slice(text.indexOf('<body>'), text.indexOf('<script src=')).replace(/<!--[\s\S]*?-->/g, '');
    for (const m of body.matchAll(/>([^<>]*)</g)) if (CYRILLIC.test(m[1])) add(m[1].trim(), 'ui.html, разметка');
    for (const m of body.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)) if (CYRILLIC.test(m[1])) add(m[1], 'ui.html, атрибут');
  }
  return { keys, templates };
}

module.exports = async function busI18nTests({ check, HOOKS }) {
  const SCRIPTS = path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts');
  const I = require(path.join(SCRIPTS, 'ui-i18n.js'));
  const L = require(path.join(SCRIPTS, 'ui-logic.js'));
  const cron = require(path.join(SCRIPTS, 'cron.js'));
  const { keys, templates } = collectKeys(SCRIPTS);

  const missing = [...keys].filter(([key]) => I.EN[key] === undefined).map(([key, where]) => `${where}: ${key}`);
  check('bus i18n: у каждой строки интерфейса есть английский перевод', !missing.length, `без перевода (${missing.length}):\n        ${missing.join('\n        ')}`);
  const dead = Object.keys(I.EN).filter((key) => !keys.has(key));
  check('bus i18n: в словаре нет ключей, которых нет в коде', !dead.length, dead.join('\n        '));
  check('bus i18n: ключ tr/N — строка в одинарных кавычках, иначе тест его не видит', !templates.length, templates.join('\n        '));
  const skewed = Object.keys(I.EN).filter((key) => placeholders(key) !== placeholders(I.EN[key]));
  check('bus i18n: плейсхолдеры {x} в переводе те же, что в исходной строке', !skewed.length, skewed.join('\n        '));
  const russian = Object.keys(I.EN).filter((key) => CYRILLIC.test(I.EN[key].replace(/## Шина/g, ''))); // «## Шина» — буквальный заголовок блока в файле роли
  check('bus i18n: в английских строках нет кириллицы', !russian.length, russian.join('\n        '));
  const edges = Object.keys(I.EN).filter((key) => /^\s/.test(key) !== /^\s/.test(I.EN[key]) || /\s$/.test(key) !== /\s$/.test(I.EN[key]));
  check('bus i18n: пробелы по краям строки в переводе сохранены — строки склеиваются', !edges.length, edges.join('\n        '));

  // Язык по умолчанию в node — русский: демон, CLI и остальные тесты английского видеть не должны
  check('bus i18n: без setLang tr отдаёт русский', I.lang() === 'ru' && I.tr('Отправлено.') === 'Отправлено.');
  check('bus i18n: pick — только известные языки, остальное русский', I.pick('en') === 'en' && I.pick('de') === 'ru' && I.pick(undefined) === 'ru');
  try {
    I.setLang('en');
    check('bus i18n: параметры подставляются в перевод', I.tr('«{name}» уже идёт.', { name: 'nightly' }).includes('nightly') && !CYRILLIC.test(I.tr('«{name}» уже идёт.', { name: 'nightly' })));
    check('bus i18n: строка без перевода возвращается как есть', I.tr('такой строки в словаре нет') === 'такой строки в словаре нет');
    const sent = L.sentNote({ to: 'dima', from: 'shop', kind: 'local', needsWake: true, auto: 'started' }, 'TASK');
    check('bus i18n: подписи ui-logic.js на английском', !CYRILLIC.test(sent) && sent.includes('dima'), sent);
    const status = L.agentStatus({ registered: true, alive: true, kind: 'local', unread: 2 }, 5000);
    check('bus i18n: статус агента на английском', !CYRILLIC.test(JSON.stringify(status)), JSON.stringify(status));
    const blocked = L.blockedNote({ name: 'qa', registered: false, blocked: 'это оркестратор каталога.' });
    check('bus i18n: причина блокировки из снимка сервера переводится на странице', !CYRILLIC.test(blocked), blocked);
    const described = ['0 9 * * 1-5', '*/15 * * * *', '0 */2 * * *', '30 8 1,15 * *', '0 9 * 3-6 0,6', '5 5 * * 2,4', '* * * * *', '7 3,4,5,6,7 * * *', 'x', '99 * * * *'].map((expr) => cron.describe(expr));
    check('bus i18n: cron.describe на английском', described.every((text) => text && !CYRILLIC.test(text)), described.join(' | '));
    check('bus i18n: cron.describe — будни', cron.describe('0 9 * * 1-5') === 'on weekdays at 09:00', cron.describe('0 9 * * 1-5'));
    I.provide(() => 'ru');
    check('bus i18n: provide — язык запроса сильнее языка процесса', I.tr('Отправлено.') === 'Отправлено.');
  } finally {
    I.provide(null);
    I.setLang('ru');
  }
  check('bus i18n: после тестов язык снова русский', cron.describe('0 9 * * 1-5') === 'по будням в 09:00');
};

if (require.main === module) {
  const HOOKS = __dirname;
  if (process.argv.includes('--missing')) {
    // Заготовка для словаря: ключи, которым ещё нет перевода
    const I = require(path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts', 'ui-i18n.js'));
    const { keys } = collectKeys(path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts'));
    for (const [key, where] of keys) if (I.EN[key] === undefined) console.log(`${where}\t${JSON.stringify(key)}`);
  } else {
    let failed = 0;
    const check = (name, cond, detail) => {
      if (!cond) failed++;
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '\n      → ' + detail : ''}`);
    };
    module.exports({ check, HOOKS }).then(() => process.exit(failed ? 1 : 0));
  }
}
