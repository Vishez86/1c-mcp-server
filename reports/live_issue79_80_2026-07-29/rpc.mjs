// Минимальный JSON-RPC клиент к MCP-серверу 1С.
// Использование: import { call, payload, rpcCall } from './rpc.mjs'
const BASE = process.env.MCP_URL || 'https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc';
const BASIC = process.env.MCP_BASIC || '';

let inited = false;
let id = 0;

async function rpc(url, method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'mcp-protocol-version': '2025-06-18',
  };
  if (BASIC) headers.authorization = `Basic ${Buffer.from(BASIC).toString('base64')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, не JSON: ${text.slice(0, 500)}`);
  }
  return json;
}

async function ensureInit(url) {
  if (inited) return;
  await rpc(url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'issue79-80-probe', version: '1.0.0' },
  });
  inited = true;
}

export async function rpcCall(method, params, url = BASE) {
  await ensureInit(url);
  return rpc(url, method, params);
}

export async function call(name, args, url = BASE) {
  await ensureInit(url);
  return rpc(url, 'tools/call', { name, arguments: args });
}

// Достаёт полезную нагрузку: structuredContent либо распарсенный текст.
export function payload(out) {
  const r = out?.result;
  if (!r) return out;
  if (r.structuredContent) return r.structuredContent;
  const t = r.content?.find((c) => c.type === 'text')?.text;
  if (t) {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  return r;
}

export const endpoint = BASE;
