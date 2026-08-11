// ПАРИТЕТ КОЛЛЕКЦИЙ ПОЛЕЙ: обработка настройки ↔ читатель политики (M-21).
//
// Закрывает класс дефектов «пометка в интерфейсе молча не применяется». Форма
// MCP_НастройкаМаскирования выводит в правую панель поля тех коллекций, что
// перечислены в таблице видов модуля объекта (А.9 ТЗ каталога). Читатель
// MCP_Config.МаскиПолейТиповLLM проверяет каждое имя из fields по метаданным и
// ОТКЛОНЯЕТ незнакомое с предупреждением. Если форма показывает коллекцию,
// которой нет в проверке читателя, пользователь ставит галку, запись пишется в
// политику — и не применяется. Ровно это и было с полями табличных частей.
//
// Проверка текстовая: читает оба .bsl и сверяет наборы имён коллекций. Ни
// компилятора 1С, ни живого контура для неё не нужно — она обязана падать
// раньше публикации.
//
//   node scripts/privacy_field_collections_parity_port.mjs

import { readFileSync } from "node:fs";

const OBJECT_MODULE = "src/DataProcessors/MCP_НастройкаМаскирования/ObjectModule.bsl";
const CONFIG_MODULE = "src/CommonModules/MCP_Config.bsl";

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    console.log(`FAIL | не прочитан ${path}: ${error.message}`);
    process.exit(1);
  }
};

// ---- Что выводит форма: строки ДанныеПоиска в ВидыМетаданныхДляМаскирования --
function collectionsShownByForm(src) {
  const start = src.indexOf("Функция ВидыМетаданныхДляМаскирования");
  if (start < 0) return null;
  const end = src.indexOf("КонецФункции", start);
  const body = src.slice(start, end);
  const found = new Set();
  // Последний аргумент каждой Новый Структура(...) — перечень коллекций полей.
  for (const m of body.matchAll(/"([А-Яа-яЁёA-Za-z,]+)"\s*\)\s*\)\s*;/gu)) {
    for (const name of m[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) found.add(trimmed);
    }
  }
  return found;
}

// ---- Что проверяет читатель: имена коллекций в ПоляТипаPrivacy ---------------
function collectionsCheckedByReader(src) {
  const start = src.indexOf("Функция ПоляТипаPrivacy");
  if (start < 0) return null;
  const end = src.indexOf("КонецФункции", start);
  const body = src.slice(start, end);
  const found = new Set();
  for (const m of body.matchAll(/Добавить\("([А-Яа-яЁёA-Za-z]+)"\)/gu)) found.add(m[1]);
  for (const m of body.matchAll(/СтрРазделить\("([А-Яа-яЁёA-Za-z,]+)"/gu)) {
    for (const name of m[1].split(",")) if (name.trim()) found.add(name.trim());
  }
  // Реквизиты/СтандартныеРеквизиты табличных частей обходятся отдельным вызовом.
  for (const m of body.matchAll(/ДобавитьПоляКоллекцииPrivacy\(Результат,\s*Часть,\s*"([А-Яа-яЁёA-Za-z]+)"\)/gu)) {
    found.add(`ТЧ.${m[1]}`);
  }
  return found;
}

const objectSrc = read(OBJECT_MODULE);
const configSrc = read(CONFIG_MODULE);

let fails = 0;
const check = (ok, name, detail = "") => {
  if (!ok) fails += 1;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}${detail ? ` — ${detail}` : ""}`);
};

const shown = collectionsShownByForm(objectSrc);
const checked = collectionsCheckedByReader(configSrc);

check(shown !== null && shown.size > 0, "таблица видов формы разобрана",
  shown ? `коллекций: ${[...shown].join(", ")}` : "ВидыМетаданныхДляМаскирования не найдена");
check(checked !== null && checked.size > 0, "проверка читателя разобрана",
  checked ? `коллекций: ${[...checked].join(", ")}` : "ПоляТипаPrivacy не найдена");

if (!shown || !checked || !shown.size || !checked.size) {
  console.log("");
  console.log("Итог паритета: FAIL — структура модулей изменилась, порт требует правки");
  process.exit(1);
}

// Скалярные коллекции обязаны быть в проверке читателя дословно.
const SCALAR = [...shown].filter((c) => c !== "ТабличныеЧасти" && c !== "СтандартныеТабличныеЧасти");
const missing = SCALAR.filter((c) => !checked.has(c));
check(missing.length === 0,
  "каждая скалярная коллекция формы проверяется читателем", missing.join(", "));

// Табличные части: форма их выводит → читатель обязан обходить поля ТЧ.
if (shown.has("ТабличныеЧасти") || shown.has("СтандартныеТабличныеЧасти")) {
  check(checked.has("ТабличныеЧасти") && checked.has("СтандартныеТабличныеЧасти"),
    "коллекции табличных частей обходятся читателем");
  check(checked.has("ТЧ.Реквизиты") && checked.has("ТЧ.СтандартныеРеквизиты"),
    "поля внутри табличных частей попадают в проверку",
    "иначе пометка поля ТЧ отклоняется как «не найдено в метаданных»");
}

// Обратная сторона: читатель не должен требовать коллекций, которых форма не
// показывает, — это означало бы, что политику можно набрать только руками.
const extra = [...checked].filter((c) => !c.startsWith("ТЧ.") && !shown.has(c));
check(extra.length === 0, "читатель не проверяет коллекций сверх показанных формой",
  extra.length ? `${extra.join(", ")} — форма их не выводит, набрать пометку невозможно` : "");

console.log("");
console.log(`Итог паритета коллекций: ${fails === 0 ? "PASS" : "FAIL"} (провалов: ${fails})`);
console.log("Порт сверяет ТЕКСТЫ модулей: расхождение интерфейса и читателя политики ловится до публикации.");
process.exit(fails === 0 ? 0 : 1);
