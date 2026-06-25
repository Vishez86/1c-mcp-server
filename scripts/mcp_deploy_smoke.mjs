#!/usr/bin/env node
// CR-C: финальный smoke-gate деплоя MCP-сервера 1С.
//
// Назначение: после публикации расширения / обновления конфигурации выполнить ОДИН
// тривиальный read-only `run_1c_query` и убедиться, что он возвращает ok:true.
// Это ловит частичную публикацию (рассинхрон MCP_Knowledge / MCP_Query / MCP_Tools_Impl),
// при которой `run_1c_query` падает с internal_error (ДобавитьДоменныеПодсказки) ещё до
// первого прод-запроса.
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
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/mcp_deploy_smoke.mjs [--url URL] [--basic user:pass] [--timeout-ms N] [--verbose]");
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

async function main() {
  const options = parseArgs(process.argv);
  console.log(`[smoke-gate] target: ${options.url}`);
  console.log(`[smoke-gate] query : ${SMOKE_QUERY}`);

  const result = await rpc(options, "tools/call", {
    name: "run_1c_query",
    arguments: { query: SMOKE_QUERY },
  });
  const unwrapped = unwrapToolResult(result);

  if (options.verbose) {
    console.log(`[smoke-gate] response: ${JSON.stringify(unwrapped).slice(0, 1200)}`);
  }

  if (unwrapped?.ok === true) {
    const rows = Array.isArray(unwrapped.rows) ? unwrapped.rows.length : (unwrapped.row_count ?? "?");
    console.log(`[smoke-gate] PASS — run_1c_query ok:true (rows=${rows})`);
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
