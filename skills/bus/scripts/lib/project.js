/**
 * Корень и имя проекта для хуков.
 *
 * Корень ищем от CLAUDE_PROJECT_DIR (каталог, где стартовала сессия), а не от hook.cwd:
 * cwd «ходит» за Claude после каждого cd, и имя проекта менялось бы на случайную подпапку.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKERS = ['.git', 'package.json', 'CLAUDE.md', '.claude'];

/** Ближайший вверх каталог с маркером проекта. Домашняя папка проектом не считается. */
function projectRoot(hook = {}) {
  const home = os.homedir();
  const start = path.resolve(process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd());

  for (let dir = start; ; dir = path.dirname(dir)) {
    if (path.relative(dir, home) === '') return null;
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Имя проекта для уведомлений. */
function projectName(hook = {}) {
  return path.basename(projectRoot(hook) || hook.cwd || process.cwd());
}

module.exports = { projectRoot, projectName };
