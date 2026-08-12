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

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const SMOKE_QUERY = "ВЫБРАТЬ ПЕРВЫЕ 1 Счет.Код ИЗ ПланСчетов.Хозрасчетный КАК Счет";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    url: process.env.MCP_URL || DEFAULT_URL,
    basic: process.env.MCP_BASIC || "",
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 60000),
    verbose: false,
    baseOnly: false,
    strictMarkers: false,
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
    else if (arg === "--strict-markers") options.strictMarkers = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/mcp_deploy_smoke.mjs [--url URL] [--basic user:pass] [--timeout-ms N] [--verbose] [--base-only] [--strict-markers]");
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

// Транспорт на node:https, а не fetch: undici рвёт connect по жёсткому
// внутреннему таймауту около 10 с, и на нестабильном канале гейт падал
// «fetch failed» при полностью живом контуре — то есть сообщал о неполной
// публикации, которой не было. Здесь таймаут наш (--timeout-ms), плюс повтор
// на транспортных обрывах: они на этом контуре штатное явление.
function httpsRequestOnce(options, payload) {
  const target = new URL(options.url);
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2025-06-18",
    "content-length": Buffer.byteLength(payload),
  };
  if (options.basic) {
    headers.authorization = `Basic ${Buffer.from(options.basic, "utf8").toString("base64")}`;
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: target.pathname + target.search,
      method: "POST",
      headers,
      // Сертификат контура самоподписанный.
      rejectUnauthorized: false,
      timeout: options.timeoutMs,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${options.timeoutMs} ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function rpc(options, method, params) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const попыток = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= попыток; attempt += 1) {
    let response;
    try {
      response = await httpsRequestOnce(options, payload);
    } catch (error) {
      lastError = error;
      if (attempt < попыток) {
        if (options.verbose) console.log(`[smoke-gate] транспорт: ${error.message}, попытка ${attempt + 1}`);
        await new Promise((s) => setTimeout(s, 5000));
        continue;
      }
      throw new Error(`транспорт: ${error.message} (попыток: ${попыток})`);
    }

    const { status, text } = response;
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${status}, non-JSON response: ${text.slice(0, 500)}`);
      }
    }
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${text.slice(0, 500)}`);
    if (json?.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
    return json?.result;
  }

  throw lastError ?? new Error("транспорт: неизвестный сбой");
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
//
// Служебные объекты самого MCP-сервера (MCP_Маскирование, MCP_ПравовыеИсточники и
// т.п.) фикстурами быть НЕ МОГУТ. Их имена смешанного алфавита — латинское «MCP_»
// плюс кириллица, — и правило антиомоглифа `temporary_table_identifier_mixed_script`
// блокирует ЛЮБОЙ запрос к ним, ещё до проверки полей. Латиница сортируется раньше
// кириллицы, поэтому такой объект оказывается первым в discovery и забирает
// фикстуру: маркер предвалидации полей получал mixed_script вместо field_not_found
// и гейт сообщал о неполной публикации, которой не было. (Само ложное срабатывание
// правила на РАЗРЕШИВШЕМСЯ имени объекта конфигурации — отдельный дефект движка
// запросов, вне рамок privacy-каталога.)
const СЛУЖЕБНЫЙ_ПРЕФИКС = /(^|\.)MCP_/u;

async function discoverFixtures(options) {
  const fixtures = { catalog: null, tabularOwner: null, tabularSection: null, register: null, chart: null };

  const catalogs = await callTool(options, "list_metadata_objects", { kinds: ["Справочник"], limit: 40 });
  for (const item of catalogs?.objects ?? []) {
    if (!item?.full_name) continue;
    if (СЛУЖЕБНЫЙ_ПРЕФИКС.test(item.full_name)) continue;
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
// MCP_Tools он проходил, хотя поле stage в ответе отсутствовало. Признак читается там, где
// сервер его действительно отдаёт (верхний уровень и error), а не в error.details.
//
// Маркер — это ПОЛ ревизии, а не полный контракт: он подтверждает, что модуль не старше
// того изменения, которым маркер введён. При добавлении фич маркеры обновляются.
//
// #92. У маркера есть ПОЛЕ `since` — коммит, в котором маркер введён или обновлён под
// последнюю правку своего модуля. Аудит свежести (auditMarkerFreshness) сверяет его с
// последним коммитом, тронувшим модуль: если модуль менялся ПОЗЖЕ маркера, маркер уже
// не доказывает, что опубликована последняя правка. Раньше это было молчаливым
// свойством («маркер — пол ревизии»), и частичная публикация #89 прошла все маркеры.
const MODULE_MARKERS = [
  {
    module: "MCP_Metadata",
    since: "cf08b07",
    what: "предвалидация полей (field_not_found) и машинные признаки типа (is_reference/ref_types, T-3)",
    async run(options, fixtures) {
      if (!fixtures.catalog) return { status: "skip", note: "нет справочника с поддержкой ссылок" };
      const r = await callTool(options, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.ЗаведомоНетТакогоПоляГейта КАК Поле ИЗ ${fixtures.catalog} КАК Т`,
        limit: 1,
      });
      const code = r?.error_code ?? r?.error?.error_code;
      if (code !== "field_not_found") {
        return { status: "fail", note: `ожидался field_not_found, получено: ${code ?? JSON.stringify(r).slice(0, 120)}` };
      }
      // Второй признак — из ПОСЛЕДНЕЙ правки модуля (cf08b07, T-3): рядом с
      // представлением типа публикуются машинные ключи. Проверяется наличие ключа,
      // а не значение: is_reference=false у строкового реквизита законно. Без этой
      // половины маркер оставался «полом» августа и молча не доказывал свежесть (#92).
      const structure = await callTool(options, "get_metadata_structure", {
        type: fixtures.catalog, section: "attributes", limit: 20,
      });
      const attributes = structure?.metadata?.attributes ?? [];
      if (attributes.length === 0) {
        return { status: "pass", note: `field_not_found ок; у ${fixtures.catalog} нет реквизитов для проверки T-3` };
      }
      const без = attributes.filter((item) => item?.is_reference === undefined || item?.ref_types === undefined);
      return без.length === 0
        ? { status: "pass", note: `field_not_found ок; is_reference/ref_types есть у всех ${attributes.length} реквизитов` }
        : { status: "fail", note: `нет ключей is_reference/ref_types у ${без.length} из ${attributes.length} реквизитов`
            + " — MCP_Metadata старее T-3 (cf08b07)" };
    },
  },
  {
    module: "MCP_Tools",
    since: "77d8754",
    what: "stage при отказе до выполнения виден клиенту",
    async run(options, fixtures) {
      if (!fixtures.tabularSection) return { status: "skip", note: "нет справочника с табличной частью" };
      const r = await callTool(options, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка ИЗ ${fixtures.tabularOwner}.ЗаведомоНетТакойТабличнойЧастиГейта КАК Т`,
        limit: 1,
      });
      // stage по контракту лежит на верхнем уровне ответа и в error, а НЕ в error.details:
      // MCP_Tools.bsl копирует его СкопироватьПолеДеталей(Детали, Данные, Ошибка, "stage")
      // именно затем, чтобы признак «движок не вызывался» был виден клиенту. Проверка
      // одного лишь error.details.stage не проходила никогда: гейт возвращал FAIL на
      // корректном контуре и сообщал о неполной публикации, которой не было.
      const stage = r?.stage ?? r?.error?.stage ?? r?.error?.details?.stage;
      return stage
        ? { status: "pass", note: `stage=${stage}` }
        : { status: "fail", note: `stage отсутствует и на верхнем уровне, и в error (ключи: ${Object.keys(r ?? {}).join(", ") || "нет"})` };
    },
  },
  {
    module: "MCP_Query",
    since: "d90c3b9",
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
    since: "77d8754",
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
    module: "MCP_Config",
    since: "764a4c8",
    what: "privacy по типам опубликован: секции type_aliases/type_field_masks и config_warnings",
    async run(options) {
      // Ключи секций отдаёт MCP_Config через MCP_Tools, поэтому маркер ловит
      // и старый MCP_Config, и старый MCP_Tools. Проверять их наличие, а не
      // enabled: при пустой политике privacy штатно выключен.
      const r = await callTool(options, "get_current_user_context", {});
      const privacy = r?.privacy;
      if (!privacy) return { status: "fail", note: "в ответе нет блока privacy — MCP_Tools старый" };
      const missing = ["type_aliases", "type_field_masks", "config_warnings", "config_errors"].filter(
        (key) => privacy[key] === undefined,
      );
      return missing.length === 0
        ? { status: "pass", note: `engine_revision=${privacy.engine_revision ?? "до 2026-08-03.2"},`
            + ` enabled=${privacy.enabled}, предупреждений: ${(privacy.config_warnings ?? []).length}` }
        : { status: "fail", note: `нет ключей: ${missing.join(", ")} — MCP_Config старее privacy по типам` };
    },
  },
  {
    module: "MCP_Маскирование",
    since: "764a4c8",
    // Справочник — объект метаданных, файла модуля у него нет: поведение маркера
    // (уход легаси-ключей, чтение политики) даёт MCP_Config, по нему и сверяется
    // свежесть.
    path: "src/CommonModules/MCP_Config.bsl",
    what: "каталог политики опубликован: легаси-ключей нет, справочник читается",
    async run(options) {
      // Парный маркер каталога политики (ревизия 2026-08-11.1, §7.2 п.5 ТЗ):
      // ревизии недостаточно — она живёт в MCP_Config, а поведение в других
      // модулях (#92). Проверяются оба признака переезда:
      //   1) из privacy-блока УШЛИ ключи organization_aliases/person_aliases —
      //      старый MCP_Config продолжал бы их отдавать;
      //   2) политика справочника читается: config_errors не содержит отказа
      //      «справочник MCP_Маскирование не найден» — новая сборка без
      //      справочника уводит контур в аварийный режим (fail-closed), и
      //      оставлять его так нельзя.
      const r = await callTool(options, "get_current_user_context", {});
      const privacy = r?.privacy;
      if (!privacy) return { status: "fail", note: "в ответе нет блока privacy" };
      const legacy = ["organization_aliases", "person_aliases"].filter(
        (key) => privacy[key] !== undefined,
      );
      if (legacy.length > 0) {
        return { status: "fail", note: `в privacy остались легаси-ключи: ${legacy.join(", ")}`
          + " — MCP_Config старее каталога политики (2026-08-11.1)" };
      }
      const errors = (privacy.config_errors ?? []).map(String);
      const noCatalog = errors.some((text) => text.includes("MCP_Маскирование"));
      if (noCatalog) {
        return { status: "fail", note: "аварийный режим: справочник MCP_Маскирование не опубликован"
          + ` (${errors[0]?.slice(0, 120) ?? ""})` };
      }
      return { status: "pass", note: `engine_revision=${privacy.engine_revision}, легаси-ключей нет,`
        + ` config_errors: ${errors.length}` };
    },
  },
  {
    module: "MCP_Security",
    since: "764a4c8",
    what: "privacy-подмена опубликована и вызовы не блокирует",
    async run(options) {
      // Отказов в контракте нет: MCP_Tools ничего не спрашивает у гейта, а
      // MCP_Security решает закрытость при сборке ответа. Согласованность
      // комплекта доказывает успешный вызов: рассинхрон модулей даёт
      // internal_error на «метод не найден».
      const r = await callTool(options, "get_current_user_context", {});
      if (r?.ok === true) return { status: "pass", note: "вызовы проходят, отказов нет" };
      const code = r?.error_code ?? r?.error?.error_code ?? "";
      return {
        status: "fail",
        note: `вызов не прошёл (${code || "нет кода"}) — вероятен рассинхрон MCP_Security/MCP_Config/MCP_Tools`,
      };
    },
  },
  {
    module: "MCP_Examples",
    since: "7ff5d05",
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

// #92, часть 1: ЯВНАЯ сверка ревизии. Ожидаемое значение берётся не из константы
// скрипта, а из рабочего дерева — `РевизияPrivacyДвижка` в MCP_Config.bsl. Тогда
// гейт отвечает на вопрос «на контуре тот код, что лежит в этой ветке?», а не
// «работает ли что-нибудь». Ревизию публикует только MCP_Config, поэтому проверка
// доказывает свежесть ИМЕННО его — для остальных модулей служат маркеры и аудит
// свежести (часть 2).
function ожидаемаяРевизияИзКода() {
  const path = resolve(REPO_ROOT, "src/CommonModules/MCP_Config.bsl");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { revision: null, note: `MCP_Config.bsl не прочитан (${error?.code || error?.message})` };
  }
  const block = text.split("Функция РевизияPrivacyДвижка()")[1];
  if (!block) return { revision: null, note: "в MCP_Config.bsl нет функции РевизияPrivacyДвижка" };
  const match = block.match(/Возврат\s+"([^"]+)"/u);
  return match
    ? { revision: match[1], note: "" }
    : { revision: null, note: "не разобран литерал ревизии в РевизияPrivacyДвижка" };
}

async function проверитьРевизию(options) {
  const ожидание = ожидаемаяРевизияИзКода();
  const r = await callTool(options, "get_current_user_context", {});
  const наКонтуре = r?.privacy?.engine_revision ?? null;

  if (!ожидание.revision) {
    return { status: "skip", note: `${ожидание.note}; ревизия контура: ${наКонтуре ?? "нет"}` };
  }
  if (!наКонтуре) {
    return { status: "fail", note: `контур не отдаёт engine_revision, а код объявляет ${ожидание.revision}`
      + " — MCP_Config старше ревизионного маркера либо MCP_Tools не публикует privacy-блок" };
  }
  if (наКонтуре !== ожидание.revision) {
    return { status: "fail", note: `рассинхрон: код ${ожидание.revision}, контур ${наКонтуре}`
      + " — опубликован не тот комплект, что в рабочем дереве" };
  }
  return { status: "pass", note: `код и контур на ${наКонтуре}` };
}

// #92, часть 2: аудит свежести маркеров. Маркер доказывает лишь то, что модуль не
// старше СВОЕЙ возможности, и это молчаливо переставало работать, когда модуль
// правили, а маркер — нет: частичная публикация #89 прошла все маркеры.
// Здесь сверяется `since` маркера с последним коммитом, тронувшим файл модуля.
// Аудит не про контур, а про честность гейта, поэтому по умолчанию он
// предупреждает (и говорит об этом в итоге), а падает только по --strict-markers.
function последнийКоммитМодуля(module, явныйПуть = "") {
  const пути = явныйПуть ? [явныйПуть] : [
    `src/CommonModules/${module}.bsl`,
    `src/DataProcessors/${module}/ObjectModule.bsl`,
  ];
  for (const путь of пути) {
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%h %ad", "--date=short", "--", путь], {
        cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        const [sha, date] = out.split(" ");
        return { sha, date, путь };
      }
    } catch {
      // git недоступен или путь вне репозитория — трактуется как «нет данных».
    }
  }
  return null;
}

function коммитСодержит(предок, потомок) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", предок, потомок], {
      cwd: REPO_ROOT, stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function auditMarkerFreshness() {
  const строки = [];
  let устарело = 0;
  let безДанных = 0;

  for (const marker of MODULE_MARKERS) {
    const последний = последнийКоммитМодуля(marker.module, marker.path ?? "");
    if (!marker.since) {
      строки.push({ module: marker.module, verdict: "нет since", note: "маркер не заявляет коммит — свежесть не доказывается" });
      устарело += 1;
      continue;
    }
    if (!последний) {
      строки.push({ module: marker.module, verdict: "нет данных git", note: `since=${marker.since}` });
      безДанных += 1;
      continue;
    }
    // Маркер актуален, если последний коммит модуля ДОСТИЖИМ из since либо совпадает
    // с ним: значит после введения маркера модуль не менялся.
    const актуален = последний.sha === marker.since || коммитСодержит(последний.sha, marker.since);
    if (актуален) {
      строки.push({ module: marker.module, verdict: "актуален", note: `модуль ${последний.sha} (${последний.date}), since=${marker.since}` });
    } else {
      строки.push({
        module: marker.module,
        verdict: "УСТАРЕЛ",
        note: `модуль правился в ${последний.sha} (${последний.date}) после маркера since=${marker.since}`
          + " — маркер не доказывает публикацию последней правки",
      });
      устарело += 1;
    }
  }

  return { строки, устарело, безДанных };
}

async function runMarkers(options) {
  console.log("");
  console.log("[smoke-gate] ревизия движка — сверка рабочего дерева и контура (#92)");
  let ревизия;
  try {
    ревизия = await проверитьРевизию(options);
  } catch (error) {
    ревизия = { status: "fail", note: `исключение: ${error?.message || error}` };
  }
  console.log(`[smoke-gate] ${{ pass: "PASS", fail: "FAIL", skip: "SKIP" }[ревизия.status]} engine_revision   ${ревизия.note}`);

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

  if (ревизия.status === "fail") failed += 1;

  if (failed > 0) {
    console.error(`[smoke-gate] FAIL — проверок не прошло: ${failed}`);
    console.error("[smoke-gate] HINT: публикация неполная. Модуль из строки FAIL старше остальных либо "
      + "не выложен. Опубликуйте весь обязательный комплект (scripts/required_modules.manifest.json) "
      + "одним согласованным набором и повторите гейт.");
  }

  // Аудит свежести печатается ВСЕГДА, в том числе при зелёных маркерах: его смысл —
  // сказать, чего маркеры НЕ доказывают. Молчание здесь и было дефектом #92.
  console.log("");
  console.log("[smoke-gate] аудит свежести маркеров (#92) — что маркеры доказывают");
  const аудит = auditMarkerFreshness();
  for (const строка of аудит.строки) {
    console.log(`[smoke-gate] ${строка.verdict.padEnd(14)} ${строка.module.padEnd(18)} ${строка.note}`);
  }
  if (аудит.устарело > 0) {
    console.log(`[smoke-gate] маркеров, не доказывающих последнюю правку модуля: ${аудит.устарело}`);
    console.log("[smoke-gate] HINT: привяжите маркер к возможности из последней правки модуля и обновите"
      + " его since на коммит этой правки. Пока since старше модуля, зелёный маркер не означает,"
      + " что опубликован актуальный модуль.");
  }
  if (аудит.безДанных > 0) {
    console.log(`[smoke-gate] модулей без данных git: ${аудит.безДанных} (запуск вне репозитория?)`);
  }

  return { failed, skipped, staleMarkers: аудит.устарело };
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
    // Служебные объекты сервера (MCP_Маскирование и родня) исключаются той же
    // причиной, что и в фикстурах маркеров: латиница «MCP_» внутри кириллического
    // имени срабатывает антиомоглифом до проверки полей. Латиница сортируется раньше
    // кириллицы, поэтому такой объект приходит из discovery ПЕРВЫМ и забирал запасной
    // запрос — на ЗУП (нет плана счетов) гейт из-за этого падал с
    // temporary_table_identifier_mixed_script и сообщал о частичной публикации,
    // которой не было. Фильтр в discoverFixtures стоял, в запасном пути — нет.
    const fallback = (catalogs?.objects ?? []).find((item) => item?.full_name
      && item.supports_query !== false
      && !СЛУЖЕБНЫЙ_ПРЕФИКС.test(item.full_name));
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
    const { failed, skipped, staleMarkers } = await runMarkers(options);
    if (failed > 0) {
      process.exitCode = 1;
      return;
    }
    if (staleMarkers > 0 && options.strictMarkers) {
      console.error(`[smoke-gate] FAIL по --strict-markers: маркеров с недоказанной свежестью ${staleMarkers}`);
      process.exitCode = 1;
      return;
    }
    const оговорка = staleMarkers > 0
      ? ` — но ${staleMarkers} маркер(ов) не доказывают последнюю правку своего модуля (см. аудит выше)`
      : "";
    console.log(`[smoke-gate] PASS — маркеры модулей пройдены${skipped ? ` (пропущено по отсутствию фикстур: ${skipped})` : ""}${оговорка}`);
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
