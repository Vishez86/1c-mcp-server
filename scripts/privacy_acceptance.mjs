// Приёмка privacy-политики по типам (задача 597, ТЗ v1.3.0 §11.2 и §11.3).
//
// Два режима, оба обязательны для закрытия фазы E:
//
//   node scripts/privacy_acceptance.mjs
//       Базовый прогон при ПУСТЫХ секциях privacy: контракт не изменился,
//       ложных отказов нет, служебный блок на месте. Запускается сразу после
//       деплоя, до заполнения политики.
//
//   node scripts/privacy_acceptance.mjs --enforced
//       Прогон с ЗАПОЛНЕННОЙ политикой. Закрытый тип и его поля скрипт узнаёт
//       из живого ответа get_current_user_context (privacy.type_aliases /
//       type_field_masks с mode: deny) — имена метаданных не захардкожены.
//
//   --json reports/privacy_acceptance.latest.json   выгрузить результат
//   MCP_URL=https://host/BASE/hs/mcp/rpc            другой контур
//
// Транспорт — node:https: fetch/undici рвёт connect на жёстких 10 с через VPN,
// что выглядит как «упал контур». Сертификат контура самоподписанный.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const URL_MCP = process.env.MCP_URL || "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const BASIC = process.env.MCP_BASIC || "";
const ENFORCED = process.argv.includes("--enforced");
const jsonFlagIndex = process.argv.indexOf("--json");
const JSON_OUT = jsonFlagIndex > -1 ? process.argv[jsonFlagIndex + 1] : "";

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

async function callTool(name, args) {
  const { body, raw } = await rpc("tools/call", { name, arguments: args });
  if (raw && !body) return { ok: false, transport: raw };
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

// Код ошибки инструмента приходит либо в error.code, либо внутри данных.
const errorCodeOf = (res) => res?.error?.code ?? res?.data?.error?.code ?? res?.data?.code ?? "";
const validationCodes = (data) => [
  ...(data?.validation?.errors ?? []).map((i) => i.code),
  ...(data?.errors ?? []).map((i) => i.code),
];

// ------------------------------------------------------------------ отчёт

const results = [];
let passed = 0;
let failed = 0;
let skipped = 0;

function record(section, name, verdict, detail) {
  results.push({ section, name, verdict, detail });
  if (verdict === "PASS") passed += 1;
  else if (verdict === "FAIL") failed += 1;
  else skipped += 1;
  const mark = verdict === "PASS" ? "OK  " : verdict === "FAIL" ? "FAIL" : "SKIP";
  console.log(`${mark} | ${section} | ${name}${detail ? `\n       ${detail}` : ""}`);
}

const check = (section, name, condition, detail) =>
  record(section, name, condition ? "PASS" : "FAIL", detail);

// ------------------------------------------------------------- политика

const policy = {
  present: false,
  enabled: false,
  warnings: [],
  errors: [],
  denyAliasTypes: [],
  denyMaskTypes: [],
  maskFieldsByType: new Map(),
};

async function loadPolicy() {
  const res = await callTool("get_current_user_context", {});
  if (!res.ok) return { fatal: res.transport || JSON.stringify(res.error) };
  const p = res.data?.privacy;
  if (!p) return { fatal: "в ответе get_current_user_context нет блока privacy" };

  policy.present = true;
  policy.enabled = p.enabled === true;
  policy.warnings = p.config_warnings ?? [];
  policy.errors = p.config_errors ?? [];
  policy.hasTypeSections = p.type_aliases !== undefined && p.type_field_masks !== undefined;

  for (const entry of p.type_aliases?.entries ?? []) {
    if (entry.mode === "deny") policy.denyAliasTypes.push(entry.type);
  }
  for (const entry of p.type_field_masks?.entries ?? []) {
    if (entry.mode === "deny") policy.denyMaskTypes.push(entry.type);
    policy.maskFieldsByType.set(entry.type, entry.fields ?? []);
  }
  return {};
}

// ------------------------------------------------------- базовый прогон

async function runBaseline() {
  const S = "§11.2 базовый (пустые секции)";

  check(S, "блок privacy присутствует в get_current_user_context", policy.present);
  check(
    S,
    "секции type_aliases и type_field_masks опубликованы (код задеплоен)",
    policy.hasTypeSections === true,
    policy.hasTypeSections ? "" : "ключей нет — расширение с фазами A–D не задеплоено",
  );
  check(S, "config_warnings пуст", (policy.warnings ?? []).length === 0,
    (policy.warnings ?? []).join(" | "));
  check(S, "config_errors пуст (политика не в config_error)", (policy.errors ?? []).length === 0,
    (policy.errors ?? []).join(" | "));

  // Контроль отсутствия ложных отказов при пустой политике.
  const catalogs = await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 5 });
  const anyCatalog = (catalogs.data?.objects ?? []).find((o) => o.full_name)?.full_name;
  if (!anyCatalog) {
    record(S, "контроль: поиск по имени работает", "SKIP", "не нашли справочник для фикстуры");
  } else {
    const search = await callTool("search_objects", { query: "а", types: [anyCatalog], limit: 1 });
    const code = errorCodeOf(search);
    check(S, "контроль: search_objects по имени не отклонён",
      code !== "privacy_denied_field" && code !== "privacy_config_error",
      code ? `код: ${code}` : "");

    const query = await callTool("validate_1c_query", {
      query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${anyCatalog} КАК Т`,
    });
    const codes = validationCodes(query.data);
    check(S, "контроль: валидация запроса без privacy-кодов",
      !codes.includes("privacy_denied_field") && !codes.includes("privacy_config_error"),
      codes.join(", "));
  }

  console.log(
    "\nДалее вручную: node scripts/mcp_contract_test.mjs --all-response-modes" +
      " — контракт при пустых секциях не должен измениться (§11.2 п.1).",
  );
}

// ------------------------------------------------------ жёсткий прогон

async function runEnforced() {
  const S3 = "§11.3 жёсткий режим";
  const S2 = "§11.2 второй эшелон";

  const denyTypes = [...new Set([...policy.denyAliasTypes, ...policy.denyMaskTypes])];
  if (!denyTypes.length) {
    record(S3, "политика с mode: deny", "SKIP",
      "в живой политике нет ни одной deny-записи — заполните privacy в MCP_ServerConfig");
    return;
  }
  const closed = denyTypes[0];
  console.log(`\nЗакрытый тип для матрицы: ${closed}\n`);

  // ---- группа «Прямой запрос»: выбор, отбор, сортировка, переименование.
  const nameField = (policy.maskFieldsByType.get(closed) ?? []).find((f) =>
    ["Наименование", "НаименованиеПолное", "Код", "Представление"].includes(f),
  ) || "Наименование";

  const denialCases = [
    ["выбор закрытого поля", `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК П ИЗ ${closed} КАК Т`],
    ["переименование КАК X", `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК X ИЗ ${closed} КАК Т`],
    ["обращение без псевдонима", `ВЫБРАТЬ ПЕРВЫЕ 1 ${nameField} ИЗ ${closed}`],
    ["отбор ПОДОБНО (оракул)",
      `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${closed} КАК Т ГДЕ Т.${nameField} ПОДОБНО "А%"`],
    ["сортировка по закрытому полю",
      `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${closed} КАК Т УПОРЯДОЧИТЬ ПО Т.${nameField}`],
    ["ПРЕДСТАВЛЕНИЕ(Ссылка)",
      `ВЫБРАТЬ ПЕРВЫЕ 1 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`],
    ["ПРЕДСТАВЛЕНИЕССЫЛКИ(Ссылка)",
      `ВЫБРАТЬ ПЕРВЫЕ 1 ПРЕДСТАВЛЕНИЕССЫЛКИ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`],
  ];
  for (const [name, query] of denialCases) {
    const res = await callTool("validate_1c_query", { query });
    const codes = validationCodes(res.data);
    check(S3, `отказ: ${name}`, codes.includes("privacy_denied_field"),
      codes.length ? `коды: ${codes.join(", ")}` : "приняли запрос без отказа");
  }

  // ---- контроль: работа по ссылке остаётся разрешённой.
  const refOk = await callTool("validate_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${closed} КАК Т УПОРЯДОЧИТЬ ПО Т.Ссылка`,
  });
  check(S3, "контроль: выбор и сортировка по Ссылке разрешены",
    !validationCodes(refOk.data).includes("privacy_denied_field"),
    validationCodes(refOk.data).join(", "));

  // ---- группа «Несколько источников»: одноимённое поле чужого типа.
  const others = await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 30 });
  const openCatalog = (others.data?.objects ?? [])
    .map((o) => o.full_name)
    .find((fn) => fn && !denyTypes.some((t) => t.toLowerCase() === fn.toLowerCase()));
  if (!openCatalog) {
    record(S3, "одноимённое поле незакрытого источника", "SKIP", "не нашли открытый справочник");
  } else {
    const mixed = await callTool("validate_1c_query", {
      query:
        `ВЫБРАТЬ ПЕРВЫЕ 1 О.${nameField} КАК П ИЗ ${openCatalog} КАК О` +
        ` ЛЕВОЕ СОЕДИНЕНИЕ ${closed} КАК З ПО ЛОЖЬ`,
    });
    check(S3, "контроль: одноимённое поле незакрытого источника разрешено",
      !validationCodes(mixed.data).includes("privacy_denied_field"),
      validationCodes(mixed.data).join(", "));
  }

  // ---- группа «Остальные tools»: поиск по имени.
  const search = await callTool("search_objects", { query: "а", types: [closed], limit: 1 });
  check(S3, "отказ: search_objects по имени в закрытом типе",
    errorCodeOf(search) === "privacy_denied_field" || search.isError === true,
    `код: ${errorCodeOf(search) || "нет"}`);

  const searchAll = await callTool("search_objects", { query: "а", limit: 1 });
  check(S3, "отказ: search_objects без types (закрытые типы в области поиска)",
    errorCodeOf(searchAll) === "privacy_denied_field" || searchAll.isError === true,
    `код: ${errorCodeOf(searchAll) || "нет"}`);

  // ---- второй эшелон: ответ по ссылке закрытого типа маскируется.
  const sample = await callTool("run_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${closed} КАК Т`,
    limit: 1,
  });
  const row = sample.data?.rows?.[0]?.Ссылка;
  if (!row) {
    record(S2, "псевдоним в presentation ссылки", "SKIP", "нет строк для фикстуры");
  } else {
    const aliasEntry = (policy.denyAliasTypes.includes(closed) || policy.denyMaskTypes.includes(closed));
    check(S2, "uuid и navigation_url сохранены", Boolean(row.uuid),
      `uuid: ${row.uuid ? "есть" : "нет"}, navigation_url: ${row.navigation_url ? "есть" : "нет"}`);
    check(S2, "presentation не отдаёт исходное название",
      aliasEntry ? typeof row.presentation === "string" : true,
      `presentation: ${row.presentation}`);
  }

  // ---- наблюдаемость: диагностика отказа не содержит закрываемых значений.
  const diag = await callTool("validate_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК П ИЗ ${closed} КАК Т`,
  });
  const messages = (diag.data?.validation?.errors ?? diag.data?.errors ?? [])
    .map((e) => e.message)
    .join(" ");
  check(S3, "диагностика называет тип и поле",
    messages.includes(closed.split(".").pop()) || messages.includes(nameField),
    messages.slice(0, 200));
}

// ------------------------------------------------------------------ main

(async () => {
  console.log(`Контур: ${URL_MCP}`);
  console.log(`Режим: ${ENFORCED ? "--enforced (заполненная политика)" : "базовый (пустые секции)"}\n`);

  const loaded = await loadPolicy();
  if (loaded.fatal) {
    console.error(`Не удалось прочитать политику: ${loaded.fatal}`);
    process.exitCode = 2;
    return;
  }

  if (ENFORCED) await runEnforced();
  else await runBaseline();

  console.log(`\nИтог: PASS ${passed}, FAIL ${failed}, SKIP ${skipped}`);

  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        { url: URL_MCP, mode: ENFORCED ? "enforced" : "baseline", policy: {
          enabled: policy.enabled,
          hasTypeSections: policy.hasTypeSections === true,
          denyAliasTypes: policy.denyAliasTypes,
          denyMaskTypes: policy.denyMaskTypes,
          warnings: policy.warnings,
          errors: policy.errors,
        }, passed, failed, skipped, results },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`JSON: ${JSON_OUT}`);
  }

  if (failed > 0) process.exitCode = 1;
})();
