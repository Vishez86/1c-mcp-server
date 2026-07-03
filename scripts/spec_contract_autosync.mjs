#!/usr/bin/env node
// spec_contract_autosync.mjs
// ============================================================================
// Заградительная автосверка (TC-30): сравнивает inputSchema из живого tools/list
// с блоками "### Input Schema" в doc/mcp_1c_tools_spec.md и падает (exit 1) при
// расхождении состава свойств, required, объявленных default или типов.
//
// Назначение — не дать спеке и коду снова разойтись после ручной синхронизации
// (F1/F2/F3). Запускать после каждого изменения inputSchema или спеки.
//
// Использование:
//   node scripts/spec_contract_autosync.mjs [--spec <path>] [--json <out>]
// Переменные окружения (как у mcp_contract_test.mjs):
//   MCP_URL         JSON-RPC endpoint (по умолчанию тот же, что в контракт-тесте)
//   MCP_BASIC       Basic-auth в форме user:pass (опционально)
//   MCP_TIMEOUT_MS  таймаут запроса (по умолчанию 60000)
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC = resolve(HERE, "..", "doc", "mcp_1c_tools_spec.md");

// Ключи, которые в спеке допускается опускать в inputSchema-блоке (они не part of
// per-tool arguments): протокольные параметры уровня JSON-RPC params.
const PROTOCOL_PARAMS = new Set(["_response_mode", "response_mode", "_include_auth_context", "include_auth_context"]);

function parseArgs(argv) {
  const opts = { spec: DEFAULT_SPEC, json: "" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--spec") opts.spec = resolve(argv[++i]);
    else if (argv[i] === "--json") opts.json = argv[++i];
  }
  return opts;
}

// ---- Парсинг спеки: tool -> inputSchema ------------------------------------
function parseSpecSchemas(specPath) {
  const lines = readFileSync(specPath, "utf8").split(/\r?\n/);
  const schemas = {};
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(/^##\s+7\.[0-9.]+\.\s+`([a-z0-9_]+)`/i);
    if (!header) { i++; continue; }
    const tool = header[1];
    let j = i + 1;
    let schema = null;
    while (j < lines.length && !/^##\s/.test(lines[j])) {
      if (/^###\s+Input Schema/i.test(lines[j])) {
        let k = j + 1;
        while (k < lines.length && !/^```json/.test(lines[k]) && !/^##\s/.test(lines[k])) k++;
        if (k < lines.length && /^```json/.test(lines[k])) {
          const buf = [];
          k++;
          while (k < lines.length && !/^```/.test(lines[k])) { buf.push(lines[k]); k++; }
          try { schema = JSON.parse(buf.join("\n")); }
          catch (e) { schema = { __parse_error: e.message }; }
        }
        break;
      }
      j++;
    }
    if (schema) schemas[tool] = schema;
    i = j;
  }
  return schemas;
}

// ---- Живой tools/list ------------------------------------------------------
async function fetchToolsList(url, basic, timeoutMs) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (basic) headers.authorization = `Basic ${Buffer.from(basic, "utf8").toString("base64")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(`JSON-RPC ${json.error.code}: ${json.error.message}`);
    return json.result?.tools || [];
  } finally {
    clearTimeout(timer);
  }
}

// ---- Сравнение одного инструмента ------------------------------------------
function compareSchemas(tool, liveSchema, specSchema, issues) {
  if (specSchema.__parse_error) {
    issues.push({ tool, kind: "spec_parse_error", detail: specSchema.__parse_error });
    return;
  }
  const liveProps = liveSchema?.properties || {};
  const specProps = specSchema?.properties || {};
  const liveNames = new Set(Object.keys(liveProps));
  const specNames = new Set(Object.keys(specProps));

  for (const name of liveNames) {
    if (PROTOCOL_PARAMS.has(name)) continue;
    if (!specNames.has(name)) issues.push({ tool, kind: "missing_in_spec", param: name });
  }
  for (const name of specNames) {
    if (PROTOCOL_PARAMS.has(name)) continue;
    if (!liveNames.has(name)) issues.push({ tool, kind: "missing_in_live", param: name });
  }

  // default и type для общих свойств
  for (const name of liveNames) {
    if (!specNames.has(name) || PROTOCOL_PARAMS.has(name)) continue;
    const lp = liveProps[name] || {};
    const sp = specProps[name] || {};
    const lHas = Object.prototype.hasOwnProperty.call(lp, "default");
    const sHas = Object.prototype.hasOwnProperty.call(sp, "default");
    if (lHas !== sHas) {
      issues.push({ tool, kind: "default_declared_mismatch", param: name,
        detail: `live ${lHas ? "объявляет" : "не объявляет"} default, spec ${sHas ? "объявляет" : "не объявляет"}` });
    } else if (lHas && sHas && JSON.stringify(lp.default) !== JSON.stringify(sp.default)) {
      issues.push({ tool, kind: "default_value_mismatch", param: name,
        detail: `live=${JSON.stringify(lp.default)} spec=${JSON.stringify(sp.default)}` });
    }
    if (lp.type && sp.type && lp.type !== sp.type) {
      issues.push({ tool, kind: "type_mismatch", param: name, detail: `live=${lp.type} spec=${sp.type}` });
    }
  }

  // required как множества
  const liveReq = new Set(liveSchema?.required || []);
  const specReq = new Set(specSchema?.required || []);
  for (const r of liveReq) if (!specReq.has(r)) issues.push({ tool, kind: "required_only_in_live", param: r });
  for (const r of specReq) if (!liveReq.has(r)) issues.push({ tool, kind: "required_only_in_spec", param: r });
}

async function main() {
  const opts = parseArgs(process.argv);
  const url = process.env.MCP_URL || DEFAULT_URL;
  const basic = process.env.MCP_BASIC || "";
  const timeoutMs = Number(process.env.MCP_TIMEOUT_MS || 60000);

  console.log(`spec-autosync: spec=${opts.spec}`);
  console.log(`spec-autosync: target=${url}`);

  const specSchemas = parseSpecSchemas(opts.spec);
  const tools = await fetchToolsList(url, basic, timeoutMs);
  const liveSchemas = {};
  for (const t of tools) liveSchemas[t.name] = t.inputSchema || {};

  const specTools = new Set(Object.keys(specSchemas));
  const liveTools = new Set(Object.keys(liveSchemas));
  const issues = [];

  for (const t of liveTools) if (!specTools.has(t)) issues.push({ tool: t, kind: "tool_missing_section_in_spec" });
  for (const t of specTools) if (!liveTools.has(t)) issues.push({ tool: t, kind: "tool_missing_in_live" });

  for (const t of [...liveTools].filter((x) => specTools.has(x)).sort()) {
    compareSchemas(t, liveSchemas[t], specSchemas[t], issues);
  }

  const summary = {
    startedAt: new Date().toISOString(),
    target: url,
    spec: opts.spec,
    liveToolCount: liveTools.size,
    specSectionCount: specTools.size,
    issueCount: issues.length,
    issues,
  };

  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify(summary, null, 2), "utf8");
    console.log(`spec-autosync: report -> ${opts.json}`);
  }

  console.log(`spec-autosync: live tools=${liveTools.size}, spec sections=${specTools.size}, issues=${issues.length}`);
  if (issues.length) {
    console.log("Расхождения:");
    for (const it of issues) {
      console.log(`- [${it.kind}] ${it.tool}${it.param ? "." + it.param : ""}${it.detail ? " :: " + it.detail : ""}`);
    }
    process.exitCode = 1;
  } else {
    console.log("OK: спека и tools/list согласованы.");
  }
}

main().catch((err) => {
  console.error(`spec-autosync FATAL: ${err.message}`);
  process.exitCode = 2;
});
