#!/usr/bin/env node
// CR-C: финальный smoke-gate деплоя MCP-сервера 1С.
//
// Назначение: после публикации расширения / обновления конфигурации выполнить ОДИН
// тривиальный read-only `run_1c_query` и убедиться, что он возвращает ok:true.
// Это ловит частичную публикацию (рассинхрон MCP_Knowledge / MCP_Query / MCP_Tools_Impl),
// при которой `run_1c_query` падает с internal_error (ДобавитьДоменныеПодсказки) ещё до
// первого прод-запроса.
//
// Затем проверяются МАРКЕРЫ МОДУЛЕЙ — по одному наблюдаемому признаку на критичный
// модуль комплекта. Без них гейт пропускал частичную публикацию: при неопубликованном
// MCP_Tools он проходил, хотя поле stage в ответе отсутствовало.
// Маркер — это ПОЛ ревизии модуля, а не полный контракт. Отключается флагом --base-only.
//
// Гейт: процесс завершается кодом 1 при ok:false / internal_error / транспортной ошибке
// и кодом 0 только при ok:true. Предназначен для запуска как последний шаг деплоя в CI
// или вручную по инструкции INSTALL.md.
//
// Использование:
//   node scripts/mcp_deploy_smoke.mjs [--url URL] [--basic user:pass] [--timeout-ms N] [--verbose]
// Переменные окружения: MCP_URL, MCP_BASIC, MCP_TIMEOUT_MS.

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const SMOKE_QUERY = "ВЫБРАТЬ ПЕРВЫЕ 1 Счет.Код ИЗ ПланСчетов.Хозрасчетный КАК Счет";

function parseArgs(argv) {
  const options = {
    url: process.env.MCP_URL || DEFAULT_URL,
    basic: process.env.MCP_BASIC || "",
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 60000),
    verbose: false,
    baseOnly: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") options.url = argv[++i];
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--basic") options.basic = argv[++i];
    else if (arg.startsWith("--basic=")) options.basic = arg.slice("--basic=".length);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--base-only") options.baseOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/mcp_deploy_smoke.mjs [--url URL] [--basic user:pass] [--timeout-ms N] [--verbose] [--base-only]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.url) throw new Error("MCP URL is required. Use --url or MCP_URL.");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return options;
}

async function rpc(options, method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (options.basic) {
    headers.authorization = `Basic ${Buffer.from(options.basic, "utf8").toString("base64")}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}, non-JSON response: ${text.slice(0, 500)}`);
      }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    if (json?.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
    return json?.result;
  } finally {
    clearTimeout(timer);
  }
}

// Разворачивает result tools/call: structuredContent либо JSON из content[0].text.
function unwrapToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const textItem = result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string");
  if (textItem) {
    if (!textItem.text) return {};
    try {
      return JSON.parse(textItem.text);
    } catch {
      return result;
    }
  }
  return result;
}

const callTool = async (options, name, args) =>
  unwrapToolResult(await rpc(options, "tools/call", { name, arguments: args }));

// Фикстуры для маркеров подбираются на живой базе: ни одного захардкоженного имени
// метаданных, иначе гейт годился бы только для одной конфигурации.
async function discoverFixtures(options) {
  const fixtures = { catalog: null, tabularOwner: null, tabularSection: null, register: null, chart: null };

  const catalogs = await callTool(options, "list_metadata_objects", { kinds: ["Справочник"], limit: 40 });
  for (const item of catalogs?.objects ?? []) {
    if (!item?.full_name) continue;
    const structure = await callTool(options, "get_metadata_structure", {
      type: item.full_name,
      include_standard_attributes: true,
      include_tabular_sections: true,
    });
    const meta = structure?.metadata ?? {};
    if (meta.supports_ref !== true) continue;
    if (!fixtures.catalog) fixtures.catalog = item.full_name;
    const section = (meta.tabular_sections ?? [])[0]?.name;
    if (section && !fixtures.tabularSection) {
      fixtures.tabularOwner = item.full_name;
      fixtures.tabularSection = section;
    }
    if (fixtures.catalog && fixtures.tabularSection) break;
  }

  const passport = await callTool(options, "get_database_passport", {});
  fixtures.register = (passport?.accounting_registers ?? [])[0]?.register ?? null;

  const charts = await callTool(options, "list_metadata_objects", { kinds: ["ПланСчетов"], limit: 5 });
  fixtures.chart = (charts?.objects ?? [])[0]?.full_name ?? null;

  return fixtures;
}

// Маркеры — по одному наблюдаемому признаку на критичный модуль. Гейт до этого проверял
// только run_1c_query ok:true и потому пропускал частичную публикацию: при неопубликованном
// MCP_Tools он проходил, хотя поле stage в ответе отсутствовало.
//
// Маркер — это ПОЛ ревизии, а не полный контракт: он подтверждает, что модуль не старше
// того изменения, которым маркер введён. При добавлении фич маркеры обновляются.
const MODULE_MARKERS = [
  {
    module: "MCP_Metadata",
    what: "предвалидация полей: несуществующее поле отклоняется как field_not_found",
    async run(options, fixtures) {
      if (!fixtures.catalog) return { status: "skip", note: "нет справочника с поддержкой ссылок" };
      const r = await callTool(options, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.ЗаведомоНетТакогоПоляГейта КАК Поле ИЗ ${fixtures.catalog} КАК Т`,
        limit: 1,
      });
      const code = r?.error_code ?? r?.error?.error_code;
      return code === "field_not_found"
        ? { status: "pass", note: `available_fields: ${(r?.available_fields ?? r?.error?.available_fields ?? []).length}` }
        : { status: "fail", note: `ожидался field_not_found, получено: ${code ?? JSON.stringify(r).slice(0, 120)}` };
    },
  },
  {
    module: "MCP_Tools",
    what: "stage виден клиенту при отказе до выполнения",
    async run(options, fixtures) {
      if (!fixtures.tabularSection) return { status: "skip", note: "нет справочника с табличной частью" };
      const r = await callTool(options, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка ИЗ ${fixtures.tabularOwner}.ЗаведомоНетТакойТабличнойЧастиГейта КАК Т`,
        limit: 1,
      });
      // stage по контракту лежит на верхнем уровне ответа и в error, а НЕ в error.details:
      // MCP_Tools.bsl копирует его СкопироватьПолеДеталей(Детали, Данные, Ошибка, "stage")
      // именно затем, чтобы признак «движок не вызывался» был виден клиенту. Маркер,
      // читавший error.details.stage, давал FAIL на полностью корректном контуре и
      // сообщал о неполной публикации, которой не было.
      const stage = r?.stage ?? r?.error?.stage;
      return stage
        ? { status: "pass", note: `stage=${stage}` }
        : { status: "fail", note: `stage отсутствует и на верхнем уровне, и в error (ключи: ${Object.keys(r ?? {}).join(", ") || "нет"})` };
    },
  },
  {
    module: "MCP_Query",
    what: "объявленное исключение // СТАНДАРТ-ИСКЛЮЧЕНИЕ признаётся",
    async run(options, fixtures) {
      if (!fixtures.register) return { status: "skip", note: "в базе нет регистра бухгалтерии" };
      const query = "ВЫБРАТЬ ПЕРВЫЕ 1 Рег.Период КАК Период\n"
        + "// СТАНДАРТ-ИСКЛЮЧЕНИЕ: base_register_table_without_vt_check — маркер деплой-гейта, "
        + "проверяется признание объявленного исключения\n"
        + `ИЗ ${fixtures.register} КАК Рег`;
      const r = await callTool(options, "validate_1c_query", { query, strict: true, explain: true });
      const codes = (r?.errors ?? []).map((item) => item.code);
      return r?.valid === true
        ? { status: "pass", note: "исключение признано" }
        : { status: "fail", note: `valid=${r?.valid}, codes: ${codes.join(", ") || "нет"}` };
    },
  },
  {
    module: "MCP_Tools_Impl",
    what: "карта счетов отвечает",
    async run(options, fixtures) {
      if (!fixtures.chart) return { status: "skip", note: "в базе нет плана счетов" };
      const r = await callTool(options, "get_accounting_accounts_map", { chart: fixtures.chart, limit: 2 });
      return r?.ok === true
        ? { status: "pass", note: `счетов в ответе: ${(r.accounts ?? []).length}` }
        : { status: "fail", note: `ok=${r?.ok}, ${r?.error_code ?? ""}` };
    },
  },
  {
    module: "MCP_Examples",
    what: "get_query_examples зарегистрирован и отвечает",
    async run(options, fixtures) {
      const tools = await rpc(options, "tools/list", {});
      const names = (tools?.tools ?? []).map((item) => item.name);
      if (!names.includes("get_query_examples")) {
        return { status: "fail", note: "инструмента нет в tools/list — MCP_Tools или MCP_Examples не опубликован" };
      }
      // Объект берём из discovery: имя наугад дало бы metadata_not_found, и маркер
      // ругался бы на модуль вместо собственной фикстуры.
      const object = fixtures.chart ?? fixtures.catalog;
      if (!object) return { status: "skip", note: "нет объекта метаданных для пробы" };
      const r = await callTool(options, "get_query_examples", { object, days_back: 1, limit: 1 });
      // enabled=false — штатное состояние конфигурации, а не признак старого модуля.
      return r?.ok === true || r?.enabled === false
        ? { status: "pass", note: `enabled=${r?.enabled}` }
        : { status: "fail", note: `${r?.error_code ?? "нет ok"}: ${String(r?.message ?? "").slice(0, 100)}` };
    },
  },
];

async function runMarkers(options) {
  console.log("");
  console.log("[smoke-gate] маркеры модулей — проверка полноты публикации");
  const fixtures = await discoverFixtures(options);
  if (options.verbose) console.log(`[smoke-gate] фикстуры: ${JSON.stringify(fixtures)}`);

  let failed = 0;
  let skipped = 0;
  for (const marker of MODULE_MARKERS) {
    let outcome;
    try {
      outcome = await marker.run(options, fixtures);
    } catch (error) {
      outcome = { status: "fail", note: `исключение: ${error?.message || error}` };
    }
    const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP" }[outcome.status];
    console.log(`[smoke-gate] ${mark} ${marker.module.padEnd(16)} ${marker.what}`);
    console.log(`[smoke-gate]      ${outcome.note}`);
    if (outcome.status === "fail") failed += 1;
    if (outcome.status === "skip") skipped += 1;
  }

  if (failed > 0) {
    console.error(`[smoke-gate] FAIL — маркеров не прошло: ${failed}`);
    console.error("[smoke-gate] HINT: публикация неполная. Модуль из строки FAIL старше остальных либо "
      + "не выложен. Опубликуйте весь обязательный комплект (scripts/required_modules.manifest.json) "
      + "одним согласованным набором и повторите гейт.");
  }
  return { failed, skipped };
}

async function main() {
  const options = parseArgs(process.argv);
  console.log(`[smoke-gate] target: ${options.url}`);

  let query = SMOKE_QUERY;
  let unwrapped = await callTool(options, "run_1c_query", { query });

  // Базовый запрос по умолчанию бьёт в план счетов, которого нет в конфигурациях без
  // бухучёта (ЗУП отвечает error_code=metadata_not_found внутри query_validation_failed).
  // Тогда объект подбирается через discovery: иначе гейт применим только к базам с
  // бухгалтерией, что противоречит требованию конфигурационной независимости.
  const notFound = (unwrapped?.error_code === "metadata_not_found")
    || String(unwrapped?.error?.details?.raw_exception ?? "").includes("metadata_not_found");
  if (unwrapped?.ok !== true && notFound) {
    const catalogs = await callTool(options, "list_metadata_objects", { kinds: ["Справочник"], limit: 10 });
    const fallback = (catalogs?.objects ?? []).find((item) => item?.full_name && item.supports_query !== false);
    if (fallback) {
      query = `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${fallback.full_name} КАК Т`;
      console.log(`[smoke-gate] план счетов недоступен, подобран объект: ${fallback.full_name}`);
      unwrapped = await callTool(options, "run_1c_query", { query });
    }
  }
  console.log(`[smoke-gate] query : ${query}`);

  if (options.verbose) {
    console.log(`[smoke-gate] response: ${JSON.stringify(unwrapped).slice(0, 1200)}`);
  }

  if (unwrapped?.ok === true) {
    const rows = Array.isArray(unwrapped.rows) ? unwrapped.rows.length : (unwrapped.row_count ?? "?");
    console.log(`[smoke-gate] PASS — run_1c_query ok:true (rows=${rows})`);
    if (options.baseOnly) {
      console.log("[smoke-gate] маркеры модулей пропущены по --base-only");
      process.exitCode = 0;
      return;
    }
    const { failed, skipped } = await runMarkers(options);
    if (failed > 0) {
      process.exitCode = 1;
      return;
    }
    console.log(`[smoke-gate] PASS — маркеры модулей пройдены${skipped ? ` (пропущено по отсутствию фикстур: ${skipped})` : ""}`);
    process.exitCode = 0;
    return;
  }

  const errorCode = unwrapped?.error?.code || unwrapped?.error_code || "unknown_error";
  const errorMessage = unwrapped?.error?.message || JSON.stringify(unwrapped).slice(0, 800);
  console.error(`[smoke-gate] FAIL — run_1c_query did not return ok:true (code=${errorCode})`);
  console.error(`[smoke-gate] ${errorMessage}`);
  if (String(errorMessage).includes("ДобавитьДоменныеПодсказки")) {
    console.error("[smoke-gate] HINT: похоже на частичную публикацию — MCP_Knowledge выкачен без метода. "
      + "Опубликуйте весь обязательный комплект модулей (scripts/required_modules.manifest.json) одним набором.");
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[smoke-gate] FAIL — ${error?.message || error}`);
  process.exitCode = 1;
});
