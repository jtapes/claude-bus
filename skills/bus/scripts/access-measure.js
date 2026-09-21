#!/usr/bin/env node
/**
 * Замер цены доступа агента: сколько токенов занимает первый ход фонового подъёма при каждом сочетании снятых групп.
 * Форма агента в UI берёт отсюда итог и дельты у галочек. Формулой не обойтись — веса групп не складываются:
 * замер 21.09.2026 — снятый в одиночку Skill прибавляет ≈2.5к, а «снято всё» экономит 13.4к при сумме по группам 9.3к.
 *
 * Зовёт НАСТОЯЩИЙ claude: 2^7 = 128 запусков на haiku, ≈$0.003 каждый — около $0.4 и пяти минут.
 * Цифры зависят от машины (скиллы, плагины, user-scope MCP, версия CLI) — после заметных перемен перемерь.
 * Меряем во временном каталоге теми же флагами, шо и wake.js, глобальные CLAUDE.md и rules/ исключены так же.
 * Каждому сочетанию — свой каталог с одним определением: тул Agent перечисляет агентов каталога в своём описании,
 * и 128 соседей в одной папке раздули бы группу «субагенты» втрое (так и вышло на первом прогоне).
 * MCP — одной группой «все серверы»: лениво загруженный сервер весит десятки токенов, дробить нечего.
 *
 * Запуск: node access-measure.js [--model haiku] [--parallel 8] [--out <файл>] [--dry]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const bus = require('./bus.js');
const wake = require('./wake.js');

const OUT = path.join(__dirname, 'access-weights.json');
const ORDER = [...bus.ACCESS_GROUPS.map((group) => group.key), 'mcp']; // ключ сочетания — снятые группы через «+» в этом порядке
const TIMEOUT_MS = 3 * 60 * 1000;

function option(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  return at < 0 ? fallback : argv[at + 1];
}

/** Все сочетания снятых групп: от «ничего не снято» до «снято всё». */
function combos() {
  return Array.from({ length: 2 ** ORDER.length }, (_, mask) => ORDER.filter((_key, bit) => mask & (1 << bit)));
}

function definition(name, off, model) {
  const line = bus.deniedLine(off.map((key) => (key === 'mcp' ? 'mcp:*' : key)));
  return ['---', `name: ${name}`, 'description: временный агент замера доступа', `model: ${model}`, ...(line ? [`disallowedTools: ${line}`] : []), '---', '', 'Ты агент для замера. Ответь одним словом: ок.', ''].join('\n');
}

async function main(argv) {
  const model = option(argv, '--model', 'haiku');
  const parallel = Math.max(1, Number(option(argv, '--parallel', 8)) || 8);
  const out = path.resolve(option(argv, '--out', OUT));
  const all = combos();
  if (argv.includes('--dry')) return console.log(`Сочетаний: ${all.length}, модель ${model}, по ${parallel} параллельно → ${out}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-access-'));
  const contexts = {};
  const failed = [];
  try {
    const home = bus.CONFIG_DIR.split(path.sep).join('/');
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ claudeMdExcludes: [`${home}/CLAUDE.md`, `${home}/rules/**`] }));
    const cwdOf = (i) => path.join(dir, String(i));
    all.forEach((off, i) => {
      fs.mkdirSync(path.join(cwdOf(i), '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(cwdOf(i), '.claude', 'agents', 'access.md'), definition('access', off, model));
    });

    let next = 0;
    const worker = async () => {
      while (next < all.length) {
        const i = next++;
        const key = all[i].join('+');
        let r = null;
        for (let attempt = 0; attempt < 2 && !(r && r.ok && r.context); attempt++) r = await wake.runClaude({ cwd: cwdOf(i), agent: 'access', settings, prompt: 'привет', timeoutMs: TIMEOUT_MS });
        if (r.ok && r.context) contexts[key] = r.context;
        else failed.push(`${key || '(всё доступно)'}: ${r.reason || 'нет usage в ответе'}`);
        process.stdout.write(`\r${Object.keys(contexts).length + failed.length}/${all.length}`);
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write('\n');
  if (failed.length) {
    console.error(`Не замерилось ${failed.length} из ${all.length} — таблица не записана:\n${failed.slice(0, 5).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const { spawnSync } = require('child_process');
  const cli = (String(spawnSync(`${process.env.BUS_CLAUDE_CMD || 'claude'} --version`, { shell: true, encoding: 'utf8', windowsHide: true }).stdout).match(/\d+\.\d+\.\d+/) || [''])[0];
  fs.writeFileSync(out, JSON.stringify({ measured: new Date().toLocaleDateString('sv-SE'), cli, model, order: ORDER, contexts }, null, 1) + '\n');
  console.log(`Записано: ${out}. Всё доступно — ${contexts['']}, снято всё — ${contexts[ORDER.join('+')]}.`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
