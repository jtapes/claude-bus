/**
 * Обновление шины из релиза (skills/bus/scripts/update.js) без сети: API GitHub и raw подменены локальным http-сервером
 * (BUS_UPDATE_API, BUS_UPDATE_RAW), папка скилла — во временном каталоге. Зовёт run-tests.js.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

module.exports = async function busUpdateTests({ sandbox, check, HOOKS }) {
  const SCRIPTS = path.resolve(HOOKS, '..', 'skills', 'bus', 'scripts');
  const root = path.join(sandbox, 'update');
  fs.mkdirSync(root, { recursive: true });

  // Подставной GitHub: releases/latest, дерево тега и raw-файлы. Что отдавать — меняет сценарий через fake
  const fake = { latest: { status: 200, body: { tag_name: 'v1.1.0', body: 'Что нового: кнопка', html_url: 'https://github.com/o/r/releases/tag/v1.1.0' } }, files: {}, tamper: null, extraTree: [] };
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/api/repos/o/r/releases/latest') return send(fake.latest.status, fake.latest.body);
    if (req.url.startsWith('/api/repos/o/r/git/trees/v1.1.0')) {
      const tree = Object.entries(fake.files).map(([rel, text]) => ({ path: `skills/bus/${rel}`, mode: '100644', type: 'blob', sha: blobSha(Buffer.from(text)) }));
      return send(200, { tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: '0'.repeat(40) }, { path: 'skills/bus/scripts', mode: '040000', type: 'tree', sha: '1'.repeat(40) }, ...tree, ...fake.extraTree], truncated: false });
    }
    const raw = /^\/raw\/o\/r\/v1\.1\.0\/skills\/bus\/(.+)$/.exec(req.url);
    if (raw) {
      const rel = decodeURIComponent(raw[1]);
      if (!(rel in fake.files)) return send(404, 'нет');
      return send(200, fake.tamper === rel ? `${fake.files[rel]} подменено` : fake.files[rel]);
    }
    send(404, 'нет');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { api: process.env.BUS_UPDATE_API, raw: process.env.BUS_UPDATE_RAW };
  process.env.BUS_UPDATE_API = `${base}/api`;
  process.env.BUS_UPDATE_RAW = `${base}/raw`;
  delete require.cache[require.resolve(path.join(SCRIPTS, 'update.js'))];
  const update = require(path.join(SCRIPTS, 'update.js'));

  let n = 0;
  /** Папка скилла «как у пользователя»: release.json 1.0.0 и файлы из списка. */
  const mkSkill = (files, release = { version: '1.0.0', repo: 'o/r', files: [...Object.keys(files), 'release.json'] }) => {
    const dir = path.join(root, `skill-${++n}`, 'bus');
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    if (release) fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));
    return dir;
  };
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const newRelease = JSON.stringify({ version: '1.1.0', repo: 'o/r', files: ['SKILL.md', 'scripts/bus.js', 'scripts/new.js', 'release.json'] });
  const releaseFiles = () => ({ 'SKILL.md': 'скилл 1.1.0', 'scripts/bus.js': 'bus 1.1.0', 'scripts/new.js': 'новый файл', 'release.json': newRelease });
  const oldFiles = { 'SKILL.md': 'скилл 1.0.0', 'scripts/bus.js': 'bus 1.0.0', 'scripts/gone.js': 'убран в 1.1.0', 'references/old.md': 'тоже убран' };

  try {
    // ---------- check ----------
    hits.length = 0;
    const noMark = await update.check({ dir: mkSkill({ 'SKILL.md': 'x' }, null) });
    const gitDir = mkSkill({ 'SKILL.md': 'x' });
    fs.mkdirSync(path.join(gitDir, '.git'));
    const underGit = await update.check({ dir: gitDir });
    check('W1 bus update check: нет release.json или папка скилла — git-клон → off, в сеть не ходим', noMark.state === 'off' && underGit.state === 'off' && hits.length === 0, JSON.stringify([noMark, underGit, hits]));

    const dir = mkSkill(oldFiles);
    const available = await update.check({ dir });
    check('W2 bus update check: релиз новее — available с версиями, заметками и ссылкой', available.state === 'available' && available.current === '1.0.0' && available.latest === '1.1.0' && available.tag === 'v1.1.0' && available.notes === 'Что нового: кнопка' && available.url.startsWith('https://github.com/'), JSON.stringify(available));

    fake.latest.body = { ...fake.latest.body, tag_name: 'v1.0.0' };
    const same = await update.check({ dir });
    fake.latest.body = { ...fake.latest.body, tag_name: 'v0.9.9' };
    const older = await update.check({ dir });
    fake.latest.body = { ...fake.latest.body, tag_name: 'v1.10.0', body: 'я'.repeat(2000), html_url: 'javascript:alert(1)' };
    const numeric = await update.check({ dir: mkSkill({}, { version: '1.9.0', repo: 'o/r', files: [] }) });
    check('W3 bus update check: такой же или старее — none; версии сравниваются числами (1.10 новее 1.9); заметки режутся до 600, ссылка не на github.com — выброшена', same.state === 'none' && older.state === 'none' && numeric.state === 'available' && numeric.latest === '1.10.0' && numeric.notes.length === 600 && numeric.url === '', JSON.stringify([same, older, { ...numeric, notes: numeric.notes.length }]));

    fake.latest = { status: 403, body: { message: 'API rate limit exceeded' } };
    const limited = await update.check({ dir });
    fake.latest = { status: 200, body: 'не json' };
    const garbage = await update.check({ dir });
    fake.latest = { status: 200, body: { tag_name: 'nightly' } };
    const badTag = await update.check({ dir });
    check('W4 bus update check: 403 лимита, мусор вместо JSON, тег не x.y.z — error с причиной, без исключения', [limited, garbage, badTag].every((r) => r.state === 'error' && r.reason), JSON.stringify([limited, garbage, badTag]));
    fake.latest = { status: 200, body: { tag_name: 'v1.1.0', body: '', html_url: '' } };

    // ---------- install ----------
    fs.writeFileSync(path.join(dir, 'my-notes.md'), 'файл пользователя');
    fake.files = releaseFiles();
    const done = await update.install({ dir, tag: 'v1.1.0' });
    const backup = `${dir}.backup`;
    check('W5 bus update install: файлы релиза встали, убранные из релиза удалены вместе с опустевшей папкой, файл пользователя цел, release.json новый',
      done.ok && done.version === '1.1.0' && done.from === '1.0.0' && read(path.join(dir, 'scripts', 'bus.js')) === 'bus 1.1.0' && read(path.join(dir, 'scripts', 'new.js')) === 'новый файл'
      && !fs.existsSync(path.join(dir, 'scripts', 'gone.js')) && !fs.existsSync(path.join(dir, 'references')) && read(path.join(dir, 'my-notes.md')) === 'файл пользователя' && update.release(dir).version === '1.1.0', JSON.stringify(done) + fs.readdirSync(dir).join(','));
    check('W6 bus update install: копия прежней папки — в bus.backup рядом, со старыми файлами', read(path.join(backup, 'scripts', 'bus.js')) === 'bus 1.0.0' && read(path.join(backup, 'scripts', 'gone.js')) === 'убран в 1.1.0' && JSON.parse(read(path.join(backup, 'release.json'))).version === '1.0.0', String(fs.existsSync(backup)));

    const snapshot = (d) => JSON.stringify(fs.readdirSync(d, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(d, f)).isFile() ? read(path.join(d, f)) : '']));
    const untouched = mkSkill(oldFiles);
    const before = snapshot(untouched);
    fake.tamper = 'scripts/bus.js';
    const tampered = await update.install({ dir: untouched, tag: 'v1.1.0' }).catch((e) => e);
    fake.tamper = null;
    check('W7 bus update install: подменённый по дороге файл (хеш не сошёлся) — отказ с именем файла, папка скилла и бэкап не тронуты', tampered instanceof Error && tampered.message.includes('scripts/bus.js') && tampered.message.includes('хеш') && snapshot(untouched) === before && !fs.existsSync(`${untouched}.backup`), tampered.message);

    let refused = [];
    for (const evil of ['skills/bus/../../evil.js', 'skills/bus/scripts/..\\..\\evil.js', 'skills/bus/.git/config']) {
      fake.extraTree = [{ path: evil, mode: '100644', type: 'blob', sha: 'a'.repeat(40) }];
      refused.push(await update.install({ dir: untouched, tag: 'v1.1.0' }).catch((e) => e));
    }
    fake.extraTree = [{ path: 'skills/bus/link', mode: '120000', type: 'blob', sha: 'a'.repeat(40) }];
    refused.push(await update.install({ dir: untouched, tag: 'v1.1.0' }).catch((e) => e));
    fake.extraTree = [];
    check('W8 bus update install: путь с .. или обратным слэшем, .git и симлинк в дереве — отказ до скачивания, папка не тронута, наружу ничего не записано',
      refused.every((e) => e instanceof Error && e.message.includes('подозрительный путь')) && snapshot(untouched) === before && !fs.existsSync(path.join(root, 'evil.js')), refused.map((e) => e.message).join(' | '));

    fake.files = { ...releaseFiles() };
    delete fake.files['release.json'];
    const noMarkRelease = await update.install({ dir: untouched, tag: 'v1.1.0' }).catch((e) => e);
    const offInstall = await update.install({ dir: gitDir, tag: 'v1.1.0' }).catch((e) => e);
    check('W9 bus update install: в релизе нет release.json — отказ; обновление выключено (git-клон) — отказ', noMarkRelease instanceof Error && noMarkRelease.message.includes('release.json') && offInstall instanceof Error && offInstall.message.includes('выключено') && snapshot(untouched) === before, `${noMarkRelease.message} | ${offInstall.message}`);

    check('W10 bus update: safeRel пускает только пути внутрь папки скилла', update.safeRel('scripts/a.js') && !update.safeRel('../a') && !update.safeRel('/etc/passwd') && !update.safeRel('C:/x') && !update.safeRel('a//b') && !update.safeRel('a/./b') && !update.safeRel('.git/HEAD'));
  } finally {
    server.close();
    if (saved.api === undefined) delete process.env.BUS_UPDATE_API;
    else process.env.BUS_UPDATE_API = saved.api;
    if (saved.raw === undefined) delete process.env.BUS_UPDATE_RAW;
    else process.env.BUS_UPDATE_RAW = saved.raw;
  }
};
