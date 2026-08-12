#!/usr/bin/env node
// ПРЕДДЕПЛОЙНАЯ ПРОВЕРКА МЕЖМОДУЛЬНЫХ ВЫЗОВОВ: каждый `MCP_Модуль.Метод(` в
// репозитории обязан указывать на СУЩЕСТВУЮЩУЮ ЭКСПОРТНУЮ процедуру или функцию
// этого модуля.
//
// Зачем отдельная проверка. Конфигуратор межмодульные вызовы не разрешает: он
// компилирует модуль, а «метод не найден» выдаёт в рантайме, на конкретной
// ветке. Именно так волна 2 дважды уезжала на контур и откатывалась — сервер
// публиковался успешно и был мёртв. bsl_predeploy_check смотрит модуль изнутри,
// bsl_call_resolution — вызовы внутри модуля; эта проверка закрывает третий
// класс: удалили экспортную функцию, а вызов из соседнего модуля остался.
//
// Проверка обязательна в двух случаях:
//   • из общего модуля удалена или переименована экспортная функция;
//   • публикуется подмножество комплекта (см. required_modules.manifest.json).
//
//   node scripts/bsl_cross_module_calls.mjs [<корень src>]
//
// Код возврата: 0 — все вызовы разрешаются, 1 — есть висячие.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

const root = process.argv[2] || "src";

function bslFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...bslFiles(path));
    else if (extname(entry).toLowerCase() === ".bsl") out.push(path);
  }
  return out;
}

// Комментарии снимаются построчно; строковые литералы сохраняются — вызов
// внутри литерала невозможен, а текст запроса может содержать точки и скобки,
// которые regexp вызова не путают.
const stripComments = (src) =>
  src.split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, "")).join("\n");

const WORD = "А-Яа-яЁёA-Za-z_0-9";
const declRe = new RegExp(
  `^[ \\t]*(?:Функция|Процедура)[ \\t]+([${WORD}]+)[ \\t]*\\([^)]*\\)[ \\t]*Экспорт`,
  "gimu",
);
const callRe = new RegExp(`\\b(MCP_[${WORD}]+)\\.([${WORD}]+)[ \\t]*\\(`, "gu");

let files;
try {
  files = bslFiles(root);
} catch (error) {
  console.error(`Не прочитан каталог ${root}: ${error.message}`);
  process.exit(2);
}

// Экспортный контракт каждого модуля. Ключ — имя файла без расширения: общие
// модули лежат как <Имя>.bsl, поэтому имя файла и есть имя модуля.
const exported = new Map();
const sources = new Map();
for (const path of files) {
  const src = stripComments(readFileSync(path, "utf8"));
  sources.set(path, src);
  const names = new Set();
  for (const m of src.matchAll(declRe)) names.add(m[1].toUpperCase());
  exported.set(basename(path, ".bsl"), names);
}

const dangling = [];
const seen = new Set();
let callCount = 0;
for (const [path, src] of sources) {
  const caller = basename(path, ".bsl");
  for (const m of src.matchAll(callRe)) {
    const [, moduleName, methodName] = m;
    // Вызов внутри своего модуля через собственное имя — законная форма.
    if (moduleName === caller) continue;
    // Модуля нет в репозитории: он может жить в основной конфигурации базы
    // (например MCP_MaskingRule как обработка) — не наша забота.
    if (!exported.has(moduleName)) continue;
    callCount += 1;
    if (exported.get(moduleName).has(methodName.toUpperCase())) continue;
    const key = `${caller}|${moduleName}.${methodName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dangling.push({ caller, moduleName, methodName });
  }
}

console.log(`[cross-calls] модулей: ${files.length}, разрешаемых межмодульных вызовов: ${callCount}`);
if (dangling.length === 0) {
  console.log("[cross-calls] ✔ висячих вызовов нет — экспортный контракт согласован");
  process.exit(0);
}

console.log("[cross-calls] ✘ ВИСЯЧИЕ ВЫЗОВЫ (публикация даст «метод не найден» в рантайме):");
for (const item of dangling) {
  console.log(`[cross-calls]   ${item.caller} → ${item.moduleName}.${item.methodName} — экспортной функции нет`);
}
process.exit(1);
