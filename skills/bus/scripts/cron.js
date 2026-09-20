/**
 * Cron для расписания шины: 5 полей (минута час день-месяца месяц день-недели), время локальное.
 * Без DOM и зависимостей: демон и тесты берут через require, страница — с сервера (/cron.js → window.BusCron).
 * Поддержано: `*`, списки `1,15`, диапазоны `1-5`, шаг через «/» (каждые 10 минут, `8-20/2`), день недели 0–7 (0 и 7 — воскресенье).
 * День месяца и день недели, заданные оба, — «или», как в обычном cron.
 * Тексты идут через tr из ui-i18n.js: у демона и CLI язык всегда русский, у страницы и запросов UI — выбранный во вкладке.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./ui-i18n.js') : root.BusI18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BusCron = api;
})(this, function ({ tr, N }) {
  const FIELDS = [
    { name: N('минута'), min: 0, max: 59 },
    { name: N('час'), min: 0, max: 23 },
    { name: N('день месяца'), min: 1, max: 31 },
    { name: N('месяц'), min: 1, max: 12 },
    { name: N('день недели'), min: 0, max: 7 },
  ];
  const DAYS = [N('вс'), N('пн'), N('вт'), N('ср'), N('чт'), N('пт'), N('сб')];
  const MONTHS = [N('янв'), N('фев'), N('мар'), N('апр'), N('мая'), N('июн'), N('июл'), N('авг'), N('сен'), N('окт'), N('ноя'), N('дек')];
  const SEARCH_LIMIT_DAYS = 366 * 5; // «31 февраля» не наступит никогда — поиск next() должен кончиться

  class CronError extends Error {}

  function parseField(text, { name, min, max }) {
    const values = new Set();
    for (const part of text.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!m) throw new CronError(tr('cron, поле «{name}»: не понял «{part}»', { name: tr(name), part }));
      const step = m[2] === undefined ? 1 : Number(m[2]);
      if (step < 1) throw new CronError(tr('cron, поле «{name}»: шаг должен быть от 1', { name: tr(name) }));
      let [from, to] = m[1] === '*' ? [min, max] : m[1].split('-').map(Number);
      if (to === undefined) to = m[2] === undefined ? from : max; // «5/10» — от 5 до конца с шагом
      if (from < min || to > max || from > to) throw new CronError(tr('cron, поле «{name}»: «{part}» вне {min}–{max}', { name: tr(name), part, min, max }));
      for (let v = from; v <= to; v += step) values.add(v);
    }
    return values;
  }

  /** → { minute, hour, dom, month, dow: Set, domAny, dowAny, expr }. Мусор — CronError с полем и причиной. */
  function parse(expr) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) throw new CronError(tr('cron — это 5 полей: минута час день-месяца месяц день-недели. Пример: 0 9 * * 1-5'));
    const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i]));
    const dow = new Set([...dowRaw].map((d) => d % 7));
    return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*', expr: parts.join(' ') };
  }

  function dayMatches(c, date) {
    const dom = c.dom.has(date.getDate());
    const dow = c.dow.has(date.getDay());
    if (c.domAny) return dow;
    if (c.dowAny) return dom;
    return dom || dow;
  }

  const matches = (c, date) => c.minute.has(date.getMinutes()) && c.hour.has(date.getHours()) && c.month.has(date.getMonth() + 1) && dayMatches(c, date);

  /** Ближайший запуск строго после from. Идём днями, внутри дня — по часам и минутам из наборов. Не нашёлся — null. */
  function next(c, from = new Date()) {
    const start = new Date(from.getTime());
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);
    const hours = [...c.hour].sort((a, b) => a - b);
    const minutes = [...c.minute].sort((a, b) => a - b);
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let i = 0; i < SEARCH_LIMIT_DAYS; i++, day.setDate(day.getDate() + 1)) {
      if (!c.month.has(day.getMonth() + 1) || !dayMatches(c, day)) continue;
      for (const h of hours) {
        for (const m of minutes) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          // Перевод часов: несуществующее время Date сдвигает — такой запуск пропускаем, а не стреляем не в тот час
          if (at >= start && at.getHours() === h && at.getMinutes() === m) return at;
        }
      }
    }
    return null;
  }

  /** Ближайшие count запусков — для подсказки в UI. */
  function upcoming(c, count = 3, from = new Date()) {
    const out = [];
    for (let at = next(c, from); at && out.length < count; at = next(c, at)) out.push(at);
    return out;
  }

  /**
   * Самый короткий промежуток между запусками, в минутах: по нему предупреждаем о частом расписании. Сутки считаем от ближайшего
   * запуска, а не от «сейчас»: «* * * * 1», заведённый во вторник, иначе проходил бы как редкий.
   */
  function minGapMinutes(c, from = new Date()) {
    let gap = Infinity;
    let prev = next(c, from);
    const until = (prev || from).getTime() + 24 * 60 * 60 * 1000;
    for (let at = prev && next(c, prev), n = 0; at && at.getTime() < until && n < 1500; prev = at, at = next(c, at), n++) gap = Math.min(gap, (at - prev) / 60000);
    return gap;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const sorted = (set) => [...set].sort((a, b) => a - b);
  const isFull = (set, f) => set.size === f.max - f.min + 1;

  /** Набор подряд идущих значений → «пн–пт», иначе список. */
  function spans(values, label) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      let j = i;
      while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
      out.push(j - i >= 2 ? `${label(values[i])}–${label(values[j])}` : values.slice(i, j + 1).map(label).join(', '));
      i = j;
    }
    return out.join(', ');
  }

  /** «0 9 * * 1-5» → «по будням в 09:00». Не разобрал — текст ошибки: подпись в UI и list не должна падать. */
  function describe(expr) {
    let c;
    try {
      c = parse(expr);
    } catch (e) {
      return e.message;
    }
    const parts = c.expr.split(' ');
    const stepOf = (p) => (/^\*\/(\d+)$/.exec(p) || [])[1];

    let time;
    let every = true; // «каждые N» уже говорит про дни — «каждый день» к нему не дописываем
    // Шаг, который не делит 60, рвётся на стыке часа (*/45 — это :00 и :45): «каждые 45 мин» было бы враньём
    if (stepOf(parts[0]) && parts[1] === '*' && 60 % Number(stepOf(parts[0])) === 0) time = stepOf(parts[0]) === '1' ? tr('каждую минуту') : tr('каждые {n} мин', { n: stepOf(parts[0]) });
    else if (parts[0] === '*' && parts[1] === '*') time = tr('каждую минуту');
    else if (c.minute.size === 1 && stepOf(parts[1])) time = tr('каждые {n} ч в :{mm}', { n: stepOf(parts[1]), mm: pad(sorted(c.minute)[0]) });
    else if (c.minute.size <= 6 && parts[1] === '*') time = tr('каждый час в {list}', { list: sorted(c.minute).map((m) => `:${pad(m)}`).join(', ') });
    else {
      every = false;
      if (c.minute.size === 1 && c.hour.size <= 4) time = tr('в {list}', { list: sorted(c.hour).map((h) => `${pad(h)}:${pad(sorted(c.minute)[0])}`).join(', ') });
      else time = tr('минуты {m}, часы {h}', { m: parts[0], h: parts[1] });
    }

    let days = '';
    const dow = sorted(c.dow);
    if (!c.dowAny && !isFull(c.dow, { min: 0, max: 6 })) {
      if (dow.join() === '1,2,3,4,5') days = tr('по будням');
      else if (dow.join() === '0,6') days = tr('по выходным');
      else days = tr('по {days}', { days: spans(dow.map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b), (d) => tr(DAYS[d % 7])) });
    }
    if (!c.domAny) days = `${days ? days + tr(' или ') : ''}${tr('{list}-го числа', { list: spans(sorted(c.dom), String) })}`;
    if (!isFull(c.month, FIELDS[3])) days = `${days ? days + ', ' : ''}${spans(sorted(c.month), (m) => tr(MONTHS[m - 1]))}`;
    if (!days && !every) days = tr('каждый день');
    return `${days} ${time}`.trim();
  }

  return { CronError, parse, matches, next, upcoming, minGapMinutes, describe };
});
