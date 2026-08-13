#!/usr/bin/env node
// Разрешение вызовов BSL-модуля: во что указывает каждое «Имя(».
//
// Опечатка в имени вызываемой функции — самая дорогая ошибка при публикации:
// модуль компилируется, а падает в рантайме на конкретной ветке, которую
// проверяющий может не пройти. Проверка разбирает все вызовы и делит их на
// разрешённые и неизвестные.
//
// Вызов считается разрешённым, если он:
//   • объявлен в этом же модуле;
//   • квалифицирован именем модуля (МодульX.Метод) — тогда проверяет 1С;
//   • встречается хотя бы в одном другом модуле репозитория, то есть у него
//     есть рабочий прецедент (платформенные СтрНайти, Сред, ВРег и прочие).
//
// Использование: node scripts/bsl_call_resolution.mjs <модуль.bsl> [...] | --all

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripBsl, targetsFromArgv } from "./bsl_lines.mjs";

const { files: targets, all } = targetsFromArgv(process.argv.slice(2));
const root = "src";
if (targets.length === 0) {
  console.error("Usage: node scripts/bsl_call_resolution.mjs <файл.bsl> [...] | --all");
  process.exit(2);
}

const WORD = "\\p{L}\\p{N}_";

// Разбор литералов и комментариев — общий модуль bsl_lines.mjs (ТЗ-1 R-2).
// Собственная построчная копия не понимала многострочные литералы, и текст
// внутри них разбирался как код: 37 из 40 «неразрешённых имён» замера 13.08 —
// это `актуальных(`, `president(`, `assembly(` из текстов MCP_LegalSources.
const strip = stripBsl;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".bsl")) out.push(p);
  }
  return out;
}

// Имена, вызываемые без точки перед ними.
// «Новый ОписаниеТипов(...)» — конструктор типа, а не вызов функции: имя типа
// проверяет платформа, и в список вызовов оно попадать не должно.
const NEW_RE = /Новый[ \t]+$/iu;
function callNames(clean) {
  const re = new RegExp(`(?<![${WORD}.])([\\p{L}_][${WORD}]*)[ \\t]*\\(`, "gu");
  const out = [];
  for (const m of clean.matchAll(re)) {
    if (NEW_RE.test(clean.slice(Math.max(0, m.index - 10), m.index))) continue;
    out.push({ name: m[1], index: m.index });
  }
  return out;
}

function declaredIn(clean) {
  const re = new RegExp(`^[ \\t]*(?:Функция|Процедура)[ \\t]+([${WORD}]+)`, "gimu");
  return new Set([...clean.matchAll(re)].map((m) => m[1].toUpperCase()));
}

// Конструкции языка, за которыми скобка есть, но вызовом они не являются.
const KEYWORDS = new Set([
  "ЕСЛИ", "ИНАЧЕЕСЛИ", "ПОКА", "ДЛЯ", "ВОЗВРАТ", "И", "ИЛИ", "НЕ",
  "ФУНКЦИЯ", "ПРОЦЕДУРА", "НОВЫЙ", "ВЫЗВАТЬИСКЛЮЧЕНИЕ", "ТОГДА", "ЦИКЛ",
]);

// Слепое пятно критерия «прецедент в другом модуле»: платформенная функция,
// использованная во всём репозитории ровно один раз, прецедента не имеет и
// выглядит неразрешённой. Ниже — те, что сверены вручную по синтакс-помощнику
// и вдобавок работают в уже опубликованных модулях. Список пополнять только
// после такой сверки: иначе проверка перестанет ловить опечатки в именах.
const PLATFORM_GLOBALS = new Set([
  "СИМВОЛ",          // MCP_Query: Символ(160) — неразрывный пробел
  "ТЕКУЩАЯДАТА",     // MCP_Tools_Impl
  "НАЙТИПОССЫЛКАМ",  // MCP_Tools_Impl
  "ИМЯКОМПЬЮТЕРА",   // MCP_Tools_Impl
  // Сверено 12.08.2026 через синтакс-помощник: UTC-миллисекунды от 01.01.0001.
  "ТЕКУЩАЯУНИВЕРСАЛЬНАЯДАТАВМИЛЛИСЕКУНДАХ", // MCP_Audit, MCP_Tools, MCP_HTTPService
  // Сверено 12.08.2026 через синтакс-помощник: Global context, возвращает Дату.
  // В список попала вынужденно: перевод таймеров на миллисекунды убрал последние
  // употребления имени в MCP_Audit/Query/Registers/Reports, и единственный
  // оставшийся вызов (MCP_Tools_Impl, generated_at) лишился прецедента в
  // репозитории — критерий начал показывать его «неразрешённым».
  "ТЕКУЩАЯУНИВЕРСАЛЬНАЯДАТА", // MCP_Tools_Impl
  // Сверено 12.08.2026 через синтакс-помощник: Global context,
  // СтрЗаканчиваетсяНа(<Строка>, <СтрокаПоиска>) — сравнение с учётом регистра.
  "СТРЗАКАНЧИВАЕТСЯНА", // MCP_Audit: имя тула из имени события аудита
  // Сверено 05.08.2026 через MCP-коннектор 1csyntax (синтакс-помощник),
  // get_quick_reference — обе присутствуют в справке платформы:
  //   ЗаполнитьЗначенияСвойств(<Приемник>, <Источник>, <СписокСвойств>, <ИсключаяСвойства>)
  //   ПравоДоступа(<Право>, <ОбъектМетаданных>, <Пользователь/Роль>, <СтандартныйРеквизит…>)
  // До сверки обе годами показывались как «неразрешённые», и каждая сессия
  // заново доказывала, что это слепое пятно критерия, а не дефект кода.
  "ЗАПОЛНИТЬЗНАЧЕНИЯСВОЙСТВ",  // MCP_Query
  "ПРАВОДОСТУПА",              // MCP_Security
  // Сверено 13.08.2026 (ТЗ-1 R-5). До правки многострочного сканера эти имена
  // тонули в 37 ложных срабатываниях и потому не были замечены: #143 называла
  // пять имён, фактически их девять — модуль формы вырос с момента заведения.
  //
  // СПИСОК ПЛОСКИЙ И ОСТАЁТСЯ ПЛОСКИМ — решение по #143 п.2. Контекст указан в
  // комментарии у каждого имени, но проверкой не различается: чекер судит о
  // модуле по тексту, а не по его роли в конфигурации, и различение контекстов
  // потребовало бы ему знать, что модуль формы исполняется на клиенте. Пока
  // список плоский, клиентское имя в общем модуле проверка не поймает — это
  // сознательный размен: ловим опечатки, а не нарушения контекста исполнения.
  "ПОЛУЧИТЬHEXСТРОКУИЗДВОИЧНЫХДАННЫХ", // MCP_Examples — глобальный контекст
  "КОДИРОВАТЬСТРОКУ",                   // MCP_Values — глобальный, КодировкаURL
  "ДАТА",                               // MCP_Values — глобальный, конструктор даты
  "ПОКАЗАТЬВОПРОС",                     // MCP_MaskingRule/Форма — клиент
  "ЗАКРЫТЬ",                            // MCP_MaskingRule/Форма — клиент
  "ПОДКЛЮЧИТЬОБРАБОТЧИКОЖИДАНИЯ",       // MCP_MaskingRule/Форма — клиент
  "СООБЩИТЬ",                           // MCP_MaskingRule/Форма — клиент
  "РЕКВИЗИТФОРМЫВЗНАЧЕНИЕ",             // MCP_MaskingRule/Форма — контекст управляемой формы
  "ЗНАЧЕНИЕВРЕКВИЗИТФОРМЫ",             // MCP_MaskingRule/Форма — контекст управляемой формы
]);

// Прецеденты собираются ОДИН раз на весь прогон: при --all это разница между
// одним обходом репозитория и обходом на каждый файл.
const allFiles = walk(root);
const precedentByFile = new Map();
for (const f of allFiles) {
  const names = new Set(callNames(strip(readFileSync(f, "utf8"))).map((c) => c.name.toUpperCase()));
  precedentByFile.set(f.replace(/\\/g, "/"), names);
}

let exitCode = 0;
for (const target of targets) {
  if (проверитьФайл(target)) exitCode = 1;
}
if (all) {
  console.log(exitCode === 0
    ? `  ✔ неразрешённых имён нет ни в одном файле: ${targets.length}`
    : `  ✘ есть неразрешённые имена (проверено файлов: ${targets.length})`);
}
process.exit(exitCode);

function проверитьФайл(target) {
  const targetClean = strip(readFileSync(target, "utf8"));
  const local = declaredIn(targetClean);
  const targetKey = target.replace(/\\/g, "/");

  // Прецедент — имя, вызываемое в ЛЮБОМ другом модуле репозитория.
  const precedent = new Map();
  for (const [f, names] of precedentByFile) {
    if (f.endsWith(targetKey) || targetKey.endsWith(f)) continue;
    for (const k of names) if (!precedent.has(k)) precedent.set(k, f);
  }

  const lineStarts = [0];
  for (let i = 0; i < targetClean.length; i++) if (targetClean[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => lineStarts.filter((s) => s <= idx).length;

  const stats = { local: 0, keyword: 0, precedent: 0, platform: 0 };
  const unknown = new Map();
  for (const { name, index } of callNames(targetClean)) {
    const k = name.toUpperCase();
    if (KEYWORDS.has(k)) { stats.keyword++; continue; }
    if (local.has(k)) { stats.local++; continue; }
    if (precedent.has(k)) { stats.precedent++; continue; }
    if (PLATFORM_GLOBALS.has(k)) { stats.platform++; continue; }
    if (!unknown.has(name)) unknown.set(name, lineOf(index));
  }

  if (unknown.size === 0) {
    // В сплошном прогоне молчим на чистых файлах: ворота обязаны быть бинарными.
    if (!all) {
      console.log(`  вызовов: локальных ${stats.local}, с прецедентом в репозитории ${stats.precedent}`
        + `, платформенных из сверенного списка ${stats.platform}, конструкций языка ${stats.keyword}`);
      console.log("  ✔ неразрешённых имён нет");
    }
    return 0;
  }
  console.log(`  ✘ ${target}: неразрешённых имён ${unknown.size} — проверить вручную по синтакс-помощнику`);
  for (const [name, ln] of unknown) console.log(`     ${target}:${ln}  ${name}(`);
  return 1;
}
