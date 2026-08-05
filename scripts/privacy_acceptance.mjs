// Приёмка privacy-политики по типам (задача 597, ТЗ v1.3.0 §11.2 и §11.3).
//
// Контракт с 05.08.2026 — ТОЛЬКО ПОДМЕНА: отказов нет ни в одной форме. Запрос
// к закрытому полю выполняется, строки возвращаются, значение подменяется.
// Поэтому матрица проверяет ровно обратное прежнему: запрос обязан быть принят,
// а значение в ответе — не быть исходным названием.
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
//       type_field_masks) — имена метаданных не захардкожены.
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
  aliasTypes: [],
  maskTypes: [],
  prefixByType: new Map(),
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

  // mode из контракта убран: любая запись политики закрывает тип подменой.
  for (const entry of p.type_aliases?.entries ?? []) {
    policy.aliasTypes.push(entry.type);
    if (entry.prefix) policy.prefixByType.set(entry.type, entry.prefix);
  }
  for (const entry of p.type_field_masks?.entries ?? []) {
    policy.maskTypes.push(entry.type);
    policy.maskFieldsByType.set(entry.type, entry.fields ?? []);
  }
  return {};
}

// Значение считается подменённым, если это строковая маска, скрытый псевдоним
// или код псевдонима с префиксом типа. Сравнивать с исходным названием нельзя:
// живых данных контура у скрипта нет и быть не должно.
function looksMasked(value, type) {
  if (value === null || value === undefined) return false;
  const text = String(value);
  if (text === "XXXXXXX" || text === "1900-01-01T00:00:00") return true;
  const prefix = policy.prefixByType.get(type);
  if (prefix && text.startsWith(prefix)) return true;
  // Легаси-псевдонимы персон и организаций: префикс задан не в type_aliases.
  return /^(Орг|ФЛ|Сотр|Польз)-/.test(text);
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
  check(S, "config_errors пуст (аварийного режима нет)", (policy.errors ?? []).length === 0,
    (policy.errors ?? []).join(" | "));

  // Контроль отсутствия отказов при пустой политике. Коды privacy_denied_field и
  // privacy_config_error из контракта убраны — их появление означает старую сборку.
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
    check(S, "кодов отказа privacy в сборке нет",
      code !== "privacy_denied_field" && code !== "privacy_denied_autoorder"
        && code !== "privacy_config_error",
      code ? `код: ${code} — задеплоена сборка с отказами` : "");

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

// ------------------------------------------- прогон с заполненной политикой

async function runEnforced() {
  const S3 = "§11.3 заполненная политика";
  const S2 = "§11.2 второй эшелон";

  const closedTypes = [...new Set([...policy.aliasTypes, ...policy.maskTypes])];
  if (!closedTypes.length) {
    record(S3, "закрытый тип в политике", "SKIP",
      "в живой политике нет ни одной записи — заполните privacy в MCP_ServerConfig");
    return;
  }
  const closed = closedTypes[0];
  console.log(`\nЗакрытый тип для матрицы: ${closed}\n`);

  const nameField = (policy.maskFieldsByType.get(closed) ?? []).find((f) =>
    ["Наименование", "НаименованиеПолное", "Код", "Представление"].includes(f),
  ) || "Наименование";

  // Формы, которые прежний контракт отклонял. Теперь каждая обязана выполниться,
  // вернуть строки и отдать подменённое значение. Проверяются обе половины: и
  // что запрос принят, и что значение не исходное — принятый запрос с открытым
  // названием хуже отказа.
  const substitutionCases = [
    ["выбор закрытого поля", `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК П ИЗ ${closed} КАК Т`],
    ["переименование КАК X", `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК X ИЗ ${closed} КАК Т`],
    ["обращение без псевдонима", `ВЫБРАТЬ ПЕРВЫЕ 1 ${nameField} КАК П ИЗ ${closed}`],
    ["сортировка по закрытому полю",
      `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК П ИЗ ${closed} КАК Т УПОРЯДОЧИТЬ ПО Т.${nameField}`],
    ["ПРЕДСТАВЛЕНИЕ(Ссылка)",
      `ВЫБРАТЬ ПЕРВЫЕ 1 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`],
    ["ПРЕДСТАВЛЕНИЕССЫЛКИ(Ссылка)",
      `ВЫБРАТЬ ПЕРВЫЕ 1 ПРЕДСТАВЛЕНИЕССЫЛКИ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`],
    ["АВТОУПОРЯДОЧИВАНИЕ",
      `ВЫБРАТЬ ПЕРВЫЕ 1 Т.${nameField} КАК П ИЗ ${closed} КАК Т АВТОУПОРЯДОЧИВАНИЕ`],
  ];

  const denialCodes = ["privacy_denied_field", "privacy_denied_autoorder", "privacy_config_error"];
  const columnOf = (name) => (name === "переименование КАК X" ? "X" : "П");

  for (const [name, query] of substitutionCases) {
    const validation = await callTool("validate_1c_query", { query });
    const codes = validationCodes(validation.data);
    check(S3, `принят: ${name}`, !codes.some((c) => denialCodes.includes(c)),
      codes.length ? `коды: ${codes.join(", ")}` : "");

    const run = await callTool("run_1c_query", { query, limit: 1 });
    const rows = run.data?.rows ?? [];
    if (!rows.length) {
      record(S3, `подмена: ${name}`, "SKIP", "запрос вернул ноль строк — нет фикстуры");
      continue;
    }
    const value = rows[0][columnOf(name)];
    check(S3, `подмена: ${name}`, looksMasked(value, closed),
      looksMasked(value, closed) ? "" : "значение не выглядит подменённым");
  }

  // ---- контроль: работа по ссылке остаётся разрешённой и не искажается.
  const refOk = await callTool("validate_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${closed} КАК Т УПОРЯДОЧИТЬ ПО Т.Ссылка`,
  });
  check(S3, "контроль: выбор и сортировка по Ссылке разрешены",
    !validationCodes(refOk.data).some((c) => denialCodes.includes(c)),
    validationCodes(refOk.data).join(", "));

  // ---- парная проба: одноимённое поле незакрытого источника обязано остаться
  // ОТКРЫТЫМ. Половина «стало разрешено» ничего не доказывает без половины «не
  // стало подменяться лишнее» — подмена наугад ломает аналитику молча.
  const others = await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 30 });
  const openCatalog = (others.data?.objects ?? [])
    .map((o) => o.full_name)
    .find((fn) => fn && !closedTypes.some((t) => t.toLowerCase() === fn.toLowerCase()));
  if (!openCatalog) {
    record(S3, "парная: одноимённое поле незакрытого источника открыто", "SKIP",
      "не нашли открытый справочник");
  } else {
    const mixed = await callTool("run_1c_query", {
      query:
        `ВЫБРАТЬ ПЕРВЫЕ 1 О.Наименование КАК П ИЗ ${openCatalog} КАК О` +
        ` ЛЕВОЕ СОЕДИНЕНИЕ ${closed} КАК З ПО ЛОЖЬ`,
      limit: 1,
    });
    const mixedRows = mixed.data?.rows ?? [];
    if (!mixedRows.length) {
      record(S3, "парная: одноимённое поле незакрытого источника открыто", "SKIP",
        "нет строк для фикстуры");
    } else {
      check(S3, "парная: одноимённое поле незакрытого источника открыто",
        !looksMasked(mixedRows[0].П, closed),
        "значение открытого типа подменено — ложное срабатывание");
    }
  }

  // ---- остальные инструменты: поиск по имени в закрытом типе работает.
  const search = await callTool("search_objects", { query: "а", types: [closed], limit: 1 });
  check(S3, "search_objects по имени в закрытом типе не отклонён",
    !denialCodes.includes(errorCodeOf(search)) && search.isError !== true,
    `код: ${errorCodeOf(search) || "нет"}`);

  // ---- второй эшелон: ответ по ссылке закрытого типа маскируется.
  const sample = await callTool("run_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${closed} КАК Т`,
    limit: 1,
  });
  const row = sample.data?.rows?.[0]?.Ссылка;
  if (!row) {
    record(S2, "псевдоним в presentation ссылки", "SKIP", "нет строк для фикстуры");
  } else {
    check(S2, "uuid и navigation_url сохранены", Boolean(row.uuid),
      `uuid: ${row.uuid ? "есть" : "нет"}, navigation_url: ${row.navigation_url ? "есть" : "нет"}`);
    check(S2, "presentation не отдаёт исходное название",
      looksMasked(row.presentation, closed),
      `presentation: ${row.presentation}`);
  }
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
          aliasTypes: policy.aliasTypes,
          maskTypes: policy.maskTypes,
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
