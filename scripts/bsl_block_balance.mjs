#!/usr/bin/env node
// Баланс блоков BSL-модуля по токенам.
//
// Разбор литералов и комментариев — общий модуль bsl_lines.mjs (ТЗ-1 R-2/R-4):
// собственная построчная копия сканера здесь считала ключевые слова ВНУТРИ
// многострочных литералов и давала на MCP_LegalSources ложное «Если 19/13,
// Цикл 19/6». Баланс считается по тексту ПОСЛЕ снятия литералов и комментариев.
//
// Использование: node scripts/bsl_block_balance.mjs <файл.bsl> [...] | --all

import { readFileSync } from "node:fs";
import { scanBsl, targetsFromArgv } from "./bsl_lines.mjs";

const { files, all } = targetsFromArgv(process.argv.slice(2));
if (files.length === 0) {
  console.error("Usage: node scripts/bsl_block_balance.mjs <файл.bsl> [...] | --all");
  process.exit(2);
}

let failed = 0;

for (const path of files) {
  const { clean } = scanBsl(readFileSync(path, "utf8"));

  // ТОКЕНИЗАЦИЯ: перекрытие невозможно, КонецЕсли — отдельный токен от Если
  const tok = clean.split(/[^\p{L}\p{N}_]+/u).filter(Boolean).map((t) => t.toUpperCase());
  const c = (w) => tok.filter((t) => t === w).length;
  const rows = [
    ["Процедура", c("ПРОЦЕДУРА"), c("КОНЕЦПРОЦЕДУРЫ")],
    ["Функция", c("ФУНКЦИЯ"), c("КОНЕЦФУНКЦИИ")],
    ["Если", c("ЕСЛИ"), c("КОНЕЦЕСЛИ")],
    ["Цикл", c("ДЛЯ") + c("ПОКА"), c("КОНЕЦЦИКЛА")],
    ["Попытка", c("ПОПЫТКА"), c("КОНЕЦПОПЫТКИ")],
  ];

  const bad = rows.filter(([, o, cl]) => o !== cl);
  if (all) {
    if (bad.length > 0) {
      failed = 1;
      console.log(`  ✘ ${path}: ${bad.map(([n, o, cl]) => `${n} ${o}/${cl}`).join(", ")}`);
    }
    continue;
  }

  if (files.length > 1) console.log(`\n${path}`);
  for (const [n, o, cl] of rows) {
    if (o !== cl) failed = 1;
    console.log(`  ${o === cl ? "✔" : "✘"} ${n.padEnd(10)} ${o} / ${cl}`);
  }
  console.log(`  ИначеЕсли: ${c("ИНАЧЕЕСЛИ")} (отдельный токен, блок не открывает)`);
  console.log(`  Перем: ${c("ПЕРЕМ")}`);
}

if (all) {
  console.log(failed === 0
    ? `  ✔ баланс блоков сошёлся во всех файлах: ${files.length}`
    : `  ✘ файлов с несошедшимся балансом есть выше (всего проверено ${files.length})`);
}
process.exit(failed);
