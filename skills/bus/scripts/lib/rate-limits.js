/**
 * Снимок лимитов claude.ai: cache/rate-limits.json, формат statusline — { five_hour: { used_percentage, resets_at }, seven_day: … }.
 *
 * Пишут двое: statusline.js на каждом обновлении и фоновые подъёмы шины (событие rate_limit_event потока claude -p).
 * Читают tg-notify (limit.js, время сброса при упоре в лимит) и UI шины (шапка). Свежесть — mtime файла.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
const SNAPSHOT = path.join(CACHE_DIR, 'rate-limits.json');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const known = (win) => Boolean(win && typeof win === 'object' && Number.isFinite(win.used_percentage));

/** Окно без процента (начало сессии) прежнее не затирает: у другой сессии оно могло быть. */
function saveSnapshot(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return;
  const old = readJson(SNAPSHOT);
  const next = old && typeof old === 'object' ? { ...old } : {};
  for (const [key, win] of Object.entries(rateLimits)) if (known(win) || !known(next[key])) next[key] = win;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(next));
  } catch {
    // кэш — не повод ронять хук или подъём
  }
}

/** rate_limit_event потока claude -p → формат снимка; не то событие — null. utilization — доля (0.74 = 74%, сверено со statusline). */
function fromStreamEvent(e) {
  const windows = e && e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.unifiedWindows;
  if (!windows || typeof windows !== 'object') return null;
  const out = {};
  for (const [key, win] of Object.entries(windows)) {
    if (win && Number.isFinite(win.utilization)) out[key] = { used_percentage: Math.round(win.utilization * 1000) / 10, ...(Number.isFinite(win.resetsAt) ? { resets_at: win.resetsAt } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** → { five_hour?, seven_day?, at: мс записи } или null — снимка нет. */
function readSnapshot() {
  const data = readJson(SNAPSHOT);
  if (!data || typeof data !== 'object') return null;
  let at = 0;
  try {
    at = fs.statSync(SNAPSHOT).mtimeMs;
  } catch {
    return null;
  }
  const out = { at: Math.round(at) };
  for (const key of ['five_hour', 'seven_day']) if (known(data[key])) out[key] = { used_percentage: data[key].used_percentage, resets_at: Number.isFinite(data[key].resets_at) ? data[key].resets_at : null };
  return out;
}

module.exports = { SNAPSHOT, saveSnapshot, fromStreamEvent, readSnapshot };
