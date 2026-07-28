#!/usr/bin/env node
// Локальная предкоммитная проверка изменений legal-sources (без платформы 1С):
// A. Структурный линт BSL: баланс блоков + корректность строковых литералов с | -переносами.
// B. Сквозная согласованность: СписокTools = dispatcher = EXPECTED_TOOLS = спека = README = манифест.
// C. Содержимое инструкции pravo_gov_ru: инварианты + синхронность модуля и мастер-копии.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let checks = 0;

function ok(cond, label, detail = "") {
  checks++;
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? " :: " + detail : ""}`);
  }
}

function read(rel) {
  return readFileSync(join(REPO, rel), "utf8");
}

// ---------- A. Структурный линт BSL ----------------------------------------

function lintBsl(rel) {
  const text = read(rel);
  const lines = text.split(/\r?\n/);
  const problems = [];
  let inString = false; // состояние "внутри строкового литерала" на конец предыдущей строки

  // счётчики блоков (вне строк и комментариев)
  const counters = {
    func: 0, proc: 0, if: 0, loop: 0, try: 0,
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    let code = ""; // код вне строк/комментариев на этой строке
    let i = 0;
    const trimmed = raw.replace(/^\s+/, "");

    if (inString) {
      // строка-продолжение обязана начинаться с |
      if (trimmed === "") { problems.push(`${n + 1}: пустая строка внутри незакрытого строкового литерала`); continue; }
      if (!trimmed.startsWith("|")) {
        problems.push(`${n + 1}: незакрытый строковый литерал, но строка не начинается с |`);
        inString = false; // не каскадировать ошибку
      } else {
        i = raw.indexOf("|") + 1;
      }
    }

    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (ch === '"') {
          if (raw[i + 1] === '"') { i++; } // экранированная кавычка
          else inString = false;
        }
      } else {
        if (ch === '"') inString = true;
        else if (ch === "/" && raw[i + 1] === "/") break; // комментарий до конца строки
        else code += ch;
      }
    }

    const u = code.toUpperCase();
    const count = (re) => (u.match(re) || []).length;
    counters.func += count(/(^|[^\wА-ЯЁ])ФУНКЦИЯ(?![\wА-ЯЁ])/g) - count(/КОНЕЦФУНКЦИИ/g);
    counters.proc += count(/(^|[^\wА-ЯЁ])ПРОЦЕДУРА(?![\wА-ЯЁ])/g) - count(/КОНЕЦПРОЦЕДУРЫ/g);
    counters.if += count(/(^|[^\wА-ЯЁ])ЕСЛИ(?![\wА-ЯЁ])/g) - count(/КОНЕЦЕСЛИ/g);
    counters.loop += count(/(^|[^\wА-ЯЁ])ЦИКЛ(?![\wА-ЯЁ])/g) - count(/КОНЕЦЦИКЛА/g);
    counters.try += count(/(^|[^\wА-ЯЁ])ПОПЫТКА(?![\wА-ЯЁ])/g) - count(/КОНЕЦПОПЫТКИ/g);
  }

  if (inString) problems.push("EOF: файл закончился внутри строкового литерала");
  for (const [k, v] of Object.entries(counters)) {
    if (v !== 0) problems.push(`дисбаланс блоков '${k}': ${v}`);
  }
  ok(problems.length === 0, `BSL lint ${rel}`, problems.join("; "));
}

console.log("A. Структурный линт BSL");
lintBsl("src/CommonModules/MCP_LegalSources.bsl");
lintBsl("src/CommonModules/MCP_Tools.bsl");
lintBsl("src/CommonModules/MCP_Tools_Impl.bsl");

// ---------- B. Сквозная согласованность -------------------------------------

console.log("B. Согласованность проводки тулов");

const toolsBsl = read("src/CommonModules/MCP_Tools.bsl");

// имена из определений тулов: _Tool("name", ...)
const definedNames = [...toolsBsl.matchAll(/_Tool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
// вызовы в СписокTools: Tool_xxx(РежимРезультата)
const listCalls = [...toolsBsl.matchAll(/Результат\.Добавить\(Tool_([a-z0-9_]+)\(/g)].map((m) => m[1]);
// ветки диспетчера: ИмяТула = "xxx"
const dispatchNames = [...new Set([...toolsBsl.matchAll(/ИмяТула\s*=\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))];

const expectedToolsSrc = read("scripts/mcp_contract_test.mjs");
const expectedBlock = expectedToolsSrc.match(/const EXPECTED_TOOLS = \[([\s\S]*?)\];/)[1];
const expectedTools = [...expectedBlock.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);

const spec = read("doc/mcp_1c_tools_spec.md");
const specTable = [...spec.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

const readme = read("README.md");
const readmeTable = [...readme.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

const setEq = (a, b) => a.length === b.length && [...new Set(a)].every((x) => b.includes(x));
const diff = (a, b) => [...new Set([...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))])].join(",");

ok(definedNames.length === 37, `37 определений тулов в MCP_Tools.bsl`, `получено ${definedNames.length}`);
ok(setEq(definedNames, listCalls.map((c) => definedNames.find((n) => n === c) || c)), "СписокTools вызывает все определения", diff(definedNames, listCalls));
ok(setEq(definedNames, dispatchNames), "dispatcher покрывает все тулы", diff(definedNames, dispatchNames));
ok(setEq(definedNames, expectedTools), "EXPECTED_TOOLS соответствует коду", diff(definedNames, expectedTools));
ok(setEq(definedNames, specTable), "таблица спеки соответствует коду", diff(definedNames, specTable));
ok(setEq(definedNames, readmeTable), "таблица README соответствует коду", diff(definedNames, readmeTable));

const manifest = JSON.parse(read("scripts/required_modules.manifest.json"));
const filesOnDisk = readdirSync(join(REPO, "src/CommonModules")).filter((f) => f.endsWith(".bsl")).map((f) => f.replace(".bsl", ""));
ok(setEq(manifest.common_modules, filesOnDisk), "манифест = файлы src/CommonModules", diff(manifest.common_modules, filesOnDisk));
ok(manifest.counts.common_modules === manifest.common_modules.length, "counts.common_modules корректен");

// спека: наличие Input Schema блоков для новых тулов (то, что проверяет spec_contract_autosync)
for (const tool of ["list_legal_sources", "get_legal_source_guide"]) {
  const section = spec.split(new RegExp(`##\\s+7\\.\\d+\\.\\s+\`${tool}\``))[1];
  ok(Boolean(section && section.includes("### Input Schema")), `спека: секция и Input Schema для ${tool}`);
}

// ---------- C. Содержимое инструкции ----------------------------------------

console.log("C. Содержимое инструкции pravo_gov_ru");

const mod = read("src/CommonModules/MCP_LegalSources.bsl");

// восстановить текст guide из BSL-литерала (строки | внутри функции)
function extractGuide(funcName) {
  const funcBody = mod.split(`Функция ${funcName}()`)[1].split("КонецФункции")[0];
  const guideLines = [];
  for (const line of funcBody.split(/\r?\n/)) {
    const t = line.replace(/^\s+/, "");
    if (t.startsWith('"')) guideLines.push(t.slice(1));
    else if (t.startsWith("|")) guideLines.push(t.slice(1));
  }
  let guide = guideLines.join("\n");
  if (guide.endsWith('";')) guide = guide.slice(0, -2);
  return guide.replace(/""/g, '"');
}
const guide = extractGuide("ИнструкцияPravoGovRu");

ok(guide.length > 2000, "guide достаточно подробный", `длина ${guide.length}`);
const mustContain = [
  "publication.pravo.gov.ru/api",
  "/api/Documents",
  "/api/Document?eoNumber=",
  "publication.pravo.gov.ru/document/{eoNumber}",
  "file/pdf?eoNumber={eoNumber}",
  "ДД.ММ.ГГГГ",
  "YYYY-MM-DD",
  "СНАЧАЛА РЕШИ, ПОТОМ ИЩИ",
  "10, 30, 100 или 200",
  "NumberSearchType",
  "ноября 2011",
];
for (const s of mustContain) ok(guide.includes(s), `guide содержит «${s}»`);
ok(!guide.includes("2026-01-01"), "в примере guide нет ISO-даты (ловушка формата устранена)");

// политика
ok(mod.includes('"internet_search_forbidden", Истина'), "policy: internet_search_forbidden=true");

// links в модуле = шаблоны в guide
for (const tpl of ["document/{eoNumber}", "file/pdf?eoNumber={eoNumber}"]) {
  ok(mod.includes(`Ссылки.Вставить`) && mod.includes(tpl), `links содержит шаблон ${tpl}`);
}

// мастер-копия синхронна по смысловым строкам
const master = read("doc/legal_sources/pravo_gov_ru_guide.md");
const keyLines = guide.split("\n").map((l) => l.trim()).filter((l) =>
  l.startsWith("Пример:") || l.includes("ДД.ММ.ГГГГ") || l.startsWith("РАЗДЕЛЕНИЕ РОЛЕЙ") || l.includes("Базовый адрес"));
for (const l of keyLines) {
  ok(master.includes(l), `мастер-копия синхронна: «${l.slice(0, 60)}…»`);
}

// описания тулов несут запрет интернета
ok(/list_legal_sources"[\s\S]{0,700}ЗАПРЕЩЕНО/.test(toolsBsl), "описание list_legal_sources содержит запрет");
ok(/get_legal_source_guide"[\s\S]{0,700}не через открытый интернет/.test(toolsBsl), "описание get_legal_source_guide содержит запрет");

console.log("D. Содержимое инструкции pravo_gov_ru_actual");

const guideActual = extractGuide("ИнструкцияPravoGovRuActual");
ok(guideActual.length > 2000, "actual-guide достаточно подробный", `длина ${guideActual.length}`);
const mustContainActual = [
  "actual.pravo.gov.ru:8000/api/ebpi",
  "attrsearch",
  '{"AttrId":7,"AttrMode":9',
  '[50,"position","20220701",0,0]',
  "redactions",
  "actual=true",
  "redtext",
  "getcontent",
  "content.html#hash={dochash}&ttl=1",
  "pravo.gov.ru/codex/",
  "НЕ ДОКУМЕНТИРОВАН",
  "СНАЧАЛА РЕШИ, ПОТОМ ИЩИ",
  "01.07.2022",
];
for (const s of mustContainActual) ok(guideActual.includes(s), `actual-guide содержит «${s}»`);
ok(mod.includes('"pravo_gov_ru_actual"'), "источник pravo_gov_ru_actual зарегистрирован");
ok(guide.includes("pravo_gov_ru_actual"), "guide pravo_gov_ru ссылается на actual-источник");

const masterActual = read("doc/legal_sources/pravo_gov_ru_actual_guide.md");
const keyLinesActual = guideActual.split("\n").map((l) => l.trim()).filter((l) =>
  l.startsWith("Пример (до URL-кодирования)") || l.includes("ПОСЛЕДНИЙ НОЛЬ") || l.startsWith("РАЗДЕЛЕНИЕ РОЛЕЙ") || l.includes("actual.pravo.gov.ru:8000"));
for (const l of keyLinesActual) {
  ok(masterActual.includes(l), `мастер-копия actual синхронна: «${l.slice(0, 60)}…»`);
}

console.log(`\nИтого: ${checks} проверок, ${failures} провалов`);
process.exit(failures ? 1 : 0);
