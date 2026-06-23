#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = resolve(REPO_ROOT, "skills/1c-query-language");
const OUTPUT = resolve(REPO_ROOT, "src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl");
const DEFAULT_VERSION = "8.3.27";
const DOMAIN = "query-language";
const RESOURCE_PREFIX = `1c-docs://${DEFAULT_VERSION}/${DOMAIN}`;

const SOURCE_FILES = [
  "SKILL.md",
  "references/version-provenance.md",
  "references/query-syntax.md",
  "references/functions-and-expressions.md",
  "references/virtual-tables.md",
  "references/accumulation-register.md",
  "references/info-register.md",
  "references/chart-of-accounts.md",
  "references/bsl-query-api.md",
];

const TOPIC_TITLES = {
  "skill": "Маршрутизатор skill 1c-query-language",
  "version-provenance": "Версия и provenance справочника",
  "query-syntax": "Синтаксис языка запросов 1С",
  "functions-and-expressions": "Функции и выражения языка запросов",
  "virtual-tables": "Виртуальные таблицы регистра бухгалтерии",
  "accumulation-register": "РегистрНакопления",
  "info-register": "РегистрСведений",
  "chart-of-accounts": "ПланСчетов и таблица движений",
  "bsl-query-api": "Работа с запросами из BSL",
};

const EXTRA_TAGS = {
  skill: ["skill", "router", "mcp", "retrieval"],
  "version-provenance": ["version", "provenance", "source", "8.3.27"],
  "query-syntax": ["syntax", "select", "where", "join", "group", "order"],
  "functions-and-expressions": ["functions", "expressions", "null", "date", "string", "math"],
  "virtual-tables": ["accounting", "virtual-tables", "ОборотыДтКт", "Остатки", "Обороты"],
  "accumulation-register": ["accumulation", "register", "Остатки", "Обороты"],
  "info-register": ["info-register", "СрезПоследних", "СрезПервых"],
  "chart-of-accounts": ["chart-of-accounts", "ПланСчетов", "subconto"],
  "bsl-query-api": ["bsl", "query-api", "Запрос", "ВыполнитьПакет"],
};

const SYNONYMS = {
  case: ["ВЫБОР", "КОГДА", "ТОГДА", "CASE"],
  join: ["СОЕДИНЕНИЕ", "ЛЕВОЕ СОЕДИНЕНИЕ", "ВНУТРЕННЕЕ СОЕДИНЕНИЕ", "JOIN"],
  null: ["NULL", "ЕСТЬNULL", "ЕСТЬ NULL"],
  "slice last": ["СрезПоследних", "РегистрСведений"],
  balance: ["Остатки", "ОстаткиИОбороты"],
  turnover: ["Обороты", "ОборотыДтКт"],
  "temporary table": ["ПОМЕСТИТЬ", "Временные таблицы", "МенеджерВТ"],
  abs: ["АБС", "модуль", "математические функции"],
  subconto: ["Субконто", "ВидыСубконто", "ПланСчетов"],
};

function toRepoPath(absPath) {
  return relative(SKILL_ROOT, absPath).replaceAll("\\", "/");
}

function topicIdFromPath(path) {
  return path.split("/").pop().replace(/\.md$/i, "").toLowerCase();
}

function transliterate(value) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
    э: "e", ю: "yu", я: "ya",
  };
  return Array.from(value.toLowerCase())
    .map((ch) => map[ch] ?? ch)
    .join("");
}

function slugify(value) {
  const slug = transliterate(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "section";
}

function normalizeGeneratedContent(text) {
  return text;
}

function parseSections(sourceFile, markdown) {
  const topicId = topicIdFromPath(sourceFile);
  const lines = normalizeGeneratedContent(markdown).split(/\r?\n/);
  const headingStack = [];
  const sections = [];
  const usedSlugs = new Map();
  let current = null;

  function pushCurrent() {
    if (!current) return;
    const content = current.lines.join("\n").trimEnd();
    if (!content.trim() && current.level > 1) return;
    current.content = content;
    sections.push(current);
  }

  for (const line of lines) {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (match) {
      pushCurrent();
      const level = match[1].length;
      const title = match[2].replace(/\s+#*$/, "").trim();
      headingStack.length = level - 1;
      headingStack[level - 1] = title;
      const baseSlug = slugify(title);
      const count = usedSlugs.get(baseSlug) || 0;
      usedSlugs.set(baseSlug, count + 1);
      const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
      current = {
        section_id: `${sourceFile}#${slug}`,
        resource_uri: `${RESOURCE_PREFIX}/${topicId}#${slug}`,
        title,
        source_file: sourceFile,
        topic_id: topicId,
        heading_path: headingStack.filter(Boolean),
        tags: inferTags(topicId, title),
        level,
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  pushCurrent();
  return sections;
}

function inferTags(topicId, title) {
  const tags = new Set([topicId, ...(EXTRA_TAGS[topicId] || [])]);
  const hay = `${topicId} ${title}`.toLowerCase();
  for (const [key, values] of Object.entries(SYNONYMS)) {
    if (hay.includes(key.toLowerCase()) || values.some((item) => hay.includes(item.toLowerCase()))) {
      tags.add(key);
      for (const item of values) tags.add(item);
    }
  }
  for (const token of title.split(/[\s,.;:()/"'`«»<>[\]{}|]+/).filter((item) => item.length > 2)) {
    tags.add(token);
  }
  return Array.from(tags).slice(0, 24);
}

function bslString(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function emitStringArray(varName, values) {
  const out = [`\t${varName} = Новый Массив;`];
  for (const value of values) {
    out.push(`\t${varName}.Добавить(${bslString(value)});`);
  }
  return out;
}

function splitLongLine(line, max = 900) {
  const chunks = [];
  let rest = line;
  while (rest.length > max) {
    let idx = rest.lastIndexOf(" ", max);
    if (idx < 200) idx = max;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx);
  }
  chunks.push(rest);
  return chunks;
}

function emitContent(content) {
  const out = [`\tТекст = "";`];
  const lines = content.split("\n");
  for (const line of lines) {
    const chunks = splitLongLine(line);
    for (let i = 0; i < chunks.length; i += 1) {
      const suffix = i === chunks.length - 1 ? " + Символы.ПС" : "";
      if (chunks[i]) out.push(`\tТекст = Текст + ${bslString(chunks[i])}${suffix};`);
      else if (suffix) out.push(`\tТекст = Текст + Символы.ПС;`);
    }
  }
  return out;
}

function emitSection(section) {
  const out = [];
  out.push("");
  out.push(...emitStringArray("Путь", section.heading_path));
  out.push(...emitStringArray("Теги", section.tags));
  out.push(...emitContent(section.content));
  out.push(`\tДобавитьСекцию(Секции, ${bslString(section.section_id)}, ${bslString(section.resource_uri)}, ${bslString(section.title)}, ${bslString(section.source_file)}, ${bslString(section.topic_id)}, Путь, Теги, Текст);`);
  return out;
}

function emitTopic(topic) {
  return [
    "\tТема = Новый Структура;",
    `\tТема.Вставить("id", ${bslString(topic.id)});`,
    `\tТема.Вставить("title", ${bslString(topic.title)});`,
    `\tТема.Вставить("section_count", ${topic.section_count});`,
    `\tТема.Вставить("source_file", ${bslString(topic.source_file)});`,
    `\tТема.Вставить("resource_uri", ${bslString(topic.resource_uri)});`,
    "\tТемы.Добавить(Тема);",
    "",
  ];
}

function buildBsl(sections, topics) {
  const lines = [];
  lines.push("// MCP_Knowledge_1CQueryDocs.bsl");
  lines.push("// ====================================================================");
  lines.push("// Сгенерированный read-only индекс документации по языку запросов 1С.");
  lines.push("// Источник: skills/1c-query-language/SKILL.md и references/*.md");
  lines.push(`// Версия документации: ${DEFAULT_VERSION}`);
  lines.push("// Сгенерировано детерминированно из markdown-источников.");
  lines.push("// Не редактировать вручную: используйте scripts/generate_1c_language_docs_bsl.mjs.");
  lines.push("// ====================================================================");
  lines.push("");
  lines.push("Функция ВерсияДокументации() Экспорт");
  lines.push(`\tВозврат ${bslString(DEFAULT_VERSION)};`);
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция ДоменДокументации() Экспорт");
  lines.push(`\tВозврат ${bslString(DOMAIN)};`);
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция СписокРесурсов() Экспорт");
  lines.push("\tРесурсы = Новый Массив;");
  lines.push(`\tДобавитьРесурс(Ресурсы, ${bslString(`${RESOURCE_PREFIX}/index`)}, "1C language docs index", "Карта документации по языку запросов 1С.");`);
  lines.push(`\tДобавитьРесурс(Ресурсы, ${bslString(`${RESOURCE_PREFIX}/provenance`)}, "1C language docs provenance", "Версия, источники и правила разрешения конфликтов.");`);
  for (const topic of topics) {
    if (topic.id === "version-provenance") continue;
    lines.push(`\tДобавитьРесурс(Ресурсы, ${bslString(topic.resource_uri)}, ${bslString(topic.title)}, ${bslString(`Раздел документации: ${topic.title}.`)});`);
  }
  lines.push("\tВозврат Ресурсы;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция ЭтоРесурсДокументации(URI) Экспорт");
  lines.push(`\tВозврат СтрНачинаетсяС(Строка(URI), ${bslString(RESOURCE_PREFIX)});`);
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция ПрочитатьРесурс(URI) Экспорт");
  lines.push("\tURI = Строка(URI);");
  lines.push(`\tЕсли URI = ${bslString(`${RESOURCE_PREFIX}/index`)} Тогда`);
  lines.push("\t\tВозврат ТекстИндекс();");
  lines.push(`\tИначеЕсли URI = ${bslString(`${RESOURCE_PREFIX}/provenance`)} Тогда`);
  lines.push("\t\tВозврат КонтентРесурса(\"version-provenance\", \"\");");
  lines.push("\tИначеЕсли СтрНайти(URI, \"#\") > 0 Тогда");
  lines.push("\t\tВозврат КонтентСекцииПоURI(URI);");
  lines.push("\tИначе");
  lines.push("\t\tTopicID = Сред(URI, СтрДлина(" + bslString(`${RESOURCE_PREFIX}/`) + ") + 1);");
  lines.push("\t\tВозврат КонтентРесурса(TopicID, URI);");
  lines.push("\tКонецЕсли;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция ListTopics(Версия = \"\", Домен = \"\") Экспорт");
  lines.push("\tПроверитьВерсиюИДомен(Версия, Домен);");
  lines.push("\tРезультат = Новый Структура;");
  lines.push("\tРезультат.Вставить(\"version\", ВерсияДокументации());");
  lines.push("\tРезультат.Вставить(\"domain\", ДоменДокументации());");
  lines.push("\tРезультат.Вставить(\"topics\", Темы());");
  lines.push("\tВозврат Результат;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция SearchDocs(Query, Версия = \"\", Домен = \"\", TopK = 5, MaxCharsPerResult = 1800) Экспорт");
  lines.push("\tПроверитьВерсиюИДомен(Версия, Домен);");
  lines.push("\tQuery = СокрЛП(Строка(Query));");
  lines.push("\tЕсли ПустаяСтрока(Query) Тогда");
  lines.push("\t\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), \"Параметр query обязателен.\");");
  lines.push("\tКонецЕсли;");
  lines.push("\tТермы = ТермыПоиска(Query);");
  lines.push("\tРезультаты = Новый Массив;");
  lines.push("\tДля Каждого Секция Из ВсеСекции() Цикл");
  lines.push("\t\tScore = СчетРелевантности(Секция, Термы, Query);");
  lines.push("\t\tЕсли Score > 0 Тогда");
  lines.push("\t\t\tРез = Новый Структура;");
  lines.push("\t\t\tРез.Вставить(\"section_id\", Секция.section_id);");
  lines.push("\t\t\tРез.Вставить(\"title\", Секция.title);");
  lines.push("\t\t\tРез.Вставить(\"source_file\", Секция.source_file);");
  lines.push("\t\t\tРез.Вставить(\"resource_uri\", Секция.resource_uri);");
  lines.push("\t\t\tРез.Вставить(\"score\", Score);");
  lines.push("\t\t\tРез.Вставить(\"excerpt\", Обрезать(Фрагмент(Секция.content, Термы), MaxCharsPerResult));");
  lines.push("\t\t\tДобавитьРезультатПоСчету(Результаты, Рез, TopK);");
  lines.push("\t\tКонецЕсли;");
  lines.push("\tКонецЦикла;");
  lines.push("\tОтвет = Новый Структура;");
  lines.push("\tОтвет.Вставить(\"version\", ВерсияДокументации());");
  lines.push("\tОтвет.Вставить(\"domain\", ДоменДокументации());");
  lines.push("\tОтвет.Вставить(\"query\", Query);");
  lines.push("\tОтвет.Вставить(\"results\", Результаты);");
  lines.push("\tОтвет.Вставить(\"truncated\", Ложь);");
  lines.push("\tЕсли Результаты.Количество() = 0 Тогда");
  lines.push("\t\tЗаметки = Новый Массив;");
  lines.push("\t\tЗаметки.Добавить(\"Релевантные секции не найдены. Уточните термин или проверьте список тем через list_1c_language_doc_topics.\");");
  lines.push("\t\tОтвет.Вставить(\"notes\", Заметки);");
  lines.push("\tКонецЕсли;");
  lines.push("\tВозврат Ответ;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция ReadSection(SectionID = \"\", ResourceURI = \"\", MaxChars = 8000, Cursor = \"\") Экспорт");
  lines.push("\tSectionID = СокрЛП(Строка(SectionID));");
  lines.push("\tResourceURI = СокрЛП(Строка(ResourceURI));");
  lines.push("\tЕсли ПустаяСтрока(SectionID) = ПустаяСтрока(ResourceURI) Тогда");
  lines.push("\t\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), \"Укажите ровно один из параметров section_id или resource_uri.\");");
  lines.push("\tКонецЕсли;");
  lines.push("\tСекция = Неопределено;");
  lines.push("\tДля Каждого Кандидат Из ВсеСекции() Цикл");
  lines.push("\t\tЕсли (НЕ ПустаяСтрока(SectionID) И Кандидат.section_id = SectionID)");
  lines.push("\t\t\tИЛИ (НЕ ПустаяСтрока(ResourceURI) И Кандидат.resource_uri = ResourceURI) Тогда");
  lines.push("\t\t\tСекция = Кандидат;");
  lines.push("\t\t\tПрервать;");
  lines.push("\t\tКонецЕсли;");
  lines.push("\tКонецЦикла;");
  lines.push("\tЕсли Секция = Неопределено Тогда");
  lines.push("\t\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), \"Секция документации не найдена.\");");
  lines.push("\tКонецЕсли;");
  lines.push("\tСмещение = ЧислоКурсора(Cursor);");
  lines.push("\tКонтент = Сред(Секция.content, Смещение + 1);");
  lines.push("\tОбрезанный = Обрезать(Контент, MaxChars);");
  lines.push("\tОтвет = Новый Структура;");
  lines.push("\tОтвет.Вставить(\"version\", ВерсияДокументации());");
  lines.push("\tОтвет.Вставить(\"domain\", ДоменДокументации());");
  lines.push("\tОтвет.Вставить(\"section_id\", Секция.section_id);");
  lines.push("\tОтвет.Вставить(\"title\", Секция.title);");
  lines.push("\tОтвет.Вставить(\"source_file\", Секция.source_file);");
  lines.push("\tОтвет.Вставить(\"resource_uri\", Секция.resource_uri);");
  lines.push("\tОтвет.Вставить(\"heading_path\", Секция.heading_path);");
  lines.push("\tОтвет.Вставить(\"content\", Обрезанный);");
  lines.push("\tTruncated = СтрДлина(Контент) > СтрДлина(Обрезанный);");
  lines.push("\tОтвет.Вставить(\"truncated\", Truncated);");
  lines.push("\tОтвет.Вставить(\"next_cursor\", ?(Truncated, Строка(Смещение + СтрДлина(Обрезанный)), Null));");
  lines.push("\tВозврат Ответ;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция Provenance(Версия = \"\", Домен = \"\") Экспорт");
  lines.push("\tПроверитьВерсиюИДомен(Версия, Домен);");
  lines.push("\tОтвет = ReadSection(\"references/version-provenance.md#versiya-spravochnika\", \"\", 20000, \"\");");
  lines.push("\tПравила = Новый Структура;");
  lines.push("\tПравила.Вставить(\"default_version\", ВерсияДокументации());");
  lines.push("\tПравила.Вставить(\"official_docs_priority\", \"highest_for_syntax\");");
  lines.push("\tПравила.Вставить(\"live_metadata_priority\", \"highest_for_infobase_specific_fields\");");
  lines.push("\tОтвет.Вставить(\"rules\", Правила);");
  lines.push("\tВозврат Ответ;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция Темы()");
  lines.push("\tТемы = Новый Массив;");
  lines.push("\tТема = Неопределено;");
  for (const topic of topics) lines.push(...emitTopic(topic));
  lines.push("\tВозврат Темы;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push("Функция ВсеСекции()");
  lines.push("\tСекции = Новый Массив;");
  lines.push("\tПуть = Неопределено;");
  lines.push("\tТеги = Неопределено;");
  lines.push("\tТекст = \"\";");
  for (const section of sections) lines.push(...emitSection(section));
  lines.push("\tВозврат Секции;");
  lines.push("КонецФункции");
  lines.push("");
  lines.push(helperBsl());
  return lines.join("\n");
}

function helperBsl() {
  return `Процедура ДобавитьРесурс(Ресурсы, URI, Имя, Описание)
\tРесурс = Новый Структура;
\tРесурс.Вставить("uri", URI);
\tРесурс.Вставить("name", Имя);
\tРесурс.Вставить("description", Описание);
\tРесурс.Вставить("mimeType", "text/markdown");
\tРесурсы.Добавить(Ресурс);
КонецПроцедуры

Процедура ДобавитьСекцию(Секции, SectionID, ResourceURI, Title, SourceFile, TopicID, HeadingPath, Tags, Content)
\tСекция = Новый Структура;
\tСекция.Вставить("section_id", SectionID);
\tСекция.Вставить("resource_uri", ResourceURI);
\tСекция.Вставить("title", Title);
\tСекция.Вставить("source_file", SourceFile);
\tСекция.Вставить("topic_id", TopicID);
\tСекция.Вставить("heading_path", HeadingPath);
\tСекция.Вставить("tags", Tags);
\tСекция.Вставить("content", Content);
\tСекции.Добавить(Секция);
КонецПроцедуры

Процедура ПроверитьВерсиюИДомен(Версия, Домен)
\tВерсия = СокрЛП(Строка(Версия));
\tДомен = СокрЛП(Строка(Домен));
\tЕсли НЕ ПустаяСтрока(Версия) И Версия <> ВерсияДокументации() Тогда
\t\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), "Версия документации не поддерживается: " + Версия);
\tКонецЕсли;
\tЕсли НЕ ПустаяСтрока(Домен) И Домен <> ДоменДокументации() Тогда
\t\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), "Домен документации не поддерживается: " + Домен);
\tКонецЕсли;
КонецПроцедуры

Функция ТекстИндекс()
\tТекст = "# Документация по языку запросов 1С " + ВерсияДокументации() + Символы.ПС + Символы.ПС;
\tДля Каждого Тема Из Темы() Цикл
\t\tТекст = Текст + "- " + Тема.title + " — " + Тема.resource_uri + Символы.ПС;
\tКонецЦикла;
\tВозврат Текст;
КонецФункции

Функция КонтентРесурса(TopicID, URI)
\tКонтент = "";
\tДля Каждого Секция Из ВсеСекции() Цикл
\t\tЕсли Секция.topic_id = TopicID Тогда
\t\t\tЕсли НЕ ПустаяСтрока(Контент) Тогда
\t\t\t\tКонтент = Контент + Символы.ПС;
\t\t\tКонецЕсли;
\t\t\tКонтент = Контент + Секция.content;
\t\tКонецЕсли;
\tКонецЦикла;
\tЕсли ПустаяСтрока(Контент) Тогда
\t\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), "Ресурс документации не найден: " + Строка(URI));
\tКонецЕсли;
\tВозврат Контент;
КонецФункции

Функция КонтентСекцииПоURI(URI)
\tДля Каждого Секция Из ВсеСекции() Цикл
\t\tЕсли Секция.resource_uri = URI Тогда
\t\t\tВозврат Секция.content;
\t\tКонецЕсли;
\tКонецЦикла;
\tMCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_InvalidArguments(), "Секция документации не найдена: " + Строка(URI));
КонецФункции

Функция ТермыПоиска(Query)
\tНорм = НРег(Строка(Query));
\tПунктуация = ".,;:()[]{}<>/\\\\|""'\\\`!?«»" + Символы.Таб + Символы.ПС;
\tДля Индекс = 1 По СтрДлина(Пунктуация) Цикл
\t\tСимв = Сред(Пунктуация, Индекс, 1);
\t\tНорм = СтрЗаменить(Норм, Симв, " ");
\tКонецЦикла;
\tСлова = СтрРазделить(Норм, " ", Ложь);
\tТермы = Новый Массив;
\tДля Каждого Слово Из Слова Цикл
\t\tСлово = СокрЛП(Слово);
\t\tЕсли СтрДлина(Слово) >= 2 И НЕ МассивСодержит(Термы, Слово) Тогда
\t\t\tТермы.Добавить(Слово);
\t\tКонецЕсли;
\tКонецЦикла;
\tВозврат Термы;
КонецФункции

Функция МассивСодержит(МассивЗначений, Искомое)
\tДля Каждого Значение Из МассивЗначений Цикл
\t\tЕсли Значение = Искомое Тогда
\t\t\tВозврат Истина;
\t\tКонецЕсли;
\tКонецЦикла;
\tВозврат Ложь;
КонецФункции

Функция СчетРелевантности(Секция, Термы, Query)
\tScore = 0;
\tTitle = НРег(Секция.title);
\tContent = НРег(Секция.content);
\tTags = НРег(СоединитьМассив(Секция.tags, " "));
\tPath = НРег(СоединитьМассив(Секция.heading_path, " "));
\tQueryNorm = НРег(Query);
\tЕсли СтрНайти(Title, QueryNorm) > 0 Тогда
\t\tScore = Score + 50;
\tКонецЕсли;
\tЕсли СтрНайти(Content, QueryNorm) > 0 Тогда
\t\tScore = Score + 25;
\tКонецЕсли;
\tДля Каждого Терм Из Термы Цикл
\t\tЕсли СтрНайти(Title, Терм) > 0 Тогда
\t\t\tScore = Score + 10;
\t\tКонецЕсли;
\t\tЕсли СтрНайти(Tags, Терм) > 0 Тогда
\t\t\tScore = Score + 8;
\t\tКонецЕсли;
\t\tЕсли СтрНайти(Path, Терм) > 0 Тогда
\t\t\tScore = Score + 5;
\t\tКонецЕсли;
\t\tЕсли СтрНайти(Content, Терм) > 0 Тогда
\t\t\tScore = Score + 1;
\t\tКонецЕсли;
\tКонецЦикла;
\tВозврат Score;
КонецФункции

Функция СоединитьМассив(МассивЗначений, Разделитель)
\tТекст = "";
\tДля Каждого Значение Из МассивЗначений Цикл
\t\tЕсли НЕ ПустаяСтрока(Текст) Тогда
\t\t\tТекст = Текст + Разделитель;
\t\tКонецЕсли;
\t\tТекст = Текст + Строка(Значение);
\tКонецЦикла;
\tВозврат Текст;
КонецФункции

Процедура ДобавитьРезультатПоСчету(Результаты, Рез, TopK)
\tИндекс = 0;
\tПока Индекс < Результаты.Количество() Цикл
\t\tЕсли Рез.score > Результаты[Индекс].score Тогда
\t\t\tПрервать;
\t\tКонецЕсли;
\t\tИндекс = Индекс + 1;
\tКонецЦикла;
\tРезультаты.Вставить(Индекс, Рез);
\tПока Результаты.Количество() > TopK Цикл
\t\tРезультаты.Удалить(Результаты.Количество() - 1);
\tКонецЦикла;
КонецПроцедуры

Функция Фрагмент(Content, Термы)
\tНорм = НРег(Content);
\tПозиция = 0;
\tДля Каждого Терм Из Термы Цикл
\t\tПозиция = СтрНайти(Норм, Терм);
\t\tЕсли Позиция > 0 Тогда
\t\t\tПрервать;
\t\tКонецЕсли;
\tКонецЦикла;
\tЕсли Позиция <= 0 Тогда
\t\tВозврат Content;
\tКонецЕсли;
\tНачало = Позиция - 300;
\tЕсли Начало < 1 Тогда
\t\tНачало = 1;
\tКонецЕсли;
\tВозврат Сред(Content, Начало);
КонецФункции

Функция Обрезать(Content, MaxChars)
\tЕсли MaxChars <= 0 Тогда
\t\tMaxChars = 1;
\tКонецЕсли;
\tЕсли СтрДлина(Content) <= MaxChars Тогда
\t\tВозврат Content;
\tКонецЕсли;
\tВозврат Лев(Content, MaxChars);
КонецФункции

Функция ЧислоКурсора(Cursor)
\tПопытка
\t\tВозврат ?(ПустаяСтрока(Строка(Cursor)), 0, Цел(Число(Cursor)));
\tИсключение
\t\tВозврат 0;
\tКонецПопытки;
КонецФункции`;
}

async function main() {
  const allSections = [];
  const topics = [];
  for (const rel of SOURCE_FILES) {
    const abs = resolve(SKILL_ROOT, rel);
    const sourceFile = toRepoPath(abs);
    const markdown = await readFile(abs, "utf8");
    const sections = parseSections(sourceFile, markdown);
    allSections.push(...sections);
    const id = topicIdFromPath(sourceFile);
    topics.push({
      id,
      title: TOPIC_TITLES[id] || id,
      section_count: sections.length,
      source_file: sourceFile,
      resource_uri: id === "version-provenance" ? `${RESOURCE_PREFIX}/provenance` : `${RESOURCE_PREFIX}/${id}`,
    });
  }
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${buildBsl(allSections, topics)}\n`, "utf8");
  console.log(`Generated ${relative(REPO_ROOT, OUTPUT)} with ${allSections.length} sections for ${DEFAULT_VERSION}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
