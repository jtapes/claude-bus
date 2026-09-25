/**
 * Настройки шины по проектам: ~/.claude/bus/settings.json → { global: { ключ: значение }, projects: { "<каталог>": { ключ: значение } } }.
 * Проект переопределяет дефолты из SCHEMA. В файле лежит только то, шо от дефолта отличается;
 * каталога в файле нет (или root пустой — глобальный агент, UI вне проекта) — работают дефолты.
 * Ключи с global: true одни на все проекты и лежат в global: каталог им не нужен, сброс всех настроек проекта их не трогает.
 * Файла нет, он битый или значение в нём не проходит проверку — тоже дефолт: шина из-за настроек не падает.
 *
 * Модуль лёгкий и от bus.js не зависит: его грузит и wake.js, которому bus.js парсить незачем.
 * Меняют настройки пользователь из UI (шестерёнка) и оркестратор (bus.js settings set) — проверка «кто» лежит на вызывающем.
 * label и hint — ключи перевода (N): форму строит UI, английский текст лежит в ui-i18n.js.
 */

const os = require('os');
const path = require('path');
const fsx = require('./fsx.js');
// Словарь (ui-i18n.js, ≈60 КБ) грузится, только когда есть шо переводить — текст ошибки: settings.js тянут bus.js и wake.js на каждый send и хук.
// N — пометка «ключ перевода» для теста bus i18n, строку она не меняет
const N = (text) => text;
const tr = (...args) => require('./ui-i18n.js').tr(...args);

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const FILE = path.join(CONFIG_DIR, 'bus', 'settings.json');
const MODEL = /^[A-Za-z0-9._[\]-]{1,60}$/; // уходит в командную строку claude

const GROUPS = [
  { key: 'wake', label: N('Подъём агентов') },
  { key: 'message', label: N('Сообщения') },
  { key: 'agent', label: N('Промпт агентов') },
  { key: 'schedule', label: N('Расписание') },
  { key: 'ui', label: N('Интерфейс') },
];

/** Порядок — порядок полей в форме. atLeast — ключ настройки, меньше которой эта быть не может. global — одна на все проекты. */
const SCHEMA = [
  { key: 'wake.enabled', group: 'wake', type: 'bool', default: true, label: N('Поднимать агентов в фоне'),
    hint: N('Агенту пришло сообщение — шина сама запускает его в фоне, и он отвечает без твоего участия. Выключишь — сообщение дождётся, пока агента поднимет сессия проекта. Общий рубильник «bus.js autowake off» сильнее: он гасит подъём во всех проектах.') },
  { key: 'wake.perHour', group: 'wake', type: 'int', default: 6, min: 1, max: 60, unit: N('в час'), label: N('Подъёмов в час на агента'),
    hint: N('Сколько раз в час другие агенты могут разбудить одного агента. Это тормоз от зацикленной переписки: каждый подъём — около 20 тысяч токенов. Твои сообщения из этого окна лимит не держит и в счёт не идут.') },
  { key: 'wake.timeoutMin', group: 'wake', type: 'int', default: 60, min: 1, max: 120, unit: N('мин'), label: N('Время на один подъём'),
    hint: N('Сколько минут агент может работать за один подъём. Не уложился — процесс убит, в списке агент помечен «упал», продолжить можно кнопкой. Долгим задачам (сборка, большой рефакторинг) ставь больше.') },

  { key: 'message.maxLength', group: 'message', type: 'int', default: 5000, min: 500, max: 10000, unit: N('символов'), label: N('Длина сообщения'),
    hint: N('Предел длины одного сообщения. Всё, шо длиннее, агент присылает файлом-вложением. Больше предел — больше токенов съест каждое сообщение у получателя.') },
  { key: 'files.max', group: 'message', type: 'int', default: 10, min: 1, max: 20, unit: N('шт.'), label: N('Вложений в сообщении'),
    hint: N('Сколько файлов можно приложить к одному сообщению.') },
  { key: 'files.maxMb', group: 'message', type: 'int', default: 30, min: 1, max: 100, unit: N('МБ'), label: N('Размер вложения'),
    hint: N('Предел размера одного приложенного файла. Копия каждого вложения остаётся в .claude/bus/files проекта.') },
  { key: 'history.lines', group: 'message', type: 'int', default: 30, min: 5, max: 200, unit: N('строк'), label: N('Строк в history'),
    hint: N('Сколько последних сообщений агент получает командой history, когда вспоминает переписку.') },
  { key: 'history.chars', group: 'message', type: 'int', default: 8000, min: 2000, max: 50000, unit: N('символов'), label: N('Потолок history'),
    hint: N('Предел вывода history в символах: три символа — примерно один токен в контексте агента. Старые сообщения, которые не влезли, отбрасываются.') },

  { key: 'agent.promptGlobal', group: 'agent', type: 'text', default: '', max: 2000, global: true, unit: N('символов'), label: N('Всем агентам во всех проектах'),
    hint: N('Твои правила для субагентов шины в любом проекте. Текст приходит агенту вместе с входящими при каждом подъёме: три символа — примерно один токен, так шо держи коротким. Оркестраторам и задачам расписания без адресата он не идёт.') },
  { key: 'agent.prompt', group: 'agent', type: 'text', default: '', max: 2000, unit: N('символов'), label: N('Агентам этого проекта'),
    hint: N('Добавка к общему тексту для субагентов этого проекта: приходит следом за ним, общий не заменяет.') },

  { key: 'schedule.model', group: 'schedule', type: 'model', default: 'sonnet', label: N('Модель задач по расписанию'),
    hint: N('На какой модели идёт задача по расписанию, если в самой задаче модель не указана. Такие задачи работают без присмотра, поэтому по умолчанию не самая дорогая модель.') },
  { key: 'schedule.timeoutMin', group: 'schedule', type: 'int', default: 60, min: 1, max: 120, unit: N('мин'), label: N('Таймаут задачи'),
    hint: N('Сколько минут даётся задаче по расписанию, если в ней самой таймаут не указан.') },
  { key: 'schedule.minGapMin', group: 'schedule', type: 'int', default: 5, min: 1, max: 60, unit: N('мин'), label: N('Минимальный интервал'),
    hint: N('Расписание чаще этого интервала шина не примет (из консоли — только с --force). Защита от задачи, которая жжёт токены каждую минуту.') },

  { key: 'ui.showLoadFrom', group: 'ui', type: 'int', default: 1000, min: 0, max: 100000, unit: N('токенов'), label: N('Показывать вес переписки от'),
    hint: N('С какого веса непрочитанной и несжатой переписки он показывается рядом с агентом в списке.') },
  { key: 'ui.heavyTokens', group: 'ui', type: 'int', default: 3000, min: 0, max: 100000, atLeast: 'ui.showLoadFrom', unit: N('токенов'), label: N('Тяжёлый диалог от'),
    hint: N('С какого веса диалог подсвечивается: пора нажать «Сжать диалог», иначе агент затянет всё это в контекст.') },
  { key: 'ui.summaryModel', group: 'ui', type: 'model', default: 'haiku', label: N('Модель для «Сжать диалог»'),
    hint: N('Какая модель пересказывает переписку в сводку. Задача простая — хватает самой дешёвой.') },
  { key: 'ui.rewriteModel', group: 'ui', type: 'model', default: 'opus', label: N('Модель для правки роли'),
    hint: N('Какая модель переписывает роль агента по твоей просьбе в форме агента. От неё зависит качество роли, поэтому по умолчанию сильная.') },
];

const BY_KEY = new Map(SCHEMA.map((item) => [item.key, item]));
const DEFAULTS = Object.freeze(Object.fromEntries(SCHEMA.map((item) => [item.key, item.default])));

class SettingsError extends Error {
  /** key — поле формы, у которого UI покажет ошибку. */
  constructor(message, key = null) {
    super(message);
    this.key = key;
  }
}

/** Каталог проекта → ключ в файле: один и тот же каталог из реестра, из cwd и из UI должен дать одну строку. */
function rootKey(root) {
  if (!root) return null;
  const resolved = path.resolve(String(root)).split(path.sep).join('/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** Файл старше слоя global или слой в нём битый — глобальных настроек просто нет. */
function readFile() {
  const data = plain(fsx.readJson(FILE, {}));
  return { ...data, global: plain(data.global), projects: plain(data.projects) };
}

/** Чтение-правка-запись файла под локом: два одновременных сохранения (UI и settings set) иначе теряли одно из них. */
const withLock = (fn) => fsx.withLock(`${FILE}.lock`, fn, () => new SettingsError(tr('Настройки сейчас сохраняет другой процесс. Повтори через пару секунд.')));

function writeFile(data) {
  if (!Object.keys(data.global).length) delete data.global;
  fsx.writeAtomic(FILE, JSON.stringify(data, null, 2) + '\n');
}

/** Значение из формы или консоли → значение настройки. Строки приходят из CLI: «12», «off». */
function parse(item, raw) {
  if (item.type === 'bool') {
    if (raw === true || raw === false) return raw;
    const word = String(raw).trim().toLowerCase();
    if (['1', 'true', 'on', 'yes', 'да', 'вкл'].includes(word)) return true;
    if (['0', 'false', 'off', 'no', 'нет', 'выкл'].includes(word)) return false;
    throw new SettingsError(tr('{key}: нужно on или off.', { key: item.key }), item.key);
  }
  if (item.type === 'model') {
    const model = String(raw).trim();
    if (!MODEL.test(model)) throw new SettingsError(tr('{key}: имя модели — латиница, цифры, точка и дефис, до 60 символов.', { key: item.key }), item.key);
    return model;
  }
  if (item.type === 'text') {
    const text = String(raw).replace(/\r\n?/g, '\n').trim();
    if (text.length > item.max) throw new SettingsError(tr('{key}: не длиннее {max} символов, сейчас {n}.', { key: item.key, max: item.max, n: text.length }), item.key);
    return text;
  }
  const number = typeof raw === 'number' ? raw : /^\s*-?\d+\s*$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(number)) throw new SettingsError(tr('{key}: нужно целое число.', { key: item.key }), item.key);
  if (number < item.min || number > item.max) throw new SettingsError(tr('{key}: от {min} до {max}.', { key: item.key, min: item.min, max: item.max }), item.key);
  return number;
}

/** Сохранённое руками могло протухнуть или оказаться мусором — такое значение молча уступает дефолту. */
function valid(item, raw) {
  try {
    return parse(item, raw);
  } catch {
    return undefined;
  }
}

/** Только переопределения, прошедшие проверку: { ключ: значение } — проекта и общие (global); без каталога — одни общие. */
function overrides(root) {
  const data = readFile();
  const key = rootKey(root);
  const project = key ? plain(data.projects[key]) : {};
  const out = {};
  for (const item of SCHEMA) {
    const saved = item.global ? data.global : project;
    const value = Object.prototype.hasOwnProperty.call(saved, item.key) ? valid(item, saved[item.key]) : undefined;
    if (value !== undefined && value !== item.default) out[item.key] = value;
  }
  return out;
}

/** Настройки каталога целиком: дефолты плюс переопределения. Парные пороги, разъехавшиеся в файле, подтягиваются к нижнему. */
function get(root) {
  const values = { ...DEFAULTS, ...overrides(root) };
  for (const item of SCHEMA) if (item.atLeast && values[item.key] < values[item.atLeast]) values[item.key] = values[item.atLeast];
  return values;
}

/**
 * Поменять настройки проекта. patch — { ключ: значение | null }, null — вернуть дефолт. Сначала проверяется всё, потом пишется:
 * наполовину сохранённой формы не бывает. Чтение, правка и запись — под локом (withLock). Каталог нужен только проектным ключам: общие (global) меняются и без него.
 * Текст режется redact(): он едет в контекст агентов, ключам из settings.json там не место. → настройки каталога после правки.
 */
function set(root, patch) {
  const key = rootKey(root);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError(tr('Нужен объект «ключ: значение».'));
  if (!key && Object.keys(patch).some((name) => !(BY_KEY.get(name) || {}).global)) throw new SettingsError(tr('Настройки привязаны к каталогу проекта, а его нет.'));
  withLock(() => {
    const next = overrides(root);
    for (const [name, raw] of Object.entries(patch)) {
      const item = BY_KEY.get(name);
      if (!item) throw new SettingsError(tr('Нет настройки «{name}». Есть: {list}', { name, list: SCHEMA.map((s) => s.key).join(', ') }), name);
      if (raw === null || raw === undefined || raw === '') delete next[name];
      else next[name] = item.type === 'text' ? parse(item, require('./lib/redact.js').redact(String(raw))) : parse(item, raw);
    }
    const merged = { ...DEFAULTS, ...next };
    for (const item of SCHEMA) {
      if (item.atLeast && merged[item.key] < merged[item.atLeast]) throw new SettingsError(tr('{key} не может быть меньше {other} ({value}).', { key: item.key, other: item.atLeast, value: merged[item.atLeast] }), item.key);
    }
    for (const item of SCHEMA) if (next[item.key] === item.default) delete next[item.key];
    const data = readFile();
    const layer = (global) => Object.fromEntries(Object.entries(next).filter(([name]) => Boolean(BY_KEY.get(name).global) === global));
    data.global = layer(true);
    if (key && Object.keys(layer(false)).length) data.projects[key] = layer(false);
    else if (key) delete data.projects[key];
    writeFile(data);
  });
  return get(root);
}

/** Сбросить одну настройку или все настройки проекта. Общие (global) «сбросить всё» не трогает — только по имени. */
const reset = (root, name = null) => set(root, Object.fromEntries((name ? [name] : SCHEMA.filter((item) => !item.global).map((item) => item.key)).map((k) => [k, null])));

module.exports = { GROUPS, SCHEMA, DEFAULTS, MODEL, SettingsError, get, set, reset };
