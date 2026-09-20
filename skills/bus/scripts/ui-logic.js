/**
 * Логика страницы шины без DOM: фильтры, сборка ленты, выбор агентов, подписи. Страница берёт её с сервера
 * (/logic.js → window.BusLogic), тесты — через require: так поведение ленты проверяется в node, без браузера.
 * Сюда — только чистые функции: ни document, ни fetch, ни состояния между вызовами. Язык подписей — не здесь, а в ui-i18n.js (tr).
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./ui-i18n.js') : root.BusI18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BusLogic = api;
})(this, function ({ tr, N }) {
  const FILE_TOKENS = 25; // путь вложения в строке inbox и history, оценка
  const SHOW_LOAD_FROM = 1000; // с этого веса переписка агента показывается в списке
  const HEAVY_TOKENS = 3000; // с этого веса диалог подсвечивается: пора сжимать
  const KIND_LABEL = { project: N('проект'), local: N('локальный'), global: N('глобальный') };

  // Медь (оттенки 15–45) занята самой шиной — провода агентов её обходят
  const HUE_FROM = 50;
  const HUE_SLOTS = 22;
  const HUE_STEP = 14.5;

  /**
   * Цвет провода агента — из имени: один и тот же в списке и в ленте, между перезапусками не гуляет.
   * FNV-1a и фиксированные слоты: прежний «h*31 % 360» красил masha и shop-api в один цвет, а соседние оттенки не различить.
   */
  function hue(name) {
    let h = 0x811c9dc5;
    for (const ch of String(name)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
    return Math.round((HUE_FROM + (h % HUE_SLOTS) * HUE_STEP) % 360);
  }

  /**
   * Хеш на 22 слота неизбежно сталкивает имена (dima и landing, qa и backend). Среди известных агентов коллизии разводим:
   * по алфавиту каждый садится в свой слот, занятый — шагает на 7 слотов дальше (7 и 22 взаимно просты, соседние оттенки не выпадают).
   * → Map имя → оттенок; для имени не из списка (агента сняли, а сообщения остались) страница берёт hue().
   */
  function assignHues(agents) {
    const taken = new Set();
    const hues = new Map();
    const names = [...new Set(agents.map((x) => x.name))].sort();
    for (const name of names) {
      let slot = Math.round(((hue(name) - HUE_FROM + 360) % 360) / HUE_STEP) % HUE_SLOTS;
      for (let n = 0; n < HUE_SLOTS && taken.has(slot); n++) slot = (slot + 7) % HUE_SLOTS;
      taken.add(slot);
      hues.set(name, Math.round((HUE_FROM + slot * HUE_STEP) % 360));
    }
    return hues;
  }

  const pairKey = (a, b) => [a, b].sort().join('|');
  const pairOf = (m) => pairKey(m.fromKey, m.toKey);
  /** Выбраны ровно двое — смотрим их диалог друг с другом, а не всё подряд про каждого. */
  const selectedPair = (filters) => (filters.agents.size === 2 ? pairKey(...filters.agents) : null);

  function covered(m, summaries) {
    const summary = summaries.get(pairOf(m));
    return Boolean(summary && m.id <= summary.upto);
  }

  /** Оценка, а не счёт: кириллица — около трёх символов на токен, плюс служебная часть строки history. */
  const tokensOf = (list) => Math.round(list.reduce((sum, m) => sum + m.text.length / 3 + 10 + (m.files || []).length * FILE_TOKENS, 0));
  /** Сводку агент читает целиком строкой «# сводка с …» — она тоже весит; 15 — служебная часть этой строки. */
  const summaryTokens = (summary) => (summary && typeof summary.text === 'string' ? Math.round(summary.text.length / 3) + 15 : 0);
  const sizeOf = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} ${tr('МБ')}` : `${Math.max(1, Math.round(bytes / 1024))} ${tr('КБ')}`);
  const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}${tr('к')}` : String(n));
  const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

  function passes(m, filters, hereRoot) {
    const pair = selectedPair(filters);
    if (pair ? pairOf(m) !== pair : filters.agents.size && !filters.agents.has(m.fromKey) && !filters.agents.has(m.toKey)) return false;
    if (filters.types.size && !filters.types.has(m.type)) return false;
    // Без выбора агента лента — только каталог UI; выбранного агента или пару видно из любого каталога:
    // галочка «только эта директория» давала пустую ленту на клик по агенту из «Другие проекты»
    if (!filters.agents.size && hereRoot && m.roots.length && !m.roots.includes(hereRoot)) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!`${m.from} ${m.to} ${m.type} ${m.text} ${(m.files || []).map((f) => f.name).join(' ')}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  /** Текст кусками для подсветки поиска: [{ text, hit }], hit — совпадение с q без учёта регистра. Пустой q — один кусок. */
  function splitByQuery(text, q) {
    const s = String(text);
    const needle = String(q || '').toLowerCase();
    if (!needle) return [{ text: s, hit: false }];
    const low = s.toLowerCase();
    // toLowerCase меняет длину редких символов (İ) — индексы поплыли бы, такой текст не подсвечиваем
    if (low.length !== s.length) return [{ text: s, hit: false }];
    const parts = [];
    let from = 0;
    for (let at = low.indexOf(needle); at !== -1; at = low.indexOf(needle, from)) {
      if (at > from) parts.push({ text: s.slice(from, at), hit: false });
      parts.push({ text: s.slice(at, at + needle.length), hit: true });
      from = at + needle.length;
    }
    if (from < s.length || !parts.length) parts.push({ text: s.slice(from), hit: false });
    return parts;
  }

  /**
   * Непрочитанные ответы — по каждому ответившему последние N его сообщений оркестратору каталога UI (meKey): от его имени пользователь и пишет.
   * repliesBy — { ключ агента: сколько }. inbox хранит строки, а не id, точнее не узнать.
   */
  function unreadIds(messages, repliesBy, meKey) {
    const ids = new Set();
    if (!meKey) return ids;
    for (const [key, count] of Object.entries(repliesBy || {})) {
      if (count) for (const m of messages.filter((x) => x.toKey === meKey && x.fromKey === key).slice(-count)) ids.add(m.id);
    }
    return ids;
  }

  /**
   * Чьи ответы пора снять как прочитанные: открыт диалог одного агента (выбран он один или в паре с оркестратором каталога UI — me),
   * вкладка на экране и ответы от него лежат. → ключ агента или null. Общая лента и вкладка в фоне ничего не читают.
   */
  function readTarget(selected, me, visible) {
    if (!visible || !me) return null;
    const others = [...selected].filter((key) => key !== me.key);
    return others.length === 1 && (me.repliesBy || {})[others[0]] ? others[0] : null;
  }

  /**
   * Клик — переписка одного агента (повторный клик по нему же снимает фильтр). Двойной клик (repeat) и Ctrl/Shift+клик (add) —
   * добавить агента к выбранным или убрать. before — выбор до первого клика двойного: второй клик достраивает его,
   * а не то, шо первый уже успел переключить.
   */
  function nextSelection(current, key, { add = false, repeat = false, before = null } = {}) {
    if (add || (repeat && before)) {
      const selected = new Set(add ? current : before);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return { selected, before, multi: true };
    }
    const onlyHim = current.size === 1 && current.has(key);
    return { selected: onlyHim ? new Set() : new Set([key]), before: new Set(current), multi: false };
  }

  /**
   * Лента как список: { kind: 'day' | 'msg' | 'summary' }. В диалоге пары сообщения, ушедшие в сводку, свёрнуты под её карточку
   * (агент их тоже больше не читает). В общей ленте карточка сводки встаёт сразу за последним сообщением, которое она покрывает.
   * cont у сообщения — оно продолжает серию: на ветке ему хватает малого узла вместо полного отвода.
   */
  function feedItems({ messages, summaries, filters, hereRoot, showCovered = false }) {
    const pair = selectedPair(filters);
    const summary = (pair && summaries.get(pair)) || null;
    const matched = messages.filter((m) => passes(m, filters, hereRoot));
    const shown = summary && !showCovered ? matched.filter((m) => !covered(m, summaries)) : matched;
    const hidden = matched.filter((m) => covered(m, summaries)).length;

    const cardAfter = new Map(); // пара → id последнего покрытого сообщения: сообщения идут по порядку id, последний выигрывает
    if (!pair) for (const m of shown) if (covered(m, summaries)) cardAfter.set(pairOf(m), m.id);
    const cardIds = new Map([...cardAfter].map(([key, id]) => [id, summaries.get(key)]));

    const items = [];
    let day = '';
    let placed = !summary;
    // Серия: сообщение идёт сразу за сообщением того же отправителя тому же адресату — день или сводка между ними серию рвут
    const continues = (m) => {
      const last = items[items.length - 1];
      return Boolean(last && last.kind === 'msg' && last.m.fromKey === m.fromKey && last.m.toKey === m.toKey);
    };
    const place = () => {
      if (!placed) items.push({ kind: 'summary', summary, hidden, inPair: true });
      placed = true;
    };
    for (const m of shown) {
      if (summary && m.id > summary.upto) place();
      if (m.t.slice(0, 10) !== day) {
        day = m.t.slice(0, 10);
        items.push({ kind: 'day', day });
      }
      items.push({ kind: 'msg', m, covered: covered(m, summaries), cont: continues(m) });
      if (cardIds.has(m.id)) items.push({ kind: 'summary', summary: cardIds.get(m.id), hidden: 0, inPair: false });
    }
    place();
    return { items, matched, shown, pair, summary };
  }

  /** Панель пары: сколько весит несжатый хвост и можно ли его сжимать. */
  function pairInfo(matched, summaries) {
    const tail = matched.filter((m) => !covered(m, summaries));
    const weight = tokensOf(tail);
    return { total: matched.length, tail: tail.length, weight, heavy: weight >= HEAVY_TOKENS, early: tail.length >= 2 && weight < SHOW_LOAD_FROM, canSqueeze: tail.length >= 2 };
  }

  /**
   * Отчёт о весе переписки: строка на диалог, тяжёлые первыми. tokens — несжатый хвост (его агент затянет через history),
   * summary — вес сводки. here — диалог каталога UI: такие идут в итог total, чужие проекты — справкой ниже.
   * → { rows: [{ pair, keys, names, here, total, fresh, tokens, summary, heavy }], total: { dialogs, fresh, tokens, summary } }
   */
  function weightReport(messages, summaries, hereRoot) {
    const pairs = new Map();
    for (const m of messages) {
      const pair = pairOf(m);
      if (!pairs.has(pair)) {
        const sides = [[m.fromKey, m.from], [m.toKey, m.to]].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        pairs.set(pair, { pair, keys: sides.map((x) => x[0]), names: sides.map((x) => x[1]), here: false, list: [] });
      }
      const row = pairs.get(pair);
      row.list.push(m);
      if (!hereRoot || !m.roots.length || m.roots.includes(hereRoot)) row.here = true;
    }
    const rows = [...pairs.values()].map(({ list, ...row }) => {
      const fresh = list.filter((m) => !covered(m, summaries));
      const tokens = tokensOf(fresh);
      return { ...row, total: list.length, fresh: fresh.length, tokens, summary: summaryTokens(summaries.get(row.pair)), heavy: tokens >= HEAVY_TOKENS };
    }).sort((a, b) => Number(b.here) - Number(a.here) || b.tokens + b.summary - (a.tokens + a.summary) || a.pair.localeCompare(b.pair));
    const mine = rows.filter((row) => row.here);
    const sum = (key) => mine.reduce((n, row) => n + row[key], 0);
    return { rows, total: { dialogs: mine.length, fresh: sum('fresh'), tokens: sum('tokens'), summary: sum('summary') } };
  }

  function groupAgents(agents) {
    const order = (a, b) => (b.orchestrator ? 1 : 0) - (a.orchestrator ? 1 : 0) || Number(b.registered) - Number(a.registered) || a.name.localeCompare(b.name);
    return {
      here: agents.filter((a) => a.here).sort(order),
      globals: agents.filter((a) => !a.root).sort(order),
      others: agents.filter((a) => a.root && !a.here).sort((a, b) => a.root.localeCompare(b.root) || order(a, b)),
    };
  }

  /**
   * Подпись агента в списке. Чужое непрочитанное никто не «не читает»: субагент заберёт его при подъёме, проект — на следующем
   * промпте. У оркестратора этого каталога подписи нет: в его ящике ответы пользователю, они горят медью на ответившем агенте.
   * load — вес несжатой переписки агента в токенах.
   * → { label, notes: [{ tone: wait | run | ok | bad | load, text, title? }], busy, mine }
   */
  function agentStatus(agent, load = 0) {
    const mine = Boolean(agent.orchestrator && agent.here);
    const sub = agent.kind === 'local' || agent.kind === 'global';
    const w = agent.wake;
    const busy = Boolean(w && w.state === 'running');
    // wraps — локальная обёртка над глобальной ролью: роль одна на все проекты, в каталоге только переписка
    const label = (!agent.registered ? (agent.blocked ? tr('не в шине · писать нельзя') : tr('не в шине · заведётся при первом сообщении')) : agent.orchestrator && agent.here ? tr('оркестратор · пишешь от его имени') : agent.wraps ? tr('глобальный · переписка в проекте') : tr(KIND_LABEL[agent.kind])) + (agent.alive ? '' : tr(' · нет на диске'));
    const notes = [];
    if (agent.unread && !busy && !mine) notes.push({ tone: 'wait', text: sub ? tr('ждёт подъёма: {n}', { n: agent.unread }) : tr('увидит на следующем промпте: {n}', { n: agent.unread }) });
    if (busy) notes.push({ tone: 'run', text: tr('работает…') });
    else if (w && w.state === 'ok') notes.push({ tone: 'ok', text: tr('ответил {at}', { at: clock(w.at) }) + (w.tokens ? tr(' · ≈{n} ток.', { n: short(w.tokens) }) : ''), title: tr('Фоновый подъём: {sec} с, разбудил {by}. За час подъёмов: {wakes}', { sec: Math.round((w.ms || 0) / 1000), by: w.by, wakes: w.wakes }) });
    else if (w) notes.push({ tone: 'bad', text: w.state === 'limit' ? (w.until ? tr('лимит для агентов до {until} — тебе ответит', { until: clock(w.until) }) : tr('лимит для агентов — тебе ответит')) : tr('упал {at}: {reason}', { at: clock(w.at), reason: w.reason }), title: `${w.reason}\n${tr('Подробности — wake.log в ящике агента')}` });
    if (load >= SHOW_LOAD_FROM) notes.push({ tone: 'load', text: tr('переписка ≈{n} ток.', { n: short(load) }), title: tr('несжатая переписка агента, оценка') });
    return { label, notes, busy, mine };
  }

  /**
   * Почему агенту нельзя написать, или '' — если можно. Пользователь кликнул по backend «не в шине», строка подсветилась, а «Кому» молча
   * осталось на оркестраторе — сообщение ушло не тому, и «агент не ответил». Теперь клик по такому агенту объясняет, шо делать.
   * Агент «не в шине» без agent.blocked не заблокирован: сервер заведёт его сам при первом сообщении.
   */
  function blockedNote(agent) {
    if (!agent.registered) return agent.blocked ? tr('«{name}» не в шине, и завести его отсюда нельзя: {why}', { name: agent.name, why: tr(agent.blocked) }) : '';
    if (!agent.alive) return tr('«{name}»: его определения или каталога больше нет на диске — написать ему нельзя. Снять из шины: bus.js remove {name}', { name: agent.name });
    return agent.blocked ? `«${agent.name}»: ${tr(agent.blocked)}` : '';
  }

  /**
   * Шо чистит красная кнопка над лентой. Никто не выбран — весь журнал каталога; пара — её диалог; один агент — диалог пользователя с ним,
   * то есть пара «оркестратор, от чьего имени ему пишет UI ↔ агент». Раньше с одним выбранным агентом кнопка сносила весь журнал.
   * → { mode: 'all' | 'pair' | 'single' | 'none', a, b, names, hint }
   */
  function clearTarget(filters, agents) {
    const keys = [...filters.agents];
    const nameBy = (key) => (agents.find((a) => a.key === key) || { name: key.split('@')[0] }).name;
    if (!keys.length) return { mode: 'all' };
    if (keys.length === 2) return { mode: 'pair', a: keys[0], b: keys[1], names: keys.map(nameBy).join(' ↔ ') };
    if (keys.length > 2) return { mode: 'none', hint: tr('Выбрано больше двух агентов. Оставь одного — очистится твой диалог с ним, или двоих — их диалог.') };
    const agent = agents.find((a) => a.key === keys[0]);
    // Имя проекта в реестре одно на машину, поэтому его ключ — само имя
    if (agent && agent.from) return { mode: 'single', a: agent.key, b: agent.from, names: `${agent.from} ↔ ${agent.name}` };
    return { mode: 'none', hint: tr('«{name}» — не тот, кому ты пишешь из UI, своего диалога с ним нет. Выбери второго агента — очистится их диалог; сними выбор — весь журнал каталога.', { name: nameBy(keys[0]) }) };
  }

  const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/; // то же правило, шо NAME и RESERVED в bus.js
  const validAgentName = (name) => AGENT_NAME.test(String(name || '')) && !['files', 'scheduler', 'schedule'].includes(name);

  /** Можно ли выбрать агента в «Кому»: есть от чьего имени писать (agent.from), а сам он в шине или заведётся при первом сообщении. */
  const writable = (agent) => Boolean(!agent.blocked && agent.alive);

  /** Скрин из буфера приходит безымянным «image.png» — даём имя со временем, иначе в папке шины их не различить. */
  function nameOf(fileName, pasted, d = new Date()) {
    if (!pasted || !/^image\.\w+$/i.test(fileName)) return fileName;
    const p = (n) => String(n).padStart(2, '0');
    return `screenshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${fileName.split('.').pop()}`;
  }

  // ---------- голосовой ввод: удержание пробела ----------

  /** Надиктованное встаёт в место курсора; пробел по краям — только там, где его нет. → { value, caret } */
  function dictated(before, after, text) {
    const said = String(text).replace(/\s+/g, ' ').trim();
    if (!said) return { value: before + after, caret: before.length };
    const head = before + (before && !/\s$/.test(before) ? ' ' : '') + said;
    return { value: head + (after && !/^\s/.test(after) ? ' ' : '') + after, caret: head.length };
  }

  /**
   * Шо делает короткое нажатие пробела на элементе под фокусом. Нажатие перехватывается (иначе при удержании в поле сыпались бы
   * пробелы, а кнопка кликалась бы после диктовки), поэтому тап страница доигрывает сама: type — напечатать пробел,
   * click — нажать, none — ничего; skip — не перехватывать вовсе: список пробелом открывается, а программно его не открыть.
   */
  function spaceTap(tag, type) {
    const t = String(type || '').toLowerCase();
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && ['', 'text', 'search'].includes(t))) return 'type';
    if (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(t))) return 'click';
    return tag === 'SELECT' || tag === 'INPUT' ? 'skip' : 'none';
  }

  /** Коды ошибок SpeechRecognition — человеческим языком; '' — ошибки нет. aborted — отмена по Esc, это не сбой. */
  function voiceNote(code) {
    if (!code) return '';
    if (code === 'aborted') return tr('Диктовка отменена.');
    if (code === 'unsupported') return tr('Голосовой ввод: этот браузер не умеет распознавать речь — нужен Chrome или Edge.');
    if (code === 'not-allowed' || code === 'service-not-allowed') return tr('Голосовой ввод: нет доступа к микрофону. Разреши его для этой страницы — значок слева от адреса.');
    if (code === 'audio-capture') return tr('Голосовой ввод: микрофон не найден.');
    if (code === 'network') return tr('Голосовой ввод: сервис распознавания недоступен — он работает через интернет.');
    if (code === 'no-speech') return tr('Ничего не расслышал — держи пробел и говори.');
    return tr('Голосовой ввод не удался: {code}.', { code });
  }

  /** Шо стало с подъёмом:r.auto — started | busy | limit | off | failed, r.wake — оркестратор, которому ушёл запасной звонок. */
  function raisedNote(r) {
    if (r.auto === 'started') return tr('{to} поднят в фоне — ответ придёт в ленту, статус виден у него в списке слева.', { to: r.to });
    if (r.auto === 'busy') return tr('{to} уже работает в фоне — новое сообщение заберёт сам.', { to: r.to });
    const why = r.auto === 'off' ? tr('автоподъём выключен') : r.reason || tr('фоновый запуск не удался');
    return r.wake
      ? tr('{to} не поднят: {why}. Позвонил оркестратору {wake} — он поднимет агента на твоём следующем промпте в его сессии.', { to: r.to, why, wake: r.wake })
      : tr('{to} не поднят: {why}. Сообщение ждёт в его inbox.', { to: r.to, why });
  }

  /** Первое сообщение завело агента в шину: сервер правил файлы роли — пользователь должен видеть, какие. */
  function enrolledNote(r) {
    const e = r.enrolled;
    if (!e) return '';
    const what = e.wrapper ? tr('создана обёртка {file} (глобальная роль не тронута, переписка — в проекте)', { file: e.file }) : e.wrote ? tr('в роль {file} дописан блок «Шина»', { file: e.file }) : tr('роль не менялась');
    return tr('{to} заведён в шину: {what}. ', { to: r.to, what });
  }

  function sentNote(r) {
    const sent = r.from ? tr('Отправлено от имени {from}.', { from: r.from }) : tr('Отправлено.');
    if (r.kind === 'project') return `${sent} ${tr('{to} увидит на своём следующем промпте.', { to: r.to })}`;
    return `${enrolledNote(r)}${sent} ${raisedNote(r)}`;
  }

  // ---------- расписание ----------

  const SCHEDULE_MINUTE_STEPS = [5, 10, 15, 20, 30]; // варианты «каждые N минут» в форме — те же, шо примет сервер без --force
  const SCHEDULE_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]; // варианты «каждые N часов»
  const SCHEDULE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/; // как NAME в scheduler.js

  const pad2 = (n) => String(n).padStart(2, '0');

  /** «09:05» → { h, m } или null: форма не должна собирать cron из недописанного времени. */
  function parseHM(text) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim());
    return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
  }

  /**
   * cron-строка из пресета формы расписания. Мусор (пустое время, шаг не из списка) — null, а не кривой cron.
   * p: { time: "ЧЧ:ММ", day: "0"–"6" (0 — воскресенье, как в cron.js), n, minute, expr }
   */
  function buildScheduleCron(preset, p = {}) {
    const t = parseHM(p.time);
    if (preset === 'daily') return t ? `${t.m} ${t.h} * * *` : null;
    if (preset === 'weekdays') return t ? `${t.m} ${t.h} * * 1-5` : null;
    if (preset === 'weekly') return t && /^[0-6]$/.test(String(p.day)) ? `${t.m} ${t.h} * * ${p.day}` : null;
    if (preset === 'minutes') return SCHEDULE_MINUTE_STEPS.includes(Number(p.n)) ? `*/${p.n} * * * *` : null;
    if (preset === 'hours') {
      const minute = Number(p.minute);
      return SCHEDULE_HOUR_STEPS.includes(Number(p.n)) && Number.isInteger(minute) && minute >= 0 && minute <= 59 ? `${minute} */${p.n} * * *` : null;
    }
    if (preset === 'custom') return String(p.expr || '').trim() || null;
    return null;
  }

  /**
   * Обратная сторона buildScheduleCron: cron существующей задачи → пресет и его поля для формы.
   * Не узнали строку — «свой cron» с исходным выражением, а не попытка подогнать её силой.
   */
  function scheduleCronPreset(expr) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) return { preset: 'custom', expr: String(expr || '') };
    const [mi, h, dom, mo, dow] = parts;
    if (dom === '*' && mo === '*') {
      if (/^\d+$/.test(mi) && /^\d+$/.test(h)) {
        const time = `${pad2(Number(h))}:${pad2(Number(mi))}`;
        if (dow === '*') return { preset: 'daily', time };
        if (dow === '1-5') return { preset: 'weekdays', time };
        if (/^[0-6]$/.test(dow)) return { preset: 'weekly', time, day: dow };
      } else if (dow === '*') {
        const everyMin = /^\*\/(\d+)$/.exec(mi);
        if (everyMin && h === '*' && SCHEDULE_MINUTE_STEPS.includes(Number(everyMin[1]))) return { preset: 'minutes', n: everyMin[1] };
        const everyHour = /^\*\/(\d+)$/.exec(h);
        if (everyHour && /^\d+$/.test(mi) && SCHEDULE_HOUR_STEPS.includes(Number(everyHour[1]))) return { preset: 'hours', n: everyHour[1], minute: mi };
      }
    }
    return { preset: 'custom', expr: parts.join(' ') };
  }

  /** «→ dima» или «→ сессия проекта · sonnet» — кому и чем исполнится задача. */
  const scheduleTarget = (job, defaultModel) => (job.to ? `→ ${job.to}` : `→ ${tr('сессия проекта')} · ${job.model || defaultModel}`);

  /** «21.09 09:00» — ближайший запуск; «—» — выключена, кривая или cron не наступит никогда. */
  function scheduleNextLabel(next) {
    if (!next) return '—';
    const d = new Date(next);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** Итог последнего запуска строкой + тон подсветки («bad» — медью, как упавший агент). */
  function scheduleLastNote(last) {
    if (!last) return { text: tr('ещё не запускалась'), tone: '' };
    const at = clock(last.at);
    if (last.state === 'running') return { text: tr('идёт с {at}', { at }), tone: 'run' };
    if (last.state === 'ok') return { text: `${tr('ок {at}', { at })}${last.tokens ? tr(' · ≈{n} ток.', { n: short(last.tokens) }) : ''}${last.note ? ` · ${last.note}` : ''}`, tone: 'ok' };
    if (last.state === 'skipped') return { text: tr('пропуск: {reason}', { reason: last.reason }), tone: 'wait' };
    return { text: tr('упала {at}: {reason}', { at, reason: last.reason }), tone: 'bad' };
  }

  /** Статус демона одной строкой; «bad» — когда он нужен (есть включённые задачи), а не работает. */
  function scheduleDaemonNote(daemon) {
    if (daemon.alive) return { text: tr('демон работает') + (daemon.lastTick ? tr(' · последний проход {at}', { at: clock(daemon.lastTick) }) : ''), tone: '' };
    if (daemon.active) return { text: tr('демон не работает, а включённые задачи есть'), tone: 'bad' };
    return { text: tr('демон не нужен — включённых задач нет'), tone: '' };
  }

  /** Счётчик и медь для кнопки «Расписание» в шапке: включённые задачи и есть ли упавшая. */
  function scheduleBadge(jobs) {
    return { count: jobs.filter((j) => j.enabled && !j.error).length, alert: jobs.some((j) => j.last && j.last.state === 'failed') };
  }

  /**
   * Задачи по каталогам для панели: [{ root, label, jobs }]. Каталог UI — первым, дальше глобальные, потом остальные по имени.
   * label — из targets[].project (пусто у глобальных — там своя подпись).
   */
  function scheduleGroups(jobs, targets, here) {
    const label = (root) => {
      if (root === null) return tr('глобальные');
      const t = targets.find((x) => x.root === root);
      return (t && t.project) || root;
    };
    const roots = [...new Set(jobs.map((j) => j.root))];
    roots.sort((a, b) => Number(b === here) - Number(a === here) || Number(a === null) - Number(b === null) || label(a).localeCompare(label(b)));
    return roots.map((root) => ({ root, label: label(root), jobs: jobs.filter((j) => j.root === root).sort((a, b) => a.name.localeCompare(b.name)) }));
  }

  const validScheduleName = (name) => SCHEDULE_NAME.test(String(name || ''));

  /** Отказ сервера «cron чаще раза в 5 минут» (saveJob в scheduler.js) — по нему показываем «Всё равно сохранить». */
  const isFrequentError = (message) => /^Слишком часто:/.test(String(message || ''));

  return {
    hue, assignHues, pairKey, pairOf, selectedPair, covered, tokensOf, summaryTokens, HEAVY_TOKENS, weightReport, sizeOf, short, passes, splitByQuery, unreadIds, readTarget, nextSelection, feedItems, pairInfo, groupAgents, agentStatus, blockedNote, writable, nameOf, dictated, spaceTap, voiceNote, raisedNote, sentNote, clearTarget, validAgentName,
    SCHEDULE_MINUTE_STEPS, SCHEDULE_HOUR_STEPS, buildScheduleCron, scheduleCronPreset, scheduleTarget, scheduleNextLabel, scheduleLastNote, scheduleDaemonNote, scheduleBadge, scheduleGroups, validScheduleName, isFrequentError,
  };
});
