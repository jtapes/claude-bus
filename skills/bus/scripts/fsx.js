/**
 * Файловые мелочи шины, общие для bus, journal, wake, scheduler, settings и ui: атомарная запись, JSON, локи, живой ли pid,
 * лог с ротацией, время, сравнение путей.
 * Модуль лёгкий и ни от чего в шине не зависит: его грузит и хук inbox --hook на каждом промпте.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;
const FRESH_LOCK_MS = 2000; // лок раннера создаётся пустым (open wx) и тут же пишется: пустой и молодой — чужой раннер между этими шагами, а не мусор
const LOG_ROTATE_BYTES = 256 * 1024; // wake.log агента и лог задачи расписания

const samePath = (a, b) => path.relative(a, b) === '';

/** 2026-09-19 19:46:33 — в журнал, audit.log и логи запусков; short — 09-19 19:46, в строки, которые читает модель: год там лишние токены. */
function stamp(short = false, at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  const day = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return short ? `${day} ${time}` : `${d.getFullYear()}-${day} ${time}:${p(d.getSeconds())}`;
}

/** Запись через временный файл с pid и rename: читающий никогда не видит файл наполовину. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // на Windows файл в этот миг держит OneDrive, антивирус или читающий процесс — пишем поверх
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

/** Файла нет или он битый — fallback. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const writeJson = (file, data) => writeAtomic(file, JSON.stringify(data) + '\n');

/**
 * fn() под wx-локом: чтение-правка-запись файла, который правят несколько процессов. Ждём до LOCK_WAIT_MS,
 * лок старше LOCK_STALE_MS — от упавшего процесса. busy() → ошибка, если не дождались: свой класс у каждого модуля.
 */
function withLock(lock, fn, busy) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); // остался от упавшего процесса
      } catch {
        // лок успели снять — пробуем взять заново
      }
      if (Date.now() > deadline) throw busy();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // уже снят как протухший
    }
  }
}

/**
 * Дописать в файл, который никто не чистит: перевалил limit — уезжает в .1, прежний .1 затирается. Ротация — по возможности:
 * её сбой запись не срывает. carry(старый файл) → шо перенести в голову нового.
 * Ротация — под локом <файл>.lock и с повторной проверкой размера: два писателя на границе порога иначе ротировали оба,
 * и второй rename затирал .1 со всем старым свежим файлом из одной строки.
 */
function appendRotating(file, text, limit, carry = null) {
  try {
    if (fs.statSync(file).size > limit) {
      withLock(`${file}.lock`, () => {
        if (fs.statSync(file).size <= limit) return; // сосед ротировал, пока мы ждали лок
        fs.renameSync(file, `${file}.1`);
        if (carry) fs.appendFileSync(file, carry(`${file}.1`));
      }, () => new Error('ротация занята'));
    }
  } catch {
    // файла ещё нет, он занят или лок не дался — пишем как есть
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

const appendLog = (file, text) => appendRotating(file, text, LOG_ROTATE_BYTES);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // процесс есть, но не наш
  }
}

// ---------- лок раннера: { pid, at, timeoutMs? } — у подъёма агента (wake.js) и запуска задачи расписания ----------

/**
 * Лок держит живой раннер. Процесс умер или висит дольше своего таймаута с запасом — лок протух.
 * timeoutMs — если раннер не положил в лок свой (у проекта таймаут бывает свой, а каталога запуска здесь не знают).
 */
function lockHeld(file, timeoutMs) {
  const lock = readJson(file, null);
  if (!lock) return false;
  // Лок старше загрузки системы — от запуска, который оборвала перезагрузка: его pid Windows уже раздала кому-то другому
  if (lock.at < Date.now() - os.uptime() * 1000) return false;
  return alive(lock.pid) && Date.now() - lock.at < (Number(lock.timeoutMs) || timeoutMs) + 60 * 1000;
}

/**
 * Лок пишется в два шага: open(wx) создаёт пустой файл, write кладёт pid. Второй раннер, заглянувший между ними, видел «мусор»,
 * стирал живой лок и запускался параллельно. Пустой или недописанный лок моложе пары секунд — чужой раннер, а не мусор.
 */
function freshBlank(file) {
  if (readJson(file, null)) return false;
  try {
    return Date.now() - fs.statSync(file).mtimeMs < FRESH_LOCK_MS;
  } catch {
    return false; // лок уже сняли — занимай
  }
}

/** Взять лок раннера: record — его содержимое. Живой или только что созданный чужой — false: два запуска подряд, второй просто уходит. */
function takeRunLock(file, record, timeoutMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockHeld(file, timeoutMs) || freshBlank(file)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

/**
 * Процесс со всем, шо под ним. claude на Windows — .cmd-обёртка под cmd.exe: kill() снял бы только оболочку, сам claude жил бы дальше.
 * На posix отвязанный (detached) раннер — лидер группы: минус перед pid снимает группу целиком; не лидер — снимаем сам процесс.
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    require('child_process').spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // уже умер
    }
  }
}

module.exports = { samePath, stamp, writeAtomic, readJson, writeJson, withLock, appendRotating, appendLog, alive, lockHeld, freshBlank, takeRunLock, killTree };
