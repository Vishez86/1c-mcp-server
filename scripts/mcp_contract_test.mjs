#!/usr/bin/env node

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const CONTRACT_PERIOD = makeContractPeriod();
const EXPECTED_TOOLS = [
  "list_metadata_objects",
  "get_metadata_structure",
  "search_metadata_fields",
  "count_event_subscriptions_by_event",
  "list_event_subscriptions",
  "run_1c_query",
  "validate_1c_query",
  "get_1c_query_guidance",
  "list_1c_language_doc_topics",
  "search_1c_language_docs",
  "read_1c_language_doc_section",
  "get_1c_language_doc_provenance",
  "list_registers",
  "get_accounting_accounts_map",
  "get_accounting_balances",
  "get_accounting_balances_by_subconto_age",
  "compare_accounting_balances_by_subconto",
  "get_accounting_entries",
  "get_inventory_balances_by_item",
  "get_calculation_types_map",
  "get_database_passport",
  "get_object_by_ref",
  "find_object_by_id",
  "search_objects",
  "get_link_of_object",
  "find_references_to_object",
  "get_enum_values",
  "get_register_records",
  "get_document_movements",
  "list_reports",
  "get_report_info",
  "run_1c_report",
  "get_object_history",
  "get_current_user_context",
];

function parseArgs(argv) {
  const options = {
    url: process.env.MCP_URL || DEFAULT_URL,
    basic: process.env.MCP_BASIC || "",
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 60000),
    out: process.env.MCP_CONTRACT_OUT || "",
    responseMode: process.env.MCP_RESPONSE_MODE || "",
    modes: [],
    failFast: false,
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
    else if (arg === "--out") options.out = argv[++i];
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg === "--response-mode") options.responseMode = argv[++i];
    else if (arg.startsWith("--response-mode=")) options.responseMode = arg.slice("--response-mode=".length);
    else if (arg === "--modes") options.modes = parseModes(argv[++i]);
    else if (arg.startsWith("--modes=")) options.modes = parseModes(arg.slice("--modes=".length));
    else if (arg === "--all-response-modes") options.modes = ["text_only", "structured_only", "both"];
    else if (arg === "--fail-fast") options.failFast = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.url) throw new Error("MCP URL is required. Use --url or MCP_URL.");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  if (options.responseMode) options.responseMode = normalizeMode(options.responseMode);
  if (options.modes.length === 0 && process.env.MCP_RESPONSE_MODES) {
    options.modes = parseModes(process.env.MCP_RESPONSE_MODES);
  }
  options.modes = options.modes.map(normalizeMode);
  return options;
}

function parseModes(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!["text_only", "structured_only", "both"].includes(normalized)) {
    throw new Error(`Unsupported response mode: ${mode}`);
  }
  return normalized;
}

function printHelp() {
  console.log(`Usage:
  node scripts/mcp_contract_test.mjs [--url URL] [--basic user:pass] [--out report.json] [--response-mode MODE] [--all-response-modes] [--verbose]

Environment:
  MCP_URL          JSON-RPC endpoint. Defaults to ${DEFAULT_URL}
  MCP_BASIC        Optional Basic auth value in user:pass form.
  MCP_TIMEOUT_MS   Per-request timeout, default 60000.
  MCP_CONTRACT_OUT Optional JSON report path.
  MCP_RESPONSE_MODE Optional tool result mode: text_only, structured_only, both.
  MCP_RESPONSE_MODES Optional comma-separated modes for repeated runs.
`);
}

class McpHttpClient {
  constructor(options) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.verbose = options.verbose;
    this.responseMode = options.responseMode || "";
    this.nextId = 1;
    this.headers = {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    if (options.basic) {
      this.headers.authorization = `Basic ${Buffer.from(options.basic, "utf8").toString("base64")}`;
    }
  }

  async rpc(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    if (this.responseMode && (method === "tools/list" || method === "tools/call")) {
      params = { ...params, _response_mode: this.responseMode };
    }
    const body = { jsonrpc: "2.0", id, method, params };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const elapsedMs = Date.now() - started;
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (error) {
          throw new Error(`HTTP ${response.status}, non-JSON response: ${text.slice(0, 500)}`);
        }
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (this.verbose) {
        console.log(`[rpc] ${method} #${id} ${elapsedMs}ms`);
      }
      if (json?.error) {
        const error = new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
        error.rpcError = json.error;
        error.elapsedMs = elapsedMs;
        throw error;
      }
      return { result: json?.result, elapsedMs, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(name, args = {}) {
    const { result, elapsedMs } = await this.rpc("tools/call", { name, arguments: args });
    return { result, elapsedMs };
  }
}

class ContractRunner {
  constructor(client, options) {
    this.client = client;
    this.options = options;
    this.tests = [];
    this.context = {};
    this.startedAt = null;
  }

  async test(name, fn, meta = {}) {
    const started = Date.now();
    try {
      const details = await fn();
      const row = {
        name,
        status: "PASS",
        elapsedMs: Date.now() - started,
        details: details || {},
        ...meta,
      };
      this.tests.push(row);
      printRow(row);
      return row;
    } catch (error) {
      const row = {
        name,
        status: "FAIL",
        elapsedMs: Date.now() - started,
        error: formatError(error),
        ...meta,
      };
      this.tests.push(row);
      printRow(row);
      if (this.options.failFast) throw error;
      return row;
    }
  }

  async run() {
    this.startedAt = new Date().toISOString();
    console.log(`MCP contract test target: ${this.client.url}`);
    if (this.options.responseMode) console.log(`Response mode: ${this.options.responseMode}`);
    console.log(`Started: ${this.startedAt}`);

    await this.protocolTests();
    await this.fixtureDiscovery();
    await this.discoveryTests();
    await this.queryAndSchemaTests();
    await this.referenceTests();
    await this.registerTests();
    await this.documentTests();
    await this.reportTests();
    await this.negativeTests();
    await this.crossChecks();

    return this.summary();
  }

  async fixtureDiscovery() {
    await this.test("fixtures.discover_generic_metadata", async () => {
      this.context.genericCatalog = await findFirstMetadataObject(this.client, ["Справочник"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: false,
        });
        return structure.ok === true && structure.metadata?.supports_ref === true;
      });
      this.context.genericDocument = await findFirstMetadataObject(this.client, ["Документ"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: false,
        });
        return structure.ok === true && structure.metadata?.supports_ref === true;
      });
      this.context.catalogWithTabular = await findFirstMetadataObject(this.client, ["Справочник", "Документ"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: true,
        });
        const sections = structure.metadata?.tabular_sections || [];
        if (structure.ok === true && sections.length > 0) {
          item.structure = structure.metadata;
          item.tabularSection = sections[0];
          return true;
        }
        return false;
      });
      this.context.infoRegister = await findFirstMetadataObject(this.client, ["РегистрСведений"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: false,
        });
        const schema = structure.metadata?.register_schema;
        if (structure.ok === true && schema && ((schema.dimensions || []).length > 0 || (schema.resources || []).length > 0)) {
          item.structure = structure.metadata;
          return true;
        }
        return false;
      });
      this.context.enumType = await findFirstMetadataObject(this.client, ["Перечисление"], async () => true);
      assert(this.context.genericCatalog || this.context.infoRegister, "no generic metadata fixture found");
      return {
        catalog: this.context.genericCatalog?.full_name,
        document: this.context.genericDocument?.full_name,
        catalogWithTabular: this.context.catalogWithTabular?.full_name,
        infoRegister: this.context.infoRegister?.full_name,
        enumType: this.context.enumType?.full_name,
      };
    });
  }

  async protocolTests() {
    await this.test("protocol.initialize", async () => {
      const { result } = await this.client.rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-contract-test", version: "1.0.0" },
      });
      assert(result?.serverInfo?.name, "initialize must return serverInfo.name");
      return { server: result.serverInfo };
    });

    await this.test("protocol.tools_list_has_expected_tools", async () => {
      const { result } = await this.client.rpc("tools/list", {});
      const tools = result?.tools || [];
      const names = tools.map((tool) => tool.name).sort();
      const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !EXPECTED_TOOLS.includes(name));
      assert(missing.length === 0, `missing tools: ${missing.join(", ")}`);
      assert(names.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length}, got ${names.length}; extra=${extra.join(", ")}`);
      assert((result?.server_hints || []).some((hint) => String(hint).includes("access_denied")), "tools/list must warn about per-user access_denied retry policy");
      assertToolsListMode(tools, this.options.responseMode);
      this.context.toolNames = names;
      return { count: names.length };
    });

    await this.test("protocol.resources_list_and_read", async () => {
      const list = await this.client.rpc("resources/list", {});
      const resources = list.result?.resources || [];
      assert(resources.some((item) => item.uri === "1c://metadata"), "metadata resource is missing");
      assert(resources.some((item) => item.uri === "1c://context/current-user"), "current-user resource is missing");
      assert(resources.some((item) => item.uri === "1c://knowledge/query"), "query knowledge resource is missing");
      assert(resources.some((item) => item.uri === "1c://knowledge/query/subkonto"), "subkonto knowledge resource is missing");
      assert(resources.some((item) => item.uri === "1c-docs://8.3.37/query-language/index"), "1C language docs index resource is missing");
      assert(resources.some((item) => item.uri === "1c-docs://8.3.37/query-language/provenance"), "1C language docs provenance resource is missing");
      const read = await this.client.rpc("resources/read", { uri: "1c://context/current-user" });
      const text = read.result?.contents?.[0]?.text || "";
      assert(text.includes("user"), "current-user resource must contain user data");
      const knowledge = await this.client.rpc("resources/read", { uri: "1c://knowledge/query/temporary-tables" });
      const knowledgeText = knowledge.result?.contents?.[0]?.text || "";
      assert(knowledgeText.includes("ПОМЕСТИТЬ"), "temporary-table knowledge must mention ПОМЕСТИТЬ");
      assert(knowledgeText.includes("read-only"), "temporary-table knowledge must explain read-only boundary");
      const docsIndex = await this.client.rpc("resources/read", { uri: "1c-docs://8.3.37/query-language/index" });
      const docsText = docsIndex.result?.contents?.[0]?.text || "";
      assert(docsText.includes("Документация по языку запросов 1С 8.3.37"), "docs index must mention 8.3.37");
      assert(docsText.includes("query-syntax"), "docs index must list query-syntax");
      return { resources: resources.map((item) => item.uri) };
    });
  }

  async discoveryTests() {
    await this.test("tool.get_current_user_context", async () => {
      const result = await okTool(this.client, "get_current_user_context", {
        include_roles: true,
        include_limits: true,
        include_allowed_metadata_summary: true,
        include_server_info: true,
      });
      assert(result.allowed_metadata_summary?.objects_count > 100, "objects_count is suspiciously low");
      assert(Array.isArray(result.mcp_server?.tools), "mcp_server.tools must be present");
      return {
        user: result.user?.name,
        objects: result.allowed_metadata_summary.objects_count,
        tools: result.mcp_server.tools.length,
      };
    });

    await this.test("tool.list_metadata_objects_pagination", async () => {
      const first = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник"],
        limit: 1,
        include_details: true,
      });
      assert(first.objects?.length === 1, "first page must contain one object");
      assert(first.next_cursor, "first page must expose next_cursor");
      const second = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник"],
        limit: 1,
        cursor: first.next_cursor,
        include_details: true,
      });
      assert(second.objects?.length === 1, "second page must contain one object");
      assert(first.objects[0].full_name !== second.objects[0].full_name, "cursor did not advance");
      return { first: first.objects[0].full_name, second: second.objects[0].full_name };
    });

    await this.test("tool.search_metadata_fields_pagination", async () => {
      const result = await okTool(this.client, "search_metadata_fields", {
        query: "Дата",
        kinds: ["Документ"],
        limit: 2,
      });
      assert(Array.isArray(result.fields), "fields must be an array");
      assert("truncated" in result, "truncated flag must be present");
      if (result.truncated) assert(result.next_cursor, "truncated field search must expose next_cursor");
      return { fields: result.fields.map((item) => `${item.owner_type}.${item.path}`), truncated: result.truncated };
    });

    await this.test("tool.count_event_subscriptions_by_event", async () => {
      const result = await okTool(this.client, "count_event_subscriptions_by_event", {});
      assert(Array.isArray(result.events), "events must be an array");
      assert(typeof result.event_count === "number", "event_count must be numeric");
      assert(typeof result.subscription_count === "number", "subscription_count must be numeric");
      for (let index = 0; index < result.events.length; index += 1) {
        const row = result.events[index];
        assert(typeof row.event === "string" && row.event.length > 0, "event must be a non-empty string");
        assert(typeof row.count === "number" && row.count > 0, `count must be positive for ${row.event}`);
        if (index > 0) {
          const prev = result.events[index - 1];
          assert(prev.count >= row.count, "events must be sorted by count desc");
        }
      }
      const extended = await okTool(this.client, "count_event_subscriptions_by_event", {
        include_top_handlers: true,
        top_handlers_limit: 2,
      });
      assert(Array.isArray(extended.events), "extended events must be an array");
      for (const row of extended.events) {
        assert(Array.isArray(row.top_handlers), `top_handlers must be present for ${row.event}`);
        assert(row.top_handlers.length <= 2, `top_handlers_limit was not applied for ${row.event}`);
        for (const handler of row.top_handlers) {
          assert(typeof handler.module === "string" && handler.module.length > 0, "handler module must be a non-empty string");
          assert(typeof handler.count === "number" && handler.count > 0, "handler count must be positive");
        }
      }
      this.context.eventSubscriptionEvent = result.events[0]?.event || "";
      this.context.eventSubscriptionHandlerModule = extended.events[0]?.top_handlers?.[0]?.module || "";
      return { events: result.event_count, subscriptions: result.subscription_count };
    });

    await this.test("tool.list_event_subscriptions_filters", async () => {
      const event = this.context.eventSubscriptionEvent || "";
      const listArgs = event ? { event, limit: 5 } : { limit: 5 };
      const result = await okTool(this.client, "list_event_subscriptions", listArgs);
      assert(Array.isArray(result.subscriptions), "subscriptions must be an array");
      assert("truncated" in result, "truncated flag must be present");
      if (event) {
        for (const row of result.subscriptions) {
          assert(row.event === event, `subscription event must match filter: ${row.event} !== ${event}`);
        }
      }
      const handlerContains = this.context.eventSubscriptionHandlerModule || "";
      if (event && handlerContains) {
        const filtered = await okTool(this.client, "list_event_subscriptions", {
          event,
          handler_contains: handlerContains.toLowerCase(),
          limit: 5,
        });
        for (const row of filtered.subscriptions) {
          assert(row.event === event, "combined filter must preserve event");
          assert(String(row.handler || "").toLowerCase().includes(handlerContains.toLowerCase()),
            `handler_contains did not match ${row.handler}`);
        }
        return { event, handler_contains: handlerContains, filtered: filtered.subscriptions.length };
      }
      return { event, listed: result.subscriptions.length };
    });

    await this.test("tool.list_registers_pagination", async () => {
      const result = await okTool(this.client, "list_registers", {
        register_types: ["РегистрБухгалтерии", "РегистрНакопления", "РегистрСведений"],
        limit: 2,
      });
      assert(Array.isArray(result.registers), "registers must be an array");
      assert(result.registers.length > 0, "expected at least one register");
      assert("truncated" in result, "truncated flag must be present");
      if (result.truncated) assert(result.next_cursor, "truncated register list must expose next_cursor");
      return { registers: result.registers.map((item) => item.full_name), truncated: result.truncated };
    });

    await this.test("tool.list_metadata_objects_does_not_mask_technical_metadata", async () => {
      const result = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник", "РегистрБухгалтерии", "ПланСчетов", "ПланВидовРасчета"],
        limit: 50,
        include_details: true,
      });
      assert(result.objects?.length > 0, "expected metadata objects");
      for (const item of result.objects || []) {
        assert(!String(item.full_name || "").includes("скрыто"), `full_name must not be privacy-masked: ${item.full_name}`);
        assert(!String(item.kind || "").includes("скрыто"), `kind must not be privacy-masked: ${item.kind}`);
        assert(!String(item.resource_uri || "").includes("скрыто"), `resource_uri must not be privacy-masked: ${item.resource_uri}`);
        assert(typeof item.full_name === "string" && item.full_name.includes("."), `full_name must remain a metadata identifier: ${item.full_name}`);
      }
      return { checked: result.objects.length };
    });

    await this.test("tool.list_metadata_objects_does_not_invent_missing_register", async () => {
      const result = await okTool(this.client, "list_metadata_objects", {
        query: "MCP_НесуществующийРегистр",
        limit: 50,
        include_details: true,
        include_not_allowed: true,
      });
      const names = (result.objects || []).map((item) => item.full_name);
      assert(!names.includes("РегистрСведений.MCP_НесуществующийРегистр"), "non-existent register appeared in metadata");
      return { found: names.length };
    });

    await this.test("tool.discovery_returns_guidance_is_contextual", async () => {
      const sales = await okTool(this.client, "list_reports", {
        query: "продажи прибыль рентабельность по товарным позициям",
        include_variants: false,
        include_guidance: true,
        limit: 1,
      });
      assert(hasGuidance(sales, "returns_and_storno"), "sales/report discovery must include returns-and-storno guidance");
      assert(hasGuidance(sales, "report_or_direct_query_choice"), "sales/report discovery must include report-or-query guidance");

      const materials = await okTool(this.client, "list_reports", {
        query: "остатки и поступление сырья материалов тмц возвраты поставщику",
        include_variants: false,
        include_guidance: true,
        limit: 1,
      });
      assert(hasGuidance(materials, "returns_and_storno"), "materials/inventory discovery must include returns-and-storno guidance");

      const hr = await okTool(this.client, "list_reports", {
        query: "увольнение сотрудников кадровые документы",
        include_variants: false,
        include_guidance: true,
        limit: 1,
      });
      assert(!hasGuidance(hr, "returns_and_storno"), "HR discovery must not include returns-and-storno guidance");
      return {
        salesGuidance: sales.domain_guidance,
        materialsGuidance: materials.domain_guidance,
        hrGuidanceCount: hr.domain_guidance?.length || 0,
      };
    });
  }

  async queryAndSchemaTests() {
    await this.test("tool.get_metadata_structure_generic_reference_object", async () => {
      const fixture = this.context.catalogWithTabular || this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no reference metadata object" };
      const result = await okTool(this.client, "get_metadata_structure", {
        type: fixture.full_name,
        include_standard_attributes: true,
        include_tabular_sections: true,
      });
      const meta = result.metadata;
      assert(meta.supports_ref === true, "fixture must support references");
      const ts = meta.tabular_sections || [];
      if (fixture.tabularSection) {
        assert(ts.some((item) => item.name === fixture.tabularSection.name), "fixture tabular section is missing");
      }
      return { attributes: meta.attributes?.length, tabularSections: ts.map((item) => item.name).slice(0, 8) };
    });

    await this.test("tool.get_metadata_structure_information_register_schema", async () => {
      const fixture = this.context.infoRegister;
      if (!fixture) return { skipped: true, reason: "no information register fixture" };
      const result = await okTool(this.client, "get_metadata_structure", {
        type: fixture.full_name,
        include_standard_attributes: false,
        include_tabular_sections: false,
      });
      const schema = result.metadata?.register_schema;
      assert(result.metadata?.kind === "РегистрСведений", "register kind must be РегистрСведений");
      assert(schema, "register_schema must be present");
      return { periodicity: schema.periodicity, dimensions: schema.dimensions.length, resources: schema.resources.length };
    });

    await this.test("tool.get_metadata_structure_accounting_register_virtual_tables", async () => {
      const accountingRegister = await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      this.context.accountingRegister = accountingRegister;
      const result = await okTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_standard_attributes: true,
        include_tabular_sections: false,
        include_virtual_tables: true,
      });
      const schema = result.metadata?.register_schema;
      assert(result.metadata?.kind === "РегистрБухгалтерии", "register kind must be РегистрБухгалтерии");
      assert(schema, "register_schema must be present");
      const virtualTables = schema.virtual_tables || [];
      assert(virtualTables.some((item) => item.name === "Остатки"), "accounting register Остатки virtual table is missing");
      assert(virtualTables.some((item) => item.name === "Обороты"), "accounting register Обороты virtual table is missing");
      assert(virtualTables.some((item) => item.name === "ОборотыДтКт"), "accounting register ОборотыДтКт virtual table is missing");
      assert(virtualTables.some((item) => item.name === "ОстаткиИОбороты"), "accounting register ОстаткиИОбороты virtual table is missing");
      const balance = virtualTables.find((item) => item.name === "Остатки");
      assert((balance.common_fields || []).includes("Субконто1"), "Остатки must advertise Субконто1");
      assert((balance.common_fields || []).includes("КоличествоОстаток"), "Остатки must advertise КоличествоОстаток");
      assert((balance.common_fields || []).includes("СуммаОстаток"), "Остатки must advertise СуммаОстаток");
      assert(!(balance.common_fields || []).includes("ВидСубконто1"), "Остатки must not advertise non-universal ВидСубконто1 field");
      assert((balance.description || "").includes("УникальныйИдентификатор"), "Остатки description must mention UUID joins for Субконто");
      assert((balance.description || "").includes("ВидыСубконто"), "Остатки description must mention account chart ВидыСубконто lookup");
      const debitCredit = virtualTables.find((item) => item.name === "ОборотыДтКт");
      assert((debitCredit.common_fields || []).includes("СубконтоДт1"), "ОборотыДтКт must advertise СубконтоДт1");
      assert((debitCredit.common_fields || []).includes("СубконтоКт1"), "ОборотыДтКт must advertise СубконтоКт1");
      assert(!(debitCredit.common_fields || []).includes("ВидСубконтоДт1"), "ОборотыДтКт must not advertise non-universal ВидСубконтоДт1 field");
      return { register: accountingRegister.fullName, virtualTables };
    });

    await this.test("tool.get_metadata_structure_accumulation_resources_by_mode", async () => {
      const accumulationRegister = await findAccumulationRegister(this.client);
      if (!accumulationRegister) return { skipped: true, reason: "no accumulation register" };
      this.context.accumulationRegister = accumulationRegister;
      const result = await okTool(this.client, "get_metadata_structure", {
        type: accumulationRegister.fullName,
        include_standard_attributes: true,
        include_tabular_sections: false,
        include_virtual_tables: true,
      });
      const schema = result.metadata?.register_schema;
      assert(schema, "register_schema must be present");
      assert(schema.resources_by_mode && typeof schema.resources_by_mode === "object", "resources_by_mode must be present");
      assert(Array.isArray(schema.resources_by_mode.records), "resources_by_mode.records must be an array");
      assert(Array.isArray(schema.resources_by_mode.turnovers), "resources_by_mode.turnovers must be an array");
      return { register: accumulationRegister.fullName, resourcesByMode: schema.resources_by_mode };
    });

    await this.test("tool.validate_1c_query_existing_tabular_section", async () => {
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${fixture.full_name}.${fixture.tabularSection.name}`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `expected valid=true, errors=${JSON.stringify(result.errors)}`);
      assert((result.detected_objects || []).includes(fixture.full_name), "detected_objects should include parent object");
      return { detected: result.detected_objects };
    });

    await this.test("tool.validate_1c_query_guidance_is_opt_in", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК Продажи ИЗ ${fixture.full_name}`;
      const compact = await okTool(this.client, "validate_1c_query", {
        query,
        strict: true,
      });
      assert(!Array.isArray(compact.query_guidance), "validate_1c_query must omit query_guidance by default");
      assert(!Array.isArray(compact.domain_guidance), "validate_1c_query must omit domain_guidance by default");

      const explained = await okTool(this.client, "validate_1c_query", {
        query,
        strict: true,
        include_guidance: true,
      });
      assert(hasGuidance(explained, "returns_and_storno"), "validate_1c_query must include domain_guidance when requested");
      return { compactGuidance: compact.domain_guidance, explainedGuidance: explained.domain_guidance?.length || 0 };
    });

    await this.test("tool.validate_1c_query_warns_document_tabular_register_fanout", async () => {
      const documentWithTabular = await findFirstMetadataObject(this.client, ["Документ"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: true,
        });
        const sections = structure.metadata?.tabular_sections || [];
        if (structure.ok === true && sections.length > 0) {
          item.structure = structure.metadata;
          item.tabularSection = sections[0];
          return true;
        }
        return false;
      });
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!documentWithTabular?.tabularSection?.name || !accountingRegister) {
        return { skipped: true, reason: "no document tabular section or accounting register fixture" };
      }

      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 ТЧ.Ссылка КАК Документ, СУММА(ТЧ.Сумма) КАК Сумма ИЗ ${documentWithTabular.full_name}.${documentWithTabular.tabularSection.name} КАК ТЧ ВНУТРЕННЕЕ СОЕДИНЕНИЕ ${accountingRegister.fullName} КАК Рег ПО Рег.Регистратор = ТЧ.Ссылка СГРУППИРОВАТЬ ПО ТЧ.Ссылка`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `fanout-risk query should remain valid, errors=${JSON.stringify(result.errors)}`);
      assert((result.warnings || []).some((warning) => warning.includes("Риск умножения строк")), `fanout warning is missing: ${JSON.stringify(result.warnings)}`);
      assert(hasGuidance(result, "document_tabular_register_join_fanout"), "fanout guidance is missing");
      return {
        document: documentWithTabular.full_name,
        tabularSection: documentWithTabular.tabularSection.name,
        register: accountingRegister.fullName,
        warnings: result.warnings,
        guidance: result.domain_guidance,
      };
    });

    await this.test("tool.validate_1c_query_warns_accounting_subconto_fanout", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 Рег.Регистратор КАК Регистратор, Субконто.Значение КАК Субконто ИЗ ${accountingRegister.fullName} КАК Рег ЛЕВОЕ СОЕДИНЕНИЕ ${accountingRegister.fullName}.Субконто КАК Субконто ПО Рег.Период = Субконто.Период И Рег.Регистратор = Субконто.Регистратор И Рег.НомерСтроки = Субконто.НомерСтроки`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `subconto join warning query must remain valid, errors=${JSON.stringify(result.errors)}`);
      assert((result.warnings || []).some((warning) => warning.includes("без отбора по Вид")), `subconto kind fanout warning is missing: ${JSON.stringify(result.warnings)}`);
      assert((result.warnings || []).some((warning) => warning.includes("ВидДвижения")), `subconto movement warning is missing: ${JSON.stringify(result.warnings)}`);
      return { register: accountingRegister.fullName, warnings: result.warnings };
    });

    await this.test("tool.validate_1c_query_returns_guidance_is_contextual", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const sales = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК Продажи ИЗ ${fixture.full_name}`,
        strict: true,
        explain: true,
      });
      assert(hasGuidance(sales, "returns_and_storno"), "sales-like query validation must include returns-and-storno guidance");
      assert(hasGuidance(sales, "report_or_direct_query_choice"), "sales-like query validation must include report-or-query guidance");

      const assets = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК ОсновныеСредства ИЗ ${fixture.full_name}`,
        strict: true,
        explain: true,
      });
      assert(hasGuidance(assets, "returns_and_storno"), "fixed-assets query validation must include returns-and-storno guidance");

      const hr = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК КадровыйОбъект ИЗ ${fixture.full_name}`,
        strict: true,
        explain: true,
      });
      assert(!hasGuidance(hr, "returns_and_storno"), "HR-like query validation must not include returns-and-storno guidance");
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      let subconto = null;
      if (accountingRegister) {
        subconto = await okTool(this.client, "validate_1c_query", {
          query: `ВЫБРАТЬ ПЕРВЫЕ 1 Обороты.СубконтоДт1 ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Обороты`,
          parameters: {
            Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
            Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
          },
          strict: true,
          explain: true,
        });
        assert(hasGuidance(subconto, "subconto_join_by_uuid"), "subconto query validation must include UUID join guidance");
        const instruction = (subconto.domain_guidance || []).find((item) => item.id === "subconto_join_by_uuid")?.instruction || "";
        assert(instruction.includes("ВидыСубконто"), "subconto guidance must mention account chart ВидыСубконто lookup");
      }
      return {
        salesValid: sales.valid,
        assetsValid: assets.valid,
        hrValid: hr.valid,
        salesGuidance: sales.domain_guidance,
        assetsGuidance: assets.domain_guidance,
        subcontoGuidance: subconto?.domain_guidance,
      };
    });

    await this.test("tool.validate_1c_query_rejects_main_register_subconto_dtkt", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Хозрасчетный.СубконтоДт1 КАК Субконто ИЗ ${accountingRegister.fullName} КАК Хозрасчетный`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "main accounting register СубконтоДт1 must be invalid");
      assert((result.errors || []).some((error) => error.code === "subconto_wrong_table"), `subconto_wrong_table error is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    await this.test("tool.validate_1c_query_having_keyword", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 Объект.Ссылка КАК Ссылка, КОЛИЧЕСТВО(Объект.Ссылка) КАК Количество ИЗ ${fixture.full_name} КАК Объект СГРУППИРОВАТЬ ПО Объект.Ссылка ИМЕЮЩИЕ КОЛИЧЕСТВО(Объект.Ссылка) > 0`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `ИМЕЮЩИЕ must be valid, errors=${JSON.stringify(result.errors)}`);
      assert(hasQueryGuidance(result, "grouping_having"), "validation must include grouping guidance");
      return { detected: result.detected_objects };
    });

    await this.test("tool.get_1c_query_guidance_contextual", async () => {
      const result = await okTool(this.client, "get_1c_query_guidance", {
        query: "ВЫБРАТЬ Субконто1, СУММА(СуммаОборот) КАК Сумма ПОМЕСТИТЬ ВТ_Обороты ИЗ РегистрБухгалтерии.<Имя>.Обороты(&Нач, &Кон) СГРУППИРОВАТЬ ПО Субконто1 ИМЕЮЩИЕ СУММА(СуммаОборот) > 0",
        intent: "проверить бухгалтерскую аналитику по субконто через временные таблицы",
        include_examples: true,
        max_sections: 8,
      });
      assert(Array.isArray(result.guidance), "guidance must be an array");
      assert(result.configuration_agnostic === true, "guidance must be configuration agnostic");
      assert(hasGuidanceItem(result.guidance, "temporary_tables_read_only"), "must include temporary table guidance");
      assert(hasGuidanceItem(result.guidance, "subconto_generic"), "must include subconto guidance");
      assert(hasGuidanceItem(result.guidance, "grouping_having"), "must include grouping guidance");
      const parameters = await okTool(this.client, "get_1c_query_guidance", {
        topic: "parameters",
        include_examples: true,
        max_sections: 3,
      });
      assert(hasGuidanceItem(parameters.guidance, "query_parameters"), "parameters topic must include query_parameters guidance");
      assert(JSON.stringify(parameters.guidance).includes("uuid"), "parameters guidance must mention UUID references");
      const payroll = await okTool(this.client, "get_1c_query_guidance", {
        topic: "payroll-and-hr",
        include_examples: true,
        max_sections: 3,
      });
      assert(hasGuidanceItem(payroll.guidance, "payroll_calculation_registers"), "payroll topic must include calculation register guidance");
      const reportsVsQuery = await okTool(this.client, "get_1c_query_guidance", {
        topic: "reports-vs-query",
        include_examples: true,
        max_sections: 3,
      });
      assert(hasGuidanceItem(reportsVsQuery.guidance, "report_or_direct_query_choice"), "reports-vs-query topic must include report-or-query guidance");
      const debtors = await okTool(this.client, "get_1c_query_guidance", {
        intent: "отчет по дебиторам: долг на начало 2025, отгрузки за 2024, оплаты за 2024, долг на текущий момент",
        include_examples: true,
        max_sections: 8,
      });
      assert(hasGuidanceItem(debtors.guidance, "debtors_report_pattern"), "debtor report guidance must include deterministic pattern");
      return { guidance: result.guidance.map((item) => item.id), debtorsGuidance: debtors.guidance.map((item) => item.id) };
    });

    await this.test("tool.1c_language_docs_generated_index", async () => {
      const topics = await okTool(this.client, "list_1c_language_doc_topics", {
        version: "8.3.37",
      });
      assert(topics.version === "8.3.37", "topics must use documentation version 8.3.37");
      assert(Array.isArray(topics.topics), "topics must be an array");
      assert(topics.topics.some((item) => item.id === "query-syntax"), "query-syntax topic is missing");
      assert(topics.topics.some((item) => item.id === "version-provenance"), "version-provenance topic is missing");

      const slice = await okTool(this.client, "search_1c_language_docs", {
        query: "СрезПоследних ГДЕ Условие",
        top_k: 5,
        max_chars_per_result: 1200,
      });
      assert(slice.version === "8.3.37", "search must use documentation version 8.3.37");
      assert(Array.isArray(slice.results), "search results must be an array");
      assert(slice.results.some((item) => String(item.source_file || "").includes("info-register")), "СрезПоследних search must find info-register docs");
      assert(slice.results.every((item) => String(item.excerpt || "").length <= 1200), "search excerpts must respect max_chars_per_result");

      const abs = await okTool(this.client, "search_1c_language_docs", {
        query: "АБС функция",
        top_k: 5,
      });
      assert(abs.results.some((item) => String(item.source_file || "").includes("functions-and-expressions")), "АБС search must find functions docs");

      const section = slice.results[0];
      const read = await okTool(this.client, "read_1c_language_doc_section", {
        section_id: section.section_id,
        max_chars: 1000,
      });
      assert(read.section_id === section.section_id, "read section must return requested section_id");
      assert(typeof read.content === "string" && read.content.length > 0, "read section must return content");
      assert(read.content.length <= 1000, "read section must respect max_chars");

      const provenance = await okTool(this.client, "get_1c_language_doc_provenance", {
        version: "8.3.37",
      });
      assert(provenance.version === "8.3.37", "provenance must use documentation version 8.3.37");
      assert(String(provenance.source_file || "").includes("version-provenance"), "provenance must cite version-provenance source");
      assert(provenance.rules?.default_version === "8.3.37", "provenance must include default_version rule");
      return {
        topics: topics.topics.length,
        sliceResults: slice.results.map((item) => item.section_id),
        absResults: abs.results.map((item) => item.section_id),
      };
    });

    await this.test("tool.get_accounting_accounts_map", async () => {
      const charts = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланСчетов"],
        limit: 1,
      });
      const chart = charts.objects?.[0]?.full_name;
      if (!chart) return { skipped: true, reason: "no chart of accounts in metadata" };
      const result = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_empty_subconto: false,
        include_raw_rows: true,
        limit: 5,
      });
      assert(result.chart === chart, `unexpected chart: ${result.chart}`);
      assert(Array.isArray(result.columns), "columns must be present");
      assert(Array.isArray(result.rows), "rows must be present");
      assert(Array.isArray(result.accounts), "accounts must be present");
      assert("total_accounts" in result, "total_accounts must be present");
      if (result.accounts.length > 0) {
        assert(Array.isArray(result.accounts[0].subconto), "account.subconto must be an array");
      }
      assert(result.configuration_agnostic === true, "result must be configuration agnostic");
      const maxLimitResult = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_query: true,
        limit: 1000,
      });
      assert(maxLimitResult.query_used?.includes("ВЫБРАТЬ ПЕРВЫЕ 1000 "), "query must use an ungrouped numeric limit");
      assert(!/ВЫБРАТЬ\s+ПЕРВЫЕ\s+1[\s\u00a0\u202f]+000\b/u.test(maxLimitResult.query_used || ""), "query limit must not contain thousands separators");
      return { chart, rows: result.rows.length, maxLimitAccounts: maxLimitResult.accounts?.length || 0, subcontoAttributes: result.subconto_attributes };
    });

    await this.test("tool.get_accounting_entries_grouped", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        credit_account_code_prefixes: ["02"],
        group_by: ["period_month", "credit_account"],
        include_query: true,
        limit: 5,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.configuration_agnostic === true, "result must be configuration agnostic");
      assert(result.mode === "entries_grouped", "grouped entries mode is expected");
      assert(columnNames.includes("ПериодМесяц"), "period_month grouping column is missing");
      assert(columnNames.includes("СчетКт"), "credit_account grouping column is missing");
      assert(columnNames.includes("Сумма"), "amount aggregate column is missing");
      assert(result.query_used?.includes(`${accountingRegister.fullName} КАК Рег`), "query must read main accounting register records");
      assert(result.query_used?.includes("Рег.СчетКт.Код ПОДОБНО &CreditPrefix0"), "credit account prefix filter must be emitted");
      return { register: accountingRegister.fullName, rows: result.rows?.length || 0, queryUsed: result.query_used };
    });

    await this.test("tool.get_accounting_entries_subconto_join", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const charts = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланСчетов"],
        limit: 1,
      });
      const chart = charts.objects?.[0]?.full_name;
      if (!chart) return { skipped: true, reason: "no chart of accounts in metadata" };
      const accountMap = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_empty_subconto: false,
        limit: 20,
      });
      const account = (accountMap.accounts || []).find((item) => item.subconto?.[0]?.ref?.type && item.subconto?.[0]?.ref?.uuid);
      const subconto = account?.subconto?.[0]?.ref;
      if (!account?.code || !subconto) {
        return { skipped: true, reason: "no account with subconto mapping", chart };
      }
      const result = await okTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        credit_account_code_prefixes: [String(account.code)],
        subconto_side: "credit",
        subconto_kind: toQueryRef(subconto),
        group_by: ["credit_subconto"],
        include_query: true,
        limit: 5,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(columnNames.includes("СубконтоКт"), "credit subconto grouping column is missing");
      assert(result.query_used?.includes(`${accountingRegister.fullName}.Субконто КАК СубконтоКт`), "query must join accounting register subconto table");
      assert(result.query_used?.includes("СубконтоКт.Вид = &ВидСубконто"), "subconto kind filter must be emitted");
      return { register: accountingRegister.fullName, account: account.code, subconto: subconto.presentation, rows: result.rows?.length || 0 };
    });

    await this.test("tool.get_accounting_entries_preflight_rejects_mismatched_subconto_kind", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const charts = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланСчетов"],
        limit: 1,
      });
      const chart = charts.objects?.[0]?.full_name;
      if (!chart) return { skipped: true, reason: "no chart of accounts in metadata" };
      const accountMap = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_empty_subconto: false,
        limit: 1000,
      });
      const accounts = accountMap.accounts || [];
      let fixture = null;
      for (const account of accounts) {
        const accountCode = String(account.code || "");
        const familySubcontoUuids = new Set(
          accounts
            .filter((item) => String(item.code || "").startsWith(accountCode))
            .flatMap((item) => item.subconto || [])
            .map((item) => item.uuid)
            .filter(Boolean),
        );
        const foreign = accounts
          .flatMap((item) => item.subconto || [])
          .find((item) => item.uuid && item.ref?.type && !familySubcontoUuids.has(item.uuid));
        if (accountCode && account.subconto?.length && foreign) {
          fixture = { account, foreign };
          break;
        }
      }
      if (!fixture) return { skipped: true, reason: "no mismatched subconto kind fixture", chart };

      const result = await rawTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        chart,
        debit_account_code_prefixes: [String(fixture.account.code)],
        subconto_side: "debit",
        subconto_kind: {
          type: fixture.foreign.ref.type,
          uuid: fixture.foreign.uuid,
          presentation: fixture.foreign.name,
        },
        group_by: ["debit_subconto", "debit_account"],
        include_query: true,
        limit: 5,
      });
      assert(result.ok === false, "mismatched subconto kind must fail before query execution");
      assert((result.error_code || result.error?.error_code) === "subconto_kind_mismatch", `unexpected smart error_code: ${JSON.stringify(result)}`);
      const details = result.details || result.error?.details?.parsed_details || {};
      assert(Array.isArray(details.available_subconto_kinds), "available_subconto_kinds must be present");
      assert(details.available_subconto_kinds.length === (fixture.account.subconto || []).length
        || details.available_subconto_kinds.length > 0, "available_subconto_kinds must not be empty for selected account");
      assert(Array.isArray(result.suggestions || result.error?.suggestions), "suggestions must be present");
      assert(Array.isArray(result.query_guidance || result.error?.query_guidance), "query_guidance must be forced on mismatch");
      return {
        account: fixture.account.code,
        requestedSubconto: fixture.foreign.name,
        available: details.available_subconto_kinds,
        errorCode: result.error_code || result.error?.error_code,
      };
    });

    await this.test("tool.get_accounting_entries_rejects_ambiguous_subconto_grouping", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await rawTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        group_by: ["credit_subconto"],
        limit: 5,
      });
      assert(result.ok === false, "ambiguous subconto grouping must fail");
      assert(result.error?.code === "invalid_arguments", `unexpected code: ${result.error?.code}`);
      assert(String(result.error?.message || "").includes("subconto_kind"), "error must point to subconto_kind");
      return { error: result.error };
    });

    await this.test("tool.get_calculation_types_map", async () => {
      const plans = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланВидовРасчета"],
        limit: 2,
      });
      const plan = plans.objects?.[0]?.full_name;
      if (!plan) return { skipped: true, reason: "no chart of calculation types in metadata" };
      const result = await okTool(this.client, "get_calculation_types_map", {
        plan,
        limit: 5,
      });
      assert(result.plan === plan, `unexpected plan: ${result.plan}`);
      assert(Array.isArray(result.calculation_types), "calculation_types must be present");
      assert("total_calculation_types" in result, "total_calculation_types must be present");
      assert(result.configuration_agnostic === true, "result must be configuration agnostic");
      return { plan, calculationTypes: result.calculation_types.length, total: result.total_calculation_types };
    });

    await this.test("tool.get_database_passport", async () => {
      const result = await okTool(this.client, "get_database_passport", {
        include_organizations: true,
        include_period: true,
        include_closed_periods: true,
        include_accumulation_registers: true,
        include_information_registers: true,
        include_calculation_registers: true,
        organization_limit: 5,
        accounting_register_limit: 2,
        accumulation_register_limit: 5,
        information_register_limit: 5,
        calculation_register_limit: 5,
        include_empty_registers: true,
      });
      assert(result.configuration_agnostic === true, "passport must be configuration agnostic");
      assert(result.read_only === true, "passport must be read-only");
      assert(result.cache_hit === false || result.cache_hit === true, "cache_hit must be boolean");
      assert(typeof result.cache_age_seconds === "number", "cache_age_seconds must be a number");
      assert(Array.isArray(result.organizations), "organizations must be an array");
      assert(result.data_period && typeof result.data_period === "object", "data_period must be present");
      assert(Array.isArray(result.accounting_registers), "accounting_registers must be an array");
      assert(Array.isArray(result.closed_periods), "closed_periods must be an array");
      assert(result.accumulation_registers && typeof result.accumulation_registers === "object", "accumulation_registers must be an object");
      assert(result.accumulation_registers.cache_hit === false || result.accumulation_registers.cache_hit === true, "accumulation_registers.cache_hit must be boolean");
      assert(typeof result.accumulation_registers.cache_age_seconds === "number", "accumulation_registers.cache_age_seconds must be a number");
      assert(typeof result.accumulation_registers.checked === "number", "accumulation_registers.checked must be a number");
      assert(Array.isArray(result.accumulation_registers.with_data), "accumulation_registers.with_data must be an array");
      assert(Array.isArray(result.accumulation_registers.empty), "accumulation_registers.empty must be an array");
      assert(result.information_registers && typeof result.information_registers === "object", "information_registers must be an object");
      assert(result.calculation_registers && typeof result.calculation_registers === "object", "calculation_registers must be an object");
      return {
        organizations: result.organizations.length,
        accountingRegisters: result.accounting_registers.length,
        accumulationChecked: result.accumulation_registers_checked,
      };
    });

    await this.test("tool.run_1c_query_temporary_table_package", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 5 Объект.Ссылка КАК Ссылка, УникальныйИдентификатор(Объект.Ссылка) КАК UUID ПОМЕСТИТЬ ВТОбъекты ИЗ ${fixture.full_name} КАК Объект ИНДЕКСИРОВАТЬ ПО UUID; ВЫБРАТЬ ПЕРВЫЕ 1 ВТОбъекты.Ссылка КАК Ссылка, ВТОбъекты.UUID КАК UUID ИЗ ВТОбъекты КАК ВТОбъекты`,
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      if (!row) return { skipped: true, reason: "generic catalog fixture has no rows", catalog: fixture.full_name };
      assertRef(row.Ссылка, "temporary table ref");
      assert(row.Ссылка.uuid === row.UUID, "temporary table UUID must match encoded ref uuid");
      assert(result.validation?.ok === true, "run_1c_query must include successful validation.ok");
      assert(result.validation?.valid === true, "run_1c_query validation must keep valid=true for compatibility");
      assert(Array.isArray(result.validation?.warnings), "run_1c_query validation warnings must be an array");
      return { row };
    });

    await this.test("tool.run_1c_query_guidance_is_opt_in", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК Продажи ИЗ ${fixture.full_name}`;
      const compact = await okTool(this.client, "run_1c_query", {
        query,
        limit: 1,
      });
      assert(!Array.isArray(compact.query_guidance), "run_1c_query must omit query_guidance by default");
      assert(!Array.isArray(compact.domain_guidance), "run_1c_query must omit domain_guidance by default");
      assert(!Array.isArray(compact.validation?.query_guidance), "run_1c_query validation.query_guidance must be opt-in");

      const guided = await okTool(this.client, "run_1c_query", {
        query,
        limit: 1,
        include_guidance: true,
      });
      assert(Array.isArray(guided.query_guidance), "run_1c_query must include query_guidance when requested");
      assert(Array.isArray(guided.validation?.query_guidance), "run_1c_query validation.query_guidance must follow include_guidance");
      return { compactRows: compact.rows?.length || 0, guidedQueryGuidance: guided.query_guidance.length };
    });

    await this.test("tool.run_1c_query_counterparty_contact_info", async () => {
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 5 Ссылка ИЗ ${fixture.full_name}.${fixture.tabularSection.name}`,
        limit: 5,
        include_column_types: true,
      });
      if (!result.rows?.length) {
        return { skipped: true, reason: "tabular section fixture has no rows", table: `${fixture.full_name}.${fixture.tabularSection.name}` };
      }
      const first = result.rows[0];
      assertRef(first.Ссылка, "tabular section row owner ref");
      this.context.counterpartyRef = first.Ссылка;
      this.context.sampleRef ||= first.Ссылка;
      return { rows: result.rows.length, firstRef: first.Ссылка };
    });

    await this.test("tool.run_1c_query_reference_encoding", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, УникальныйИдентификатор(Ссылка) КАК UUID ИЗ ${fixture.full_name}`,
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      if (!row) return { skipped: true, reason: "generic catalog fixture has no rows", catalog: fixture.full_name };
      assertRef(row.Ссылка, "organization query ref");
      assert(row.Ссылка.uuid === row.UUID, "encoded ref uuid must match query UUID column");
      this.context.organizationRef = row.Ссылка;
      this.context.sampleRef ||= row.Ссылка;
      return { ref: row.Ссылка };
    });

    await this.test("tool.run_1c_query_accounting_debit_credit_subconto", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Обороты.СчетДт, Обороты.СчетКт, Обороты.СубконтоДт1, Обороты.СубконтоКт1, Обороты.СуммаОборот ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Обороты`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
        include_column_types: true,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(columnNames.includes("СубконтоДт1"), "ОборотыДтКт query must expose СубконтоДт1");
      assert(columnNames.includes("СубконтоКт1"), "ОборотыДтКт query must expose СубконтоКт1");
      return { register: accountingRegister.fullName, columns: columnNames, rows: result.rows?.length || 0 };
    });

    await this.test("tool.run_1c_query_accounting_balance_subconto", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 5 Остатки.Счет, Остатки.Субконто1, Остатки.КоличествоОстаток, Остатки.СуммаОстаток ИЗ ${accountingRegister.fullName}.Остатки(&Период) КАК Остатки`,
        parameters: {
          Период: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 5,
        include_column_types: true,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(columnNames.includes("Субконто1"), "balance query must expose Субконто1");
      assert(columnNames.includes("КоличествоОстаток"), "balance query must expose КоличествоОстаток");
      assert(columnNames.includes("СуммаОстаток"), "balance query must expose СуммаОстаток");
      return { register: accountingRegister.fullName, columns: columnNames, rows: result.rows?.length || 0 };
    });

    await this.test("tool.run_1c_query_zero_row_subconto_position_warning", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Остатки.Счет, Остатки.Субконто1 ИЗ ${accountingRegister.fullName}.Остатки(&Период) КАК Остатки ГДЕ Остатки.Счет.Код = &Код`,
        parameters: {
          Период: { kind: "datetime", value: CONTRACT_PERIOD.end },
          Код: { kind: "string", value: "__mcp_no_such_account_code__" },
        },
        limit: 1,
      });
      assert(result.row_count === 0, "fixture query must return zero rows");
      assert((result.warnings || []).some((item) => String(item).includes("позиция субконто")), "zero-row accounting subconto query must warn about subconto position");
      assert(!Array.isArray(result.query_guidance), "position warning must not force query_guidance");
      return { register: accountingRegister.fullName, warnings: result.warnings };
    });
  }

  async referenceTests() {
    await this.test("tool.search_objects_returns_structured_refs", async () => {
      const ref = this.context.sampleRef || this.context.organizationRef || this.context.counterpartyRef;
      if (!ref?.type) return { skipped: true, reason: "no sample reference fixture" };
      const query = String(ref.presentation || "").trim();
      if (!query) return { skipped: true, reason: "sample reference has empty presentation" };
      const result = await okTool(this.client, "search_objects", {
        query,
        types: [ref.type],
        limit: 3,
        include_fields: [],
      });
      if (!result.matches?.length) {
        return { skipped: true, reason: "sample reference presentation is not searchable for this type", query, type: ref.type };
      }
      assertRef(result.matches[0].ref, "search_objects ref");
      this.context.counterpartyRef ||= result.matches[0].ref;
      return { matches: result.matches.length, first: result.matches[0].ref };
    });

    await this.test("tool.get_object_by_ref_with_tabular_section", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const fixture = this.context.catalogWithTabular;
      const wantsTabular = fixture?.full_name === ref.type && fixture?.tabularSection?.name;
      const result = await okTool(this.client, "get_object_by_ref", {
        type: ref.type,
        uuid: ref.uuid,
        fields: [],
        include_standard_fields: true,
        include_tabular_sections: Boolean(wantsTabular),
        tabular_sections: wantsTabular ? [fixture.tabularSection.name] : [],
        tabular_section_row_limit: 5,
      });
      assert(result.found === true, "object must be found");
      assertRef(result.object?.ref, "get_object_by_ref object.ref");
      if (wantsTabular) {
        assert(result.object?.tabular_sections?.[fixture.tabularSection.name], "fixture tabular section must be returned");
      }
      return {
        ref: result.object.ref,
        fields: Object.keys(result.object.fields || {}),
        tabularSections: Object.keys(result.object.tabular_sections || {}),
      };
    });

    await this.test("tool.find_object_by_id", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const result = await okTool(this.client, "find_object_by_id", {
        uuid: ref.uuid,
        types: [ref.type],
        limit: 5,
      });
      assert(result.found === true, "find_object_by_id must find the object");
      assertRef(result.matches?.[0]?.ref, "find_object_by_id match ref");
      return { searchedTypes: result.searched_types_count, matches: result.matches.length };
    });

    await this.test("tool.get_link_of_object", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const result = await okTool(this.client, "get_link_of_object", {
        type: ref.type,
        uuid: ref.uuid,
        link_type: "auto",
        include_presentation: true,
      });
      assert(result.found === true, "get_link_of_object must find the object");
      assertRef(result.ref, "get_link_of_object ref");
      assert((result.links || []).some((link) => link.type === "e1cib"), "e1cib link must be present");
      return { links: result.links };
    });

    await this.test("tool.find_references_to_object", async () => {
      const ref = requireContextRef(this.context.organizationRef || this.context.counterpartyRef || this.context.sampleRef, "organizationRef/counterpartyRef/sampleRef");
      const result = await okTool(this.client, "find_references_to_object", {
        target: { type: ref.type, uuid: ref.uuid },
        max_types: 3,
        limit_per_type: 2,
        include_samples: true,
      });
      assertRef(result.target, "find_references_to_object target");
      assert(Array.isArray(result.references), "references must be an array");
      return { groups: result.references.length, searchedTypes: result.searched_types_count, truncated: result.truncated };
    });

    await this.test("tool.get_object_history_graceful", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const result = await okTool(this.client, "get_object_history", {
        target: { type: ref.type, uuid: ref.uuid },
        mode: "auto",
        limit: 5,
      });
      assertRef(result.target, "get_object_history target");
      assert(Array.isArray(result.events), "events must be an array");
      assert(result.capabilities, "capabilities must be present");
      return { supported: result.supported, events: result.events.length, capabilities: result.capabilities };
    });
  }

  async registerTests() {
    await this.test("tool.get_enum_values", async () => {
      const enumType = this.context.enumType;
      if (!enumType) return { skipped: true, reason: "no enum fixture" };
      const result = await okTool(this.client, "get_enum_values", {
        type: enumType.full_name,
        include_empty: true,
        include_order: true,
        limit: 10,
      });
      assert(Array.isArray(result.values), "enum values must be an array");
      return { values: result.values.map((item) => item.name) };
    });

    await this.test("tool.get_register_records_records_mode", async () => {
      const fixture = this.context.infoRegister;
      if (!fixture) return { skipped: true, reason: "no information register fixture" };
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрСведений",
        register: fixture.name,
        mode: "records",
        limit: 2,
      });
      assert(result.register === fixture.full_name, "unexpected register name");
      assert(Array.isArray(result.rows), "register rows must be an array");
      return { rows: result.rows.length, truncated: result.truncated, nextCursor: result.next_cursor };
    });

    await this.test("tool.get_register_records_accounting_debit_credit_mode", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers_debit_credit",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["СчетДт", "СчетКт", "СубконтоДт1", "СубконтоКт1"],
        resources: ["СуммаОборот"],
        include_column_types: true,
        limit: 1,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(result.register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.mode === "turnovers_debit_credit", "unexpected accounting register mode");
      assert(columnNames.includes("СубконтоДт1"), "get_register_records must expose СубконтоДт1");
      assert(columnNames.includes("СубконтоКт1"), "get_register_records must expose СубконтоКт1");
      return { register: accountingRegister.fullName, columns: columnNames, rows: result.rows?.length || 0, queryUsed: result.query_used };
    });

    await this.test("tool.get_register_records_accounting_debit_credit_filter", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const sample = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers_debit_credit",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["СчетДт", "СчетКт"],
        resources: ["СуммаОборот"],
        limit: 1,
      });
      const account = sample.rows?.[0]?.СчетДт;
      if (!account?.type || !account?.uuid) {
        return { skipped: true, reason: "no debit-credit turnover rows with account ref", register: accountingRegister.fullName };
      }
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers_debit_credit",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        filters: { СчетДт: toQueryRef(account) },
        dimensions: ["СчетДт", "СчетКт"],
        resources: ["СуммаОборот"],
        include_query: true,
        limit: 5,
      });
      assert(result.query_used?.includes("ГДЕ СчетДт = &Filter_СчетДт"), "accounting debit-credit filter must be emitted as WHERE");
      assert(!result.query_used?.includes("ОборотыДтКт(&ПериодНачало, &ПериодКонец,"), "filter must not be injected into ОборотыДтКт parameter slots");
      for (const row of result.rows || []) {
        assert(row.СчетДт?.uuid === account.uuid, "filtered debit account must match requested account");
      }
      return { register: accountingRegister.fullName, account: account.presentation, rows: result.rows?.length || 0, queryUsed: result.query_used };
    });

    await this.test("tool.get_register_records_accounting_turnovers_filter", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const sample = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["Счет"],
        resources: ["СуммаОборот"],
        limit: 1,
      });
      const account = sample.rows?.[0]?.Счет;
      if (!account?.type || !account?.uuid) {
        return { skipped: true, reason: "no accounting turnover rows with account ref", register: accountingRegister.fullName };
      }
      const turnovers = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        filters: { Счет: toQueryRef(account) },
        dimensions: ["Счет"],
        resources: ["СуммаОборот"],
        include_query: true,
        limit: 5,
      });
      assert(turnovers.query_used?.includes("ГДЕ Счет = &Filter_Счет"), "accounting turnovers filter must be emitted as WHERE");
      assert(!turnovers.query_used?.includes("Обороты(&ПериодНачало, &ПериодКонец,"), "filter must not be injected into Обороты parameter slots");
      for (const row of turnovers.rows || []) {
        assert(row.Счет?.uuid === account.uuid, "filtered turnover account must match requested account");
      }
      const balanceAndTurnovers = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "balance_and_turnovers",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        filters: { Счет: toQueryRef(account) },
        dimensions: ["Счет"],
        resources: ["СуммаОборот"],
        include_query: true,
        limit: 5,
      });
      assert(balanceAndTurnovers.query_used?.includes("ГДЕ Счет = &Filter_Счет"), "accounting balance-and-turnovers filter must be emitted as WHERE");
      assert(!balanceAndTurnovers.query_used?.includes("ОстаткиИОбороты(&ПериодНачало, &ПериодКонец,"), "filter must not be injected into ОстаткиИОбороты parameter slots");
      for (const row of balanceAndTurnovers.rows || []) {
        assert(row.Счет?.uuid === account.uuid, "filtered account must match requested account");
      }
      return {
        register: accountingRegister.fullName,
        account: account.presentation,
        turnoversRows: turnovers.rows?.length || 0,
        balanceAndTurnoversRows: balanceAndTurnovers.rows?.length || 0,
        turnoversQueryUsed: turnovers.query_used,
        balanceAndTurnoversQueryUsed: balanceAndTurnovers.query_used,
      };
    });

    await this.test("tool.get_accounting_balances", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "get_accounting_balances", {
        accounting_register: accountingRegister.name,
        mode: "balance",
        period: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["Счет"],
        resources: ["Сумма"],
        limit: 2,
      });
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.mode === "balance", "unexpected accounting balance mode");
      assert(Array.isArray(result.rows), "accounting balance rows must be an array");
      assert("truncated" in result, "truncated flag must be present");
      return { register: accountingRegister.fullName, rows: result.rows.length, truncated: result.truncated };
    });

    await this.test("tool.get_accounting_balances_by_subconto_age", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const map = await okTool(this.client, "get_accounting_accounts_map", {
        account_code_prefix: "62",
        include_empty_subconto: false,
        limit: 20,
      });
      const accountWithSettlementDoc = (map.accounts || []).find((account) =>
        (account.subconto || []).some((item) => item.position === 1)
        && (account.subconto || []).some((item) => item.position === 3)
      );
      if (!accountWithSettlementDoc) {
        return { skipped: true, reason: "no 62 account with subconto positions 1 and 3" };
      }
      const subcontoKinds = (accountWithSettlementDoc.subconto || [])
        .sort((left, right) => left.position - right.position)
        .map((item) => item.name);
      const result = await okTool(this.client, "get_accounting_balances_by_subconto_age", {
        accounting_register: accountingRegister.name,
        as_of: CONTRACT_PERIOD.end,
        account_code_prefixes: ["62"],
        balance_side: "debit",
        subconto_kinds: subcontoKinds,
        group_subconto_index: 1,
        age_subconto_index: 3,
        age_buckets: [90, 180, 365],
        limit: 5,
        include_query: true,
      });
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.configuration_agnostic === true, "aging tool must be configuration agnostic");
      assert(Array.isArray(result.bucket_rows), "aging bucket_rows must be an array");
      assert(Array.isArray(result.rows), "aging rows must be an array");
      assert(result.query_used?.detail?.includes(".Остатки("), "aging detail query must use Остатки");
      return { register: accountingRegister.fullName, rows: result.rows.length, buckets: result.bucket_rows.length };
    });

    await this.test("tool.compare_accounting_balances_by_subconto", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const map = await okTool(this.client, "get_accounting_accounts_map", {
        account_code_prefix: "62",
        include_empty_subconto: false,
        limit: 20,
      });
      const accountWithCounterparty = (map.accounts || []).find((account) =>
        (account.subconto || []).some((item) => item.position === 1)
      );
      if (!accountWithCounterparty) {
        return { skipped: true, reason: "no 62 account with counterparty subconto" };
      }
      const subcontoKinds = (accountWithCounterparty.subconto || [])
        .sort((left, right) => left.position - right.position)
        .map((item) => item.name);
      const result = await okTool(this.client, "compare_accounting_balances_by_subconto", {
        accounting_register: accountingRegister.name,
        as_of: CONTRACT_PERIOD.end,
        subconto_kinds: subcontoKinds,
        match_subconto_index: 1,
        left_account_code_prefixes: ["62"],
        left_balance_side: "debit",
        right_account_code_prefixes: ["60"],
        right_balance_side: "credit",
        limit: 5,
        include_query: true,
      });
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.configuration_agnostic === true, "compare tool must be configuration agnostic");
      assert(Array.isArray(result.rows), "compare rows must be an array");
      assert(result.query_used?.includes("ВТ_ЛевыеОстатки"), "compare query must use temporary left table");
      return { register: accountingRegister.fullName, rows: result.rows.length };
    });

    await this.test("tool.get_register_records_bad_mode_is_diagnostic", async () => {
      const fixture = this.context.infoRegister;
      if (!fixture) return { skipped: true, reason: "no information register fixture" };
      const result = await rawTool(this.client, "get_register_records", {
        register_type: "РегистрСведений",
        register: fixture.name,
        mode: "balance",
        period: "2026-05-13T00:00:00",
        limit: 1,
      });
      assert(result.ok === false, "bad register mode must return ok=false");
      assert(result.error?.code === "register_mode_not_supported", `unexpected error code: ${result.error?.code}`);
      return { error: result.error };
    });
  }

  async documentTests() {
    await this.test("fixture.query_document_with_movements", async () => {
      const fixture = this.context.genericDocument;
      if (!fixture) return { skipped: true, reason: "no document fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, УникальныйИдентификатор(Ссылка) КАК UUID ИЗ ${fixture.full_name}`,
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      if (!row) return { skipped: true, reason: "document fixture has no rows", document: fixture.full_name };
      assertRef(row.Ссылка, "document query ref");
      this.context.documentRef = row.Ссылка;
      return { ref: row.Ссылка };
    });

    await this.test("tool.get_document_movements", async () => {
      const ref = this.context.documentRef;
      if (!ref) return { skipped: true, reason: "no document row fixture" };
      const result = await okTool(this.client, "get_document_movements", {
        document_type: ref.type,
        uuid: ref.uuid,
        row_limit_per_register: 2,
        include_empty_registers: false,
      });
      assert(result.found === true, "document movements target must be found");
      assertRef(result.document, "get_document_movements document");
      assert(Array.isArray(result.movements), "movements must be an array");
      return { registers: result.movements.map((item) => item.register), truncated: result.truncated };
    });
  }

  async reportTests() {
    await this.test("tool.list_reports", async () => {
      const result = await okTool(this.client, "list_reports", {
        query: "Анализ",
        include_variants: true,
        include_guidance: true,
        limit: 5,
      });
      assert(result.reports?.length > 0, "expected reports");
      assert(hasInteractionHint(result, "report_or_direct_query_choice"), "report discovery must include report-or-query interaction hint");
      const report = result.reports[0];
      assert(report.type?.startsWith("Отчет."), "report type must be full metadata name");
      assert(typeof report.has_custom_pre_compose === "boolean", "report must expose has_custom_pre_compose flag");
      this.context.reportType = report.type;
      this.context.reportVariant = report.variants?.[0]?.name || "Основной";
      return { reports: result.reports.map((item) => item.type), firstVariant: this.context.reportVariant };
    });

    await this.test("tool.get_report_info", async () => {
      const report = this.context.reportType;
      if (!report) return { skipped: true, reason: "no report fixture" };
      const result = await okTool(this.client, "get_report_info", {
        report,
        include_schema: true,
        include_variants: true,
        include_default_settings: true,
      });
      assert(result.report === report, "report_info returned different report");
      assert(Array.isArray(result.variants), "variants must be an array");
      assert(Array.isArray(result.parameters), "parameters must be an array");
      assert(typeof result.has_custom_pre_compose === "boolean", "report_info must expose has_custom_pre_compose flag");
      assert(typeof result.report_parameter_source === "string", "report_info must expose report_parameter_source");
      if (result.parameters.length > 0) {
        assert("name" in result.parameters[0], "report parameter must include name");
        assert("type" in result.parameters[0] || "type_description" in result.parameters[0], "report parameter must include type");
      }
      return { report: result.report, variants: result.variants };
    });

    await this.test("tool.run_1c_report_graceful", async () => {
      const report = this.context.reportType;
      if (!report) return { skipped: true, reason: "no report fixture" };
      const variant = this.context.reportVariant || "Основной";
      const result = await okTool(this.client, "run_1c_report", {
        report,
        variant,
        output_format: "table",
        limit: 3,
        timeout_seconds: 30,
        include_parameters_used: true,
      });
      assert(result.report === report, "run_1c_report returned different report");
      assert("execution_supported" in result, "execution_supported must be present");
      assert(result.parameters_used && typeof result.parameters_used === "object", "parameters_used must be present");
      assert("pre_compose_applied" in result || result.execution_supported === false, "pre_compose_applied must be present for supported report execution");
      assert(Array.isArray(result.rows), "rows must be an array even when unsupported");
      return {
        report: result.report,
        executionSupported: result.execution_supported,
        rows: result.rows.length,
        warnings: result.warnings || [],
      };
    });
  }

  async negativeTests() {
    await this.test("negative.validate_missing_metadata_is_invalid", async () => {
      const result = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.MCP_НесуществующийРегистр",
        strict: true,
        explain: true,
      });
      assert(result.valid === false, `validate must reject missing metadata, got valid=true with detected=${JSON.stringify(result.detected_objects)}`);
      assert((result.errors || []).some((error) => error.code === "metadata_not_found"), `metadata_not_found error is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    await this.test("negative.run_missing_metadata_is_diagnostic", async () => {
      const result = await rawTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.MCP_НесуществующийРегистр",
        limit: 1,
      });
      assert(result.ok === false, "missing metadata query must fail");
      const parsedDetails = result.error?.details?.parsed_details;
      const validationDetails = Array.isArray(parsedDetails) ? parsedDetails : [];
      const hasMetadataNotFound = validationDetails.some((error) => error.code === "metadata_not_found")
        || result.error?.details?.raw_exception?.includes("metadata_not_found");
      const hasExecutionDiagnostic = result.error?.message?.includes("Таблица не найдена")
        || result.error?.details?.raw_exception?.includes("Таблица не найдена");
      assert(hasMetadataNotFound || hasExecutionDiagnostic, "must include missing-metadata or table-not-found diagnostics");
      return { errorCode: result.error?.code, message: result.error?.message, parsedDetails };
    });

    await this.test("negative.run_validate_before_run_false_is_ignored", async () => {
      const result = await rawTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.MCP_НесуществующийРегистр",
        validate_before_run: false,
        limit: 1,
      });
      assert(result.ok === false, "invalid query must fail even with validate_before_run=false");
      assert(result.error?.code === "query_validation_failed", `unexpected error code: ${result.error?.code}`);
      const parsedDetails = result.error?.details?.parsed_details;
      const validationDetails = Array.isArray(parsedDetails) ? parsedDetails : [];
      assert(validationDetails.some((error) => error.code === "metadata_not_found")
        || result.error?.details?.raw_exception?.includes("metadata_not_found"), "validation diagnostics must be present");
      return { errorCode: result.error?.code, parsedDetails };
    });

    await this.test("negative.validate_forbidden_keyword", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ Ссылка ИЗ ${fixture.full_name} ДЛЯ ИЗМЕНЕНИЯ`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "forbidden keyword query must be invalid");
      assert((result.errors || []).some((error) => error.code === "forbidden_keyword"), "forbidden_keyword error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.validate_invalid_imeya_keyword", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 Объект.Ссылка КАК Ссылка, КОЛИЧЕСТВО(Объект.Ссылка) КАК Количество ИЗ ${fixture.full_name} КАК Объект СГРУППИРОВАТЬ ПО Объект.Ссылка ИМЕЯ КОЛИЧЕСТВО(Объект.Ссылка) > 0`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "ИМЕЯ query must be invalid");
      assert((result.errors || []).some((error) => error.code === "invalid_1c_query_keyword"), "invalid_1c_query_keyword error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.get_accounting_entries_rejects_subconto_value_without_kind", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      const fixture = this.context.genericCatalog || this.context.genericDocument;
      if (!accountingRegister || !fixture) {
        return { skipped: true, reason: "no accounting register or reference fixture" };
      }
      const ref = await firstRefFromType(this.client, fixture.full_name);
      if (!ref) return { skipped: true, reason: "no reference row" };
      const result = await rawTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        subconto_side: "debit",
        subconto_value: toQueryRef(ref),
        limit: 5,
      });
      assert(result.ok === false, "subconto_value without subconto_kind must fail");
      assert(result.error?.code === "invalid_arguments", `unexpected code: ${result.error?.code}`);
      assert(String(result.error?.message || "").includes("subconto_kind"), "error must point to subconto_kind");
      return { error: result.error };
    });

    await this.test("negative.run_main_register_subconto_dtkt_is_smart_error", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Хозрасчетный.СубконтоДт1 КАК Субконто ИЗ ${accountingRegister.fullName} КАК Хозрасчетный`,
        limit: 1,
      });
      assert(result.ok === false, "main accounting register СубконтоДт1 run must fail");
      assert(result.error_code === "subconto_wrong_table" || result.error?.error_code === "subconto_wrong_table", `smart error_code is missing: ${JSON.stringify(result)}`);
      assert((result.hint || result.error?.hint || "").includes("Субконто"), "smart hint must mention Субконто");
      assert((result.see_also || result.error?.see_also || "").includes(".Субконто"), "see_also must point to .Субконто table");
      assert(Array.isArray(result.validation_errors || result.error?.validation_errors), "validation_errors must be present");
      return { errorCode: result.error_code || result.error?.error_code, hint: result.hint || result.error?.hint };
    });

    await this.test("negative.validate_rejects_accounting_balance_vt_deref_params", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Остатки.Счет КАК Счет ИЗ ${accountingRegister.fullName}.Остатки(&Дата, СчетДт.Код ПОДОБНО "01%") КАК Остатки`;
      const validation = await okTool(this.client, "validate_1c_query", {
        query,
        parameters: { Дата: { kind: "datetime", value: CONTRACT_PERIOD.end } },
        strict: true,
        explain: true,
      });
      assert(validation.valid === false, "Остатки virtual table params with dotted field dereference must be invalid");
      assert((validation.errors || []).some((error) => error.code === "vt_param_field_error"), `vt_param_field_error is missing: ${JSON.stringify(validation.errors)}`);

      const run = await rawTool(this.client, "run_1c_query", {
        query,
        parameters: { Дата: { kind: "datetime", value: CONTRACT_PERIOD.end } },
        validate_before_run: false,
        limit: 1,
      });
      assert(run.ok === false, "run_1c_query must fail before execution for invalid Остатки params");
      assert(run.error?.code === "query_validation_failed", `unexpected run error code: ${run.error?.code}`);
      return { validationErrors: validation.errors, runErrorCode: run.error?.code };
    });

    await this.test("negative.validate_plain_batch_without_temp_tables", async () => {
      const first = this.context.genericCatalog;
      const second = this.context.genericDocument || this.context.catalogWithTabular || first;
      if (!first || !second) return { skipped: true, reason: "not enough query fixtures" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${first.full_name}; ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${second.full_name}`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "plain batch query without temp tables must be invalid");
      assert((result.errors || []).some((error) => error.code === "batch_query_forbidden"), "batch_query_forbidden error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.validate_temp_table_without_final_select", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Объект.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТОбъекты ИЗ ${fixture.full_name} КАК Объект`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "temp table query without final SELECT must be invalid");
      assert((result.errors || []).some((error) => error.code === "temporary_table_package_required"), "temporary_table_package_required error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.get_object_by_ref_bad_uuid", async () => {
      const fixture = this.context.genericCatalog || this.context.genericDocument;
      if (!fixture) return { skipped: true, reason: "no reference fixture" };
      const result = await rawTool(this.client, "get_object_by_ref", {
        type: fixture.full_name,
        uuid: "not-a-uuid",
      });
      assert(result.ok === false, "bad uuid must fail");
      assert(result.error?.code === "invalid_arguments", `unexpected code: ${result.error?.code}`);
      return { error: result.error };
    });

    await this.test("negative.unknown_tool", async () => {
      const result = await rawTool(this.client, "definitely_not_a_tool", {});
      assert(result.ok === false, "unknown tool must return ok=false");
      assert(result.error?.code, "unknown tool error code must be present");
      return { error: result.error };
    });

    if (process.env.MCP_DENIED_TYPE) {
      await this.test("manual.denied_type_returns_access_denied", async () => {
        const result = await rawTool(this.client, "get_metadata_structure", {
          type: process.env.MCP_DENIED_TYPE,
        });
        assert(result.ok === false, "denied type must fail");
        assert(result.error?.code === "access_denied", `expected access_denied, got ${result.error?.code}`);
        assert(result.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change", "missing retry policy");
        return { type: process.env.MCP_DENIED_TYPE, authorization: result.authorization };
      });
    }

    if (process.env.MCP_DENIED_REPORT) {
      await this.test("manual.denied_report_returns_access_denied", async () => {
        const result = await rawTool(this.client, "get_report_info", {
          report: process.env.MCP_DENIED_REPORT,
        });
        assert(result.ok === false, "denied report must fail");
        assert(result.error?.code === "access_denied", `expected access_denied, got ${result.error?.code}`);
        assert(result.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change", "missing retry policy");
        return { report: process.env.MCP_DENIED_REPORT, authorization: result.authorization };
      });
    }
  }

  async crossChecks() {
    await this.test("crosscheck.every_listed_query_object_has_basic_structure_sample", async () => {
      const candidates = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник", "Документ", "РегистрСведений", "РегистрНакопления"],
        limit: 12,
        include_details: true,
      });
      const checked = [];
      const failures = [];
      for (const item of candidates.objects || []) {
        if (!item.supports_query) continue;
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: false,
          include_tabular_sections: false,
        });
        checked.push(item.full_name);
        if (structure.ok !== true) {
          failures.push({ type: item.full_name, error: structure.error });
        }
      }
      assert(failures.length === 0, `metadata structure failures: ${JSON.stringify(failures)}`);
      return { checked };
    });
  }

  summary() {
    const passed = this.tests.filter((test) => test.status === "PASS").length;
    const failed = this.tests.filter((test) => test.status === "FAIL").length;
    const summary = {
      target: this.client.url,
      responseMode: this.options.responseMode || "server_default",
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      total: this.tests.length,
      passed,
      failed,
      tests: this.tests,
    };
    console.log("");
    console.log(`Summary: ${passed} passed, ${failed} failed, ${this.tests.length} total`);
    if (failed > 0) {
      console.log("Failures:");
      for (const test of this.tests.filter((item) => item.status === "FAIL")) {
        console.log(`- ${test.name}: ${test.error.message}`);
      }
    }
    return summary;
  }
}

async function findAccountingRegister(client) {
  const result = await okTool(client, "list_metadata_objects", {
    kinds: ["РегистрБухгалтерии"],
    limit: 1,
    include_details: false,
  });
  const item = result.objects?.[0];
  if (!item?.full_name) return null;
  const [, nameFromFullName = ""] = item.full_name.split(".");
  const name = item.name || nameFromFullName;
  if (!name) return null;
  return {
    fullName: item.full_name,
    name,
  };
}

async function findAccumulationRegister(client) {
  const result = await okTool(client, "list_metadata_objects", {
    kinds: ["РегистрНакопления"],
    limit: 1,
    include_details: false,
  });
  const item = result.objects?.[0];
  if (!item?.full_name) return null;
  const [, nameFromFullName = ""] = item.full_name.split(".");
  const name = item.name || nameFromFullName;
  if (!name) return null;
  return {
    fullName: item.full_name,
    name,
  };
}

async function findFirstMetadataObject(client, kinds, predicate, pageLimit = 50) {
  let cursor = "";
  for (let page = 0; page < 4; page += 1) {
    const result = await okTool(client, "list_metadata_objects", {
      kinds,
      limit: pageLimit,
      cursor,
      include_details: true,
    });
    for (const item of result.objects || []) {
      if (!item?.full_name) continue;
      const accepted = await predicate(item);
      if (accepted) {
        const [, nameFromFullName = ""] = item.full_name.split(".");
        return {
          ...item,
          fullName: item.full_name,
          name: item.name || nameFromFullName,
        };
      }
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return null;
}

async function okTool(client, name, args) {
  const result = await rawTool(client, name, args);
  assert(result?.ok === true, `${name} did not return ok=true: ${JSON.stringify(result?.error || result || {}).slice(0, 1200)}`);
  return result;
}

async function rawTool(client, name, args) {
  const { result } = await client.callTool(name, args);
  assertToolResultEnvelope(result, name, client.responseMode);
  const unwrapped = unwrapToolResult(result);
  assertAuthContext(unwrapped, name);
  if (unwrapped?.ok === false) {
    assertErrorDiagnosticText(result, name);
    if (unwrapped.error?.code === "access_denied") {
      assert(unwrapped.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change"
        || unwrapped.error?.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change",
        `${name} access_denied must include retry policy`);
    }
  }
  return unwrapped;
}

function assertToolsListMode(tools, responseMode) {
  if (!responseMode) return;
  if (responseMode === "text_only") {
    const withSchema = tools.filter((tool) => tool.outputSchema);
    assert(withSchema.length === 0, `text_only tools/list must not declare outputSchema: ${withSchema.map((tool) => tool.name).join(", ")}`);
    return;
  }
  const withoutSchema = tools.filter((tool) => !tool.outputSchema);
  assert(withoutSchema.length === 0, `${responseMode} tools/list must declare outputSchema: ${withoutSchema.map((tool) => tool.name).join(", ")}`);
}

function assertToolResultEnvelope(result, toolName, responseMode) {
  if (!responseMode) return;
  if (!result || typeof result !== "object") {
    throw new Error(`${toolName} result envelope must be an object`);
  }
  const text = firstTextContent(result);
  if (responseMode === "text_only") {
    assert(!result.structuredContent, `${toolName} text_only must not include structuredContent`);
    assert(canParseJsonObject(text), `${toolName} text_only content[0].text must contain full JSON`);
    return;
  }
  assert(result.structuredContent && typeof result.structuredContent === "object", `${toolName} ${responseMode} must include structuredContent`);
  if (responseMode === "both") {
    if (result.isError) {
      assert((result.content || []).some((item) => item?.type === "text" && String(item.text || "").includes("Диагностика JSON:")),
        `${toolName} both error content must include JSON diagnostics`);
    } else {
      assert(String(text || "").includes("structuredContent="), `${toolName} both success text must duplicate structuredContent`);
    }
  }
}

function firstTextContent(result) {
  return result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string")?.text || "";
}

function canParseJsonObject(text) {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function unwrapToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const textItem = result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string");
  if (textItem) {
    const text = textItem.text;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return result;
    }
  }

  return result;
}

function makeContractPeriod() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    start: "2000-01-01T00:00:00",
    end: end.toISOString().slice(0, 19),
  };
}

function toQueryRef(ref) {
  return {
    kind: "ref",
    type: ref.type,
    uuid: ref.uuid,
  };
}

async function firstRefFromType(client, fullName) {
  const result = await rawTool(client, "run_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${fullName}`,
    limit: 1,
  });
  return result.rows?.[0]?.Ссылка || null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertAuthContext(result, toolName) {
  if (!result || typeof result !== "object" || !("ok" in result)) return;
  const ctx = result.auth_context;
  assert(ctx && typeof ctx === "object", `${toolName} must include auth_context`);
  assert(typeof ctx.user_name === "string", `${toolName} auth_context.user_name is missing`);
  assert(typeof ctx.identity_key === "string" && ctx.identity_key.length > 0, `${toolName} auth_context.identity_key is missing`);
  assert(ctx.cache_policy?.cacheable === false, `${toolName} auth_context.cache_policy.cacheable must be false`);
  assert(ctx.cache_policy?.revalidate_each_call === true, `${toolName} auth_context.cache_policy.revalidate_each_call must be true`);
}

function assertErrorDiagnosticText(toolResult, toolName) {
  const texts = (toolResult?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  const hasDiagnosticText = texts.some((text) => text.includes("Диагностика JSON:"));
  const hasJsonText = texts.some((text) => {
    try {
      const parsed = JSON.parse(text);
      return parsed?.ok === false && parsed?.error;
    } catch {
      return false;
    }
  });
  const hasStructuredError = toolResult?.structuredContent?.ok === false && toolResult.structuredContent?.error;
  assert(hasDiagnosticText || hasJsonText || hasStructuredError, `${toolName} error content must expose JSON diagnostics`);
}

function assertRef(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object ref`);
  assert(typeof value.type === "string" && value.type.includes("."), `${label}.type is missing`);
  assert(typeof value.uuid === "string" && value.uuid.length >= 32, `${label}.uuid is missing`);
  assert("presentation" in value, `${label}.presentation is missing`);
}

function hasGuidance(result, id) {
  return Array.isArray(result?.domain_guidance)
    && result.domain_guidance.some((item) => item?.id === id);
}

function hasQueryGuidance(result, id) {
  return Array.isArray(result?.query_guidance)
    && result.query_guidance.some((item) => item?.id === id);
}

function hasGuidanceItem(items, id) {
  return Array.isArray(items)
    && items.some((item) => item?.id === id);
}

function hasInteractionHint(result, id) {
  return result?.interaction_hint?.id === id;
}

function requireContextRef(ref, name) {
  assert(ref, `fixture ${name} is missing`);
  assertRef(ref, name);
  return ref;
}

function formatError(error) {
  return {
    message: error?.message || String(error),
    rpcError: error?.rpcError,
    stack: error?.stack,
  };
}

function printRow(row) {
  const status = row.status.padEnd(4);
  const elapsed = `${row.elapsedMs}ms`.padStart(7);
  if (row.status === "PASS") {
    console.log(`[${status}] ${elapsed} ${row.name}`);
  } else {
    console.log(`[${status}] ${elapsed} ${row.name} :: ${row.error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.modes.length > 0) {
    const summaries = [];
    for (const mode of options.modes) {
      const runOptions = {
        ...options,
        responseMode: mode,
        out: outPathForMode(options.out, mode),
        modes: [],
      };
      summaries.push(await runContract(runOptions));
    }
    const aggregate = {
      target: options.url,
      responseModes: options.modes,
      startedAt: summaries[0]?.startedAt,
      finishedAt: new Date().toISOString(),
      total: summaries.reduce((sum, item) => sum + item.total, 0),
      passed: summaries.reduce((sum, item) => sum + item.passed, 0),
      failed: summaries.reduce((sum, item) => sum + item.failed, 0),
      summaries,
    };
    if (options.out) {
      await writeReport(options.out, aggregate);
    }
    process.exitCode = aggregate.failed > 0 ? 1 : 0;
    return;
  }
  const summary = await runContract(options);
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

async function runContract(options) {
  const client = new McpHttpClient(options);
  const runner = new ContractRunner(client, options);
  const summary = await runner.run();
  if (options.out) {
    await writeReport(options.out, summary);
  }
  return summary;
}

async function writeReport(path, data) {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Report written: ${out}`);
}

function outPathForMode(path, mode) {
  if (!path) return "";
  const extension = extname(path);
  if (!extension) return `${path}.${mode}`;
  return `${path.slice(0, -extension.length)}.${mode}${extension}`;
}

main().catch((error) => {
  console.error(formatError(error).message);
  if (error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
