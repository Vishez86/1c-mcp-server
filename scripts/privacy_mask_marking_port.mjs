// JS-порт логики пометки колонок privacy (MCP_Query.bsl) + таблица кейсов H1–H10
// и парных проб R-6. Прогоняется офлайн, до деплоя: компилятора 1С на стороне
// разработки нет, а на контуре проверять можно только уже опубликованный код.
//
//   node scripts/privacy_mask_marking_port.mjs
//   node scripts/privacy_mask_marking_port.mjs --verbose
//
// Порт НЕ заменяет живую приёмку. Он отвечает на один вопрос: принимает ли
// решающая цепочка правильное решение на формах, которые живой прогон 05.08.2026
// показал открытыми. Метаданные и политика здесь — заглушки: у порта нет и не
// может быть настоящей конфигурации, поэтому проверяется логика ветвления, а не
// разрешение имён конкретного контура.
//
// Соответствие функциям BSL указано у каждой функции: расхождение порта и модуля
// хуже отсутствия порта, потому что даёт ложную уверенность.

const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------- заглушки

// Политика: закрытый справочник с псевдонимом типа и закрытым полем, открытый
// справочник, регистр с масками полей (без псевдонима — R-9) и справочник с
// единственной не-имя-подобной маской (цена R-9 фиксируется парным кейсом).
// Имена вымышленные — живых имён контура здесь быть не должно.
const CLOSED = "Справочник.ЗакрытыйТип";
const OPEN = "Справочник.ОткрытыйТип";
const MASKED_REG = "РегистрСведений.ЗакрытыйРегистр";
const MASKED_CAT = "Справочник.СМаскойКомментария";

// alias — у типа есть псевдоним (type_aliases): имя-подобные поля получают код.
// fields — маски полей (type_field_masks): строковая маска.
const POLICY = {
  [CLOSED]: { alias: true, fields: ["Наименование", "НаименованиеПолное", "Код", "Представление"] },
  [MASKED_REG]: { alias: false, fields: ["Серия", "Номер", "КемВыдан"] },
  [MASKED_CAT]: { alias: false, fields: ["Комментарий"] },
};

// Метаданные: состав полей и ссылочность. Для порта достаточно знать, есть ли
// поле у типа и ведёт ли оно на другой тип.
const META = {
  [CLOSED]: { Наименование: null, Код: null, Ссылка: CLOSED, Владелец: null, Сумма: null },
  [OPEN]: { Наименование: null, Код: null, Ссылка: OPEN, Сумма: null },
  "Справочник.Подчиненный": { Наименование: null, Ссылка: "Справочник.Подчиненный", Владелец: CLOSED },
  // Представление — РЕСУРС регистра (замер BUH/ZUP/ERP), Наименования у него нет.
  [MASKED_REG]: { Серия: null, Номер: null, КемВыдан: null, ДатаВыдачи: null, Физлицо: CLOSED, Представление: null },
  [MASKED_CAT]: { Наименование: null, Код: null, Комментарий: null, Ссылка: MASKED_CAT },
};

const normField = (s) => String(s).toUpperCase().replace(/[\s_\-.]/g, "");

// R-9: наследование включается у типов, где `Представление` ОБЪЯВЛЕНО полем.
// Заглушка сверена с живыми метаданными 06.08.2026 ТЕМ ЖЕ набором коллекций,
// каким читает движок (реквизиты + измерения + ресурсы + стандартные реквизиты):
// у паспортного регистра Представление есть ресурсом, у справочников нет.
// Сверка «по attributes» неэквивалентна и дважды дала зелёный порт при неверной
// посылке — в обе стороны.
const hasPresentationField = (type) => Boolean(META[type] && Object.keys(META[type])
  .some((f) => f.toUpperCase() === "ПРЕДСТАВЛЕНИЕ"));

// MCP_Security.ПолеЗакрытоPrivacy + R-9: Представление наследует закрытость,
// когда у типа закрыт хотя бы один реквизит И `Представление` объявлено полем.
// Без второго условия признак был бы константой «любой тип из type_field_masks
// закрывает своё представление» — найдено ревью.
const fieldClosed = (type, field) => {
  const p = POLICY[type];
  if (!p) return false;
  if (p.fields.some((f) => normField(f) === normField(field))) return true;
  return ["ПРЕДСТАВЛЕНИЕ", "PRESENTATION"].includes(normField(field))
    && p.fields.length > 0 && hasPresentationField(type);
};
// MCP_Security.ПредставлениеЗакрытоPrivacy: псевдоним типа, имя-подобное поле в
// масках либо наследование R-9 (только там, где Представление — объявленное поле).
const presentationClosed = (type) => {
  const p = POLICY[type];
  if (!p) return false;
  return Boolean(p.alias) || (p.fields.length > 0 && hasPresentationField(type));
};
// MCP_Query.ПолеЕстьУИсточникаPrivacy
const fieldExists = (type, field) => {
  const fields = META[type];
  if (!fields) return false;
  const norm = (s) => String(s).toUpperCase();
  return Object.keys(fields).some((f) => norm(f) === norm(field))
    || ["НАИМЕНОВАНИЕ", "КОД", "ПРЕДСТАВЛЕНИЕ"].includes(norm(field));
};
// MCP_Query.СсылочныеТипыПоляPrivacy
const refTypesOf = (type, field) => {
  const fields = META[type] ?? {};
  const key = Object.keys(fields).find((f) => f.toUpperCase() === String(field).toUpperCase());
  const target = key ? fields[key] : undefined;
  return target ? [target] : [];
};

// -------------------------------------------------------------- лексика

// \b в JS — ASCII-граница и с кириллицей не работает: /\bВЫБРАТЬ\b/ не совпадает
// НИКОГДА. На этом порт с первого запуска дал 20 FAIL, включая контрольные формы,
// которые живьём работают. Границу задаём классом символов идентификатора.
const B = "(?<![0-9A-Za-zА-Яа-яЁё_])";
const A = "(?![0-9A-Za-zА-Яа-яЁё_])";
const word = (w, flags = "i") => new RegExp(B + w + A, flags);

// MCP_Query.ЯвляетсяСимволомИдентификатора
const isIdentChar = (c) => /[0-9A-Za-zА-Яа-яЁё_]/.test(c);
// MCP_Query.ПрочитатьИдентификатор
function readIdent(text, i) {
  let out = "";
  while (i <= text.length && isIdentChar(text[i - 1] ?? "")) { out += text[i - 1]; i++; }
  return out;
}
// MCP_Query.ПропуститьПробелы — возвращает 1-based позицию первого значащего
function skipSpaces(text, i) {
  while (i <= text.length && /\s/.test(text[i - 1])) i++;
  return i;
}
// MCP_Query.УдалитьПробельныеСимволыPrivacy
const stripWs = (s) => String(s).replace(/\s+/g, "");
// MCP_Query.ЭтоЦепочкаИдентификаторовPrivacy
const isIdentChain = (s) => /^&?[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*(\.[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)*$/.test(s);
// MCP_Query.СтрокаИзЦифрPrivacy
const isDigits = (s) => /^\d+$/.test(String(s));
// MCP_Query.ЭтоСегментСсылкиPrivacy
const isRefSegment = (s) => ["ССЫЛКА", "REF"].includes(String(s).toUpperCase());

// MCP_Query.ЭтоКлючевоеСловоВыраженияPrivacy — список держать синхронным с BSL
const EXPR_KEYWORDS = new Set(("ВЫБОР,КОГДА,ТОГДА,ИНАЧЕ,КОНЕЦ,ЕСТЬ,NULL,НЕ,И,ИЛИ,ПОДОБНО,ССЫЛКА,"
  + "ИСТИНА,ЛОЖЬ,КАК,МЕЖДУ,В,ИЕРАРХИИ,УБЫВ,ВОЗР,РАЗЛИЧНЫЕ,ПЕРВЫЕ,"
  + "CASE,WHEN,THEN,ELSE,END,IS,NOT,AND,OR,LIKE,REFS,TRUE,FALSE,AS,BETWEEN,IN,"
  + "HIERARCHY,DESC,ASC,DISTINCT,TOP,ТИП,TYPE,ЗНАЧЕНИЕ,VALUE").split(","));

// ------------------------------------------------- карта источников и проекция

// Упрощённый порт КартаАлиасовЗапроса: разбирает ИЗ/СОЕДИНЕНИЕ вида
// «<ПолноеИмя|ВТ> [КАК <алиас>]». Для кейсов порта этого достаточно; в модуле
// разбор устойчивее (вложенность, пакеты, подзапросы).
function sourceMap(command) {
  const sources = [];
  const bindings = new Map();
  // Раздел источников идёт от ИЗ до терминатора (ГДЕ, СГРУППИРОВАТЬ, …). Внутри
  // разделителями служат запятая и слова соединений: ЛексемыИсточников в модуле
  // делает то же самое, и запятая там полноправный разделитель — без этого
  // соединение через запятую (проба П4) не давало бы привязок, а R-4 закрыл бы
  // открытую колонку. Порт обязан повторять это, иначе он «зелёный» вслепую.
  const fromAt = command.search(word("(?:ИЗ|FROM)"));
  if (fromAt < 0) return { sources, bindings, gave_up: false, reason: "no_sources_detected" };
  let section = command.slice(fromAt).replace(/^\s*(ИЗ|FROM)\s*/i, "");
  const stop = section.search(word("(?:ГДЕ|WHERE|СГРУППИРОВАТЬ|GROUP|УПОРЯДОЧИТЬ|ORDER|ИМЕЮЩИЕ|HAVING"
    + "|ОБЪЕДИНИТЬ|UNION|ИТОГИ|TOTALS|ИНДЕКСИРОВАТЬ|INDEX|ПОМЕСТИТЬ|INTO|УНИЧТОЖИТЬ|DROP)"));
  if (stop >= 0) section = section.slice(0, stop);

  const parts = section
    .split(new RegExp(`,|${B}(?:ЛЕВОЕ|ПРАВОЕ|ВНУТРЕННЕЕ|ПОЛНОЕ|ВНЕШНЕЕ|СОЕДИНЕНИЕ|LEFT|RIGHT|INNER|FULL|OUTER|JOIN)${A}`, "gi"))
    .map((s) => s.replace(new RegExp(`${B}ПО${A}[\\s\\S]*$`, "i"), ""))
    .map((s) => s.replace(new RegExp(`${B}ON${A}[\\s\\S]*$`, "i"), ""))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const m = part.match(new RegExp(
      `^([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_.]*)\\s*(?:${B}(?:КАК|AS)${A}\\s+([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*))?`, "i"));
    if (!m) continue;
    const raw = m[1];
    const alias = m[2] ?? "";
    const full = META[raw] ? raw : (raw.includes(".") ? raw : "");
    const binding = { raw, alias, full_name: full };
    sources.push(binding);
    bindings.set((alias || raw).toUpperCase(), binding);
  }
  return { sources, bindings, gave_up: false, reason: "" };
}

// Порт ЭлементыПроекцииPrivacy: элементы списка выборки по запятым нулевой
// глубины, с отсечением КАК <имя> и модификаторов ПЕРВЫЕ/РАЗЛИЧНЫЕ.
function projectionItems(command) {
  const start = command.search(word("(?:ВЫБРАТЬ|SELECT)"));
  if (start < 0) return [];
  let head = command.slice(start).replace(/^\s*(ВЫБРАТЬ|SELECT)\s*/i, "");
  head = head.replace(/^\s*(РАЗЛИЧНЫЕ|DISTINCT)\s+/i, "");
  head = head.replace(/^\s*(ПЕРВЫЕ|TOP)\s+\d+\s*/i, "");
  // Граница списка выборки на нулевой глубине.
  let depth = 0, end = head.length;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && isIdentChar(c) && !isIdentChar(head[i - 1] ?? "")) {
      const w = readIdent(head, i + 1).toUpperCase();
      if (["ИЗ", "FROM", "ПОМЕСТИТЬ", "INTO", "СГРУППИРОВАТЬ", "УПОРЯДОЧИТЬ", "ГДЕ", "ИТОГИ"].includes(w)) {
        end = i; break;
      }
      i += Math.max(0, w.length - 1);
    }
  }
  const list = head.slice(0, end);
  const items = [];
  depth = 0;
  let acc = "";
  for (const c of list) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) { items.push(acc); acc = ""; continue; }
    acc += c;
  }
  if (acc.trim()) items.push(acc);
  return items.map((raw) => {
    const m = raw.match(/^([\s\S]*?)\s+(?:КАК|AS)\s+([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)\s*$/i);
    const expression = (m ? m[1] : raw).trim();
    const column = m ? m[2] : stripWs(expression).split(".").pop();
    return { expression, column };
  });
}

// Порт ПутиАдресованныеАлиасуPrivacy: пути, адресованные псевдонимом, на любой
// глубине. Границы идентификатора с обеих сторон обязательны.
function pathsForAlias(text, alias) {
  const out = [];
  if (!alias) return out;
  const up = text.toUpperCase();
  const needle = alias.toUpperCase();
  let from = 0;
  for (;;) {
    const at = up.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    const prev = at > 0 ? text[at - 1] : "";
    if (isIdentChar(prev) || prev === "." || prev === "&") continue;
    if (isIdentChar(text[at + needle.length] ?? "")) continue;
    let i = skipSpaces(text, at + needle.length + 1);
    if (text[i - 1] !== ".") continue;
    const path = [];
    while (text[i - 1] === ".") {
      i = skipSpaces(text, i + 1);
      const seg = readIdent(text, i);
      if (!seg) break;
      path.push(seg);
      i = skipSpaces(text, i + seg.length);
    }
    if (path.length) out.push(path);
  }
  return out;
}

// Порт ГолыеИдентификаторыВыраженияPrivacy
function bareIdentifiers(fragment) {
  const out = [];
  const seen = new Set();
  let i = 1;
  const len = fragment.length;
  while (i <= len) {
    const c = fragment[i - 1];
    if (!isIdentChar(c)) { i++; continue; }
    const word = readIdent(fragment, i);
    if (!word) { i++; continue; }
    const next = i + word.length;
    const prev = i > 1 ? fragment[i - 2] : "";
    const tailAt = skipSpaces(fragment, next);
    const significant = tailAt <= len ? fragment[tailAt - 1] : "";
    if (prev !== "." && prev !== "&" && significant !== "." && significant !== "("
      && !isDigits(word) && !EXPR_KEYWORDS.has(word.toUpperCase()) && !seen.has(word.toUpperCase())) {
      seen.add(word.toUpperCase());
      out.push(word);
    }
    i = next;
  }
  return out;
}

// ------------------------------------------------------------ решение

const mark = (type, field, derived = false) => ({ type_name: type, field_name: field, derived });

// Порт ПодменаПутиОтТипаPrivacy
function markPathFromType(type, path) {
  let fieldIndex = -1;
  for (let i = 0; i < path.length; i++) if (!isRefSegment(path[i])) fieldIndex = i;
  if (fieldIndex < 0) return null;
  let current = [type];
  for (let i = 0; i < fieldIndex; i++) {
    const next = [];
    for (const t of current) for (const r of refTypesOf(t, path[i])) if (!next.includes(r)) next.push(r);
    if (!next.length) return null;
    current = next;
  }
  const field = path[fieldIndex];
  for (const t of current) if (fieldClosed(t, field)) return mark(t, field);
  return null;
}

// Порт ПодменаОдиночногоИдентификатораPrivacy (R-1)
function markBareIdentifier(name, map, ctx) {
  const field = String(name).trim();
  if (!field || field.startsWith("&") || isDigits(field)) return null;
  const path = [field];
  const sources = map.sources;
  if (sources.length === 1) return markSourceByField(sources[0], field, path, ctx, false);
  for (const s of sources) {
    const hit = markSourceByField(s, field, path, ctx, true);
    if (hit) return hit;
  }
  return null;
}

// Порт ПодменаИсточникаПоПолюPrivacy
function markSourceByField(binding, field, path, ctx, checkExists) {
  if (binding.full_name) {
    if (checkExists && !fieldExists(binding.full_name, field)) return null;
    return markPathFromType(binding.full_name, path);
  }
  const cols = ctx.marked.get(binding.raw.toUpperCase());
  if (cols) {
    const inherited = cols.get(field.toUpperCase());
    if (inherited) return mark(inherited.type_name, inherited.field_name, inherited.derived);
  }
  return null;
}

// Порт ПодменаЦепочкиPrivacy
function markChain(chain, map, ctx) {
  if (!isIdentChain(chain)) return null;
  const seg = chain.split(".");
  if (seg.length < 2) return markBareIdentifier(seg[0], map, ctx);
  const path = seg.slice(1);
  if (seg[0].startsWith("&")) {
    const types = ctx.parameters.get(seg[0].slice(1).toUpperCase());
    if (!types) return null;
    for (const t of types) { const hit = markPathFromType(t, path); if (hit) return hit; }
    return null;
  }
  const binding = map.bindings.get(seg[0].toUpperCase());
  if (!binding) return null;
  if (binding.full_name) return markPathFromType(binding.full_name, path);
  const cols = ctx.marked.get(binding.raw.toUpperCase());
  if (cols && path.length === 1) {
    const inherited = cols.get(path[0].toUpperCase());
    return inherited ? mark(inherited.type_name, inherited.field_name, inherited.derived) : null;
  }
  return null;
}

// Порт ПодменаПредставленияPrivacy + ТипыАргументаПредставленияPrivacy
function markPresentation(expr, map, ctx) {
  const re = /(ПРЕДСТАВЛЕНИЕССЫЛКИ|ПРЕДСТАВЛЕНИЕ|REFPRESENTATION|PRESENTATION)\s*\(/gi;
  let m;
  while ((m = re.exec(expr))) {
    let depth = 1, i = m.index + m[0].length;
    let arg = "";
    while (i < expr.length && depth > 0) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")") { depth--; if (!depth) break; }
      arg += expr[i]; i++;
    }
    const chained = markChain(stripWs(arg), map, ctx);
    if (chained) return chained;
    for (const t of presentationArgTypes(stripWs(arg), map, ctx)) {
      if (presentationClosed(t)) return mark(t, "Представление");
    }
  }
  return null;
}

function presentationArgTypes(chain, map, ctx) {
  if (!isIdentChain(chain)) return [];
  if (chain.startsWith("&")) return ctx.parameters.get(chain.slice(1).toUpperCase()) ?? [];
  const seg = chain.split(".");
  if (seg.length < 2) return bareIdentifierTypes(seg[0], map);
  const binding = map.bindings.get(seg[0].toUpperCase());
  if (!binding || !binding.full_name) return [];
  let current = [binding.full_name];
  for (const s of seg.slice(1)) {
    if (isRefSegment(s)) continue;
    const next = [];
    for (const t of current) for (const r of refTypesOf(t, s)) if (!next.includes(r)) next.push(r);
    if (!next.length) return [];
    current = next;
  }
  return current;
}

// Порт ТипыГологоИдентификатораPrivacy
function bareIdentifierTypes(name, map) {
  const out = [];
  const field = String(name).trim();
  if (!field || field.startsWith("&")) return out;
  const fulls = map.sources.map((s) => s.full_name).filter(Boolean);
  for (const full of fulls) {
    if (fulls.length > 1 && !fieldExists(full, field)) continue;
    if (isRefSegment(field)) { if (!out.includes(full)) out.push(full); continue; }
    for (const r of refTypesOf(full, field)) if (!out.includes(r)) out.push(r);
  }
  return out;
}

// Порт ПодменаОперандовВыраженияPrivacy (R-2 + R-3 + R-7)
function markOperands(expr, map, ctx) {
  const fragment = String(expr).trim();
  if (!fragment) return null;
  for (const s of map.sources) {
    if (!s.full_name || !s.alias) continue;
    for (const path of pathsForAlias(fragment, s.alias)) {
      const hit = markPathFromType(s.full_name, path);
      if (hit) { hit.derived = true; return hit; }
    }
  }
  // R-7: операнд — колонка временной таблицы. Прямое обращение ВТ.Х закрыто
  // наследованием пометки, а выражение над ним снимало маску (девятая форма,
  // открыта живьём на трёх контурах). В BSL добавляется и разрешение по схеме
  // колонок ВТ для разыменования ссылочной колонки — у порта модели схемы нет,
  // ветка покрыта настольной трассировкой.
  for (const s of map.sources) {
    if (s.full_name || !s.alias) continue;
    const cols = ctx.marked.get(s.raw.toUpperCase());
    if (!cols) continue;
    for (const path of pathsForAlias(fragment, s.alias)) {
      if (path.length !== 1) continue;
      const inherited = cols.get(path[0].toUpperCase());
      if (inherited) return mark(inherited.type_name, inherited.field_name, true);
    }
  }
  for (const [name, types] of ctx.parameters) {
    for (const path of pathsForAlias(fragment, "&" + name)) {
      for (const t of types) {
        const hit = markPathFromType(t, path);
        if (hit) { hit.derived = true; return hit; }
      }
    }
  }
  for (const name of bareIdentifiers(fragment)) {
    const hit = markBareIdentifier(name, map, ctx);
    if (hit) { hit.derived = true; return hit; }
  }
  return null;
}

// Порт ПодменаВыраженияПроекцииPrivacy
function markExpression(expr, map, ctx) {
  if (!String(expr).trim()) return null;
  return markChain(stripWs(expr), map, ctx)
    ?? markPresentation(expr, map, ctx)
    ?? markOperands(expr, map, ctx);
}

// Порт КорниПутейВыраженияPrivacy
const META_KINDS = new Set(["СПРАВОЧНИК", "ДОКУМЕНТ", "КОНСТАНТА", "ПЕРЕЧИСЛЕНИЕ", "РЕГИСТРСВЕДЕНИЙ",
  "РЕГИСТРНАКОПЛЕНИЯ", "РЕГИСТРБУХГАЛТЕРИИ", "РЕГИСТРРАСЧЕТА", "ПЛАНСЧЕТОВ", "ПЛАНВИДОВХАРАКТЕРИСТИК",
  "ПЛАНВИДОВРАСЧЕТА", "ПЛАНОБМЕНА", "БИЗНЕСПРОЦЕСС", "ЗАДАЧА", "ЖУРНАЛДОКУМЕНТОВ"]);

function pathRoots(fragment) {
  const out = [];
  const seen = new Set();
  let i = 1;
  const len = fragment.length;
  while (i <= len) {
    if (!isIdentChar(fragment[i - 1])) { i++; continue; }
    const w = readIdent(fragment, i);
    if (!w) { i++; continue; }
    const next = i + w.length;
    const tailAt = skipSpaces(fragment, next);
    const significant = tailAt <= len ? fragment[tailAt - 1] : "";
    const prev = i > 1 ? fragment[i - 2] : "";
    if (significant === "." && prev !== ".") {
      const root = prev === "&" ? "&" + w : w;
      const afterAs = /(?:КАК|AS)\s*$/i.test(fragment.slice(0, i - 1));
      if (!META_KINDS.has(w.toUpperCase()) && !afterAs && !EXPR_KEYWORDS.has(w.toUpperCase())
        && !seen.has(root.toUpperCase())) {
        seen.add(root.toUpperCase());
        out.push(root);
      }
    }
    i = next;
  }
  return out;
}

// Порт ИдентификаторПривязанPrivacy
function identifierBound(field, map, ctx) {
  const sources = map.sources;
  if (!sources.length) return true;
  if (sources.length === 1 && sources[0].full_name) return true;
  for (const s of sources) {
    if (s.full_name) { if (fieldExists(s.full_name, field)) return true; continue; }
    const cols = ctx.marked.get(s.raw.toUpperCase());
    if (cols && cols.has(field.toUpperCase())) return true;
  }
  return false;
}

// Порт ЕстьНеразрешенныйОперандPrivacy
function hasUnresolvedOperand(expr, map, ctx) {
  const fragment = String(expr).trim();
  if (!fragment) return false;
  for (const root of pathRoots(fragment)) {
    if (root.startsWith("&")) {
      if (!ctx.parameters.has(root.slice(1).toUpperCase())) return true;
      continue;
    }
    if (!map.bindings.has(root.toUpperCase())) return true;
  }
  for (const name of bareIdentifiers(fragment)) {
    if (!identifierBound(name, map, ctx)) return true;
  }
  return false;
}

// Порт ЕстьЗакрытыйИсточникВКомандеPrivacy
function hasClosedSource(map, ctx) {
  for (const s of map.sources) {
    if (!s.full_name) {
      const cols = ctx.marked.get(s.raw.toUpperCase());
      if (cols && cols.size) return true;
      continue;
    }
    if (presentationClosed(s.full_name)) return true;
    if ((POLICY[s.full_name]?.fields ?? []).length) return true;
  }
  return false;
}

// Порт ЗакрытыеКолонкиКомандыPrivacy (одна ветка, без ОБЪЕДИНИТЬ) + R-4
function markCommand(command, ctx) {
  const map = sourceMap(command);
  const closedSource = hasClosedSource(map, ctx);
  const result = new Map();
  for (const item of projectionItems(command)) {
    if (!item.column) continue;
    let m = markExpression(item.expression, map, ctx);
    // R-4 — только при НЕразрешённом операнде. «Разобрали и вышло, что открыто»
    // закрывать нельзя: это класс Д-3, молча испорченная аналитика.
    if (!m && closedSource && hasUnresolvedOperand(item.expression, map, ctx)) m = mark("", "", true);
    if (m) result.set(item.column.toUpperCase(), m);
  }
  return result;
}

// Порт КолонкиДляПодменыPrivacy: пакет команд, пометки ВТ переносятся дальше.
function markQuery(query, parameters = new Map()) {
  const ctx = { marked: new Map(), parameters };
  let last = new Map();
  for (const command of query.split(";")) {
    if (!command.trim()) continue;
    const marks = markCommand(command, ctx);
    last = marks;
    const into = command.match(new RegExp(`${B}(?:ПОМЕСТИТЬ|INTO)${A}\\s+([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)`, "i"));
    if (into) ctx.marked.set(into[1].toUpperCase(), marks);
  }
  return last;
}

// Порт МаскаПоляДляLLM + ПодменаЗначенияPrivacy для строкового значения:
// что окажется в колонке. Нужен для R-3 — маска против кода псевдонима.
// Код псевдонима возможен только у типа с псевдонимом (type_aliases): у типа,
// закрытого одними масками полей, кода нет — любое его поле получает маску.
function substitution(markRecord) {
  if (!markRecord) return "открыто";
  if (markRecord.derived) return "маска";
  if (!POLICY[markRecord.type_name]?.alias) return "маска";
  const nameLike = ["", "Наименование", "НаименованиеПолное", "Код", "Представление"];
  return nameLike.includes(markRecord.field_name) ? "код псевдонима" : "маска";
}

// ------------------------------------------------------------------ кейсы

const refParam = new Map([["РЕФ", [CLOSED]]]);

const CASES = [
  // H-матрица: живой прогон 05.08.2026 показал H1–H6, H8, H10 ОТКРЫТЫМИ.
  ["H0 контроль Т.Поле", `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование КАК П ИЗ ${CLOSED} КАК Т`, "П", "код псевдонима"],
  ["H1 без псевдонима", `ВЫБРАТЬ ПЕРВЫЕ 5 Наименование КАК П ИЗ ${CLOSED}`, "П", "код псевдонима"],
  ["H2 ПОДСТРОКА", `ВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(Т.Наименование, 1, 20) КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H3 конкатенация", `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование + "" КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H4 ЕСТЬNULL", `ВЫБРАТЬ ПЕРВЫЕ 5 ЕСТЬNULL(Т.Наименование, "") КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H5 ВЫБОР", `ВЫБРАТЬ ПЕРВЫЕ 5 ВЫБОР КОГДА ИСТИНА ТОГДА Т.Наименование ИНАЧЕ "" КОНЕЦ КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H6 агрегат", `ВЫБРАТЬ МАКСИМУМ(Т.Наименование) КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H8 ПОМЕСТИТЬ без псевдонима",
    `ВЫБРАТЬ Наименование КАК Н ПОМЕСТИТЬ ВТ ИЗ ${CLOSED};ВЫБРАТЬ ВТ.Н КАК П ИЗ ВТ КАК ВТ`, "П", "код псевдонима"],
  ["H8' ПОМЕСТИТЬ и выбор оба без псевдонима",
    `ВЫБРАТЬ Наименование КАК Н ПОМЕСТИТЬ ВТ ИЗ ${CLOSED};ВЫБРАТЬ Н КАК П ИЗ ВТ`, "П", "код псевдонима"],
  ["H9 СГРУППИРОВАТЬ ПО",
    `ВЫБРАТЬ Т.Наименование КАК П ИЗ ${CLOSED} КАК Т СГРУППИРОВАТЬ ПО Т.Наименование`, "П", "код псевдонима"],
  ["H10 псевдоним типа без квалификатора", `ВЫБРАТЬ Наименование КАК П ИЗ ${CLOSED}`, "П", "код псевдонима"],
  ["H11 контроль псевдонима", `ВЫБРАТЬ Т.Наименование КАК П ИЗ ${CLOSED} КАК Т`, "П", "код псевдонима"],
  // Комбинации, найденные при разборе: выражение над голым именем и представление
  // без квалификатора — тот же класс, в измеренной таблице их не было.
  ["K1 ПОДСТРОКА(голое имя)", `ВЫБРАТЬ ПОДСТРОКА(Наименование, 1, 20) КАК П ИЗ ${CLOSED}`, "П", "маска"],
  ["K2 ПРЕДСТАВЛЕНИЕ(Ссылка) без псевдонима", `ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Ссылка) КАК П ИЗ ${CLOSED}`, "П", "код псевдонима"],
  ["K3 разыменование владельца",
    `ВЫБРАТЬ Д.Владелец.Наименование КАК П ИЗ Справочник.Подчиненный КАК Д`, "П", "код псевдонима"],
  ["K4 ПОДСТРОКА от разыменования владельца",
    `ВЫБРАТЬ ПОДСТРОКА(Д.Владелец.Наименование, 1, 5) КАК П ИЗ Справочник.Подчиненный КАК Д`, "П", "маска"],
  // R-4 срабатывает на НЕразрешённом операнде: поле, которого нет ни у одного из
  // нескольких источников. Так выглядит неполнота нашего взгляда на метаданные —
  // поле может оказаться закрытым, и открывать его наугад нельзя.
  ["K5 R-4: неизвестное поле при нескольких источниках, один закрыт",
    `ВЫБРАТЬ ПОДСТРОКА(НеизвестноеПоле, 1, 5) КАК П ИЗ ${CLOSED} КАК Т СОЕДИНЕНИЕ ${OPEN} КАК О`, "П", "маска"],
  ["K6 R-4 не трогает литерал", `ВЫБРАТЬ "текст" КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  ["K7 R-4 не трогает агрегат по звёздочке", `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  ["K8 R-4 не трогает ЗНАЧЕНИЕ(<тип>.ПустаяСсылка)",
    `ВЫБРАТЬ ЗНАЧЕНИЕ(${OPEN}.ПустаяСсылка) КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  // R-6, парные пробы: обязаны остаться ОТКРЫТЫМИ.
  ["R6-1 выражение над открытым типом, закрытых источников нет",
    `ВЫБРАТЬ ПОДСТРОКА(О.Наименование, 1, 20) КАК П ИЗ ${OPEN} КАК О`, "П", "открыто"],
  ["R6-2 голое имя открытого типа, закрытых источников нет",
    `ВЫБРАТЬ Наименование КАК П ИЗ ${OPEN}`, "П", "открыто"],
  ["R6-3 голое имя есть только у открытого источника",
    `ВЫБРАТЬ Сумма КАК П ИЗ ${OPEN} КАК О СОЕДИНЕНИЕ ${CLOSED} КАК З`, "П", "открыто"],
  ["R6-4 квалифицированное поле открытого типа при закрытом соседе",
    `ВЫБРАТЬ О.Наименование КАК П ИЗ ${OPEN} КАК О СОЕДИНЕНИЕ ${CLOSED} КАК З`, "П", "открыто"],
  ["R6-5 выражение над открытым полем при закрытом соседе — R-4 не должен накрыть",
    `ВЫБРАТЬ ПОДСТРОКА(О.Наименование, 1, 20) КАК П ИЗ ${OPEN} КАК О СОЕДИНЕНИЕ ${CLOSED} КАК З`, "П", "открыто"],
  ["R6-6 закрытое и открытое имя одной строкой (П4) — закрытое",
    `ВЫБРАТЬ З.Наименование КАК Закрытое, О.Наименование КАК Открытое ИЗ ${CLOSED} КАК З, ${OPEN} КАК О`,
    "Закрытое", "код псевдонима"],
  ["R6-7 закрытое и открытое имя одной строкой (П4) — открытое",
    `ВЫБРАТЬ З.Наименование КАК Закрытое, О.Наименование КАК Открытое ИЗ ${CLOSED} КАК З, ${OPEN} КАК О`,
    "Открытое", "открыто"],
  // Д-2 (R-7): девятая форма — выражение над колонкой ВТ. Прямое обращение
  // закрыто (это H8), обёртка в функцию снимала маску на трёх контурах.
  ["A7 ПОДСТРОКА над закрытой колонкой ВТ",
    `ВЫБРАТЬ Т.Наименование КАК Х ПОМЕСТИТЬ ВТ ИЗ ${CLOSED} КАК Т;ВЫБРАТЬ ПОДСТРОКА(ВТ.Х, 1, 20) КАК П ИЗ ВТ КАК ВТ`,
    "П", "маска"],
  ["A7-2 ЕСТЬNULL над закрытой колонкой ВТ",
    `ВЫБРАТЬ Т.Наименование КАК Х ПОМЕСТИТЬ ВТ ИЗ ${CLOSED} КАК Т;ВЫБРАТЬ ЕСТЬNULL(ВТ.Х, "") КАК П ИЗ ВТ КАК ВТ`,
    "П", "маска"],
  ["A7' то же над колонкой ВТ из открытого типа — парная",
    `ВЫБРАТЬ О.Наименование КАК Х ПОМЕСТИТЬ ВТО ИЗ ${OPEN} КАК О;ВЫБРАТЬ ПОДСТРОКА(ВТО.Х, 1, 20) КАК П ИЗ ВТО КАК ВТО`,
    "П", "открыто"],
  // Д-4 (R-9): Представление наследует закрытость от любого закрытого реквизита.
  ["R9-1 Представление регистра с масками полей",
    `ВЫБРАТЬ Т.Представление КАК П ИЗ ${MASKED_REG} КАК Т`, "П", "маска"],
  ["R9-2 поле из масок регистра",
    `ВЫБРАТЬ Т.Серия КАК П ИЗ ${MASKED_REG} КАК Т`, "П", "маска"],
  ["R9-3 открытое поле регистра остаётся открытым",
    `ВЫБРАТЬ Т.ДатаВыдачи КАК П ИЗ ${MASKED_REG} КАК Т`, "П", "открыто"],
  // Парные к R-9: у СПРАВОЧНИКА с единственной не-имя-подобной маской не
  // закрывается ничего лишнего — ни имя, ни код, ни представление. Раньше
  // представление закрывалось (признак был константой «есть маски»), и это
  // ломало группировку по представлению, не добавляя защиты: имя достаётся
  // напрямую. Различитель — существует ли Представление как реквизит типа.
  ["R9-4 имя типа с одной маской Комментарий — открыто",
    `ВЫБРАТЬ Т.Наименование КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["R9-5 код того же типа — открыт",
    `ВЫБРАТЬ Т.Код КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["R9-6 ПРЕДСТАВЛЕНИЕ ссылки того же типа — тоже открыто",
    `ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["R9-7 сама маска при этом работает",
    `ВЫБРАТЬ Т.Комментарий КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "маска"],
];

// Кейс с параметром задаётся отдельно: у него свой набор типов параметров.
const PARAM_CASES = [
  ["P1 ПРЕДСТАВЛЕНИЕ(&Реф) без ИЗ", "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК П", "П", "код псевдонима"],
  ["P2 ПОДСТРОКА(&Реф.Наименование)", "ВЫБРАТЬ ПОДСТРОКА(&Реф.Наименование, 1, 5) КАК П", "П", "маска"],
];

let pass = 0, fail = 0;
function run(name, query, column, expected, parameters) {
  const marks = markQuery(query, parameters ?? new Map());
  const got = substitution(marks.get(column.toUpperCase()));
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}\n       ожидали «${expected}», получили «${got}»`
    + (VERBOSE ? `\n       ${query.replace(/\s+/g, " ")}` : ""));
}

for (const [name, query, column, expected] of CASES) run(name, query, column, expected);
for (const [name, query, column, expected] of PARAM_CASES) run(name, query, column, expected, refParam);

console.log(`\nИтог порта: PASS ${pass}, FAIL ${fail}`);
console.log("Порт проверяет ветвление решения, а не разрешение имён живого контура:"
  + " метаданные и политика здесь заглушки. Живая приёмка обязательна.");
process.exitCode = fail > 0 ? 1 : 0;
