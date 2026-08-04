// Приёмка запрос-гейта privacy по матрицам §6 и §7 ТЗ
// doc/TZ_dev_privacy_gate_type_resolution_fixes.md (issues #103–#112).
//
// §6 — пробы, которые ОБЯЗАНЫ стать отказом (каналы утечки наименований).
// §7 — пробы, которые ОБЯЗАНЫ продолжать работать (защита от ложных отказов).
//
// Имена метаданных не захардкожены: закрытые типы берутся из живого
// get_current_user_context, документ-носитель закрытой ссылки и подчинённый
// справочник ищутся интроспекцией. Фикстуры регистра бухгалтерии (счёт, дата)
// задаются переменными окружения — без них группа B уходит в SKIP, а не
// притворяется пройденной.
//
// Запуск:
//   node scripts/privacy_gate_probe.mjs
//   node scripts/privacy_gate_probe.mjs --json reports/privacy_gate_probe.json
//   MCP_URL=https://host/BASE/hs/mcp/rpc ACC_ACCOUNT=60.01 PROBE_DATE=2026-07-01 node scripts/privacy_gate_probe.mjs
//
// Транспорт node:https: undici рвёт connect на жёстких 10 с через VPN, что
// выглядит как «упал контур». Сертификат контура самоподписанный.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const URL_MCP = process.env.MCP_URL || "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const ACC_REGISTER = process.env.ACC_REGISTER || "РегистрБухгалтерии.Хозрасчетный";
const ACC_ACCOUNT = process.env.ACC_ACCOUNT || "60.01";
const PROBE_DATE = process.env.PROBE_DATE || "2026-07-01";
const jsonFlag = process.argv.indexOf("--json");
const JSON_OUT = jsonFlag > -1 ? process.argv[jsonFlag + 1] : "";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "mcp-protocol-version": "2025-11-25",
};

let rpcId = 0;

function rpc(method, params) {
  const target = new URL(URL_MCP);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  return new Promise((resolve) => {
    const req = request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: "POST",
      headers: { ...HEADERS, "content-length": Buffer.byteLength(payload) },
      rejectUnauthorized: false,
      timeout: 120000,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try {
          resolve({ body: JSON.parse(text) });
        } catch {
          resolve({ body: null, raw: text.slice(0, 500) });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ body: null, raw: String(err.message || err) }));
    req.write(payload);
    req.end();
  });
}

async function callTool(name, args) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { body, raw } = await rpc("tools/call", { name, arguments: args });
    if (!body && raw) {
      if (attempt === 3) return { ok: false, transport: raw };
      await new Promise((s) => setTimeout(s, 5000));
      continue;
    }
    if (body?.error) return { ok: false, error: body.error };
    const structured = body?.result?.structuredContent;
    const isError = body?.result?.isError === true;
    if (structured) return { ok: true, data: structured, isError };
    try {
      return { ok: true, data: JSON.parse(body?.result?.content?.[0]?.text ?? "null"), isError };
    } catch {
      return { ok: true, data: { raw: body?.result?.content?.[0]?.text }, isError };
    }
  }
  return { ok: false, transport: "не удалось выполнить вызов" };
}

const PRIVACY_CODES = ["privacy_denied_field", "privacy_denied_autoorder", "privacy_config_error"];

const codesOf = (res) => [
  ...(res?.data?.validation?.errors ?? []).map((i) => i.code),
  ...(res?.data?.errors ?? []).map((i) => i.code),
  res?.error?.code ?? "",
  res?.data?.error?.code ?? "",
  res?.data?.code ?? "",
].filter(Boolean);

// Текст ошибки инструмента: privacy-код приходит и внутри data.error.details.
const textOf = (res) => JSON.stringify(res?.data ?? res?.error ?? {}).slice(0, 400);
const deniedByPrivacy = (res) => codesOf(res).some((c) => PRIVACY_CODES.includes(c))
  || /privacy-политикой/.test(textOf(res));

async function runQuery(query, parameters, limit = 5) {
  const args = { query, limit };
  if (parameters) args.parameters = parameters;
  return callTool("run_1c_query", args);
}

// ------------------------------------------------------------------ отчёт

const results = [];
let passed = 0, failed = 0, skipped = 0;

function record(section, name, verdict, detail) {
  results.push({ section, name, verdict, detail });
  if (verdict === "PASS") passed += 1;
  else if (verdict === "FAIL") failed += 1;
  else skipped += 1;
  const mark = verdict === "PASS" ? "OK  " : verdict === "FAIL" ? "FAIL" : "SKIP";
  console.log(`${mark} | ${section} | ${name}${detail ? `\n       ${detail}` : ""}`);
}

// §6: отказ обязателен. Пропуск — утечка, поэтому FAIL с текстом ответа.
async function mustDeny(section, code, query, parameters) {
  const res = await runQuery(query, parameters);
  if (!res.ok) return record(section, code, "SKIP", `транспорт: ${res.transport ?? JSON.stringify(res.error)}`);
  const ok = deniedByPrivacy(res);
  record(section, code, ok ? "PASS" : "FAIL",
    ok ? codesOf(res).join(", ") : `ПРОШЁЛ (утечка): ${JSON.stringify(res.data?.rows ?? res.data).slice(0, 240)}`);
}

// §7: отказ запрещён. Ошибка не privacy (пустая выборка, отсутствующий счёт) —
// SKIP: проба про ложный отказ гейта, а не про наличие данных в базе.
async function mustPass(section, code, query, parameters, extra) {
  const res = await runQuery(query, parameters);
  if (!res.ok) return record(section, code, "SKIP", `транспорт: ${res.transport ?? JSON.stringify(res.error)}`);
  if (deniedByPrivacy(res)) {
    return record(section, code, "FAIL", `ЛОЖНЫЙ ОТКАЗ: ${codesOf(res).join(", ")} ${textOf(res)}`);
  }
  if (res.isError) return record(section, code, "SKIP", `ошибка не privacy: ${textOf(res)}`);
  const detail = extra ? extra(res.data) : `строк: ${(res.data?.rows ?? []).length}`;
  record(section, code, "PASS", detail);
}

// ------------------------------------------------------------- фикстуры

const fixtures = {
  closed: "", closedPrefix: "", owned: "", docType: "", docAttr: "",
  refUuid: "", accountingReady: false,
};

async function discover() {
  const ctx = await callTool("get_current_user_context", {});
  const p = ctx.data?.privacy;
  if (!p) {
    record("политика", "get_current_user_context содержит privacy", "FAIL",
      `контур не отвечает или код не задеплоен: ${ctx.transport ?? textOf(ctx)}`);
    return false;
  }
  console.log(`Контур: ${URL_MCP}`);
  console.log(`engine_revision=${p.engine_revision ?? "<нет>"}, enabled=${p.enabled}\n`);

  const denyAliases = (p.type_aliases?.entries ?? []).filter((e) => e.mode === "deny");
  const denyMasks = (p.type_field_masks?.entries ?? []).filter((e) => e.mode === "deny");
  if (!denyAliases.length && !denyMasks.length) {
    record("политика", "есть типы с mode: deny", "SKIP",
      "политика пуста — матрицы §6/§7 неприменимы, заполните privacy перед прогоном");
    return false;
  }

  // Закрытый справочник с данными: на нём строятся почти все пробы.
  for (const entry of [...denyAliases, ...denyMasks]) {
    if (!entry.type.startsWith("Справочник.")) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${entry.type} КАК Т`, null, 1);
    const uuid = probe.data?.rows?.[0]?.Р?.uuid;
    if (uuid) {
      fixtures.closed = entry.type;
      fixtures.closedPrefix = entry.prefix ?? "";
      fixtures.refUuid = uuid;
      break;
    }
  }
  if (!fixtures.closed) {
    record("политика", "закрытый справочник с данными", "SKIP", "ни один закрытый тип не вернул строк");
    return false;
  }

  // Подчинённый закрытый справочник — для проб через Владелец (в1, в2, ц5).
  for (const entry of [...denyAliases, ...denyMasks]) {
    if (entry.type === fixtures.closed || !entry.type.startsWith("Справочник.")) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Владелец КАК В ИЗ ${entry.type} КАК Т`, null, 1);
    if (probe.data?.rows?.[0]?.В?.uuid) { fixtures.owned = entry.type; break; }
  }

  // Документ с реквизитом закрытого типа — носитель ссылки для ц3/ц6/д2/A6.
  const docs = (await callTool("list_metadata_objects", { kinds: ["Документ"], limit: 40 })).data?.objects ?? [];
  for (const doc of docs.slice(0, 25)) {
    if (!doc.full_name) continue;
    const meta = await callTool("get_metadata_structure", { type: doc.full_name });
    const attr = (meta.data?.metadata?.attributes ?? []).find((a) =>
      String(a.type ?? "").includes(fixtures.closed) || String(a.types ?? "").includes(fixtures.closed));
    if (!attr) continue;
    const probe = await runQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 1 Д.${attr.name} КАК Р ИЗ ${doc.full_name} КАК Д ГДЕ Д.${attr.name} <> ЗНАЧЕНИЕ(${fixtures.closed}.ПустаяСсылка)`,
      null, 1);
    if (probe.data?.rows?.[0]?.Р?.uuid) { fixtures.docType = doc.full_name; fixtures.docAttr = attr.name; break; }
  }

  // Регистр бухгалтерии: остатки на дату по счёту — фикстура для субконто (B).
  const ost = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 1 О.Субконто1 КАК С ИЗ ${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`,
    { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` },
      Счет: { kind: "string", value: ACC_ACCOUNT } }, 1);
  fixtures.accountingReady = Array.isArray(ost.data?.rows) && ost.data.rows.length > 0;

  console.log(`фикстуры: закрытый=${fixtures.closed}, подчинённый=${fixtures.owned || "нет"},`
    + ` документ=${fixtures.docType || "нет"}.${fixtures.docAttr || ""},`
    + ` регистр=${fixtures.accountingReady ? `${ACC_REGISTER} счёт ${ACC_ACCOUNT}` : "нет"}\n`);
  return true;
}

// ---------------------------------------------------------------- пробы

async function section6() {
  const { closed, owned, docType, docAttr, refUuid } = fixtures;
  const S = "§6 обязан отказать";
  const DOC = docType ? `${docType} КАК Док` : "";

  // F (#109): пробел и перевод строки между именем функции и скобкой.
  await mustDeny(S, "ф2 PRESENTATION (пробел)", `ВЫБРАТЬ ПЕРВЫЕ 3 PRESENTATION (К.Ссылка) КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "ф4 REFPRESENTATION (пробел)", `ВЫБРАТЬ ПЕРВЫЕ 3 REFPRESENTATION (К.Ссылка) КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "ф5 ПРЕДСТАВЛЕНИЕССЫЛКИ (пробел)", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕССЫЛКИ (К.Ссылка) КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "ф7 PRESENTATION (перевод строки)", `ВЫБРАТЬ ПЕРВЫЕ 3 PRESENTATION\n(К.Ссылка) КАК Н ИЗ ${closed} КАК К`);

  // D (#106): стандартные реквизиты в пути.
  await mustDeny(S, "ц1 К.Ссылка.Наименование", `ВЫБРАТЬ ПЕРВЫЕ 3 К.Ссылка.Наименование КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "в3 К.Родитель.Наименование", `ВЫБРАТЬ ПЕРВЫЕ 3 К.Родитель.Наименование КАК Н ИЗ ${closed} КАК К`);
  if (owned) {
    await mustDeny(S, "в1 Д.Владелец.Наименование", `ВЫБРАТЬ ПЕРВЫЕ 3 Д.Владелец.Наименование КАК Н ИЗ ${owned} КАК Д`);
    await mustDeny(S, "в2 Д.Владелец.НаименованиеПолное", `ВЫБРАТЬ ПЕРВЫЕ 3 Д.Владелец.НаименованиеПолное КАК Н ИЗ ${owned} КАК Д`);
    await mustDeny(S, "ц5 Д.Владелец.Ссылка.Наименование", `ВЫБРАТЬ ПЕРВЫЕ 3 Д.Владелец.Ссылка.Наименование КАК Н ИЗ ${owned} КАК Д`);
    await mustDeny(S, "ф6 PRESENTATION (пробел) на втором закрытом типе",
      `ВЫБРАТЬ ПЕРВЫЕ 3 PRESENTATION (Д.Ссылка) КАК Н ИЗ ${owned} КАК Д`);
  } else {
    record(S, "в1/в2/ц5/ф6 через подчинённый справочник", "SKIP", "нет подчинённого закрытого справочника с данными");
  }
  if (docType) {
    await mustDeny(S, `ц3 Док.Ссылка.${docAttr}.Наименование`, `ВЫБРАТЬ ПЕРВЫЕ 3 Док.Ссылка.${docAttr}.Наименование КАК Н ИЗ ${DOC}`);
    await mustDeny(S, `ц6 Док.${docAttr}.Родитель.Наименование`, `ВЫБРАТЬ ПЕРВЫЕ 3 Док.${docAttr}.Родитель.Наименование КАК Н ИЗ ${DOC}`);
    // E (#108): разыменование колонки ВТ и подзапроса.
    await mustDeny(S, "д2 Т.Р.Наименование через ПОМЕСТИТЬ",
      `ВЫБРАТЬ Док.${docAttr} КАК Р ПОМЕСТИТЬ ВТ_Отмыв ИЗ ${DOC}\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т.Р.Наименование КАК Н ИЗ ВТ_Отмыв КАК Т`);
    await mustDeny(S, "д3 П.Р.Наименование через подзапрос",
      `ВЫБРАТЬ ПЕРВЫЕ 3 П.Р.Наименование КАК Н ИЗ (ВЫБРАТЬ Док.${docAttr} КАК Р ИЗ ${DOC}) КАК П`);
    // A (#105): разыменование после ВЫРАЗИТЬ.
    await mustDeny(S, "A6 ВЫРАЗИТЬ(...).Наименование",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(Док.${docAttr} КАК ${closed}).Наименование КАК Н ИЗ ${DOC}`);
  } else {
    record(S, "ц3/ц6/д2/д3/A6 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }
  await mustDeny(S, "д4 Т.Р.НаименованиеПолное через ПОМЕСТИТЬ",
    `ВЫБРАТЬ К.Ссылка КАК Р ПОМЕСТИТЬ ВТ_К ИЗ ${closed} КАК К\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т.Р.НаименованиеПолное КАК Н ИЗ ВТ_К КАК Т`);

  // B (#103): ПРЕДСТАВЛЕНИЕ над субконто, в том числе с пробелом (§6, комбинация).
  if (fixtures.accountingReady) {
    const ost = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const par = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustDeny(S, "P2 ПРЕДСТАВЛЕНИЕ(О.Субконто2)", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О.Субконто2) КАК Н ИЗ ${ost}`, par);
    await mustDeny(S, "P2' ПРЕДСТАВЛЕНИЕ (О.Субконто2) с пробелом", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ (О.Субконто2) КАК Н ИЗ ${ost}`, par);
    await mustDeny(S, "P3 ПРЕДСТАВЛЕНИЕ(Т.Субконто2) через ВТ",
      `ВЫБРАТЬ О.Субконто2 КАК Субконто2 ПОМЕСТИТЬ ВТ_С ИЗ ${ost}\n;\nВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(Т.Субконто2) КАК Н ИЗ ВТ_С КАК Т`, par);
    // Комбинация дефектов F+B (§6 ТЗ): без R-08 исправление #103 обходится пробелом.
    await mustDeny(S, "P3' PRESENTATION (Т.Субконто2) через ВТ с пробелом",
      `ВЫБРАТЬ О.Субконто2 КАК Субконто2 ПОМЕСТИТЬ ВТ_С ИЗ ${ost}\n;\nВЫБРАТЬ ПЕРВЫЕ 3 PRESENTATION (Т.Субконто2) КАК Н ИЗ ВТ_С КАК Т`, par);
    await mustDeny(S, "01 ПРЕДСТАВЛЕНИЕ(О.Субконто2) в подзапросе",
      `ВЫБРАТЬ ПЕРВЫЕ 3 П.Н КАК Н ИЗ (ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(О.Субконто2) КАК Н ИЗ ${ost}) КАК П`, par);
    await mustDeny(S, "02 ПРЕДСТАВЛЕНИЕ(О.Субконто2) в ветке ОБЪЕДИНИТЬ ВСЕ",
      `ВЫБРАТЬ ПЕРВЫЕ 3 "" КАК Н ИЗ ${ost}\nОБЪЕДИНИТЬ ВСЕ\nВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О.Субконто2) КАК Н ИЗ ${ost}`, par);
    await mustDeny(S, "A1 ВЫРАЗИТЬ(О.Субконто1 КАК закрытый).Наименование",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(О.Субконто1 КАК ${closed}).Наименование КАК Н ИЗ ${ost}`, par);
    await mustDeny(S, "A4 то же, НаименованиеПолное",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(О.Субконто1 КАК ${closed}).НаименованиеПолное КАК Н ИЗ ${ost}`, par);
    if (fixtures.owned) {
      await mustDeny(S, "A2 ВЫРАЗИТЬ(О.Субконто2 КАК подчинённый).Наименование",
        `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(О.Субконто2 КАК ${fixtures.owned}).Наименование КАК Н ИЗ ${ost}`, par);
    }
    // C1: двусторонняя ВТ с субконто по сторонам проводки. Выборка может быть
    // пуста — проверяется вердикт гейта, он от наличия строк не зависит.
    await mustDeny(S, "C1 ПРЕДСТАВЛЕНИЕ(Д.СубконтоДт1) из ДвиженияССубконто",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(Д.СубконтоДт1) КАК Н`
      + ` ИЗ ${ACC_REGISTER}.ДвиженияССубконто(&Дата, &Дата, , , , , , ) КАК Д`,
      { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` } });
  } else {
    record(S, "P2/P3/01/02/A1/A2/A4/C1 через регистр бухгалтерии", "SKIP",
      `нет остатков: ${ACC_REGISTER} счёт ${ACC_ACCOUNT} на ${PROBE_DATE} (задайте ACC_ACCOUNT/PROBE_DATE)`);
  }

  // G (#110): ссылка закрытого типа, переданная параметром.
  const par = { Реф: { kind: "ref", type: closed, uuid: refUuid } };
  await mustDeny(S, "р2 ПРЕДСТАВЛЕНИЕ(&Реф)", "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК Н", par);
  await mustDeny(S, "р3 ПРЕДСТАВЛЕНИЕССЫЛКИ(&Реф)", "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕССЫЛКИ(&Реф) КАК Н", par);
  await mustDeny(S, "р5 ПРЕДСТАВЛЕНИЕ(Т.Р) через ВТ из параметра",
    "ВЫБРАТЬ &Реф КАК Р ПОМЕСТИТЬ ВТ_Р\n;\nВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Т.Р) КАК Н ИЗ ВТ_Р КАК Т", par);
  await mustDeny(S, "р6 Т.Р.НаименованиеПолное через ВТ из параметра",
    "ВЫБРАТЬ &Реф КАК Р ПОМЕСТИТЬ ВТ_Р\n;\nВЫБРАТЬ Т.Р.НаименованиеПолное КАК Н ИЗ ВТ_Р КАК Т", par);

  // H (#111): порядок строк по скрытому наименованию.
  await mustDeny(S, "о3 АВТОУПОРЯДОЧИВАНИЕ по закрытой ссылке",
    `ВЫБРАТЬ ПЕРВЫЕ 15 К.Ссылка КАК Р ИЗ ${closed} КАК К УПОРЯДОЧИТЬ ПО К.Ссылка АВТОУПОРЯДОЧИВАНИЕ`);

  // #112: разыменование выражения в круглых скобках, включая ВЫБОР и параметр.
  if (docType) {
    await mustDeny(S, `в4 (Док.${docAttr}).Наименование`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}).Наименование КАК Н ИЗ ${DOC}`);
    await mustDeny(S, "в1 (ВЫБОР ... КОНЕЦ).Наименование",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБОР КОГДА ИСТИНА ТОГДА Док.${docAttr} ИНАЧЕ Док.${docAttr} КОНЕЦ).Наименование КАК Н ИЗ ${DOC}`);
    await mustDeny(S, "в2 то же, НаименованиеПолное",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБОР КОГДА ИСТИНА ТОГДА Док.${docAttr} ИНАЧЕ Док.${docAttr} КОНЕЦ).НаименованиеПолное КАК Н ИЗ ${DOC}`);
  }
  await mustDeny(S, "з3 (ВЫБОР ... К.Ссылка ... КОНЕЦ).Наименование",
    `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБОР КОГДА ИСТИНА ТОГДА К.Ссылка ИНАЧЕ К.Ссылка КОНЕЦ).Наименование КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "в3 (ВЫБОР ... &Реф ... КОНЕЦ).Наименование",
    "ВЫБРАТЬ (ВЫБОР КОГДА ИСТИНА ТОГДА &Реф ИНАЧЕ &Реф КОНЕЦ).Наименование КАК Н", par);

  // Форматирование не должно снимать ни одну проверку (#109 как принцип):
  // пробел внутри скобок функции, пробел после точки в цепочке.
  await mustDeny(S, "ф8 ПРЕДСТАВЛЕНИЕ( К.Ссылка ) — пробелы внутри скобок",
    `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ( К.Ссылка ) КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "ф9 К.Ссылка. Наименование — пробел после точки",
    `ВЫБРАТЬ ПЕРВЫЕ 3 К.Ссылка. Наименование КАК Н ИЗ ${closed} КАК К`);
  if (docType) {
    await mustDeny(S, "ф10 ВЫРАЗИТЬ(...). Наименование — пробел после точки",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(Док.${docAttr} КАК ${closed}). Наименование КАК Н ИЗ ${DOC}`);
    await mustDeny(S, "ф11 (Док.Контрагент). Наименование — пробел после точки",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}). Наименование КАК Н ИЗ ${DOC}`);
    await mustDeny(S, "ф12 Т.Р. Наименование через ВТ — пробел после точки",
      `ВЫБРАТЬ Док.${docAttr} КАК Р ПОМЕСТИТЬ ВТ_П ИЗ ${DOC}\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т.Р. Наименование КАК Н ИЗ ВТ_П КАК Т`);
  }
  if (fixtures.accountingReady) {
    const ost2 = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const par2 = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustDeny(S, "ф13 ПРЕДСТАВЛЕНИЕ( О.Субконто2 ) — пробелы внутри скобок",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ( О.Субконто2 ) КАК Н ИЗ ${ost2}`, par2);
    await mustDeny(S, "ф14 ПРЕДСТАВЛЕНИЕ(О. Субконто2) — пробел после точки",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О. Субконто2) КАК Н ИЗ ${ost2}`, par2);
  }

  // I (#112): разыменование выражения в скобках. Обёртка в скобки — обход,
  // не зависящий от ключевого слова, поэтому проверяются и голые скобки, и ВЫБОР.
  await mustDeny(S, "з3 (ВЫБОР ... К.Ссылка ...).Наименование",
    `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБОР КОГДА ИСТИНА ТОГДА К.Ссылка ИНАЧЕ К.Ссылка КОНЕЦ).Наименование КАК Н`
    + ` ИЗ ${closed} КАК К`);
  await mustDeny(S, "и1 ((К.Ссылка)).Наименование — вложенные скобки",
    `ВЫБРАТЬ ПЕРВЫЕ 3 ((К.Ссылка)).Наименование КАК Н ИЗ ${closed} КАК К`);
  await mustDeny(S, "и2 ЕСТЬNULL(...).Наименование",
    `ВЫБРАТЬ ПЕРВЫЕ 3 ЕСТЬNULL(К.Ссылка, К.Ссылка).Наименование КАК Н ИЗ ${closed} КАК К`);
  if (docType) {
    await mustDeny(S, `в4 (Док.${docAttr}).Наименование`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}).Наименование КАК Н ИЗ ${DOC}`);
    await mustDeny(S, `в1 (ВЫБОР ... Док.${docAttr} ...).Наименование`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБОР КОГДА ИСТИНА ТОГДА Док.${docAttr} ИНАЧЕ Док.${docAttr} КОНЕЦ).Наименование`
      + ` КАК Н ИЗ ${DOC}`);
    await mustDeny(S, `в2 то же, НаименованиеПолное`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБОР КОГДА ИСТИНА ТОГДА Док.${docAttr} ИНАЧЕ Док.${docAttr} КОНЕЦ).НаименованиеПолное`
      + ` КАК Н ИЗ ${DOC}`);
  } else {
    record(S, "в1/в2/в4 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }
  await mustDeny(S, "в3 (ВЫБОР ... &Реф ...).Наименование",
    "ВЫБРАТЬ (ВЫБОР КОГДА ИСТИНА ТОГДА &Реф ИНАЧЕ &Реф КОНЕЦ).Наименование КАК Н",
    { Реф: { kind: "ref", type: closed, uuid: refUuid } });
}

async function section7() {
  const { closed, docType, docAttr, refUuid } = fixtures;
  const S = "§7 обязан работать";
  const par = { Реф: { kind: "ref", type: closed, uuid: refUuid } };

  if (fixtures.accountingReady) {
    const ost = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const parAcc = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustPass(S, "B1 ПРЕДСТАВЛЕНИЕ(О.Организация)", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О.Организация) КАК Н ИЗ ${ost}`, parAcc);
    await mustPass(S, "B2 ПРЕДСТАВЛЕНИЕ(О.Счет)", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О.Счет) КАК Н ИЗ ${ost}`, parAcc);
    await mustPass(S, "B3 ПРЕДСТАВЛЕНИЕ(Т.Организация) через ВТ",
      `ВЫБРАТЬ О.Организация КАК Организация ПОМЕСТИТЬ ВТ_О ИЗ ${ost}\n;\nВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(Т.Организация) КАК Н ИЗ ВТ_О КАК Т`, parAcc);
    await mustPass(S, "B4 сама ссылка О.Субконто2", `ВЫБРАТЬ ПЕРВЫЕ 3 О.Субконто2 КАК С ИЗ ${ost}`, parAcc);
    await mustPass(S, "B5 ВЫРАЗИТЬ без разыменования",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(О.Субконто1 КАК ${closed}) КАК С ИЗ ${ost}`, parAcc);
    await mustPass(S, "B10 отбор по ссылке-параметру",
      `ВЫБРАТЬ ПЕРВЫЕ 3 О.Субконто1 КАК С ИЗ ${ost} ГДЕ О.Субконто1 = &Реф`,
      { ...parAcc, ...par });
  } else {
    record(S, "B1–B5, B10 через регистр бухгалтерии", "SKIP", "нет остатков для фикстуры");
  }

  if (docType) {
    await mustPass(S, `B6 Док.${docAttr}.ПометкаУдаления`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 Док.${docAttr}.ПометкаУдаления КАК Н ИЗ ${docType} КАК Док`);
    await mustPass(S, "B8 чтение колонки ВТ без разыменования",
      `ВЫБРАТЬ Док.${docAttr} КАК Р ПОМЕСТИТЬ ВТ_Р ИЗ ${docType} КАК Док\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т.Р КАК Р ИЗ ВТ_Р КАК Т`);
  } else {
    record(S, "B6/B8 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }

  await mustPass(S, "B9 ссылка-параметр в выводе", "ВЫБРАТЬ &Реф КАК Р", par, (data) => {
    const p = data?.rows?.[0]?.Р?.presentation;
    return `presentation=${JSON.stringify(p)}${fixtures.closedPrefix && String(p).startsWith(fixtures.closedPrefix)
      ? " (псевдоним)" : " — проверьте, что это псевдоним, а не имя"}`;
  });
  if (fixtures.accountingReady) {
    await mustPass(S, "B13 (О.Организация).Наименование — открытый тип в скобках (#112)",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (О.Организация).Наименование КАК Н`
      + ` ИЗ ${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`,
      { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } });
  }
  await mustPass(S, "B11 УПОРЯДОЧИТЬ ПО ссылке без АВТОУПОРЯДОЧИВАНИЕ",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Ссылка КАК Р ИЗ ${closed} КАК К УПОРЯДОЧИТЬ ПО К.Ссылка`);
  // Табличная часть закрытого типа: её поля — свои, закрытыми полями владельца
  // не проверяются. Прямая проверка, что снятие fail-open (R-03) не задело их.
  const tabular = (await callTool("get_metadata_structure", { type: closed })).data?.metadata?.tabular_parts ?? [];
  const tabularName = (tabular[0]?.name) ?? (typeof tabular[0] === "string" ? tabular[0] : "");
  if (tabularName) {
    await mustPass(S, `B12 К.${tabularName}.Представление (табличная часть закрытого типа)`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 К.${tabularName}.Представление КАК Н ИЗ ${closed} КАК К`);
  } else {
    record(S, "B12 табличная часть закрытого типа", "SKIP", "у закрытого типа нет табличных частей");
  }
  await mustPass(S, "B7 ВЫБРАТЬ * из закрытого справочника", `ВЫБРАТЬ ПЕРВЫЕ 3 * ИЗ ${closed} КАК К`);

  // I (#112): правило про скобки не должно задевать открытые типы и скобки без
  // разыменования — иначе отказ получит почти любой боевой запрос с ВТ.
  if (fixtures.accountingReady) {
    const ost = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const parAcc = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustPass(S, "B13 (О.Организация).Наименование — открытый тип",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (О.Организация).Наименование КАК Н ИЗ ${ost}`, parAcc);
    await mustPass(S, "B14 (СУММА(О.СуммаОстаток)) без разыменования",
      `ВЫБРАТЬ (СУММА(О.СуммаОстаток)) КАК С ИЗ ${ost}`, parAcc);
  } else {
    record(S, "B13/B14 через регистр бухгалтерии", "SKIP", "нет остатков для фикстуры");
  }
  if (docType) {
    await mustPass(S, `B15 (Док.${docAttr}) без разыменования`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}) КАК Р ИЗ ${docType} КАК Док`);
    await mustPass(S, `B16 (Док.${docAttr}).ПометкаУдаления — поле не закрыто`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}).ПометкаУдаления КАК Н ИЗ ${docType} КАК Док`);
  } else {
    record(S, "B15/B16 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }
}

// ------------------------------------------------------------------ main

(async () => {
  const ready = await discover();
  if (ready) {
    await section6();
    await section7();
  }

  console.log(`\nИтог: PASS ${passed}, FAIL ${failed}, SKIP ${skipped}`);
  if (failed > 0) {
    console.log("FAIL в §6 — канал утечки открыт; FAIL в §7 — гейт даёт ложный отказ.");
  }
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({
      url: URL_MCP, fixtures, summary: { passed, failed, skipped }, results,
    }, null, 2), "utf8");
    console.log(`JSON: ${JSON_OUT}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
})();
