#!/usr/bin/env node

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const EXPECTED_TOOLS = [
  "list_metadata_objects",
  "get_metadata_structure",
  "run_1c_query",
  "validate_1c_query",
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
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/mcp_contract_test.mjs [--url URL] [--basic user:pass] [--out report.json] [--verbose]

Environment:
  MCP_URL          JSON-RPC endpoint. Defaults to ${DEFAULT_URL}
  MCP_BASIC        Optional Basic auth value in user:pass form.
  MCP_TIMEOUT_MS   Per-request timeout, default 60000.
  MCP_CONTRACT_OUT Optional JSON report path.
`);
}

class McpHttpClient {
  constructor(options) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.verbose = options.verbose;
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
    console.log(`Started: ${this.startedAt}`);

    await this.protocolTests();
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

    await this.test("protocol.tools_list_has_17_tools", async () => {
      const { result } = await this.client.rpc("tools/list", {});
      const tools = result?.tools || [];
      const names = tools.map((tool) => tool.name).sort();
      const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !EXPECTED_TOOLS.includes(name));
      assert(missing.length === 0, `missing tools: ${missing.join(", ")}`);
      assert(names.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length}, got ${names.length}; extra=${extra.join(", ")}`);
      this.context.toolNames = names;
      return { count: names.length };
    });

    await this.test("protocol.resources_list_and_read", async () => {
      const list = await this.client.rpc("resources/list", {});
      const resources = list.result?.resources || [];
      assert(resources.some((item) => item.uri === "1c://metadata"), "metadata resource is missing");
      assert(resources.some((item) => item.uri === "1c://context/current-user"), "current-user resource is missing");
      const read = await this.client.rpc("resources/read", { uri: "1c://context/current-user" });
      const text = read.result?.contents?.[0]?.text || "";
      assert(text.includes("user"), "current-user resource must contain user data");
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

    await this.test("tool.list_metadata_objects_contact_reality", async () => {
      const result = await okTool(this.client, "list_metadata_objects", {
        query: "Контакт",
        limit: 50,
        include_details: true,
        include_not_allowed: true,
      });
      const names = (result.objects || []).map((item) => item.full_name);
      assert(!names.includes("РегистрСведений.КонтактнаяИнформация"), "non-existent КонтактнаяИнформация register appeared in metadata");
      return { found: names.length, hasLegacyRegister: names.includes("РегистрСведений.УдалитьКонтактнаяИнформация") };
    });

    await this.test("tool.discovery_returns_guidance_is_contextual", async () => {
      const sales = await okTool(this.client, "list_reports", {
        query: "продажи прибыль рентабельность по товарным позициям",
        include_variants: false,
        limit: 1,
      });
      assert(hasGuidance(sales, "returns_and_storno"), "sales/report discovery must include returns-and-storno guidance");

      const materials = await okTool(this.client, "list_reports", {
        query: "остатки и поступление сырья материалов тмц возвраты поставщику",
        include_variants: false,
        limit: 1,
      });
      assert(hasGuidance(materials, "returns_and_storno"), "materials/inventory discovery must include returns-and-storno guidance");

      const hr = await okTool(this.client, "list_reports", {
        query: "увольнение сотрудников кадровые документы",
        include_variants: false,
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
    await this.test("tool.get_metadata_structure_counterparties", async () => {
      const result = await okTool(this.client, "get_metadata_structure", {
        type: "Справочник.Контрагенты",
        include_standard_attributes: true,
        include_tabular_sections: true,
      });
      const meta = result.metadata;
      assert(meta.kind === "Справочник", `unexpected kind: ${meta.kind}`);
      assert(meta.supports_ref === true, "counterparties must support references");
      const ts = meta.tabular_sections || [];
      assert(ts.some((item) => item.name === "КонтактнаяИнформация"), "КонтактнаяИнформация tabular section is missing");
      return { attributes: meta.attributes?.length, tabularSections: ts.map((item) => item.name).slice(0, 8) };
    });

    await this.test("tool.get_metadata_structure_register_schema", async () => {
      const result = await okTool(this.client, "get_metadata_structure", {
        type: "РегистрСведений.ЦеныНоменклатуры",
        include_standard_attributes: false,
        include_tabular_sections: false,
      });
      const schema = result.metadata?.register_schema;
      assert(result.metadata?.kind === "РегистрСведений", "register kind must be РегистрСведений");
      assert(schema, "register_schema must be present");
      assert((schema.dimensions || []).some((item) => item.name === "Номенклатура"), "Номенклатура dimension is missing");
      assert((schema.resources || []).some((item) => item.name === "Цена"), "Цена resource is missing");
      return { periodicity: schema.periodicity, dimensions: schema.dimensions.length, resources: schema.resources.length };
    });

    await this.test("tool.validate_1c_query_existing_tabular_section", async () => {
      const result = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, Представление ИЗ Справочник.Контрагенты.КонтактнаяИнформация",
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `expected valid=true, errors=${JSON.stringify(result.errors)}`);
      assert((result.detected_objects || []).includes("Справочник.Контрагенты"), "detected_objects should include parent catalog");
      return { detected: result.detected_objects };
    });

    await this.test("tool.validate_1c_query_returns_guidance_is_contextual", async () => {
      const sales = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ Документ.РеализацияТоваровУслуг",
        strict: true,
        explain: true,
      });
      assert(hasGuidance(sales, "returns_and_storno"), "sales-like query validation must include returns-and-storno guidance");

      const assets = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ Справочник.ОсновныеСредства",
        strict: true,
        explain: true,
      });
      assert(hasGuidance(assets, "returns_and_storno"), "fixed-assets query validation must include returns-and-storno guidance");

      const hr = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ Документ.Увольнение",
        strict: true,
        explain: true,
      });
      assert(!hasGuidance(hr, "returns_and_storno"), "HR-like query validation must not include returns-and-storno guidance");
      return {
        salesValid: sales.valid,
        assetsValid: assets.valid,
        hrValid: hr.valid,
        salesGuidance: sales.domain_guidance,
        assetsGuidance: assets.domain_guidance,
      };
    });

    await this.test("tool.run_1c_query_counterparty_contact_info", async () => {
      const result = await okTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 5 Ссылка, Тип, Вид, Представление, Страна, Регион, Город ИЗ Справочник.Контрагенты.КонтактнаяИнформация ГДЕ Тип = ЗНАЧЕНИЕ(Перечисление.ТипыКонтактнойИнформации.Адрес)",
        limit: 5,
        include_column_types: true,
      });
      assert(result.rows?.length > 0, "expected at least one counterparty address");
      const first = result.rows[0];
      assertRef(first.Ссылка, "counterparty contact row ref");
      assert(first.Представление, "address presentation must be present");
      this.context.counterpartyRef = first.Ссылка;
      return { rows: result.rows.length, firstAddress: first.Представление, firstRef: first.Ссылка };
    });

    await this.test("tool.run_1c_query_reference_encoding", async () => {
      const result = await okTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, УникальныйИдентификатор(Ссылка) КАК UUID, Наименование ИЗ Справочник.Организации УПОРЯДОЧИТЬ ПО Наименование",
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      assert(row, "expected one organization row");
      assertRef(row.Ссылка, "organization query ref");
      assert(row.Ссылка.uuid === row.UUID, "encoded ref uuid must match query UUID column");
      this.context.organizationRef = row.Ссылка;
      return { ref: row.Ссылка, name: row.Наименование };
    });
  }

  async referenceTests() {
    await this.test("tool.search_objects_returns_structured_refs", async () => {
      const result = await okTool(this.client, "search_objects", {
        query: "Автотрейд",
        types: ["Справочник.Контрагенты"],
        limit: 3,
        include_fields: ["Код", "Наименование", "ИНН", "КПП"],
      });
      assert(result.matches?.length > 0, "expected at least one search match");
      assertRef(result.matches[0].ref, "search_objects ref");
      this.context.counterpartyRef ||= result.matches[0].ref;
      return { matches: result.matches.length, first: result.matches[0].ref };
    });

    await this.test("tool.get_object_by_ref_with_tabular_section", async () => {
      const ref = requireContextRef(this.context.counterpartyRef, "counterpartyRef");
      const result = await okTool(this.client, "get_object_by_ref", {
        type: ref.type,
        uuid: ref.uuid,
        fields: ["Код", "Наименование", "ИНН", "КПП"],
        include_standard_fields: true,
        include_tabular_sections: true,
        tabular_sections: ["КонтактнаяИнформация"],
        tabular_section_row_limit: 5,
      });
      assert(result.found === true, "object must be found");
      assertRef(result.object?.ref, "get_object_by_ref object.ref");
      assert(result.object?.tabular_sections?.КонтактнаяИнформация, "КонтактнаяИнформация tabular section must be returned");
      return {
        ref: result.object.ref,
        fields: Object.keys(result.object.fields || {}),
        contactRows: result.object.tabular_sections.КонтактнаяИнформация.length,
      };
    });

    await this.test("tool.find_object_by_id", async () => {
      const ref = requireContextRef(this.context.counterpartyRef, "counterpartyRef");
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
      const ref = requireContextRef(this.context.counterpartyRef, "counterpartyRef");
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
      const ref = requireContextRef(this.context.organizationRef || this.context.counterpartyRef, "organizationRef/counterpartyRef");
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
      const ref = requireContextRef(this.context.counterpartyRef, "counterpartyRef");
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
      const result = await okTool(this.client, "get_enum_values", {
        type: "Перечисление.ТипыКонтактнойИнформации",
        include_empty: true,
        include_order: true,
        limit: 10,
      });
      assert((result.values || []).some((item) => item.name === "Адрес"), "Адрес enum value must be present");
      return { values: result.values.map((item) => item.name) };
    });

    await this.test("tool.get_register_records_records_mode", async () => {
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрСведений",
        register: "ЦеныНоменклатуры",
        mode: "records",
        limit: 2,
      });
      assert(result.register === "РегистрСведений.ЦеныНоменклатуры", "unexpected register name");
      assert(result.rows?.length > 0, "expected register rows");
      assertRef(result.rows[0].Номенклатура, "register row Номенклатура ref");
      return { rows: result.rows.length, truncated: result.truncated, nextCursor: result.next_cursor };
    });

    await this.test("tool.get_register_records_bad_mode_is_diagnostic", async () => {
      const result = await rawTool(this.client, "get_register_records", {
        register_type: "РегистрСведений",
        register: "ЦеныНоменклатуры",
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
      const result = await okTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, УникальныйИдентификатор(Ссылка) КАК UUID, Номер, Дата ИЗ Документ.ОтчетПроизводстваЗаСмену УПОРЯДОЧИТЬ ПО Дата УБЫВ",
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      assert(row, "expected one production report document");
      assertRef(row.Ссылка, "document query ref");
      this.context.documentRef = row.Ссылка;
      return { ref: row.Ссылка, number: row.Номер, date: row.Дата };
    });

    await this.test("tool.get_document_movements", async () => {
      const ref = requireContextRef(this.context.documentRef, "documentRef");
      const result = await okTool(this.client, "get_document_movements", {
        document_type: ref.type,
        uuid: ref.uuid,
        row_limit_per_register: 2,
        include_empty_registers: false,
      });
      assert(result.found === true, "document movements target must be found");
      assertRef(result.document, "get_document_movements document");
      assert(result.movements?.length > 0, "expected document movements");
      return { registers: result.movements.map((item) => item.register), truncated: result.truncated };
    });
  }

  async reportTests() {
    await this.test("tool.list_reports", async () => {
      const result = await okTool(this.client, "list_reports", {
        query: "Анализ",
        include_variants: true,
        limit: 5,
      });
      assert(result.reports?.length > 0, "expected reports");
      const report = result.reports[0];
      assert(report.type?.startsWith("Отчет."), "report type must be full metadata name");
      this.context.reportType = report.type;
      this.context.reportVariant = report.variants?.[0]?.name || "Основной";
      return { reports: result.reports.map((item) => item.type), firstVariant: this.context.reportVariant };
    });

    await this.test("tool.get_report_info", async () => {
      const report = this.context.reportType || "Отчет.АнализВерсийОбъектов";
      const result = await okTool(this.client, "get_report_info", {
        report,
        include_schema: false,
        include_variants: true,
        include_default_settings: false,
      });
      assert(result.report === report, "report_info returned different report");
      assert(Array.isArray(result.variants), "variants must be an array");
      return { report: result.report, variants: result.variants };
    });

    await this.test("tool.run_1c_report_graceful", async () => {
      const report = this.context.reportType || "Отчет.АнализВерсийОбъектов";
      const variant = this.context.reportVariant || "Основной";
      const result = await okTool(this.client, "run_1c_report", {
        report,
        variant,
        output_format: "table",
        limit: 3,
        timeout_seconds: 30,
      });
      assert(result.report === report, "run_1c_report returned different report");
      assert("execution_supported" in result, "execution_supported must be present");
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
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.КонтактнаяИнформация",
        strict: true,
        explain: true,
      });
      assert(result.valid === false, `validate must reject missing metadata, got valid=true with detected=${JSON.stringify(result.detected_objects)}`);
      assert((result.errors || []).some((error) => error.code === "metadata_not_found"), `metadata_not_found error is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    await this.test("negative.run_missing_metadata_is_diagnostic", async () => {
      const result = await rawTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.КонтактнаяИнформация",
        limit: 1,
      });
      assert(result.ok === false, "missing metadata query must fail");
      assert(result.error?.message?.includes("Таблица не найдена") || result.error?.details?.parsed_details?.raw_exception?.includes("Таблица не найдена"), "must include raw table-not-found diagnostics");
      return { errorCode: result.error?.code, message: result.error?.message };
    });

    await this.test("negative.validate_forbidden_keyword", async () => {
      const result = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ Ссылка ПОМЕСТИТЬ ВТ ИЗ Справочник.Контрагенты",
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "forbidden keyword query must be invalid");
      assert((result.errors || []).some((error) => error.code === "forbidden_keyword"), "forbidden_keyword error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.get_object_by_ref_bad_uuid", async () => {
      const result = await rawTool(this.client, "get_object_by_ref", {
        type: "Справочник.Контрагенты",
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

async function okTool(client, name, args) {
  const result = await rawTool(client, name, args);
  assert(result?.ok === true, `${name} returned ok=false: ${JSON.stringify(result?.error || result).slice(0, 1200)}`);
  return result;
}

async function rawTool(client, name, args) {
  const { result } = await client.callTool(name, args);
  return unwrapToolResult(result);
}

function unwrapToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const text = result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string")?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return result;
    }
  }

  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const client = new McpHttpClient(options);
  const runner = new ContractRunner(client, options);
  const summary = await runner.run();
  if (options.out) {
    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`Report written: ${out}`);
  }
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(formatError(error).message);
  if (error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
