#!/usr/bin/env node
// Профиль размера ответа паспорта по секциям — инструмент приёмки ПР-9 и ПР-13.
//
// Зачем: потолок сокращённого паспорта задан в СИМВОЛАХ (10 000), а конверт ответа
// измеряется в байтах; на кириллице это разница вдвое. Считать руками нельзя —
// пункт приёмки перестаёт быть проверяемым. Скрипт печатает и символы, и байты по
// каждому верхнеуровневому ключу, отдельно выделяет privacy, privacy.config_warnings
// и privacy.guidance (предмет R-5 и R-6).
//
// Гейт: код возврата 1, если сокращённый паспорт превысил потолок символов
// (--limit-chars, по умолчанию 10000) либо вызов не вернул ok:true.
//
// Использование:
//   node scripts/passport_size_profile.mjs [--url URL] [--tool ИМЯ] [--args JSON]
//                                          [--limit-chars N] [--json ПУТЬ] [--no-gate]
// Переменные окружения: MCP_URL, MCP_BASIC.
//
// ЛОВУШКА, на которой уже наступали: тело ответа собирать только после
// res.setEncoding("utf8"). Без него многобайтовая кириллица бьётся на границах
// чанков, и сличение длин выдаёт ложные расхождения.

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { writeFileSync } from "node:fs";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";

function parseArgs(argv) {
  const options = {
    url: process.env.MCP_URL || DEFAULT_URL,
    basic: process.env.MCP_BASIC || "",
    tool: "get_database_passport",
    args: {},
    limitChars: 10000,
    json: "",
    gate: true,
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 240000),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") options.url = argv[++i];
    else if (arg === "--tool") options.tool = argv[++i];
    else if (arg === "--args") options.args = JSON.parse(argv[++i]);
    else if (arg === "--limit-chars") options.limitChars = Number(argv[++i]);
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--basic") options.basic = argv[++i];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--no-gate") options.gate = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/passport_size_profile.mjs [--url URL] [--tool ИМЯ] [--args JSON] [--limit-chars N] [--json ПУТЬ] [--no-gate]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function call(options) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: options.tool, arguments: options.args },
  });
  const u = new URL(options.url);
  const headers = {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-11-25",
    "Content-Length": Buffer.byteLength(body),
  };
  if (options.basic) {
    headers.Authorization = "Basic " + Buffer.from(options.basic).toString("base64");
  }
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: "POST",
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        res.setEncoding("utf8"); // без этого кириллица бьётся на границах чанков
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
          let data = null;
          try {
            const envelope = JSON.parse(raw);
            const text = envelope?.result?.content?.[0]?.text;
            data = text ? JSON.parse(text) : envelope?.result ?? envelope;
          } catch (error) {
            return reject(new Error(`Ответ не разобран: ${error}; начало: ${raw.slice(0, 200)}`));
          }
          resolve({ ms, http: res.statusCode, wireChars: raw.length, data });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`timeout ${options.timeoutMs} ms`)));
    req.write(body);
    req.end();
  });
}

const chars = (value) => (value === undefined ? 0 : JSON.stringify(value).length);
const bytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)));

function профиль(данные) {
  const секции = [];
  for (const ключ of Object.keys(данные)) {
    секции.push({ ключ, симв: chars(данные[ключ]), байт: bytes(данные[ключ]) });
  }
  секции.sort((a, b) => b.симв - a.симв);
  const privacy = данные.privacy || {};
  return {
    всего: { симв: chars(данные), байт: bytes(данные) },
    секции,
    конверт: {
      privacy: { симв: chars(данные.privacy), байт: bytes(данные.privacy) },
      "privacy.config_warnings": { симв: chars(privacy.config_warnings), байт: bytes(privacy.config_warnings) },
      "privacy.guidance": { симв: chars(privacy.guidance), байт: bytes(privacy.guidance) },
      auth_context: { симв: chars(данные.auth_context), байт: bytes(данные.auth_context) },
      correlation_id: { симв: chars(данные.correlation_id), байт: bytes(данные.correlation_id) },
    },
  };
}

const options = parseArgs(process.argv);
const ответ = await call(options);
const данные = ответ.data || {};
const п = профиль(данные);

console.log(`инструмент: ${options.tool}`);
console.log(`url: ${options.url}`);
console.log(`аргументы: ${JSON.stringify(options.args)}`);
console.log(`http ${ответ.http}, ok=${данные.ok}, ${ответ.ms} мс, провод ${ответ.wireChars} симв.`);
console.log(`ПОЛЕЗНАЯ НАГРУЗКА: ${п.всего.симв} симв. / ${п.всего.байт} Б`);
console.log(`потолок: ${options.limitChars} симв. -> ${п.всего.симв <= options.limitChars ? "УКЛАДЫВАЕТСЯ" : "ПРЕВЫШЕН"}`);
console.log("\nпо секциям (символы / байты):");
for (const s of п.секции) console.log(`  ${s.ключ.padEnd(32)} ${String(s.симв).padStart(7)} / ${String(s.байт).padStart(7)}`);
console.log("\nконверт (предмет R-5 и R-6):");
for (const [ключ, v] of Object.entries(п.конверт)) console.log(`  ${ключ.padEnd(32)} ${String(v.симв).padStart(7)} / ${String(v.байт).padStart(7)}`);
console.log(`  доля privacy в ответе: ${п.всего.симв ? Math.round((п.конверт.privacy.симв / п.всего.симв) * 100) : 0} %`);

if (options.json) {
  writeFileSync(options.json, JSON.stringify({
    инструмент: options.tool, url: options.url, аргументы: options.args,
    http: ответ.http, ok: данные.ok, мс: ответ.ms, потолок_симв: options.limitChars, профиль: п,
  }, null, 2), "utf8");
  console.log(`\nсохранено: ${options.json}`);
}

if (options.gate) {
  if (данные.ok !== true) {
    console.error(`\nГЕЙТ: вызов не вернул ok:true (code=${данные?.error?.code ?? данные?.code ?? "—"})`);
    process.exit(1);
  }
  if (п.всего.симв > options.limitChars) {
    console.error(`\nГЕЙТ: ${п.всего.симв} симв. > потолка ${options.limitChars}`);
    process.exit(1);
  }
}
