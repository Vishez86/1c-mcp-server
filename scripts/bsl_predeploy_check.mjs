#!/usr/bin/env node
// Предполётные статические проверки BSL-модуля перед публикацией.
// НЕ заменяет компилятор 1С: ловит только то, что видно из текста модуля.
//
// Использование: node scripts/bsl_predeploy_check.mjs <модуль.bsl> [...] | --all
// Код возврата: 0 — замечаний нет, 1 — есть.

import { readFileSync } from "node:fs";
import { scanBsl, targetsFromArgv } from "./bsl_lines.mjs";

const { files, all } = targetsFromArgv(process.argv.slice(2));
if (files.length === 0) {
  console.error("Usage: node scripts/bsl_predeploy_check.mjs <файл.bsl> [...] | --all");
  process.exit(2);
}

let exitCode = 0;
for (const path of files) {
  // Имя файла печатает сам checkFile — и только когда есть что показать.
  if (files.length > 1 && !all) console.log(`\n${path}`);
  if (checkFile(path, all)) exitCode = 1;
}
if (all) {
  console.log(exitCode === 0
    ? `\n  ✔ предполётные проверки пройдены на всех файлах: ${files.length}`
    : `\n  ✘ есть провалы (проверено файлов: ${files.length})`);
}
process.exit(exitCode);

function checkFile(path, quietWhenClean) {
  const src = readFileSync(path, "utf8");
  // Разбор литералов и комментариев — общий модуль bsl_lines.mjs (ТЗ-1 R-2):
  // прежняя построчная копия сбрасывала флаг «внутри строки» на каждой строке
  // и потому не понимала многострочный литерал с продолжением через «|».
  // Кавычки СОХРАНЯЮТСЯ: иначе вызов Ф("текст") выглядит как Ф() и проверка
  // арности даёт ложное срабатывание.
  const { rawLines: lines, cleanLines, clean, unclosed } = scanBsl(src);

  let fail = 0;
  const messages = [];
  function report(ok, name, detail) {
    if (!ok) fail = 1;
    messages.push(`  ${ok ? "✔" : "✘"} ${name}${detail ? " — " + detail : ""}`);
  }

const WORD = "\\p{L}\\p{N}_";
// \b в JS основан на ASCII: после кириллического слова границы нет и условие
// не срабатывает никогда. Границы слова проверяются явным lookahead/lookbehind.
const NB = `(?<![${WORD}.])`;
const NA = `(?![${WORD}])`;

// ── A. Дублирующиеся объявления (ошибка компиляции) ─────────────────────────
const declRe = new RegExp(`^[ \\t]*(Функция|Процедура)[ \\t]+([${WORD}]+)[ \\t]*\\(([^)]*)\\)`, "gimu");
const decls = [...clean.matchAll(declRe)].map((m) => ({
  kind: m[1].toLowerCase(),
  name: m[2],
  params: m[3],
}));
const byName = new Map();
const duplicates = [];
for (const d of decls) {
  const key = d.name.toUpperCase();
  if (byName.has(key)) duplicates.push(d.name);
  else byName.set(key, d);
}
report(duplicates.length === 0, "нет дублирующихся имён",
  duplicates.length ? [...new Set(duplicates)].join(", ") : `объявлений: ${decls.length}`);

// ── B + C. Возврат: процедура не возвращает значение, функция возвращает ────
// Однопроходный разбор потока ключевых слов. Построчная привязка не годится:
// тело функции может целиком лежать в одной строке
// (Функция Ф(Т) \n С = Слово(Т); Возврат С = "X"; \n КонецФункции).
const lineStarts = [0];
for (let i = 0; i < clean.length; i++) if (clean[i] === "\n") lineStarts.push(i + 1);
const lineOf = (idx) => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
};

const scanRe = new RegExp(
  `${NB}(Функция|Процедура|Возврат|КонецФункции|КонецПроцедуры)${NA}`, "giu");
const nameAfterRe = new RegExp(`^[ \\t]+([${WORD}]+)`, "u");

const procReturns = [];
const noReturn = [];
let cur = null;
let m;
while ((m = scanRe.exec(clean)) !== null) {
  const kw = m[1].toLowerCase();
  if (kw === "функция" || kw === "процедура") {
    const tail = clean.slice(m.index + m[1].length, m.index + m[1].length + 80);
    const nm = nameAfterRe.exec(tail);
    cur = { kind: kw, name: nm ? nm[1] : "<без имени>", ret: false };
  } else if (kw === "возврат") {
    if (!cur) continue;
    cur.ret = true;
    // Значение возвращается, если сразу за словом идёт не «;» и не конец строки.
    const rest = clean.slice(m.index + m[1].length);
    if (cur.kind === "процедура" && /^[ \t]*[^;\s]/.test(rest)) {
      procReturns.push(`${cur.name}:${lineOf(m.index)}`);
    }
  } else {
    if (cur && kw === "конецфункции" && cur.kind === "функция" && !cur.ret) {
      noReturn.push(cur.name);
    }
    cur = null;
  }
}
report(procReturns.length === 0, "процедуры не возвращают значение", procReturns.join(", "));
report(noReturn.length === 0, "каждая функция имеет Возврат", noReturn.join(", "));

// ── D. Число аргументов в вызовах локальных процедур и функций ──────────────
function splitTopLevel(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}
function arity(d) {
  const p = d.params.trim();
  if (!p) return { min: 0, max: 0 };
  const parts = splitTopLevel(p);
  const optional = parts.filter((x) => x.includes("=")).length;
  return { min: parts.length - optional, max: parts.length };
}
const badArity = [];
for (const d of byName.values()) {
  const a = arity(d);
  const callRe = new RegExp(`${NB}${d.name}[ \\t]*\\(`, "giu");
  let c;
  while ((c = callRe.exec(clean)) !== null) {
    const before = clean.slice(Math.max(0, c.index - 14), c.index);
    if (/(Функция|Процедура)[ \t]*$/i.test(before)) continue; // само объявление
    const open = c.index + c[0].length;
    let depth = 1, i = open;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "(") depth++;
      else if (clean[i] === ")") depth--;
      i++;
    }
    const inner = clean.slice(open, i - 1).trim();
    const n = inner === "" ? 0 : splitTopLevel(inner).length;
    if (n < a.min || n > a.max) {
      const expected = a.min === a.max ? a.min : `${a.min}–${a.max}`;
      badArity.push(`${d.name}:${lineOf(c.index)}(передано ${n}, ожидается ${expected})`);
    }
  }
}
report(badArity.length === 0, "число аргументов совпадает с объявлениями",
  [...new Set(badArity)].join("; "));

// ── E. Литералы закрыты по правилам языка ───────────────────────────────────
// Было: чётность кавычек В ПРЕДЕЛАХ СТРОКИ. Правило не знало ни многострочных
// литералов (продолжение через «|»), ни кавычек внутри комментариев, и на
// MCP_LegalSources давало шесть ложных провалов подряд (ТЗ-1 R-3).
// Стало: литерал либо закрыт на своей строке, либо продолжен строкой с «|»;
// незакрытый к концу файла остаётся провалом — ради него правило и заведено.
report(unclosed.length === 0, "строковые литералы закрыты",
  unclosed.length ? `не закрыт литерал, открытый в строках ${unclosed.slice(0, 8).join(", ")}` : "");

// ── E2. Кавычка, экранированная обратным слэшем ─────────────────────────────
// В языке 1С обратный слэш не экранирует ничего: в литерале "текст [\"20\"]."
// строка обрывается на первой же кавычке, и Конфигуратор отклоняет модуль с
// «Ожидается символ ')'». Проверка E такое не видит: кавычек в строке чётное
// число, ломается только их разбивка на пары.
//
// Флагуем не любой \", а только тот, за которым идёт содержимое (буква, цифра
// или <): в конце литерала \" законен — "C:\temp\" это строка C:\temp\, где
// слэш является данными, а кавычка закрывает литерал.
const backslashQuote = [];
lines.forEach((l, i) => {
  if (/\\"(?=[\p{L}\p{N}<])/u.test(l)) backslashQuote.push(i + 1);
});
report(backslashQuote.length === 0,
  "кавычки внутри литералов экранированы удвоением, а не слэшем",
  backslashQuote.length
    ? `строки ${backslashQuote.slice(0, 8).join(", ")} — замените \\" на ""`
    : "");

// Проверка гомоглифов в идентификаторах BSL намеренно отсутствует:
// по стандартам §4.3 правило относится к тексту запроса 1С, а не к коду
// модуля. Имена вида ПредупрежденияPF или ЗаписатьЛогCR01 — норма проекта.

// ── F. Перем на верхнем уровне модуля (запрещено в расширении) ──────────────
const peremRe = new RegExp(`^[ \\t]*Перем${NA}`, "iu");
const perem = cleanLines.filter((l) => peremRe.test(l)).length;
report(perem === 0, "нет Перем на верхнем уровне модуля", perem ? `найдено: ${perem}` : "");

// ── G. Баланс блоков по токенам ─────────────────────────────────────────────
const tokens = clean.split(new RegExp(`[^${WORD}]+`, "u")).filter(Boolean).map((t) => t.toUpperCase());
const cnt = (w) => tokens.filter((t) => t === w).length;
const pairs = [
  ["Процедура", cnt("ПРОЦЕДУРА"), cnt("КОНЕЦПРОЦЕДУРЫ")],
  ["Функция", cnt("ФУНКЦИЯ"), cnt("КОНЕЦФУНКЦИИ")],
  ["Если", cnt("ЕСЛИ"), cnt("КОНЕЦЕСЛИ")],
  ["Цикл", cnt("ДЛЯ") + cnt("ПОКА"), cnt("КОНЕЦЦИКЛА")],
  ["Попытка", cnt("ПОПЫТКА"), cnt("КОНЕЦПОПЫТКИ")],
];
const unbalanced = pairs.filter(([, o, c]) => o !== c);
report(unbalanced.length === 0, "блоки сбалансированы",
  unbalanced.map(([n, o, c]) => `${n} ${o}/${c}`).join(", "));

// ── H. Присваивание СИСТЕМНОМУ имени платформы ──────────────────────────────
//
// Стоило одного отозванного деплоя: волна 2 назвала локальную переменную
// `ТипЗначенияJSON`, а это системное перечисление — глобальное свойство
// контекста. Платформа отвечает «Поле объекта недоступно для записи», причём
// ОШИБКОЙ ВЫПОЛНЕНИЯ, а не компиляции: модуль публикуется, «Проверить модуль»
// молчит, и падает только тот путь, где строка исполняется. Функция звалась на
// каждый контейнер ответа — упали все 37 инструментов при живом tools/list.
//
// Список не претендует на полноту синтакс-помощника: здесь имена, которые
// реально просятся в переменные при работе с метаданными и JSON.
const SYSTEM_GLOBALS = [
  "Метаданные", "ТипЗначенияJSON", "Символы", "Справочники", "Документы",
  "Перечисления", "РегистрыСведений", "РегистрыНакопления", "РегистрыБухгалтерии",
  "ПланыСчетов", "ПланыВидовХарактеристик", "ПланыВидовРасчета", "ПланыОбмена",
  "Отчеты", "Обработки", "Константы", "БизнесПроцессы", "Задачи",
  "КритерииОтбора", "ХранилищаНастроек", "РегламентныеЗадания",
  "ВнешниеИсточникиДанных", "УровеньЖурналаРегистрации", "НаправлениеСортировки",
  "СтатусСообщения", "КодВозвратаДиалога", "РежимДиалогаВопрос",
];
const assignedSystem = [];
for (const name of SYSTEM_GLOBALS) {
  const re = new RegExp(`^[ \\t]*${name}[ \\t]*=[^=]`, "iu");
  cleanLines.forEach((l, i) => {
    if (re.test(l)) assignedSystem.push(`${name} (строка ${i + 1})`);
  });
}
report(assignedSystem.length === 0,
  "нет присваивания системным именам платформы", assignedSystem.join(", "));

  // В сплошном прогоне печатаем только провалы: иначе 20 модулей × 9 проверок
  // тонут в шуме, а ворота обязаны быть бинарными.
  if (fail || !quietWhenClean) {
    if (quietWhenClean) console.log(`\n${path}`);
    for (const line of messages) console.log(line);
    console.log(`\n  ${path}: строк ${lines.length}, объявлений ${decls.length}`);
  }
  return fail;
}
