/**
 * Шина отдельным окном: Chrome или Edge в режиме --app — окно без вкладок, своя иконка в панели задач, зум по Ctrl как в браузере.
 * Сервер тот же — bus.js ui на 127.0.0.1, окно лишь открывает его адрес; нет Chrome или Edge — обычная вкладка (решает ui.js).
 * Ярлык приложения: Windows — .lnk на рабочем столе (conhost --headless запускает node без консольного окна), macOS —
 * Claude Bus.app в ~/Applications (Launchpad, Spotlight), Linux — .desktop в меню приложений и на рабочем столе.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJson, writeJson } = require('./fsx.js');

const BUS_JS = path.join(__dirname, 'bus.js');
const ASSETS = path.join(__dirname, '..', 'assets');
const ICON = path.join(ASSETS, 'bus.ico');
const SHORTCUT = 'Claude Bus.lnk'; // имя без языка: ярлык ставит CLI, а у него языка страницы нет
const APP_NAME = 'Claude Bus';
const DESKTOP_FILE = 'claude-bus.desktop';
const MARK = 'app-shortcut.json'; // в каталоге шины: ярлык уже ставили — удалённый руками сам не вернётся
const PLATFORMS = ['win32', 'darwin', 'linux']; // где умеем ярлык

/** Где искать браузер с режимом --app: сначала Chrome, потом Edge (на Windows он есть почти всегда). */
function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES || env.ProgramFiles, env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)']].filter(Boolean);
    const at = (...tail) => roots.map((root) => path.win32.join(root, ...tail));
    return [...at('Google', 'Chrome', 'Application', 'chrome.exe'), ...at('Microsoft', 'Edge', 'Application', 'msedge.exe')];
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', path.posix.join(env.HOME || os.homedir(), 'Applications')];
    return ['Google Chrome', 'Microsoft Edge', 'Chromium'].flatMap((name) => apps.map((dir) => path.posix.join(dir, `${name}.app`, 'Contents', 'MacOS', name)));
  }
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].flatMap((name) => dirs.map((dir) => path.posix.join(dir, name)));
}

/** BUS_APP_BROWSER — свой путь к браузеру (или «none» — окна не будет, только вкладка). */
function findBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.BUS_APP_BROWSER) return env.BUS_APP_BROWSER === 'none' ? null : env.BUS_APP_BROWSER;
  return browserCandidates(platform, env).find((file) => exists(file)) || null;
}

// ---------- размер и место окна ----------
// Сам Chrome место --app-окна не возвращает. Поэтому окно шлёт свою геометрию в ui.js (POST /api/window), та ложится сюда,
// и следующее окно открывается таким же: флагами, если браузер запускается заново, а уже запущенный Chrome флаги окна
// пропускает — тогда страница сама берёт GET /api/window и делает resizeTo/moveTo. Зум Chrome помнит сам — по хосту 127.0.0.1.
const WINDOW = 'app-window.json'; // в каталоге шины
const APP_QUERY = '/?app=1'; // по нему страница знает, шо она в окне, а не во вкладке

/** Геометрия от страницы: целые в разумных пределах, иначе null. Свёрнутое окно Windows уводит в -32000 — такое не берём. */
function cleanWindow(g) {
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!g || typeof g !== 'object' || !int(g.w, 400, 16384) || !int(g.h, 300, 16384) || !int(g.x, -16384, 16384) || !int(g.y, -16384, 16384)) return null;
  return { x: g.x, y: g.y, w: g.w, h: g.h };
}

const loadWindow = (busDir) => cleanWindow(readJson(path.join(busDir, WINDOW), null));

/** → true, если записали. Кривое — молча мимо: страница шлёт раз в пару секунд, ругаться на каждый раз незачем. */
function saveWindow(busDir, g) {
  const win = cleanWindow(g);
  if (!win) return false;
  writeJson(path.join(busDir, WINDOW), win);
  return true;
}

/** Окно за экраном (отключили монитор) Chrome не прижимает — страница вернёт его сама, см. keepOnScreen в ui.html. */
const appArgs = (url, win = null) => [`--app=${url.replace(/\/$/, '')}${APP_QUERY}`, win ? `--window-size=${win.w},${win.h}` : '--window-size=1400,900', ...(win ? [`--window-position=${win.x},${win.y}`] : [])];

/** → путь браузера, если окно открыто; null — браузера с --app нет, пусть открывают вкладку. win — из loadWindow. */
function openApp(url, win = null) {
  const browser = findBrowser();
  if (!browser) return null;
  try {
    spawn(browser, appArgs(url, win), { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return browser;
  } catch {
    return null;
  }
}

// ---------- Windows: .lnk через PowerShell ----------

/** Что пишем в ярлык. Путь к node — текущий: сменил установку node — пересоздай ярлык (bus.js ui --shortcut). */
function shortcutPlan({ node = process.execPath, env = process.env, home = os.homedir() } = {}) {
  const system = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return {
    target: path.win32.join(system, 'System32', 'conhost.exe'),
    args: `--headless "${node}" "${BUS_JS}" ui --app`,
    cwd: home,
    icon: `${ICON},0`,
    description: 'Claude Code agent bus',
  };
}

/** Скрипт PowerShell: рабочий стол берём у Windows — он бывает перенесён в OneDrive. dir — свой каталог вместо рабочего стола (тесты). */
function shortcutScript(plan, dir) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$dir = ${dir ? q(dir) : "[Environment]::GetFolderPath('Desktop')"}`,
    `$file = Join-Path $dir ${q(SHORTCUT)}`,
    '$was = [int](Test-Path -LiteralPath $file)',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($file)',
    `$s.TargetPath = ${q(plan.target)}`,
    `$s.Arguments = ${q(plan.args)}`,
    `$s.WorkingDirectory = ${q(plan.cwd)}`,
    `$s.IconLocation = ${q(plan.icon)}`,
    `$s.Description = ${q(plan.description)}`,
    '$s.Save()',
    '[Console]::Out.Write("$was|$file")',
  ].join('\n');
}

function windowsShortcut(env) {
  const script = shortcutScript(shortcutPlan({ env }), env.BUS_SHORTCUT_DIR || '');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n')[0] || `powershell вышел с кодом ${r.status}`);
  const [was, ...rest] = r.stdout.trim().split('|');
  return { file: rest.join('|'), replaced: was === '1' };
}

// ---------- Linux: .desktop ----------

/**
 * Аргумент Exec по спецификации Desktop Entry: в кавычках экранируются " ` $ \, а потом строковое правило удваивает
 * каждый \ ещё раз; % — поле подстановки, литерал — %%.
 */
const execArg = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');

function desktopEntry({ node = process.execPath, icon = path.join(ASSETS, 'bus.png') } = {}) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Claude Code agent bus',
    `Exec=${execArg(node)} ${execArg(BUS_JS)} ui --app`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupNotify=false',
    '',
  ].join('\n');
}

/** Рабочий стол: xdg-user-dir знает локализованное имя («Рабочий стол»); нет утилиты — ~/Desktop, если есть. Домашнюю папку не берём. */
function linuxDesktopDir(home) {
  const r = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' });
  const dir = r.status === 0 ? r.stdout.trim() : path.join(home, 'Desktop');
  return dir && fs.existsSync(dir) && path.relative(dir, home) !== '' ? dir : null;
}

function linuxShortcut(env, home) {
  const base = env.BUS_SHORTCUT_DIR;
  const apps = base ? path.join(base, 'applications') : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'applications');
  const desk = base ? path.join(base, 'Desktop') : linuxDesktopDir(home);
  const file = path.join(apps, DESKTOP_FILE);
  const replaced = fs.existsSync(file);
  const text = desktopEntry();
  const written = [];
  for (const dir of [apps, desk].filter(Boolean)) {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, DESKTOP_FILE);
    fs.writeFileSync(target, text, { mode: 0o755 });
    fs.chmodSync(target, 0o755); // mode при записи срабатывает только для нового файла
    written.push(target);
  }
  // GNOME запускает ярлык с рабочего стола только «доверенным»; нет gio — спросит разок сам
  if (desk && !base) spawnSync('gio', ['set', path.join(desk, DESKTOP_FILE), 'metadata::trusted', 'true']);
  return { file, replaced, also: written.slice(1) };
}

// ---------- macOS: Claude Bus.app ----------

/** sh: путь в одинарных кавычках, кавычка внутри — '\''. */
const shArg = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function macLauncher({ node = process.execPath } = {}) {
  return `#!/bin/sh\n# Claude Bus: UI шины отдельным окном. Сменил установку node — пересоздай: bus.js ui --shortcut\nexec ${shArg(node)} ${shArg(BUS_JS)} ui --app >/dev/null 2>&1\n`;
}

/** LSUIElement — у запускалки нет своей иконки в Dock: окно Chrome приходит со своей. */
function macPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>io.github.jtapes.claude-bus</string>
  <key>CFBundleExecutable</key><string>claude-bus</string>
  <key>CFBundleIconFile</key><string>bus.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

function macShortcut(env, home) {
  const app = path.join(env.BUS_SHORTCUT_DIR || path.join(home, 'Applications'), `${APP_NAME}.app`);
  const replaced = fs.existsSync(app);
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), macPlist());
  const launcher = path.join(contents, 'MacOS', 'claude-bus');
  fs.writeFileSync(launcher, macLauncher(), { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  fs.copyFileSync(path.join(ASSETS, 'bus.icns'), path.join(contents, 'Resources', 'bus.icns'));
  spawnSync('touch', [app]); // Finder перечитает иконку
  return { file: app, replaced };
}

/** Ставит или перезаписывает ярлык. → { file, replaced, also? }; не вышло — Error с причиной. BUS_SHORTCUT_DIR — свой каталог (тесты). */
function makeShortcut({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') return windowsShortcut(env);
  if (platform === 'darwin') return macShortcut(env, home);
  if (platform === 'linux') return linuxShortcut(env, home);
  throw new Error(`ярлык на ${platform} не умеем — запускай bus.js ui --app`);
}

/**
 * Ярлык при первом запуске шины (ui или init): у `npx skills add` нет шага установки, ставим сами — один раз на каталог шины.
 * BUS_SHORTCUT=0 — не ставить (тесты: рабочий стол у Windows настоящий, домашнюю папку тесты подменяют, а его — нет).
 * → { file } | { error } | null — не ставили.
 */
function autoShortcut(busDir, env = process.env) {
  if (!PLATFORMS.includes(process.platform) || env.BUS_SHORTCUT === '0') return null;
  const mark = path.join(busDir, MARK);
  if (fs.existsSync(mark)) return null;
  let result;
  try {
    result = { file: makeShortcut({ env }).file };
  } catch (e) {
    result = { error: e.message };
  }
  try {
    fs.mkdirSync(busDir, { recursive: true });
    fs.writeFileSync(mark, JSON.stringify({ ...result, at: new Date().toISOString() }) + '\n'); // и при сбое: не пробовать на каждом старте
  } catch {
    // без отметки попробуем в следующий раз — не беда
  }
  return result;
}

module.exports = { SHORTCUT, DESKTOP_FILE, APP_NAME, MARK, WINDOW, PLATFORMS, browserCandidates, findBrowser, cleanWindow, loadWindow, saveWindow, appArgs, openApp, shortcutPlan, shortcutScript, desktopEntry, execArg, macLauncher, macPlist, makeShortcut, autoShortcut };
