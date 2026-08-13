#!/usr/bin/env node
// Статическая проверка текста запроса 1С на соответствие tz_standarty_razrabotki.md.
// Проверяет только то, что видно в тексте запроса, без обращения к 1С.
//
// Использование:
//   node scripts/query_style_check.mjs <файл.txt> [<файл2.txt> ...]
//   cat query.txt | node scripts/query_style_check.mjs -
//
// Код возврата: 0 — нарушений уровня error нет; 1 — есть error; 2 — ошибка запуска.
//
// Программно:
//   import { checkQuery } from "./query_style_check.mjs";
//   const findings = checkQuery(text);

import { readFileSync } from "node:fs";

// Строковые литералы и комментарии исключаются из большинства проверок:
// внутри них кириллица/латиница/Ё — данные, а не идентификаторы.
function stripLiteralsAndComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // строковый литерал 1С; удвоенная кавычка внутри — экранирование
      out += " ";
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { out += "  "; i += 2; continue; }
          out += " "; i += 1; break;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Документированное исключение, объявленное в тексте запроса:
//   // СТАНДАРТ-ИСКЛЮЧЕНИЕ: <идентификатор_правила> — <обоснование>
// Действует на строку маркера и следующую за ней. Обоснование обязательно:
// маркер без него остаётся нарушением (иначе исключение превращается в штамп).
const EXCEPTION_RE = /\/\/\s*СТАНДАРТ-ИСКЛЮЧЕНИЕ\s*:\s*([A-Za-z0-9_]+)\s*(?:[—–-]\s*(.*))?$/;

// Формулировки, не являющиеся обоснованием (§ «Документированное исключение»).
const NON_JUSTIFICATIONS = [
  /^так удобнее/i,
  /^не подошл/i,
  /^нужна детализаци[яю]\s*$/i,
  /^виртуальная таблица не подошла/i,
];

function collectExceptions(text) {
  const suppressed = new Map(); // ruleId -> Set(lineNumbers)
  const bogus = [];             // маркеры без внятного обоснования
  const lines = text.split("\n");

  lines.forEach((line, idx) => {
    const m = EXCEPTION_RE.exec(line.trim());
    if (!m) return;
    const ruleId = m[1];
    const lineNo = idx + 1;

    // Обоснование может продолжаться на следующих строках-комментариях
    // (формат из §1: маркер, затем перенос текста). Собираем целиком.
    let reason = (m[2] || "").trim();
    let last = idx;
    for (let j = idx + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (!next.startsWith("//")) break;
      if (EXCEPTION_RE.test(next)) break; // начался следующий маркер
      reason = (reason + " " + next.replace(/^\/\/\s*/, "")).trim();
      last = j;
    }

    const meaningful =
      reason.length >= 15 && !NON_JUSTIFICATIONS.some((re) => re.test(reason));

    if (!meaningful) {
      bogus.push({ ruleId, lineNo, reason });
      return; // подавления нет
    }
    if (!suppressed.has(ruleId)) suppressed.set(ruleId, new Set());
    // Охват: блок комментария целиком + первая строка кода после него.
    for (let n = lineNo; n <= last + 2; n += 1) suppressed.get(ruleId).add(n);
  });

  return { suppressed, bogus };
}

function pushFinding(findings, { id, severity, message, section, text, index, fragment }) {
  findings.push({
    id,
    severity,
    message,
    section,
    line: index === undefined ? null : lineOf(text, index),
    fragment: fragment ? fragment.trim().slice(0, 120) : null,
  });
}

// --- Правила ---------------------------------------------------------------

// §4.3 — буква Ё запрещена в тексте запроса (вне строковых литералов).
function checkYo(raw, code, findings) {
  const re = /[А-Яа-яЁёA-Za-z0-9_]*[Ёё][А-Яа-яЁёA-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    pushFinding(findings, {
      id: "style_yo_letter_forbidden",
      severity: "error",
      section: "§4.3",
      message: "Буква «Ё» в тексте запроса запрещена — использовать «Е». " +
        "Платформенные имена полей пишутся через «Е» (СчетДт, не СчётДт); " +
        "написание с «Ё» проходит validate_1c_query, но даёт «Поле не найдено» при исполнении.",
      text: raw,
      index: m.index,
      fragment: m[0],
    });
  }
}

// §4.3 — латиница внутри кириллического идентификатора.
//
// Различаются два случая, и правило ловит только первый:
//   ОПЕЧАТКА  — латинская серия внутри кириллического слова, которую не видно
//               глазом: «Cчет» (латинская C), «СчетDт», «ОCTATKИ». Даёт
//               «Поле не найдено»/«таблица не найдена» без видимой причины.
//   ОСОЗНАННО — целый латинский токен: ЕСТЬNULL, ДокументUUID, КонтрагентID.
//               Такие имена читаются однозначно и ловушки не создают.
//
// Признаков нарушения два, и нужен любой из них:
//   1) серия состоит ТОЛЬКО из букв-двойников — длина роли не играет.
//      «ОCTATKИ» набрано латиницей на пять букв подряд и от «ОСТАТКИ»
//      неотличимо; критерий по одной длине это пропускал.
//   2) серия короче трёх символов — даже если двойников в ней нет.
//      Одну-две латинские буквы легко задеть случайно при переключённой
//      раскладке, а осмысленное английское слово почти всегда длиннее.
const ALLOWED_LATIN_TOKENS = ["NULL", "UUID", "ID"];
const SUSPICIOUS_RUN_MAX = 2;
// Латинские буквы, визуально неотличимые от кириллических А,В,С,Е,Н,К,М,О,Р,Т,Х,У.
const LATIN_HOMOGLYPHS = new Set([..."ABCEHKMOPTXY", ..."acepxyo"]);
const isAllHomoglyphs = (run) => [...run].every((c) => LATIN_HOMOGLYPHS.has(c));

// Латинские серии внутри слова, которые выглядят как опечатка.
function suspiciousLatinRuns(word) {
  const runs = word.match(/[A-Za-z]+/g) || [];
  return runs.filter((run) => {
    if (ALLOWED_LATIN_TOKENS.includes(run.toUpperCase())) return false;
    return isAllHomoglyphs(run) || run.length <= SUSPICIOUS_RUN_MAX;
  });
}

function checkMixedScript(raw, code, findings) {
  const re = /[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const word = m[0];
    // Чисто латинское слово — ключевое слово языка (SELECT/FROM/NULL), не идентификатор.
    if (!/[А-Яа-яЁё]/.test(word)) continue;

    const bad = suspiciousLatinRuns(word);
    if (bad.length === 0) continue;

    pushFinding(findings, {
      id: "temporary_table_identifier_mixed_script",
      severity: "error",
      section: "§4.3",
      message: `Латинская вставка «${bad[0]}» внутри кириллического идентификатора ` +
        `«${word}». Кириллические А,В,Е,К,М,Н,О,Р,С,Т,Х,У визуально неотличимы от латинских, ` +
        "поэтому такая вставка почти всегда опечатка и даёт «Поле не найдено» без видимой " +
        `причины. Допустимы токены ${ALLOWED_LATIN_TOKENS.join(", ")} и любые слова от ` +
        `${SUSPICIOUS_RUN_MAX + 1} символов, В КОТОРЫХ ЕСТЬ хотя бы одна буква без ` +
        "кириллического двойника (ЕСТЬNULL, ДокументUUID): они читаются однозначно.",
      text: raw,
      index: m.index,
      fragment: word,
    });
  }
}

// §1 «Запрет на использование основной таблицы регистра без перебора виртуальных».
// Основная таблица = РегистрX.Имя без суффикса виртуальной таблицы и без "(" параметров.
// Третий сегмент, означающий виртуальную таблицу, а не основную. Перечислены
// таблицы тех видов регистров, на которые правило распространяется (см.
// BASE_TABLE_REGISTER_KINDS); таблицы регистра расчёта сюда не входят, потому
// что сам этот вид регистра правилом не проверяется.
const VT_SUFFIXES = new Set([
  "Остатки", "Обороты", "ОстаткиИОбороты", "ОборотыДтКт", "ДвиженияССубконто",
  "Субконто", "СрезПоследних", "СрезПервых", "Изменения",
]);

// Виды регистров под запретом — те же три, что и в серверном правиле
// (`ДобавитьОшибкуОсновнойТаблицыРегистра` в `MCP_Query.bsl`). Для них типовые
// виртуальные таблицы существуют ВСЕГДА, поэтому основная таблица требует
// объявленного исключения.
//
// РегистрРасчета здесь намеренно отсутствует (§1.4 стандартов). Наличие каждой
// из его виртуальных таблиц (`.База`, `.ФактическийПериодДействия`, `.График`)
// зависит от настройки конкретного регистра в конфигураторе, а отчёты по
// начислениям и удержаниям строятся именно на основной таблице — это штатный
// случай, а не обход. Требовать для него маркер исключения значило бы
// требовать обоснование за нормальный запрос.
const BASE_TABLE_REGISTER_KINDS = "РегистрБухгалтерии|РегистрНакопления|РегистрСведений";

function checkBaseRegisterTable(raw, code, findings) {
  const re = new RegExp(
    `(${BASE_TABLE_REGISTER_KINDS})\\.([А-Яа-яЁёA-Za-z0-9_]+)(\\.([А-Яа-яЁёA-Za-z0-9_]+))?`,
    "g",
  );
  let m;
  while ((m = re.exec(code)) !== null) {
    const suffix = m[4];
    if (suffix && VT_SUFFIXES.has(suffix)) continue;
    if (suffix) continue; // трёхчленная ссылка на неизвестную ВТ — не наш случай
    pushFinding(findings, {
      id: "base_register_table_without_vt_check",
      severity: "warning",
      section: "§1 (запрет основной таблицы)",
      message: "Используется основная (физическая) таблица регистра. Допустимо только " +
        "после перебора всех виртуальных таблиц этого регистра с фиксацией причины в журнале. " +
        "Напоминание: Обороты не содержит Регистратор, но ДвиженияССубконто содержит и его, и субконто.",
      text: raw,
      index: m.index,
      fragment: m[0],
    });
  }
}

// Операторы пакета. Псевдонимы действуют только внутри своего оператора:
// одно и то же имя в разных операторах пакета может означать разные таблицы
// (в одном — основной источник, в другом — внешне присоединённая ВТ).
// «;» внутри выражений языка запросов не встречается, поэтому деление надёжно.
function splitStatements(code) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === ";") {
      parts.push({ text: code.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: code.slice(start), offset: start });
  return parts;
}

// Псевдонимы, поля которых могут быть NULL по факту несовпадения пары (§4.4).
//
// Нулевая сторона определяется ВИДОМ соединения, а не позицией источника:
//   ЛЕВОЕ  — нулевая правая сторона (псевдоним после СОЕДИНЕНИЕ);
//   ПРАВОЕ — нулевая ЛЕВАЯ сторона (псевдоним источника перед видом соединения);
//   ПОЛНОЕ — нулевые обе стороны.
// Прежняя реализация всегда брала псевдоним после слова СОЕДИНЕНИЕ, поэтому при
// ПРАВОЕ проверяла не ту сторону: требовала ЕСТЬNULL там, где NULL невозможен,
// и пропускала настоящее нарушение на действительно нулевой стороне.
// Все псевдонимы ИСТОЧНИКОВ до позиции — накопленная левая сторона цепочки.
// Считаются только КАК из раздела источников (после токена ИЗ) и на нулевой глубине
// скобок: псевдонимы колонок из списка ВЫБРАТЬ стоят до ИЗ и не попадают, подзапрос
// участвует одним внешним псевдонимом. Тот же алгоритм — в серверной
// MCP_Query.ПсевдонимыИсточниковДоПозиции; расхождение реализаций означает
// расхождение вердиктов чекера и сервера.
function sourceAliasesBefore(code, limitIndex) {
  const upper = code.toUpperCase();
  const isId = (c) => c !== undefined && /[А-ЯЁA-Z0-9_]/.test(c);
  let depth = 0;
  let fromIdx = -1;
  for (let i = 0; i < upper.length - 1; i += 1) {
    const c = upper[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && upper.startsWith("ИЗ", i) && !isId(upper[i - 1]) && !isId(upper[i + 2])) {
      fromIdx = i;
      break;
    }
  }
  const result = [];
  if (fromIdx < 0 || fromIdx >= limitIndex) return result;
  depth = 0;
  for (let i = fromIdx; i < limitIndex; i += 1) {
    const c = upper[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && upper.startsWith("КАК", i) && !isId(upper[i - 1]) && !isId(upper[i + 3])) {
      const m = /[А-Яа-яЁёA-Za-z0-9_]+/.exec(code.slice(i + 3, i + 200));
      if (m) result.push(m[0].toUpperCase());
      i += 3;
    }
  }
  return result;
}

function outerJoinAliases(code) {
  const aliases = new Set();
  const re = /(ЛЕВОЕ|ПРАВОЕ|ПОЛНОЕ)\s+(?:ВНЕШНЕЕ\s+)?СОЕДИНЕНИЕ\s+[А-Яа-яЁёA-Za-z0-9_.]+\s+КАК\s+([А-Яа-яЁёA-Za-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    const kind = m[1].toUpperCase();
    if (kind === "ЛЕВОЕ" || kind === "ПОЛНОЕ") aliases.add(m[2].toUpperCase());
    if (kind === "ПРАВОЕ" || kind === "ПОЛНОЕ") {
      // Левая сторона — ВЕСЬ накопленный результат цепочки, а не последний
      // псевдоним: в «(К ЛЕВОЕ СОЕДИНЕНИЕ Д) ПРАВОЕ СОЕДИНЕНИЕ О» нулевыми
      // становятся и К, и Д. «Последнее КАК до соединения» теряло К, и
      // К.Наименование без ЕСТЬNULL молча теряло строки при исполнении (#83).
      for (const left of sourceAliasesBefore(code, m.index)) aliases.add(left);
    }
  }
  return aliases;
}

// §5.2/§5.3 — ЕСТЬ НЕ NULL для ссылочного поля без парной проверки пустой ссылки.
function checkEmptyRef(raw, code, findings) {
  const hasEmptyRefCheck = /ЗНАЧЕНИЕ\s*\(\s*[А-Яа-яЁёA-Za-z0-9_.]+\.ПустаяСсылка\s*\)/i.test(code);
  if (hasEmptyRefCheck) return;

  for (const stmt of splitStatements(code)) {
    const outer = outerJoinAliases(stmt.text);
    const re = /([А-Яа-яЁёA-Za-z0-9_]+)(?:\.([А-Яа-яЁёA-Za-z0-9_]+))?(?:\.[А-Яа-яЁёA-Za-z0-9_]+)*\s+ЕСТЬ\s+НЕ\s+NULL/gi;
    let m;
    while ((m = re.exec(stmt.text)) !== null) {
      // §4.4: поле внешне присоединённой таблицы — проверка «совпала ли пара»,
      // а не пустоты ссылки. Правило §5.2 к нему не применяется.
      if (m[2] && outer.has(m[1].toUpperCase())) continue;
      pushFinding(findings, {
        id: "empty_reference_not_filtered",
        severity: "warning",
        section: "§5.2/§5.3",
        message: "«ЕСТЬ НЕ NULL» без парной проверки пустой ссылки. Пустая ссылка не равна NULL: " +
          "для ссылочного поля добавить «<> ЗНАЧЕНИЕ(<Тип>.ПустаяСсылка)» либо разыменовать атрибут. " +
          "Если поле нессылочное — предупреждение неприменимо.",
        text: raw,
        index: stmt.offset + m.index,
        fragment: m[0],
      });
    }
  }
}

// §4.4 — поля внешне присоединённой таблицы обязаны быть обёрнуты в ЕСТЬNULL.
function checkOuterJoinNulls(raw, fullCode, findings) {
  for (const stmt of splitStatements(fullCode)) {
    checkOuterJoinNullsInStatement(raw, stmt.text, stmt.offset, findings);
  }
}

function checkOuterJoinNullsInStatement(raw, code, baseOffset, findings) {
  const outer = outerJoinAliases(code);
  if (outer.size === 0) return;

  // Диапазоны внутри ЕСТЬNULL(...) — там поле уже обработано.
  const guarded = [];
  const fn = /ЕСТЬNULL\s*\(/gi;
  let f;
  while ((f = fn.exec(code)) !== null) {
    let depth = 1;
    let i = f.index + f[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    guarded.push([f.index, i]);
  }
  const isGuarded = (pos) => guarded.some(([s, e]) => pos >= s && pos < e);

  // Условия соединения (ПО ...) не требуют обёртки: там сравнение и строит пару.
  // \b в JS не работает с кириллицей — границы слова проверяются явно.
  // Лукахед заодно отсекает ПОМЕСТИТЬ/ПОДОБНО, начинающиеся с «ПО».
  const onRanges = [];
  const onRe = /(^|[^А-Яа-яЁёA-Za-z0-9_])ПО(?=[^А-Яа-яЁёA-Za-z0-9_]|$)/gi;
  const stopRe = /(^|[^А-Яа-яЁёA-Za-z0-9_])(ГДЕ|СГРУППИРОВАТЬ|УПОРЯДОЧИТЬ|ИМЕЮЩИЕ|ВЫБРАТЬ|ПОМЕСТИТЬ|ИНДЕКСИРОВАТЬ|ЛЕВОЕ|ПРАВОЕ|ПОЛНОЕ|ВНУТРЕННЕЕ|ОБЪЕДИНИТЬ)(?=[^А-Яа-яЁёA-Za-z0-9_]|$)/i;
  let o;
  while ((o = onRe.exec(code)) !== null) {
    const start = o.index + o[1].length;
    const after = start + 2;
    const stop = stopRe.exec(code.slice(after));
    onRanges.push([start, stop ? after + stop.index : code.length]);
  }
  const inOn = (pos) => onRanges.some(([s, e]) => pos >= s && pos < e);

  const reported = new Set();
  const ref = /([А-Яа-яЁёA-Za-z0-9_]+)\.([А-Яа-яЁёA-Za-z0-9_]+)/g;
  let m;
  while ((m = ref.exec(code)) !== null) {
    if (!outer.has(m[1].toUpperCase())) continue;
    if (isGuarded(m.index) || inOn(m.index)) continue;
    // Индикатор совпадения пары — исключение §4.4.
    if (/^\s+ЕСТЬ\s+(НЕ\s+)?NULL/i.test(code.slice(m.index + m[0].length))) continue;

    const key = m[0].toUpperCase();
    if (reported.has(key)) continue;
    reported.add(key);

    pushFinding(findings, {
      id: "outer_join_field_without_isnull",
      severity: "warning",
      section: "§4.4",
      message: `Поле «${m[0]}» относится к нулевой стороне внешнего соединения ` +
        "и взято без ЕСТЬNULL. Нулевая сторона определяется видом соединения, а не позицией " +
        "в тексте: при ЛЕВОМ — присоединяемая (правая), при ПРАВОМ — левая, при ПОЛНОМ — обе, " +
        "в цепочке соединений — все источники левее ПРАВОГО или ПОЛНОГО, потому что левый " +
        "операнд такого соединения есть весь накопленный результат цепочки. " +
        "При несовпадении пары поле равно NULL: условие ГДЕ или ИМЕЮЩИЕ со значением NULL " +
        "считается НЕВЫПОЛНЕННЫМ и строка исчезает молча, арифметика с NULL даёт NULL, " +
        "агрегат по колонке из NULL даёт NULL. " +
        "Обернуть в ЕСТЬNULL со значением ТОГО ЖЕ типа (число → 0, строка → \"\", " +
        "дата → ДАТАВРЕМЯ(1,1,1), ссылка → ЗНАЧЕНИЕ(<Тип>.ПустаяСсылка), булево → ЛОЖЬ); " +
        "значение другого типа создаёт колонку составного типа. Исключение — поле-индикатор " +
        "совпадения (<Псевдоним>.<Поле> ЕСТЬ NULL), его оборачивать нельзя.",
      text: raw,
      index: baseOffset + m.index,
      fragment: m[0],
    });
  }
}

// §2 — отбор по полям виртуальной таблицы во внешнем ГДЕ вместо её параметров.
// Блокирующее нарушение: параметры ВТ применяются до агрегации, внешний ГДЕ — после.
function checkFilterOutsideVtParams(raw, fullCode, findings) {
  const VT = "(?:Остатки|Обороты|ОстаткиИОбороты|ОборотыДтКт|СрезПоследних|СрезПервых|ДвиженияССубконто)";

  for (const stmt of splitStatements(fullCode)) {
    // Псевдонимы источников-ВТ этого оператора.
    const vtAliases = new Set();
    const src = new RegExp(
      `\\.${VT}\\s*\\([\\s\\S]*?\\)\\s*КАК\\s+([А-Яа-яЁёA-Za-z0-9_]+)`, "gi");
    let s;
    while ((s = src.exec(stmt.text)) !== null) vtAliases.add(s[1].toUpperCase());
    if (vtAliases.size === 0) continue;

    // Границы секции ГДЕ этого оператора.
    const whereRe = /(^|[^А-Яа-яЁёA-Za-z0-9_])ГДЕ(?=[^А-Яа-яЁёA-Za-z0-9_]|$)/i;
    const w = whereRe.exec(stmt.text);
    if (!w) continue;
    const start = w.index + w[1].length;
    const stopRe = /(^|[^А-Яа-яЁёA-Za-z0-9_])(СГРУППИРОВАТЬ|УПОРЯДОЧИТЬ|ИМЕЮЩИЕ|ИНДЕКСИРОВАТЬ|ОБЪЕДИНИТЬ|ИТОГИ)(?=[^А-Яа-яЁёA-Za-z0-9_]|$)/i;
    const stop = stopRe.exec(stmt.text.slice(start + 3));
    const where = stmt.text.slice(start, stop ? start + 3 + stop.index : stmt.text.length);

    const reported = new Set();
    const ref = /([А-Яа-яЁёA-Za-z0-9_]+)\.([А-Яа-яЁёA-Za-z0-9_]+)/g;
    let m;
    while ((m = ref.exec(where)) !== null) {
      if (!vtAliases.has(m[1].toUpperCase())) continue;
      if (reported.has(m[0].toUpperCase())) continue;
      reported.add(m[0].toUpperCase());
      pushFinding(findings, {
        id: "vt_filter_in_external_where",
        severity: "error",
        section: "§2",
        message: `Отбор по полю «${m[0]}» виртуальной таблицы вынесен во внешний ГДЕ. ` +
          "Параметры ВТ применяются ДО агрегации, внешний ГДЕ — ПОСЛЕ: это влияет на корректность " +
          "агрегации, а не только на скорость. Перенести в параметры ВТ (отбор по счёту — в " +
          "УсловиеСчета, виды субконто — в Субконто, отборы по значению — в последнюю позицию " +
          "Условие). Проверку типа писать как ТИПЗНАЧЕНИЯ(Поле) = ТИПЗНАЧЕНИЯ(ЗНАЧЕНИЕ(<Тип>.ПустаяСсылка)).",
        text: raw,
        index: stmt.offset + start + m.index,
        fragment: m[0],
      });
    }
  }
}

// §1 — сигнатуры виртуальных таблиц. Позиции фиксированы платформой и не
// зависят от конфигурации, поэтому проверяются статически, без метаданных.
// ВАЖНО: одно и то же имя ВТ имеет РАЗНУЮ сигнатуру у разных видов регистра
// (Остатки: 4 позиции у бухгалтерии, 2 у накопления).
const VT_SIGNATURES = {
  РЕГИСТРБУХГАЛТЕРИИ: {
    ОСТАТКИ: { names: ["Период", "УсловиеСчета", "Субконто", "Условие"], accountPos: [1], condPos: 3 },
    ОБОРОТЫ: { names: ["НачалоПериода", "КонецПериода", "Периодичность", "УсловиеСчета", "Субконто", "Условие", "УсловиеКорСчета", "КорСубконто"], accountPos: [3], condPos: 5 },
    ОСТАТКИИОБОРОТЫ: { names: ["НачалоПериода", "КонецПериода", "Периодичность", "МетодДополнения", "УсловиеСчета", "Субконто", "Условие"], accountPos: [4], condPos: 6 },
    ОБОРОТЫДТКТ: { names: ["НачалоПериода", "КонецПериода", "Периодичность", "УсловиеСчетаДт", "СубконтоДт", "УсловиеСчетаКт", "СубконтоКт", "Условие"], accountPos: [3, 5], condPos: 7 },
  },
  РЕГИСТРНАКОПЛЕНИЯ: {
    ОСТАТКИ: { names: ["Период", "Условие"], accountPos: [], condPos: 1 },
    ОБОРОТЫ: { names: ["НачалоПериода", "КонецПериода", "Периодичность", "Условие"], accountPos: [], condPos: 3 },
    ОСТАТКИИОБОРОТЫ: { names: ["НачалоПериода", "КонецПериода", "Периодичность", "МетодДополнения", "Условие"], accountPos: [], condPos: 4 },
  },
  РЕГИСТРСВЕДЕНИЙ: {
    СРЕЗПОСЛЕДНИХ: { names: ["Период", "Условие"], accountPos: [], condPos: 1 },
    СРЕЗПЕРВЫХ: { names: ["Период", "Условие"], accountPos: [], condPos: 1 },
  },
  // РегистрРасчета намеренно отсутствует: наличие и сигнатура его виртуальных
  // таблиц не гарантированы платформой (§1.4) — проверять статически нельзя.
};

// Разбор аргументов вызова на нулевом уровне вложенности.
function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      args.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  args.push({ text: text.slice(start), offset: start });
  return args;
}

function checkVtSignature(raw, code, findings) {
  const re = /(РегистрБухгалтерии|РегистрНакопления|РегистрСведений)\.([А-Яа-яЁёA-Za-z0-9_]+)\.([А-Яа-яЁёA-Za-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    const byKind = VT_SIGNATURES[m[1].toUpperCase()];
    if (!byKind) continue;
    const sig = byKind[m[3].toUpperCase()];
    if (!sig) continue;

    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    const inner = code.slice(open, i - 1);
    const args = splitTopLevelArgs(inner);

    // Висящая запятая допустима (§2 п.6): пустой последний аргумент не считаем.
    let count = args.length;
    if (count > 0 && args[count - 1].text.trim() === "") count -= 1;
    // Полностью пустой вызов ВТ() — параметры не заданы, отдельная тема (не эта проверка).
    if (count === 0) continue;

    if (count > sig.names.length) {
      pushFinding(findings, {
        id: "vt_signature_too_many_positions",
        severity: "error",
        section: "§1",
        message: `${m[1]}.<Имя>.${m[3]} принимает ${sig.names.length} позиц. ` +
          `(${sig.names.join(", ")}), передано ${count}. Лишние аргументы дают ` +
          "«Неверные параметры». Внимание: одно и то же имя ВТ имеет разную сигнатуру " +
          "у разных видов регистра.",
        text: raw,
        index: m.index,
        fragment: `${m[1]}.${m[2]}.${m[3]}`,
      });
      continue;
    }

    // Условие по значению субконто, ошибочно помещённое в позицию условия по счёту.
    // Исторически самая дорогая ошибка: даёт «Поле не найдено Субконто1» и
    // провоцирует ложный вывод о платформенном ограничении.
    for (const pos of sig.accountPos) {
      if (pos >= count) continue;
      const arg = args[pos].text;
      const bad = /Субконто(Дт|Кт)?\d/i.exec(arg);
      if (!bad) continue;
      pushFinding(findings, {
        id: "vt_subconto_condition_in_account_position",
        severity: "error",
        section: "§1/§2 п.4",
        message: `«${bad[0]}» находится в позиции ${pos + 1} (${sig.names[pos]}), ` +
          `которая видит только поля счёта. Отсюда ошибка «Поле не найдено ${bad[0]}». ` +
          `Условия по ЗНАЧЕНИЮ субконто помещаются в позицию ${sig.condPos + 1} ` +
          `(${sig.names[sig.condPos]}).`,
        text: raw,
        index: open + args[pos].offset,
        fragment: arg.trim().slice(0, 60),
      });
    }
  }
}

// §4.1 — виртуальная таблица не участвует в СОЕДИНЕНИЕ напрямую: сначала
// ПОМЕСТИТЬ + ИНДЕКСИРОВАТЬ ПО, только потом соединение.
function checkDirectJoinWithVt(raw, code, findings) {
  const re = /(ЛЕВОЕ|ПРАВОЕ|ПОЛНОЕ|ВНУТРЕННЕЕ)?\s*(?:ВНЕШНЕЕ\s+)?СОЕДИНЕНИЕ\s+([А-Яа-яЁёA-Za-z0-9_]+\.[А-Яа-яЁёA-Za-z0-9_]+\.(?:Остатки|Обороты|ОстаткиИОбороты|ОборотыДтКт|СрезПоследних|СрезПервых|ДвиженияССубконто))\s*\(/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    pushFinding(findings, {
      id: "direct_join_with_virtual_table",
      severity: "error",
      section: "§4.1",
      message: `Виртуальная таблица «${m[2]}» участвует в СОЕДИНЕНИЕ напрямую. ` +
        "СУБД не может оптимизировать такое соединение. Обязательная последовательность: " +
        "наложить отборы в параметрах ВТ (§2) → ПОМЕСТИТЬ во временную таблицу → " +
        "ИНДЕКСИРОВАТЬ ПО полям будущего соединения (§3) → только затем СОЕДИНЕНИЕ.",
      text: raw,
      index: m.index,
      fragment: m[2],
    });
  }
}

// §2 п.3 — инлайн-литерал видов субконто в параметрах ВТ (падает при исполнении).
function checkInlineSubcontoLiteral(raw, code, findings) {
  const re = /\(\s*ЗНАЧЕНИЕ\s*\(\s*ПланВидовХарактеристик\.[^)]*\)\s*,\s*ЗНАЧЕНИЕ\s*\(\s*ПланВидовХарактеристик\./gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    pushFinding(findings, {
      id: "subconto_inline_literal_instead_of_array_param",
      severity: "error",
      section: "§2 п.3",
      message: "Массив видов субконто задан инлайн-литералом. Такая форма проходит validate_1c_query, " +
        "но падает при исполнении («Неверные параметры»). Передавать именованным параметром " +
        "&ВидыСубконто со значением {kind: array, value: [{kind: ref, ...}]}.",
      text: raw,
      index: m.index,
      fragment: m[0],
    });
  }
}

// Правила vt_param_type_check_rejected_form и composite_index_without_preceding_group_by
// удалены: они описывали обходы дефектов предвалидатора issue #62 и #60, закрытых в
// PR #65 (деплой 28.07.2026, живая проверка 29.07.2026). Предвалидатор принимает и
// прямые формы проверки типа (ССЫЛКА <Тип>, ТИП(<Тип>) в параметрах ВТ), и составной
// ИНДЕКСИРОВАТЬ ПО без предшествующей группировки. Держать проверки дальше значило бы
// запрещать законный синтаксис и советовать лишнюю группировку, меняющую план запроса.

// Функции встроенного языка, которых нет в языке запросов. Список ЗАКРЫТЫЙ: незнакомую
// функцию отклонять нельзя — язык запросов допускает платформенные функции и функции
// конфигурации, и ложный отказ хуже пропуска. Пополнять только после подтверждения
// документацией и живой пробой. Тот же список — в MCP_Query.НеподдерживаемыеФункцииЗапроса;
// расхождение между чекером и сервером означает расхождение вердиктов.
const UNSUPPORTED_QUERY_FUNCTIONS = ["АБС", "ABS"];

// АБС/ABS проходит validate_1c_query, но падает синтаксической ошибкой в движке
// (подтверждено живьём на БП КОРП 3.0.192.25). Ищется именно вызов: токен целиком и
// открывающая скобка за ним. Обращение к полю (Алиас.АБС) вызовом не считается.
function checkUnsupportedQueryFunction(raw, code, findings) {
  for (const name of UNSUPPORTED_QUERY_FUNCTIONS) {
    const re = new RegExp(`(^|[^A-Za-zА-Яа-яЁё0-9_.])(${name})\\s*\\(`, "gi");
    let m;
    while ((m = re.exec(code)) !== null) {
      pushFinding(findings, {
        id: "unsupported_query_function",
        severity: "error",
        // Нормативная опора — §8 tz_standarty_razrabotki.md (функции языка запросов и
        // отсутствующие аналоги встроенного языка). Метка остаётся «платформа», а не
        // «§8»: правило держится на свойстве платформы, документ его лишь фиксирует, и
        // при смене нумерации разделов метка не должна становиться ложной ссылкой.
        section: "платформа",
        message: `Функции ${m[2]} в языке запросов 1С нет: это функция встроенного языка. ` +
          `Модуль числа пишется как ВЫБОР КОГДА X < 0 ТОГДА -X ИНАЧЕ X КОНЕЦ; при вложенности ` +
          "выражение повторяется целиком, сослаться на псевдоним той же строки ВЫБРАТЬ нельзя.",
        text: raw,
        index: m.index + m[1].length,
        fragment: `${m[2]}(`,
      });
    }
  }
}

// Зарезервированные слова языка запросов, недопустимые как псевдоним (#150 Д-1).
//
// Состав СВЕРЕН ПО ПЛАТФОРМЕ 13.08.2026 на BUH_KORP, а не взят из текста задачи:
// каждое слово проверено реальным выполнением в трёх позициях — псевдоним
// источника обычной таблицы, псевдоним источника временной таблицы, псевдоним
// колонки. Из списка задачи по итогам замера ИСКЛЮЧЕНЫ два слова:
//
//   КОНЕЦ  — законен во ВСЕХ трёх позициях (OK/OK/OK). Правило с ним красило бы
//            рабочий запрос.
//   ССЫЛКА — законна как псевдоним колонки и как псевдоним источника временной
//            таблицы; отвергается только как псевдоним источника таблицы, у
//            которой есть собственный реквизит Ссылка. Между тем «Т.Ссылка КАК
//            Ссылка» — повсеместный шаблон репозитория (проверен живьём в тот же
//            день), и блокирующее правило дало бы массу ложных провалов. Отказ в
//            оставшемся узком случае происходит громко, при первом выполнении,
//            с внятным сообщением — это не тот молчаливый класс, ради которого
//            заведена проверка.
//
// Остальные 15 отвергаются платформой во ВСЕХ трёх позициях — по ним правило
// безусловное. Валидатор сервера (validate_1c_query) на всём этом наборе, кроме
// ИЗ в позиции колонки, отвечает valid=true: он к платформенному разбору здесь
// не обращается, поэтому опорой служит выполнение, а не его вердикт.
const RESERVED_ALIASES = new Set([
  "В", "И", "ИЛИ", "НЕ", "ЕСТЬ", "ПО", "КАК", "ИЗ", "ГДЕ",
  "ВЫБОР", "КОГДА", "ТОГДА", "ИНАЧЕ", "ПОДОБНО", "МЕЖДУ",
]);

// §4.3 — псевдоним, совпадающий с зарезервированным словом языка запросов.
//
// Платформа такой текст отвергает: `ВЫБРАТЬ В.П ИЗ Т КАК В` даёт
// «{(85, 17)}: Ожидается имя  ВТ_Выручка КАК <<?>>В». Проверка чисто текстовая,
// живой контур не нужен — и в этом весь смысл: дефект был пойман ДВАЖДЫ за одну
// сессию, каждый раз через отказ живой базы, причём второй раз уже после того,
// как первый был записан в журнал. Память между задачами не переносится, а
// round-trip к контуру стоит дорого.
function checkReservedAlias(raw, code, findings) {
  const re = /(^|[^А-Яа-яЁёA-Za-z0-9_.])КАК\s+([А-Яа-яЁёA-Za-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    const alias = m[2];
    if (!RESERVED_ALIASES.has(alias.toUpperCase())) continue;
    pushFinding(findings, {
      id: "reserved_word_as_alias",
      severity: "error",
      section: "§4.3",
      message: `Псевдоним «${alias}» совпадает с зарезервированным словом языка запросов — `
        + "платформа отклоняет такой запрос при выполнении («Ожидается имя»). "
        + "Назвать псевдоним по источнику или колонке, а не одной буквой.",
      text: raw,
      index: m.index + m[1].length,
      fragment: `КАК ${alias}`,
    });
  }
}

const RULES = [
  checkYo,
  checkMixedScript,
  checkReservedAlias,
  checkBaseRegisterTable,
  checkEmptyRef,
  checkOuterJoinNulls,
  checkFilterOutsideVtParams,
  checkVtSignature,
  checkDirectJoinWithVt,
  checkInlineSubcontoLiteral,
  checkUnsupportedQueryFunction,
];

// Реестр реализованных проверок — машинная истина о покрытии.
// Таблица покрытия в `tz_otladka_zaprosov_v1.0.0.md` §12 сверяется с этим
// списком: расхождение означает, что документ отстал от кода.
// Выводится по `node scripts/query_style_check.mjs --rules`.
export const IMPLEMENTED_RULES = [
  { id: "style_yo_letter_forbidden", section: "§4.3", severity: "error", title: "Буква Ё в тексте запроса" },
  { id: "temporary_table_identifier_mixed_script", section: "§4.3", severity: "error", title: "Латиница/гомоглифы в идентификаторе" },
  { id: "reserved_word_as_alias", section: "§4.3", severity: "error", title: "Зарезервированное слово как псевдоним" },
  { id: "base_register_table_without_vt_check", section: "§1", severity: "warning", title: "Основная таблица регистра без перебора ВТ" },
  { id: "exception_marker_without_justification", section: "§1", severity: "error", title: "Маркер исключения без обоснования" },
  { id: "empty_reference_not_filtered", section: "§5.2/§5.3", severity: "warning", title: "ЕСТЬ НЕ NULL без проверки пустой ссылки" },
  { id: "outer_join_field_without_isnull", section: "§4.4", severity: "warning", title: "Поле внешнего соединения без ЕСТЬNULL" },
  { id: "vt_filter_in_external_where", section: "§2", severity: "error", title: "Отбор по полю ВТ во внешнем ГДЕ" },
  { id: "vt_signature_too_many_positions", section: "§1", severity: "error", title: "Позиций больше, чем принимает ВТ" },
  { id: "vt_subconto_condition_in_account_position", section: "§1/§2 п.4", severity: "error", title: "Условие по субконто в позиции условия по счёту" },
  { id: "direct_join_with_virtual_table", section: "§4.1", severity: "error", title: "Прямое СОЕДИНЕНИЕ с виртуальной таблицей" },
  { id: "subconto_inline_literal_instead_of_array_param", section: "§2 п.3", severity: "error", title: "Инлайн-массив видов субконто" },
  { id: "unsupported_query_function", section: "платформа", severity: "error", title: "Функция встроенного языка вместо языка запросов (АБС/ABS)" },
];

export function checkQuery(text) {
  const code = stripLiteralsAndComments(text);
  const raw = [];
  for (const rule of RULES) rule(text, code, raw);

  const { suppressed, bogus } = collectExceptions(text);

  const findings = raw.filter((f) => {
    const lines = suppressed.get(f.id);
    return !(lines && f.line !== null && lines.has(f.line));
  });

  for (const b of bogus) {
    findings.push({
      id: "exception_marker_without_justification",
      severity: "error",
      section: "§1 (документированное исключение)",
      line: b.lineNo,
      fragment: `СТАНДАРТ-ИСКЛЮЧЕНИЕ: ${b.ruleId}`,
      message: b.reason
        ? `Обоснование «${b.reason}» не называет конкретное недостающее поле или свойство. ` +
          "Исключение не засчитано, нарушение остаётся."
        : "Маркер исключения без обоснования. Указать, какое именно поле или свойство " +
          "недоступно ни в одной виртуальной таблице регистра.",
    });
  }

  return findings.sort((a, b) => (a.line || 0) - (b.line || 0));
}

// --- CLI -------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node scripts/query_style_check.mjs <file.txt> [...] | -");
    console.error("       node scripts/query_style_check.mjs --rules   (реализованные проверки)");
    process.exit(2);
  }

  if (args[0] === "--rules") {
    console.log(`Реализованных проверок: ${IMPLEMENTED_RULES.length}\n`);
    const pad = Math.max(...IMPLEMENTED_RULES.map((r) => r.id.length));
    for (const r of IMPLEMENTED_RULES) {
      console.log(`${r.id.padEnd(pad)}  ${r.severity.padEnd(7)} ${r.section.padEnd(14)} ${r.title}`);
    }
    console.log("\nПравила стандартов без проверки — см. таблицу покрытия в");
    console.log("tz_otladka_zaprosov_v1.0.0.md §12. Отсутствие срабатываний означает");
    console.log("только отсутствие нарушений СРЕДИ РЕАЛИЗОВАННЫХ проверок.");
    process.exit(0);
  }

  let hasError = false;
  for (const arg of args) {
    const text = arg === "-" ? readStdin() : readFileSync(arg, "utf8");
    const label = arg === "-" ? "<stdin>" : arg;
    const findings = checkQuery(text);
    if (findings.length === 0) {
      console.log(`OK   ${label}`);
      continue;
    }
    console.log(`\n=== ${label} — нарушений: ${findings.length} ===`);
    for (const f of findings) {
      const mark = f.severity === "error" ? "ERROR " : "WARN  ";
      if (f.severity === "error") hasError = true;
      console.log(`${mark} строка ${f.line ?? "?"} [${f.id}] ${f.section}`);
      if (f.fragment) console.log(`       фрагмент: ${f.fragment}`);
      console.log(`       ${f.message}`);
    }
  }
  process.exit(hasError ? 1 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) main();
