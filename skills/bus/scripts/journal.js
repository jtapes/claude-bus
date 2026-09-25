/**
 * Журнал переписки каталога — <корень>/.claude/bus/history.jsonl, строка = запись JSON; больше JOURNAL_ROTATE_BYTES — уезжает в .1.
 * Чтение, дописка, ротация, правка из UI, диалоги пары и переписка агента. Модуль от bus.js не зависит: его грузит и wake.js.
 *
 * Записи (поля короткие — журнал читают целиком на каждый history и опрос UI):
 *   сообщение      { id, t, from, fk, to, tk, type, text, d?, files?, ui?, btw?, evolve?, fr?, tr? } — deliver() в bus.js
 *   маркер диалога { id, t, kind: 'dialog', a, ak, b, bk, d, ar?, br? } — «+» в UI и перенос при ротации
 *   сводка         { id, t, kind: 'summary', a, ak, b, bk, d?, upto, count, text, ar?, br? } — «Сжать диалог» в UI
 *   отчёт          { id, t, from: 'schedule', fk: 's', to, tk, type, text, job } — запуск по расписанию, journalNote()
 * id — время в base36 и случайный хвост (newId): сортируется по порядку отправки. t — stamp() с секундами.
 * fk/tk/ak/bk — вид стороны, KIND_CODE: p проект, l локальный, g глобальный (s — расписание, h — человек из старых журналов).
 * fr/tr/ar/br — каталог стороны, когда она не из каталога этого журнала: из реестра, а не от отправителя — не подделать.
 * d — диалог пары «проект ↔ субагент»; нет поля — первый, прежний диалог ('').
 */

const fs = require('fs');
const path = require('path');
const { stamp, writeAtomic, appendRotating, samePath } = require('./fsx.js');

const JOURNAL_ROTATE_BYTES = 2 * 1024 * 1024; // перевалил — уезжает в .1, прежний .1 затирается
const KIND_CODE = { project: 'p', local: 'l', global: 'g' };
const DIALOG_ID = /^[a-z0-9-]{1,40}$/;

const journalFile = (busDir) => path.join(busDir, 'history.jsonl');
const busDirOf = (agent) => path.dirname(agent.box); // <корень>/.claude/bus — общий для всех агентов каталога
const isSubagent = (agent) => agent.kind === 'local' || agent.kind === 'global';
const isDialogPair = (a, b) => (a.kind === 'project' && isSubagent(b)) || (b.kind === 'project' && isSubagent(a));
const dialogOf = (r) => (typeof r.d === 'string' ? r.d : '');

/** Время в base36 впереди — id сортируются по порядку отправки точнее, чем секунды в поле t. */
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;

/** Сторона переписки: имя + вид + чужой каталог — локальный dima и глобальный, dima из двух каталогов — разные стороны. */
const sideKey = (name, kind, root = '') => `${name}:${kind}:${root || ''}`;
const pairKey = (a, b) => [a, b].sort().join('|');

// ---------- чтение ----------

// Файл → { key: размер, mtime и inode на момент чтения, records }. deliver ищет в журнале до трёх раз подряд (workingDialog,
// currentDialog, customerOf) — без кэша это три чтения по 2 МБ на каждый send. Два места: свежий файл и .1 одного каталога
const cache = new Map();

function recordsOf(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return []; // переписки ещё не было
  }
  const key = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.records;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // оборванная строка от упавшей записи — пропускаем, остальное читается
    }
  }
  cache.delete(file);
  cache.set(file, { key, records });
  if (cache.size > 2) cache.delete(cache.keys().next().value);
  return records;
}

/** Записи журнала каталога, старые первыми. Ротированный .1 читается, только если попросили. Записи общие с кэшем — не менять. */
const readJournal = (busDir, withRotated = false) => [...(withRotated ? recordsOf(`${journalFile(busDir)}.1`) : []), ...recordsOf(journalFile(busDir))];

/**
 * Поиск с конца: свежий журнал, потом .1 — туда при ротации уехало старое. visit(запись) → undefined — дальше, иное — ответ.
 * Не нашлось — undefined.
 */
function searchJournal(busDir, visit) {
  for (const file of [journalFile(busDir), `${journalFile(busDir)}.1`]) {
    const records = recordsOf(file);
    for (let i = records.length - 1; i >= 0; i--) {
      const found = visit(records[i]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ---------- запись ----------

/** Запись про двух агентов — в журнал каталога каждого; каталог чужой стороны дописывается под ключом rootKey. */
function journalAppend(a, b, record, aRootKey, bRootKey) {
  const dirs = new Set([busDirOf(a), busDirOf(b)]);
  for (const busDir of dirs) {
    const foreign = (agent, key) => (agent.root && !samePath(busDirOf(agent), busDir) ? { [key]: agent.root } : {});
    appendRotating(journalFile(busDir), JSON.stringify({ ...record, ...foreign(a, aRootKey), ...foreign(b, bRootKey) }) + '\n', JOURNAL_ROTATE_BYTES, carrySummaries);
  }
}

/** Запись в журнал одного каталога не от агента шины — отчёт запуска по расписанию (scheduler.js). Лента UI рисует её как сообщение. */
function journalNote(busDir, record) {
  const id = newId();
  appendRotating(journalFile(busDir), JSON.stringify({ id, t: stamp(), ...record }) + '\n', JOURNAL_ROTATE_BYTES, carrySummaries);
  return id;
}

/**
 * Журнал уехал в .1, а history читает .1, только когда в свежем файле не хватает строк: без переноса агент остался бы и без сводки,
 * и без старых сообщений. Последняя сводка каждой пары едет в голову нового файла как есть — id тот же, UI дубль не рисует.
 * Маркер диалога едет тоже: пустой диалог иначе пропал бы из вкладок вместе с .1. Порядок перенесённых маркеров текущий диалог
 * сбил бы (он — по последней записи пары), поэтому за ними у каждой пары «проект ↔ субагент» — маркер её текущего диалога.
 */
function carrySummaries(rotated) {
  const last = new Map();
  const current = new Map(); // пара → стороны и d её последней записи
  const split = new Set(); // пары, у которых есть непервый диалог: без него текущий и так первый, указатель не нужен
  const isSub = (code) => code === 'l' || code === 'g';
  for (const line of fs.readFileSync(rotated, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      const [x, xk, xr, y, yk, yr] = r.kind ? [r.a, r.ak, r.ar, r.b, r.bk, r.br] : [r.from, r.fk, r.fr, r.to, r.tk, r.tr];
      const pair = pairKey(sideKey(x, xk, xr), sideKey(y, yk, yr));
      if (dialogOf(r)) split.add(pair);
      if (r.kind === 'summary' || r.kind === 'dialog') last.set(`${r.kind}#${pair}#${dialogOf(r)}`, line);
      if ((r.kind === 'dialog' || !r.kind) && typeof x === 'string' && typeof y === 'string' && ((xk === 'p' && isSub(yk)) || (yk === 'p' && isSub(xk)))) {
        current.set(pair, { a: x, ak: xk, ar: xr, b: y, bk: yk, br: yr, d: dialogOf(r) });
      }
    } catch {
      // оборванная строка
    }
  }
  const pointers = [...current].filter(([pair]) => split.has(pair)).map(([, p]) => p).map(({ a, ak, ar, b, bk, br, d }) =>
    JSON.stringify({ id: newId(), t: stamp(), kind: 'dialog', a, ak, ...(ar ? { ar } : {}), b, bk, ...(br ? { br } : {}), d }));
  return [...last.values(), ...pointers].map((line) => line + '\n').join('');
}

/**
 * Переписать журнал каталога (и .1) без записей, для которых drop(record) истинно; вернуть убранные. Зовёт только UI по клику пользователя.
 * send дописывает журнал без замка: строка, пришедшая между чтением и rename, из журнала выпадет (в inbox получателя останется) —
 * окно в миллисекунды, удаление ручное и редкое, замок на каждый send ради него не держим.
 */
function rewriteJournal(busDir, drop) {
  const removed = [];
  for (const file of [`${journalFile(busDir)}.1`, journalFile(busDir)]) {
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      continue; // файла нет
    }
    const kept = lines.filter((line) => {
      try {
        const record = JSON.parse(line);
        if (!record || !drop(record)) return true;
        removed.push(record);
        return false;
      } catch {
        return true; // оборванная строка — не наша забота
      }
    });
    if (kept.length === lines.length) continue;
    if (!kept.length) {
      fs.rmSync(file, { force: true });
      continue;
    }
    // Временный файл — с pid, как у любой атомарной записи: общий «.tmp» два сервера UI затирали друг другу
    writeAtomic(file, `${kept.join('\n')}\n`);
  }
  return removed;
}

// ---------- диалоги ----------
// Диалоги пользователя с агентом: у пары «проект ↔ субагент» записи журнала несут d — id диалога. Запись без d — первый, прежний диалог ('').
// Новый диалог — запись kind: 'dialog' (кнопка «+» в UI), чтоб пустой жил в журнале. Текущий — d последней записи пары:
// туда уходят ответы агента и сообщения из сессии, а history отдаёт агенту только его — в новом диалоге контекст чистый.

/** Запись журнала — сообщение или маркер диалога между сторонами с этими именами и видами. Сводки текущий диалог не двигают. */
function inPair(r, a, b) {
  const [ac, bc] = [KIND_CODE[a.kind], KIND_CODE[b.kind]];
  const is = (x, xk, y, yk) => (x === a.name && xk === ac && y === b.name && yk === bc) || (x === b.name && xk === bc && y === a.name && yk === ac);
  return r.kind === 'dialog' ? is(r.a, r.ak, r.b, r.bk) : !r.kind && is(r.from, r.fk, r.to, r.tk);
}

/** Текущий диалог пары — по журналу каталога проекта, с дочитыванием .1. */
function currentDialog(a, b) {
  const found = searchJournal(busDirOf(a.kind === 'project' ? a : b), (r) => (inPair(r, a, b) ? dialogOf(r) : undefined));
  return found === undefined ? '' : found;
}

/** Диалог d пары ещё есть в журнале каталога busDir (с .1)? */
const hasDialog = (busDir, a, b, d) => searchJournal(busDir, (r) => (inPair(r, a, b) && dialogOf(r) === d ? true : undefined)) === true;

/**
 * Переписка агента из журнала его каталога: сообщения, где он одна из сторон, и последняя сводка каждого диалога.
 * Сводку диалога пользователь делает кнопкой в UI: всё, что она покрывает (id ≤ upto), агенту уже не отдаём — ради этого она и нужна.
 * reading — метки dialog-reading.json субагента { собеседник: { d } }: диалоги, из которых он читал.
 * → { summaries: Map кто → запись сводки, all: [{ r, out, who, dir }], found: all без покрытого сводками }
 */
function dialogsOf(me, peer, withRotated, reading = {}) {
  const code = KIND_CODE[me.kind];
  const records = readJournal(busDirOf(me), withRotated);
  // У пары «проект ↔ субагент» — только текущий диалог: d последнего сообщения или маркера пары (см. currentDialog).
  // Субагенту — диалог, из которого он читал (reading), если тот ещё в журнале: «+» посреди его работы контекст не подменяет
  const split = (other) => ['p', 'l', 'g'].includes(other) && (code === 'p') !== (other === 'p');
  const current = new Map();
  const seen = new Map(); // собеседник → его диалоги в журнале
  for (const r of records) {
    const [x, xk, y, yk] = r.kind === 'dialog' ? [r.a, r.ak, r.b, r.bk] : !r.kind ? [r.from, r.fk, r.to, r.tk] : [];
    const who = x === me.name && xk === code ? [y, yk] : y === me.name && yk === code ? [x, xk] : null;
    if (!who || !split(who[1])) continue;
    current.set(who[0], dialogOf(r));
    if (!seen.has(who[0])) seen.set(who[0], new Set());
    seen.get(who[0]).add(dialogOf(r));
  }
  for (const [who, mark] of Object.entries(reading)) {
    if (current.has(who) && mark && typeof mark.d === 'string' && (!mark.d || seen.get(who).has(mark.d))) current.set(who, mark.d);
  }
  const here = (who, r) => !current.has(who) || current.get(who) === dialogOf(r);
  // В журнале каталога — переписка всех его агентов; моя — где я одна из сторон. Вид отличает локального dima от глобального
  const all = records
    .filter((r) => typeof r.t === 'string' && typeof r.text === 'string' && typeof r.id === 'string') // обрывок или чужая запись без полей — не повод падать
    .map((r) => (r.from === me.name && r.fk === code ? { r, out: true, who: r.to, dir: r.tr } : r.to === me.name && r.tk === code ? { r, out: false, who: r.from, dir: r.fr } : null))
    .filter((m) => m && (!peer || m.who === peer) && here(m.who, m.r));
  const summaries = new Map();
  for (const r of records) {
    const who = r.kind !== 'summary' || typeof r.t !== 'string' || typeof r.text !== 'string' ? null : r.a === me.name && r.ak === code ? r.b : r.b === me.name && r.bk === code ? r.a : null;
    if (who && (!peer || who === peer) && here(who, r)) summaries.set(who, r); // последняя по журналу перекрывает прежние
  }
  return { summaries, all, found: all.filter((m) => !(summaries.has(m.who) && m.r.id <= summaries.get(m.who).upto)) };
}

module.exports = {
  JOURNAL_ROTATE_BYTES, KIND_CODE, DIALOG_ID, journalFile, busDirOf, isSubagent, isDialogPair, dialogOf, newId, sideKey, pairKey,
  readJournal, searchJournal, journalAppend, journalNote, carrySummaries, rewriteJournal, inPair, currentDialog, hasDialog, dialogsOf,
};
