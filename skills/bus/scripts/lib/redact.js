/**
 * Маскирование секретов в тексте, который уходит в файл или в Telegram.
 *
 * Два слоя:
 *   1) по значению — всё из process.env, чьё имя похоже на секрет. Ключи живут в settings.json -> env,
 *      поэтому новый ключ покрывается сам, без правки этого файла;
 *   2) по формату — известные префиксы ключей и креды внутри URL, на случай если значения в env нет.
 */

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PROXY_URL/i;
const MIN_LENGTH = 8; // короче — скорее флаг или число, чем секрет
const URL_PART_MIN_LENGTH = 5; // логин/пароль прокси короче обычного ключа; ещё короче — начнём резать обычные слова
const MASK = '[REDACTED]';

const PATTERNS = [
  /sk_[0-9a-zA-Z]{20,}/g,
  /figd_[0-9a-zA-Z_-]{20,}/g,
  /fc-[0-9a-f]{20,}/g,
  /plane_api_[0-9a-f]{20,}/g,
  /\b\d{8,10}:AA[0-9A-Za-z_-]{30,}\b/g,
  /AQVN[0-9A-Za-z_-]{20,}/g,
];

// login:password внутри URL: схему и хост оставляем, креды режем
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;

/** Логин и пароль из значения-URL: скилл proxy разбирает PROXY_URL на части, и они всплывают по отдельности. */
function urlCredentials(value) {
  try {
    const { username, password } = new URL(value);
    return [username, password].map(decodeURIComponent).filter((part) => part.length >= URL_PART_MIN_LENGTH);
  } catch {
    return [];
  }
}

function secretValues(env = process.env) {
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= MIN_LENGTH)
    .flatMap(([, value]) => [value, ...urlCredentials(value)]);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function redact(text, env = process.env) {
  let out = String(text);
  for (const value of secretValues(env)) out = out.split(value).join(MASK);
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  return out.replace(URL_CREDENTIALS, `$1${MASK}@`);
}

module.exports = { redact, secretValues };
