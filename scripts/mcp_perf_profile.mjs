#!/usr/bin/env node
// Сквозной профилировщик вызова MCP-инструмента: от отправки запроса клиентом
// до получения результата, по всем слоям (ТЗ perf_tool_overhead, R-6 + приёмка).
//
// Что меряется и откуда берётся:
//   1. Клиент (этот скрипт, node:https): dns / tcp / tls / ttfb / total —
//      события сокета, единственный слой, который сервер не видит.
//   2. HTTP-слой сервера: событие MCP.http_request из get_audit_log —
//      duration_ms + стадии http_guard / http_body_read / rpc_parse /
//      rpc_handle / rpc_serialize / http_set_body + request_chars/response_chars.
//   3. Вызов инструмента: событие MCP.<tool>.success — duration_ms + стадии
//      access_check / tool_impl / auth_context / masking / size_check / serialize.
//   4. Движок запроса (для run_1c_query): стадии q_* внутри tool_impl
//      (q_validate, q_db_execute, q_unload, q_privacy_marks, q_encode_rows, ...)
//      и счётчики q_rows / q_cells / q_ref_cells / q_ref_presentation_ms.
//
// Связывание слоёв: ответ инструмента несёт correlation_id → точечная выборка
// его записи аудита; HTTP-запись correlation_id не имеет по конструкции и
// подбирается по request_chars (длина нашего тела известна) и порядку следования.
//
// Использование:
//   node scripts/mcp_perf_profile.mjs [--url URL] [--runs N] [--query "ВЫБРАТЬ ..."]
//       [--tool name --args '{"...":1}'] [--response-mode structured_only|text_only|both]
//       [--timeout-ms N] [--basic user:pass] [--no-audit] [--json] [--verbose]
//
// По умолчанию: BUH_KORP, 2 прогона, запрос на 300 строк плана счетов со ссылкой
// (упражняет кодирование ссылок — главный подозреваемый R-1). На ЗУП плана счетов
// нет — передайте свой --query.
//
// Транспорт: node:https (undici рвёт connect на 10 с — см. память проекта),
// сертификат контура самоподписанный.

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const DEFAULT_QUERY = "ВЫБРАТЬ ПЕРВЫЕ 300 Счет.Ссылка КАК Ссылка, Счет.Код КАК Код,"
  + " Счет.Порядок КАК Порядок ИЗ ПланСчетов.Хозрасчетный КАК Счет";

function parseArgs(argv) {
  const options = {
    url: process.env.MCP_URL || DEFAULT_URL,
    basic: process.env.MCP_BASIC || "",
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 120000),
    runs: 2,
    tool: "run_1c_query",
    args: null,
    query: DEFAULT_QUERY,
    responseMode: "",
    audit: true,
    json: false,
    verbose: false,
    // Обход ловушки маршрута по умолчанию: VPN-туннель с метрикой 0 глушит
    // контуры целиком — привязка сокета к адресу Wi-Fi возвращает связь
    // (см. CLAUDE.md, раздел «Примечания»). Пример: --local-address 10.130.0.75
    localAddress: process.env.MCP_LOCAL_ADDRESS || "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--url") options.url = next();
    else if (arg.startsWith("--url=")) options.url = arg.slice(6);
    else if (arg === "--basic") options.basic = next();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--query") options.query = next();
    else if (arg === "--tool") options.tool = next();
    else if (arg === "--args") options.args = JSON.parse(next());
    else if (arg === "--response-mode") options.responseMode = next();
    else if (arg === "--local-address") options.localAddress = next();
    else if (arg === "--no-audit") options.audit = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("см. шапку файла scripts/mcp_perf_profile.mjs");
      process.exit(0);
    } else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  if (!Number.isFinite(options.runs) || options.runs < 1) options.runs = 1;
  return options;
}

// Один HTTPS-запрос с тонкими таймингами сокета.
function timedRequest(options, payload) {
  const target = new URL(options.url);
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2025-11-25",
    "content-length": Buffer.byteLength(payload),
  };
  if (options.basic) {
    headers.authorization = `Basic ${Buffer.from(options.basic, "utf8").toString("base64")}`;
  }
  return new Promise((resolvePromise, reject) => {
    const t = { start: Date.now() };
    const req = httpsRequest({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: "POST",
      headers,
      rejectUnauthorized: false,
      timeout: options.timeoutMs,
      localAddress: options.localAddress || undefined,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.once("data", () => { t.ttfb = Date.now(); });
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        t.end = Date.now();
        resolvePromise({ status: res.statusCode, text, timings: t });
      });
    });
    req.on("socket", (socket) => {
      // При keep-alive сокет может быть уже установлен — тогда фаз соединения нет.
      if (socket.connecting === false) return;
      socket.once("lookup", () => { t.dns = Date.now(); });
      socket.once("connect", () => { t.tcp = Date.now(); });
      socket.once("secureConnect", () => { t.tls = Date.now(); });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${options.timeoutMs} ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function unwrapToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const textItem = result?.content?.find?.((i) => i?.type === "text" && typeof i.text === "string");
  if (textItem?.text) {
    try { return JSON.parse(textItem.text); } catch { return result; }
  }
  return result;
}

async function callToolTimed(options, name, args, responseMode) {
  const params = { name, arguments: args };
  if (responseMode) params._response_mode = responseMode;
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params });
  const { status, text, timings } = await timedRequest(options, payload);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`JSON-RPC ${json.error.code}: ${json.error.message}`);
  return {
    data: unwrapToolResult(json.result),
    timings,
    requestChars: payload.length,   // СтрДлина на сервере считает символы — сопоставимо с length
    responseChars: text.length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (v) => (typeof v === "number" ? `${v}` : "—");

function clientPhases(t) {
  const phases = {};
  if (t.dns) phases.dns = t.dns - t.start;
  if (t.tcp) phases.tcp = t.tcp - (t.dns ?? t.start);
  if (t.tls) phases.tls = t.tls - (t.tcp ?? t.start);
  phases.ttfb_after_connect = (t.ttfb ?? t.end) - (t.tls ?? t.tcp ?? t.start);
  phases.download = t.end - (t.ttfb ?? t.end);
  phases.total = t.end - t.start;
  return phases;
}

function median(values) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  return sorted[Math.floor((sorted.length - 1) / 2)]; // нижняя медиана, как в by_tool сервера
}

function printStages(prefix, stages, counters) {
  if (!stages) { console.log(`${prefix}стадии не записаны (старый MCP_Audit на контуре?)`); return; }
  const entries = Object.entries(stages);
  const known = entries.filter(([, v]) => typeof v === "number");
  const total = known.reduce((s, [, v]) => s + v, 0);
  for (const [name, value] of entries) {
    console.log(`${prefix}${name.padEnd(24)} ${String(value).padStart(8)} мс`);
  }
  console.log(`${prefix}${"(сумма стадий)".padEnd(24)} ${String(total).padStart(8)} мс`);
  if (counters) {
    for (const [name, value] of Object.entries(counters)) {
      console.log(`${prefix}${name.padEnd(24)} ${String(value).padStart(8)}${name.endsWith("_ms") ? " мс*" : ""}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const toolArgs = options.args
    ?? (options.tool === "run_1c_query" ? { query: options.query, limit: 1000 } : {});

  const runs = [];
  for (let i = 0; i < options.runs; i += 1) {
    const started = new Date();
    const r = await callToolTimed(options, options.tool, toolArgs, options.responseMode);
    const run = {
      n: i + 1,
      startedAt: started.toISOString(),
      client: clientPhases(r.timings),
      requestChars: r.requestChars,
      responseChars: r.responseChars,
      ok: r.data?.ok,
      correlationId: r.data?.correlation_id ?? null,
      responseDurationMs: r.data?.duration_ms,   // у run_1c_query — только СУБД
      rowCount: r.data?.row_count,
    };
    if (r.data?.ok !== true) {
      run.error = r.data?.error_code ?? r.data?.message ?? "ответ без ok=true";
    }
    runs.push(run);
    if (options.verbose) console.log(`[run ${run.n}] client_total=${run.client.total} мс, correlation_id=${run.correlationId}`);
  }

  if (options.audit) {
    // Журналу регистрации нужно мгновение, чтобы запись стала видимой выборке.
    await sleep(1500);
    for (const run of runs) {
      if (!run.correlationId) continue;
      try {
        const audit = await callToolTimed(options, "get_audit_log", {
          minutes_back: 30, correlation_id: run.correlationId, include_http: false, limit: 5,
        });
        run.toolEvent = (audit.data?.events ?? []).find((e) => e.kind === "tool") ?? null;
        if (audit.data?.source_available === false) run.auditUnavailable = true;
      } catch (error) {
        run.auditError = error.message;
      }
    }
    // HTTP-записи: correlation_id в них нет — подбор по request_chars и порядку.
    try {
      const httpAudit = await callToolTimed(options, "get_audit_log", {
        minutes_back: 30, include_http: true, tools: [options.tool], limit: 200,
      });
      const httpEvents = (httpAudit.data?.events ?? [])
        .filter((e) => e.kind === "http_request" && e.request_chars === runs[0].requestChars);
      // events отсортированы по дате по убыванию; прогоны — по возрастанию.
      httpEvents.reverse();
      const tail = httpEvents.slice(-runs.length);
      runs.forEach((run, i) => { run.httpEvent = tail[i] ?? null; });
    } catch (error) {
      runs.forEach((run) => { run.httpAuditError = error.message; });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ url: options.url, tool: options.tool, runs }, null, 2));
    return;
  }

  console.log(`Профиль вызова ${options.tool} — ${options.url}`);
  console.log(`Прогонов: ${runs.length}, тело запроса: ${runs[0].requestChars} симв.\n`);

  for (const run of runs) {
    console.log(`── Прогон ${run.n} ${run.ok === true ? "" : `(ОШИБКА: ${run.error})`}`);
    const c = run.client;
    console.log(`  Клиент: total=${c.total} мс`
      + (c.dns !== undefined ? `, dns=${c.dns}` : "")
      + (c.tcp !== undefined ? `, tcp=${c.tcp}` : "")
      + (c.tls !== undefined ? `, tls=${c.tls}` : "")
      + `, до первого байта после соединения=${c.ttfb_after_connect}, скачивание=${c.download}`);
    console.log(`  Ответ: ${run.responseChars} симв.,`
      + ` duration_ms в ответе (только СУБД у run_1c_query)=${ms(run.responseDurationMs)},`
      + ` строк=${ms(run.rowCount)}`);

    if (run.httpEvent) {
      console.log(`  HTTP-слой (MCP.http_request): duration_ms=${run.httpEvent.duration_ms},`
        + ` status=${run.httpEvent.http_status}, response_chars=${ms(run.httpEvent.response_chars)}`);
      printStages("    ", run.httpEvent.stages, run.httpEvent.counters);
      console.log(`  Сеть+веб-сервер (client_total − http): ${c.total - (run.httpEvent.duration_ms ?? 0)} мс`);
    } else if (options.audit) {
      console.log("  HTTP-слой: запись не подобрана (см. request_chars/окно)");
    }

    if (run.toolEvent) {
      console.log(`  Вызов инструмента (MCP.${options.tool}.success): duration_ms=${run.toolEvent.duration_ms}`);
      printStages("    ", run.toolEvent.stages, run.toolEvent.counters);
      if (run.httpEvent?.stages?.rpc_handle !== undefined && run.toolEvent.duration_ms !== undefined) {
        console.log(`  Обвязка JSON-RPC (rpc_handle − вызов): ${run.httpEvent.stages.rpc_handle - run.toolEvent.duration_ms} мс`);
      }
    } else if (options.audit) {
      console.log(`  Вызов инструмента: запись аудита не получена`
        + `${run.auditUnavailable ? " (нет права просмотра журнала)" : ""}${run.auditError ? ` (${run.auditError})` : ""}`);
    }
    console.log("");
  }

  if (runs.length > 1) {
    console.log("── Медианы по прогонам");
    console.log(`  client_total: ${ms(median(runs.map((r) => r.client.total)))} мс`);
    console.log(`  http duration_ms: ${ms(median(runs.map((r) => r.httpEvent?.duration_ms)))} мс`);
    console.log(`  tool duration_ms: ${ms(median(runs.map((r) => r.toolEvent?.duration_ms)))} мс`);
    console.log(`  db (duration_ms ответа): ${ms(median(runs.map((r) => r.responseDurationMs)))} мс`);
    const stageNames = new Set(runs.flatMap((r) => Object.keys(r.toolEvent?.stages ?? {})));
    for (const name of stageNames) {
      console.log(`  стадия ${name}: ${ms(median(runs.map((r) => r.toolEvent?.stages?.[name])))} мс`);
    }
  }
  console.log("\n* — деталь-длительность внутри родительской стадии, в сумму стадий не входит");
}

main().catch((error) => {
  console.error(`[perf-profile] СБОЙ: ${error.message}`);
  process.exit(1);
});
