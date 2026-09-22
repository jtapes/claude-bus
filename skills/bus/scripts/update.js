/**
 * Обновление шины из GitHub Release. Проверка — один раз при старте UI, установка — по кнопке на странице.
 *
 * Метка версии — release.json в папке скилла: { version, repo, files }. Её пишет только сборка публичной копии, поэтому
 * там, где метки нет (исходник шины) или папка скилла — git-клон, обновление выключено и в сеть мы не ходим.
 *
 * Ставим без npx и git: дерево тега берём из API GitHub, файлы — с raw.githubusercontent.com (лимитом API он не считается),
 * каждый сверяем с git-хешем из дерева. Меняется только папка скилла: хуки в settings.json пользователя релиз не трогает.
 * Копия прежней папки — <папка>.backup, одна: новая установка её затирает. Сервер после установки живёт на старом коде до перезапуска.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BusError } = require('./bus.js');
const { tr } = require('./ui-i18n.js');

const SKILL_DIR = path.resolve(__dirname, '..');
const API = process.env.BUS_UPDATE_API || 'https://api.github.com'; // подменяют тесты: в сеть они не ходят
const RAW = process.env.BUS_UPDATE_RAW || 'https://raw.githubusercontent.com';
const CHECK_TIMEOUT_MS = 5000;
const FILE_TIMEOUT_MS = 20000;
const NOTES_LENGTH = 600;
const PREFIX = 'skills/bus/'; // где скилл лежит в репе релиза
const SEMVER = /^\d+\.\d+\.\d+$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const versionOf = (tag) => String(tag || '').replace(/^v/, '');
/** Сравнение x.y.z числами: «1.10.0» новее «1.9.0». */
function compare(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** release.json папки скилла или null: нет файла, битый JSON, кривая версия или repo — считаем, шо метки нет. */
function release(dir = SKILL_DIR) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
    if (!SEMVER.test(r.version) || !REPO.test(r.repo)) return null;
    return { version: r.version, repo: r.repo, files: Array.isArray(r.files) ? r.files.filter((f) => typeof f === 'string') : [] };
  } catch {
    return null;
  }
}

/** Путь файла из релиза — только внутрь папки скилла: без .., абсолютных путей, обратных слэшей и .git. */
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git');
}

async function get(url, timeoutMs) {
  const res = await fetch(url, { headers: { 'User-Agent': 'claude-bus', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}
const getJson = async (url, timeoutMs = CHECK_TIMEOUT_MS) => (await get(url, timeoutMs)).json();

/** git-хеш файла: так его считает git, и так он лежит в sha дерева. */
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/**
 * → { state: 'off' } — метки нет или папка под git; 'none' — стоит последняя; 'available' — есть новее (current, latest, notes, url, tag);
 * 'error' — не проверили (сеть, лимит API, мусор в ответе): кнопки нет, причина — в reason для консоли сервера.
 */
async function check({ dir = SKILL_DIR } = {}) {
  const current = release(dir);
  if (!current || fs.existsSync(path.join(dir, '.git'))) return { state: 'off' };
  try {
    const latest = await getJson(`${API}/repos/${current.repo}/releases/latest`);
    const version = versionOf(latest && latest.tag_name);
    if (!SEMVER.test(version)) throw new Error(`тег релиза «${String(latest && latest.tag_name).slice(0, 40)}» — не x.y.z`);
    if (compare(version, current.version) <= 0) return { state: 'none', current: current.version };
    const url = String(latest.html_url || '');
    return { state: 'available', current: current.version, latest: version, tag: latest.tag_name, notes: String(latest.body || '').slice(0, NOTES_LENGTH), url: url.startsWith('https://github.com/') ? url : '' };
  } catch (e) {
    return { state: 'error', current: current.version, reason: e.name === 'TimeoutError' ? 'таймаут' : e.message };
  }
}

/** Файлы тега под skills/bus/ → [{ rel, sha, url }]; путь наружу, симлинк или урезанное дерево — отказ до скачивания. */
async function listFiles(repo, tag) {
  const tree = await getJson(`${API}/repos/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`, FILE_TIMEOUT_MS);
  if (!tree || !Array.isArray(tree.tree)) throw new BusError(tr('GitHub вернул не дерево файлов релиза.'));
  if (tree.truncated) throw new BusError(tr('Дерево релиза пришло не целиком — не ставлю.'));
  const files = [];
  for (const entry of tree.tree) {
    if (typeof entry.path !== 'string' || !entry.path.startsWith(PREFIX)) continue;
    const rel = entry.path.slice(PREFIX.length);
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || entry.mode === '120000' || !safeRel(rel) || !/^[0-9a-f]{40}$/.test(entry.sha)) throw new BusError(tr('В релизе подозрительный путь: {path}. Не ставлю.', { path: entry.path.slice(0, 120) }));
    files.push({ rel, sha: entry.sha, url: `${RAW}/${repo}/${encodeURIComponent(tag)}/${entry.path.split('/').map(encodeURIComponent).join('/')}` });
  }
  if (!files.some((f) => f.rel === 'release.json')) throw new BusError(tr('В релизе нет release.json — после такой установки обновления бы кончились. Не ставлю.'));
  return files;
}

/** Файлы, которых нет в новом релизе, и опустевшие после них папки. */
function removeStale(dir, oldFiles, keep) {
  for (const rel of oldFiles) {
    if (!safeRel(rel) || keep.has(rel)) continue;
    fs.rmSync(path.join(dir, rel), { force: true });
    for (let parent = path.dirname(path.join(dir, rel)); parent.startsWith(dir + path.sep); parent = path.dirname(parent)) {
      try {
        fs.rmdirSync(parent); // не пустая — бросит, дальше вверх не идём
      } catch {
        break;
      }
    }
  }
}

/** Папка скилла из бэкапа: вернули прежние файлы, убрали появившиеся. */
function restore(dir, backup, written) {
  for (const rel of written) if (!fs.existsSync(path.join(backup, rel))) fs.rmSync(path.join(dir, rel), { force: true });
  fs.cpSync(backup, dir, { recursive: true, force: true });
}

/**
 * Ставит релиз tag поверх папки скилла. Всё качается во временную папку и сверяется с хешами, и только потом: бэкап → запись поверх →
 * удаление файлов, которых в релизе нет (чужие файлы пользователя в папке скилла не трогаем). Сбой записи — откат из бэкапа.
 * Папку целиком не переименовываем: на Windows rename падает, пока у демона расписания или раннера открыт хендл внутри.
 */
async function install({ dir = SKILL_DIR, tag } = {}) {
  const current = release(dir);
  if (!current || fs.existsSync(path.join(dir, '.git'))) throw new BusError(tr('Обновление тут выключено: нет release.json или папка скилла — git-клон.'));
  const version = versionOf(tag);
  if (!SEMVER.test(version)) throw new BusError(tr('Не знаю, до какой версии обновлять: проверка обновлений не прошла.'));

  const files = await listFiles(current.repo, tag);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-update-'));
  try {
    // allSettled, а не all: сорвался один файл — остальные ещё пишут во временную папку, и finally снёс бы её у них из-под ног
    const results = await Promise.allSettled(files.map(async (file) => {
      let buf;
      try {
        buf = Buffer.from(await (await get(file.url, FILE_TIMEOUT_MS)).arrayBuffer());
      } catch (e) {
        throw new BusError(tr('Не скачался {path}: {why}', { path: file.rel, why: e.name === 'TimeoutError' ? tr('таймаут') : e.message }));
      }
      if (blobSha(buf) !== file.sha) throw new BusError(tr('{path} скачался битым: хеш не сходится с релизом. Ничего не поменял.', { path: file.rel }));
      fs.mkdirSync(path.dirname(path.join(stage, file.rel)), { recursive: true });
      fs.writeFileSync(path.join(stage, file.rel), buf);
    }));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;

    const backup = `${dir}.backup`;
    fs.rmSync(backup, { recursive: true, force: true });
    fs.cpSync(dir, backup, { recursive: true });

    const written = [];
    try {
      for (const file of files) {
        const target = path.join(dir, file.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        written.push(file.rel);
        fs.copyFileSync(path.join(stage, file.rel), target);
      }
      removeStale(dir, current.files, new Set(files.map((f) => f.rel)));
    } catch (e) {
      try {
        restore(dir, backup, written);
      } catch (again) {
        throw new BusError(tr('Обновление сорвалось ({why}), и откат тоже: верни папку руками из {backup}.', { why: e.message, backup }));
      }
      throw new BusError(tr('Обновление сорвалось, вернул прежние файлы: {why}', { why: e.message }));
    }
    return { ok: true, from: current.version, version, backup };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { check, install, release, compare, safeRel, blobSha, SKILL_DIR };
