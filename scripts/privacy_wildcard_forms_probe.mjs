// Приёмка P-0: вердикт «открыто» — только про осмотренную колонку.
//
// Проверяет ровно то, что изменила правка волны 1, и по КАЖДОЙ форме обхода из
// таблицы §2.7 ТЗ отдельно. Одной пробы здесь мало и это уже проверено на этом
// проекте: B7 в матрице §8 проверяет исполнимость формы, О9 — отсутствие лишней
// подмены на открытом типе, и ОБЕ были зелены, пока `SELECT TOP 3 *` отдавал
// поля политики открытыми.
//
// Запуск:
//   node scripts/privacy_wildcard_forms_probe.mjs
//   node scripts/privacy_wildcard_forms_probe.mjs --all
//   node scripts/privacy_wildcard_forms_probe.mjs --revision 2026-08-10.1
//   MCP_URL=https://host/BASE/hs/mcp/rpc node scripts/privacy_wildcard_forms_probe.mjs
//   --json reports/privacy_wildcard_forms_<контур>.json
//
// Два рубежа проверяются РАЗДЕЛЬНО, потому что чинились раздельно:
//   рубеж 1 (звено 3) — карта решений: форма исполнилась, значения обязаны быть
//                       подменены. Это и есть фикс;
//   рубеж 2 (звено 1) — предвалидатор: звёздочка отклонена. Это страховка, и одна
//                       она дефект не закрывает — подзапрос в ИЗ течёт без неё.
//
// Значения контура наружу не выводятся: вердикт строится на структурном признаке
// замаскированности, а не на сверке с эталоном имён. Имена метаданных не
// захардкожены — закрытый тип и его поля берутся из живой политики.
//
// Транспорт node:https: undici рвёт connect на жёстких 10 с через VPN, и это
// выглядит как «упал контур». Сертификат контура самоподписанный.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const CONTOURS = {
  BUH_KORP: "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc",
  ZUP_CORP: "https://laba-1c.astondevs.ru/ZUP_CORP/hs/mcp/rpc",
  ERP_DEMO: "https://laba-1c.astondevs.ru/ERP_DEMO/hs/mcp/rpc",
};

// Ревизия сборки, на которой проба осмысленна. Несовпадение останавливает прогон:
// «зелёная» матрица по старому коду на этом проекте случалась трижды, а #92
// (smoke-gate не отличает версию модуля) до сих пор открыт.
const revFlag = process.argv.indexOf("--revision");
const EXPECTED_REVISION =
  (revFlag > -1 ? process.argv[revFlag + 1] : "") ||
  process.env.MCP_EXPECTED_REVISION ||
  "2026-08-10.1";

const ALL = process.argv.includes("--all");
const jsonFlag = process.argv.indexOf("--json");
const JSON_OUT = jsonFlag > -1 ? process.argv[jsonFlag + 1] : "";
const BASIC = process.env.MCP_BASIC || "";

let URL_MCP = process.env.MCP_URL || CONTOURS.BUH_KORP;

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  // Без заголовка версии протокола кастомные методы отдают -32601.
  "mcp-protocol-version": "2025-11-25",
};
if (BASIC) HEADERS.authorization = `Basic ${Buffer.from(BASIC).toString("base64")}`;

let rpcId = 0;

function rpc(method, params) {
  const target = new URL(URL_MCP);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  const options = {
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: "POST",
    headers: { ...HEADERS, "content-length": Buffer.byteLength(payload) },
    rejectUnauthorized: false,
    timeout: 120000,
  };
  return new Promise((resolve) => {
    const req = request(options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: text.slice(0, 500) });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, body: null, raw: String(err.message || err) }));
    req.write(payload);
    req.end();
  });
}

// Повторов восемь: через VPN туннель гасит первые connect после простоя, каждая
// потерянная попытка стоит 21 с (таймаут SYN ОС). Трёх не хватало, и прогон
// вставал на первом вызове с ложным «контур недоступен» при живом контуре.
async function callTool(name, args, tries = 8) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const { body, raw } = await rpc("tools/call", { name, arguments: args });
    if (raw && !body) {
      if (attempt === tries) return { ok: false, transport: raw };
      continue;
    }
    if (body?.error) return { ok: false, error: body.error };
    const structured = body?.result?.structuredContent;
    if (structured) return { ok: true, data: structured, isError: body?.result?.isError === true };
    const textPayload = body?.result?.content?.[0]?.text;
    try {
      return { ok: true, data: JSON.parse(textPayload ?? "null"), isError: body?.result?.isError === true };
    } catch {
      return { ok: true, data: { raw: textPayload }, isError: body?.result?.isError === true };
    }
  }
  return { ok: false, transport: "не удалось после повторов" };
}

const runQuery = (query, limit = 3) => callTool("run_1c_query", { query, limit });
const validate = (query) => callTool("validate_1c_query", { query });

const codesOf = (res) => [
  ...(res?.data?.validation?.errors ?? []).map((i) => i.code),
  ...(res?.data?.errors ?? []).map((i) => i.code),
  res?.error?.code ?? "",
  res?.data?.error?.code ?? "",
  res?.data?.code ?? "",
].filter(Boolean);

const STRING_MASK = "XXXXXXX";
const DATE_MASK = "1900-01-01T00:00:00";

const fixtures = {
  revision: "",
  markers: [],
  closed: "",        // закрытый справочник с данными
  fields: [],        // плоские поля политики этого типа, у которых ЕСТЬ значения
  open: "",          // справочник вне политики — для замера цены
  openField: "",
};

// Пустое значение маской НЕ считается: иначе «стёрто» читалось бы как «подменено»
// и проба зеленела бы на пустой колонке.
function looksMasked(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") {
    if ("presentation" in value) return looksMasked(value.presentation);
    return Object.values(value).some(looksMasked);
  }
  const text = String(value);
  if (!text.length) return false;
  if (text === STRING_MASK || text === DATE_MASK) return true;
  if (text.endsWith("скрыто")) return true;
  return fixtures.markers.some((p) => p && text.startsWith(p));
}

const hasValue = (v) => v !== null && v !== undefined && String(v).length > 0;

// ------------------------------------------------------------------ отчёт

const results = [];
let passed = 0, failed = 0, skipped = 0, info = 0;
let currentName = "";

function record(section, name, verdict, detail) {
  results.push({ contour: currentName, section, name, verdict, detail: detail ?? "" });
  if (verdict === "PASS") passed++;
  else if (verdict === "FAIL") failed++;
  else if (verdict === "ЦЕНА") info++;
  else skipped++;
  const mark = { PASS: "OK  ", FAIL: "FAIL", ЦЕНА: "ЦЕНА" }[verdict] ?? "SKIP";
  console.log(`${mark} | ${section} | ${name}${detail ? `\n       ${detail}` : ""}`);
}

const check = (section, name, ok, detail) => record(section, name, ok ? "PASS" : "FAIL", detail);

// ------------------------------------------------------------------ разведка

async function discover() {
  const ctx = await callTool("get_current_user_context", {});
  if (!ctx.ok) {
    record("Р", "get_current_user_context", "SKIP",
      `контур недоступен: ${ctx.transport ?? JSON.stringify(ctx.error)}`);
    return false;
  }
  const p = ctx.data?.privacy;
  if (!p) return record("Р", "блок privacy в ответе", "FAIL", "блока нет — MCP_Tools старый"), false;

  fixtures.revision = p.engine_revision ?? "";
  check("Р", `engine_revision = ${EXPECTED_REVISION}`,
    fixtures.revision === EXPECTED_REVISION, `получено: ${fixtures.revision || "нет"}`);
  if (fixtures.revision !== EXPECTED_REVISION) {
    record("Р", "остальные пробы", "SKIP",
      "ревизия не совпала: прогон на старой сборке ничего не доказывает");
    return false;
  }

  const aliases = p.type_aliases?.entries ?? [];
  const masks = p.type_field_masks?.entries ?? [];
  for (const e of aliases) if (e.prefix) fixtures.markers.push(e.prefix);
  for (const legacy of ["Орг-", "ФЛ-", "Сотр-", "Польз-"]) fixtures.markers.push(legacy);
  if (p.organization_aliases?.prefix) fixtures.markers.push(p.organization_aliases.prefix);
  for (const key of ["prefix", "employee_prefix", "user_prefix"]) {
    if (p.person_aliases?.[key]) fixtures.markers.push(p.person_aliases[key]);
  }

  // Носитель проб — закрытый СПРАВОЧНИК с данными и с полями, прямо
  // перечисленными в политике: именно они уходили открытыми (§2.7).
  // Поля отбираются по факту непустого значения: на пустой колонке подмену от
  // открытости не отличить.
  for (const e of masks) {
    const type = String(e.type ?? "");
    if (!type.startsWith("Справочник.")) continue;
    const fields = (e.fields ?? []).map(String).filter(Boolean).slice(0, 6);
    if (!fields.length) continue;
    const list = fields.map((f, i) => `Т.${f} КАК Ф${i}`).join(", ");
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 3 ${list} ИЗ ${type} КАК Т`);
    const rows = probe.data?.rows ?? [];
    if (!rows.length) continue;
    const good = fields.filter((f, i) => rows.some((r) => hasValue(r[`Ф${i}`])));
    if (!good.length) continue;
    fixtures.closed = type;
    fixtures.fields = good.slice(0, 3);
    break;
  }
  if (!fixtures.closed) {
    record("Р", "закрытый справочник с непустыми полями политики", "SKIP",
      "не найден: формы проверять нечем");
    return false;
  }
  record("Р", "носитель проб выбран", "PASS",
    `тип из политики, полей в пробе: ${fixtures.fields.length}`);

  // Контроль базовой линии: прямая выборка тех же полей ОБЯЗАНА быть подменена.
  // Без него «подменено» в остальных пробах не значит ничего: поле могло быть
  // закрыто и до правки, а могло не закрываться вовсе.
  const direct = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 3 ${fixtures.fields.map((f, i) => `Т.${f} КАК Ф${i}`).join(", ")}`
    + ` ИЗ ${fixtures.closed} КАК Т`);
  const openFields = fixtures.fields.filter((f, i) =>
    (direct.data?.rows ?? []).some((r) => hasValue(r[`Ф${i}`]) && !looksMasked(r[`Ф${i}`])));
  check("Р", "базовая линия: прямая выборка полей политики подменена",
    openFields.length === 0,
    openFields.length ? `открыты поля: ${openFields.join(", ")} — дефект шире P-0` : "");

  // Тип ВНЕ политики — для замера цены страховки (см. раздел Ц).
  const known = new Set([...aliases, ...masks].map((e) => String(e.type)));
  const cats = (await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 60 }))
    .data?.objects ?? [];
  for (const c of cats) {
    const full = String(c.full_name ?? "");
    if (!full || known.has(full)) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 3 Т.Наименование КАК Ф ИЗ ${full} КАК Т`);
    const rows = probe.data?.rows ?? [];
    if (!rows.some((r) => hasValue(r.Ф) && !looksMasked(r.Ф))) continue;
    fixtures.open = full;
    fixtures.openField = "Наименование";
    break;
  }
  return true;
}

// ---------------------------------------------------- рубеж 1: карта решений

// Форма исполняется, и КАЖДОЕ непустое значение поля политики обязано быть
// подменено. Проба именная: сообщается, какое поле ушло открытым.
async function formMasked(section, name, buildQuery, columns) {
  const query = buildQuery();
  const res = await runQuery(query);
  if (!res.ok) return record(section, name, "SKIP", `транспорт: ${res.transport ?? ""}`);
  const rows = res.data?.rows ?? [];
  if (!rows.length) {
    // Пустой результат — не PASS: форма ничего не показала, и вердикт о подмене
    // по ней вынести нельзя. Именно так «зелёная» матрица скрывала утечку.
    const codes = codesOf(res).join(", ");
    return record(section, name, "SKIP",
      `0 строк${codes ? `, коды: ${codes}` : ""} — доказательства нет`);
  }
  const leaked = [];
  for (const col of columns) {
    for (const row of rows) {
      if (hasValue(row[col]) && !looksMasked(row[col])) { leaked.push(col); break; }
    }
  }
  check(section, name, leaked.length === 0,
    leaked.length ? `открытые колонки: ${leaked.join(", ")}` : `строк: ${rows.length}`);
}

// ---------------------------------------------------- рубеж 2: предвалидатор

async function formRejected(section, name, query) {
  const res = await validate(query);
  if (!res.ok) return record(section, name, "SKIP", `транспорт: ${res.transport ?? ""}`);
  const codes = codesOf(res);
  check(section, name, codes.includes("wildcard_select_forbidden"),
    codes.length ? `коды: ${codes.join(", ")}` : "форма ПРОШЛА предвалидатор");
}

async function formAccepted(section, name, query) {
  const res = await validate(query);
  if (!res.ok) return record(section, name, "SKIP", `транспорт: ${res.transport ?? ""}`);
  const codes = codesOf(res);
  check(section, name, !codes.includes("wildcard_select_forbidden"),
    codes.includes("wildcard_select_forbidden")
      ? "ложный отказ: умножение и КОЛИЧЕСТВО(*) звёздочкой проекции не являются"
      : `коды: ${codes.join(", ") || "нет"}`);
}

// ------------------------------------------------------------------ прогон

async function probeContour() {
  if (!(await discover())) return;

  const T = fixtures.closed;
  const F = fixtures.fields;
  const proj = (alias) => F.map((f, i) => `${alias}.${f} КАК Ф${i}`).join(", ");
  const cols = F.map((_, i) => `Ф${i}`);
  const inner = `(ВЫБРАТЬ ${F.map((f) => `Т0.${f} КАК ${f}`).join(", ")}, Т0.Ссылка КАК Ссылка`
    + ` ИЗ ${T} КАК Т0)`;

  // ---- В: звёздочка. Второй рубеж и, если форма всё же исполнима, первый.
  await formRejected("В звёздочка", "В1 ВЫБРАТЬ ПЕРВЫЕ 3 РАЗЛИЧНЫЕ *",
    `ВЫБРАТЬ ПЕРВЫЕ 3 РАЗЛИЧНЫЕ * ИЗ ${T} КАК Т`);
  await formRejected("В звёздочка", "В2 ВЫБРАТЬ ПЕРВЫЕ 3 К.*",
    `ВЫБРАТЬ ПЕРВЫЕ 3 К.* ИЗ ${T} КАК К`);
  await formRejected("В звёздочка", "В3 пакет со звёздочкой",
    `ВЫБРАТЬ * ПОМЕСТИТЬ ВТ ИЗ ${T} КАК Т; ВЫБРАТЬ * ИЗ ВТ КАК ВТ`);
  await formRejected("В звёздочка", "В4 SELECT TOP 3 *", `SELECT TOP 3 * FROM ${T} КАК Т`);
  await formRejected("В звёздочка", "В5 ВЫБРАТЬ *", `ВЫБРАТЬ * ИЗ ${T} КАК Т`);
  await formRejected("В звёздочка", "В6 SELECT DISTINCT *", `SELECT DISTINCT * FROM ${T} КАК Т`);
  await formRejected("В звёздочка", "В7 звёздочка вторым элементом",
    `ВЫБРАТЬ Т.Ссылка, * ИЗ ${T} КАК Т`);
  // Контроль ложных отказов: запрет не имеет права ломать умножение и агрегат.
  await formAccepted("В звёздочка", "В8 контроль: умножение на число",
    `ВЫБРАТЬ ПЕРВЫЕ 3 2 * 3 КАК П ИЗ ${T} КАК Т`);
  await formAccepted("В звёздочка", "В9 контроль: КОЛИЧЕСТВО(*)",
    `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК П ИЗ ${T} КАК Т`);

  // ---- П: подзапрос в ИЗ. Звёздочки нет вовсе — рубеж 2 здесь бессилен, и
  // именно эти формы доказывают, что дефект закрыт фиксом, а не запретом.
  await formMasked("П подзапрос", "П1 поле политики из подзапроса",
    () => `ВЫБРАТЬ ${proj("Т")} ИЗ ${inner} КАК Т`, cols);
  await formMasked("П подзапрос", "П2 то же + Ссылка в проекции",
    () => `ВЫБРАТЬ ${proj("Т")}, Т.Ссылка КАК Р ИЗ ${inner} КАК Т`, [...cols, "Р"]);
  await formMasked("П подзапрос", "П3 соединение с подзапросом",
    () => `ВЫБРАТЬ ${proj("П")} ИЗ ${T} КАК О ЛЕВОЕ СОЕДИНЕНИЕ ${inner} КАК П`
      + ` ПО О.Ссылка = П.Ссылка`, cols);
  await formMasked("П подзапрос", "П4 подзапрос в подзапросе, два уровня",
    () => `ВЫБРАТЬ ${proj("Т")} ИЗ (ВЫБРАТЬ ${F.map((f) => `В.${f} КАК ${f}`).join(", ")}`
      + ` ИЗ ${inner} КАК В) КАК Т`, cols);
  await formMasked("П подзапрос", "П5 подзапрос через ПОМЕСТИТЬ",
    () => `ВЫБРАТЬ ${proj("Т")} ПОМЕСТИТЬ ВТ ИЗ ${inner} КАК Т;`
      + ` ВЫБРАТЬ ${cols.map((c) => `ВТ.${c} КАК ${c}`).join(", ")} ИЗ ВТ КАК ВТ`, cols);

  // ---- Р: регресс. Формы, которые были закрыты ДО правки и обязаны остаться
  // закрытыми: контроль от «сломали транзитивность» и «закрыли лишнее».
  await formMasked("Р регресс", "Р1 ОБЪЕДИНИТЬ ВСЕ: именованный источник + подзапрос",
    () => `ВЫБРАТЬ ${proj("Т")} ИЗ ${T} КАК Т ОБЪЕДИНИТЬ ВСЕ ВЫБРАТЬ ${proj("В")}`
      + ` ИЗ ${inner} КАК В`, cols);
  await formMasked("Р регресс", "Р2 пакет с ПОМЕСТИТЬ от именованного источника",
    () => `ВЫБРАТЬ ${proj("Т")} ПОМЕСТИТЬ ВТ ИЗ ${T} КАК Т;`
      + ` ВЫБРАТЬ ${cols.map((c) => `ВТ.${c} КАК ${c}`).join(", ")} ИЗ ВТ КАК ВТ`, cols);
  await formMasked("Р регресс", "Р3 прямая выборка полей политики",
    () => `ВЫБРАТЬ ${proj("Т")} ИЗ ${T} КАК Т`, cols);

  // ---- Ц: цена страховки (строка приёмки ПР-0ц ТЗ 2.2.0).
  //
  // Колонка открытого типа, взятая через подзапрос, вердикта первого эшелона
  // больше не получает — решает второй эшелон. Механизм СИЛЬНЕЕ, чем «подмена по
  // имени ключа»: колонка уходит во второй эшелон вместе с контекстом типа, а
  // контекст берётся шагом 4 — первой ссылкой настроенного типа в строке
  // (`MCP_Security.bsl:898-906`). Если рядом лежит ссылка ЗАКРЫТОГО типа, к
  // колонке ОТКРЫТОГО типа применяется ЧУЖОЙ НАБОР МАСОК.
  //
  // Поэтому замер парный: одна и та же колонка одного и того же открытого типа,
  // с закрытой ссылкой в строке и без неё. Разница — цена шага 4.
  //
  // Это ЗАМЕР, а не FAIL: цена названа в ТЗ (P-0 п. 1) и принята. Если она велика,
  // лечится дорогим вариантом P-0 п. 4a (разбор внутрь подзапроса), а НЕ сужением
  // шага 4: шаг 4 — это гейт R-8/R-18, он закрывает Д-3 (подмену набора масок
  // паспортного регистра набором физлица), и его правка — отдельный анализ.
  if (!fixtures.open) {
    record("Ц цена", "Ц1–Ц3 замер цены", "SKIP", "тип вне политики не найден");
  } else {
    const ОП = fixtures.openField;
    const внутр = `(ВЫБРАТЬ О.${ОП} КАК ${ОП} ИЗ ${fixtures.open} КАК О)`;
    // Пара форм отличается РОВНО одним: есть ли в строке ссылка ЗАКРЫТОГО типа.
    // Разница вердиктов и есть цена шага 4 (первая ссылка настроенного типа в
    // строке задаёт контекст типа, а с ним — НАБОР МАСОК). Меряется по одной и
    // той же колонке одного и того же открытого типа.
    const формаБезСсылки = `ВЫБРАТЬ ПЕРВЫЕ 3 Т.${ОП} КАК Ф ИЗ ${внутр} КАК Т`;
    // Соединение — запятой к подзапросу с ПЕРВЫЕ 1, а НЕ ЛЕВЫМ СОЕДИНЕНИЕМ по
    // ссылкам, как в тексте передачи. Две причины, обе делают исходную форму
    // непригодной: (1) `ПО З.Ссылка = Т.Ссылка` сводит ссылки РАЗНЫХ типов — они
    // не совпадают никогда, левое соединение оставляет `З.Ссылка` равной NULL,
    // закрытой ссылки в строке не оказывается, шаг 4 не срабатывает, и проба
    // отвечает «цены нет» ЛОЖНО; (2) поле нулевой стороны без ЕСТЬNULL наш же
    // предвалидатор отвергает (`outer_join_field_without_isnull`), то есть до
    // данных дело не дошло бы вовсе. Запятая с ПЕРВЫЕ 1 даёт ту же строку с
    // гарантированно НЕпустой ссылкой закрытого типа и ограниченный объём.
    const формаСоСсылкой = `ВЫБРАТЬ ПЕРВЫЕ 3 Т.${ОП} КАК Ф, З.Ссылка КАК Р`
      + ` ИЗ ${внутр} КАК Т,`
      + ` (ВЫБРАТЬ ПЕРВЫЕ 1 З0.Ссылка КАК Ссылка ИЗ ${fixtures.closed} КАК З0) КАК З`;

    const без = await runQuery(формаБезСсылки);
    const строкиБез = без.data?.rows ?? [];
    let подмененоБез = null;
    if (!без.ok || !строкиБез.length) {
      record("Ц цена", "Ц1 открытый тип через подзапрос, закрытой ссылки в строке НЕТ", "SKIP",
        `нет строк${без.transport ? `, транспорт: ${без.transport}` : ""}`);
    } else {
      подмененоБез = строкиБез.some((r) => hasValue(r.Ф) && looksMasked(r.Ф));
      record("Ц цена", "Ц1 открытый тип через подзапрос, закрытой ссылки в строке НЕТ", "ЦЕНА",
        подмененоБез
          ? "ПОДМЕНЕНО: цена есть и без шага 4 — сработала линия по имени ключа"
          : "открыто: без закрытой ссылки в строке цены нет");
    }

    const со = await runQuery(формаСоСсылкой);
    const строкиСо = со.data?.rows ?? [];
    let подмененоСо = null;
    // Guard обязателен и важнее самой пробы: без непустой ссылки закрытого типа в
    // строке шаг 4 не может сработать по построению, и «открыто» здесь означало бы
    // «не измерено», а не «цены нет». Именно так на этом проекте трижды получалась
    // зелёная матрица.
    const ссылкаЕсть = строкиСо.some((r) => hasValue(r.Р?.uuid ?? r.Р));
    if (!со.ok || !строкиСо.length || !ссылкаЕсть) {
      record("Ц цена", "Ц2 смешанная форма: та же колонка + ссылка ЗАКРЫТОГО типа в строке", "SKIP",
        !строкиСо.length
          ? `нет строк${со.transport ? `, транспорт: ${со.transport}` : ""}`
          : "ссылки закрытого типа в строке не оказалось — шаг 4 не мог сработать, цена НЕ измерена");
    } else {
      подмененоСо = строкиСо.some((r) => hasValue(r.Ф) && looksMasked(r.Ф));
      record("Ц цена", "Ц2 смешанная форма: та же колонка + ссылка ЗАКРЫТОГО типа в строке", "ЦЕНА",
        подмененоСо
          ? "ПОДМЕНЕНО: к колонке открытого типа применён ЧУЖОЙ набор масок по контексту шага 4"
          : "открыто: шаг 4 на этой паре набор не подменил");
    }

    // Ц3 — сам вердикт о цене. Считается разницей, а не одной формой: одинаковый
    // результат у пары означает, что шаг 4 тут ни при чём, и это другой разговор.
    if (подмененоБез === null || подмененоСо === null) {
      record("Ц цена", "Ц3 цена шага 4 = разница Ц1 и Ц2", "SKIP",
        "одна из форм не дала строк: разницу считать нечем");
    } else if (подмененоСо && !подмененоБез) {
      record("Ц цена", "Ц3 цена шага 4 = разница Ц1 и Ц2", "ЦЕНА",
        "ЦЕНА ЕСТЬ и она от шага 4: колонка открыта без закрытой ссылки в строке и закрыта с ней."
        + " Решение — дорогой вариант P-0 п. 4a (разбор внутрь подзапроса)."
        + " Шаг 4 сужать НЕЛЬЗЯ: это гейт R-8/R-18, он закрывает Д-3");
    } else if (подмененоСо && подмененоБез) {
      record("Ц цена", "Ц3 цена шага 4 = разница Ц1 и Ц2", "ЦЕНА",
        "цена есть, но НЕ от шага 4: обе формы подменены, значит сработала линия по имени ключа."
        + " Шаг 4 к этому отношения не имеет, дорогой вариант 4a её не уберёт");
    } else {
      record("Ц цена", "Ц3 цена шага 4 = разница Ц1 и Ц2", "ЦЕНА",
        "цены нет ни в одной из двух форм на этом типе и этом ключе."
        + " Вердикт «цены нет вообще» из этого не следует: замер именной, а не полный");
    }

    const direct = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 3 О.${ОП} КАК Ф ИЗ ${fixtures.open} КАК О`);
    const rowsDirect = direct.data?.rows ?? [];
    check("Ц цена", "Ц4 контроль: прямая выборка открытого типа не подменена",
      rowsDirect.length > 0 && rowsDirect.every((r) => !looksMasked(r.Ф)),
      rowsDirect.length ? "" : "0 строк — контроль не выполнен");
  }
}

// ------------------------------------------------------------------ main

const targets = ALL
  ? Object.entries(CONTOURS)
  : [[Object.entries(CONTOURS).find(([, u]) => u === URL_MCP)?.[0] ?? "MCP_URL", URL_MCP]];

for (const [name, url] of targets) {
  currentName = name;
  URL_MCP = url;
  console.log(`\n=== ${name} ===`);
  await probeContour();
}

console.log(`\nИтог: PASS ${passed}, FAIL ${failed}, SKIP ${skipped}, ЦЕНА ${info}`);
console.log("SKIP — не «нормально»: это проба, доказательства не давшая. Разбирать наравне с FAIL.");

if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({
    expected_revision: EXPECTED_REVISION,
    summary: { passed, failed, skipped, price: info },
    results,
  }, null, 2), "utf8");
  console.log(`JSON: ${JSON_OUT}`);
}

process.exitCode = failed > 0 ? 1 : 0;
