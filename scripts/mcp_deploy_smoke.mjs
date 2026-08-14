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
import { СЛУЖЕБНЫЙ_ПРЕФИКС } from "./mcp_fixtures.mjs";

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

// Длина тела последнего запроса в символах — тем же счётом, каким её пишет
// сервер (СтрДлина по телу). Единственный ключ связывания записи MCP.http_request
// со своим вызовом: correlation_id в HTTP-записи не пишется по конструкции.
export let последнийРазмерТелаЗапроса = 0;

async function rpc(options, method, params) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  последнийРазмерТелаЗапроса = payload.length;
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
// Правило исключения служебных объектов MCP переехало в scripts/mcp_fixtures.mjs:
// оно было написано здесь, а в контракт-тесте отсутствовало — одна и та же ловушка
// закрыта в одном месте и открыта в другом. Теперь источник один (ТЗ-2 R-1).

async function discoverFixtures(options) {
  const fixtures = { catalog: null, tabularOwner: null, tabularSection: null, register: null, chart: null,
    informationRegister: null };

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

  // Регистр бухгалтерии берётся из перечисления метаданных, а НЕ из паспорта:
  // с 14.08 паспорт состава регистров не отдаёт вовсе (секция accounting_registers
  // удалена вместе с пробами данных). Перечисление здесь и дешевле — паспорт для
  // этой фикстуры перебирал регистры запросами.
  const accountingRegisters = await callTool(options, "list_metadata_objects",
    { kinds: ["РегистрБухгалтерии"], limit: 5 });
  fixtures.register = (accountingRegisters?.objects ?? [])[0]?.full_name ?? null;

  const charts = await callTool(options, "list_metadata_objects", { kinds: ["ПланСчетов"], limit: 5 });
  fixtures.chart = (charts?.objects ?? [])[0]?.full_name ?? null;

  // Регистр сведений нужен маркеру MCP_Query: текст правила основной таблицы
  // обязан говорить на языке ЭТОГО вида регистра, а не бухгалтерии.
  const infoRegisters = await callTool(options, "list_metadata_objects", { kinds: ["РегистрСведений"], limit: 20 });
  for (const item of infoRegisters?.objects ?? []) {
    if (!item?.full_name) continue;
    if (СЛУЖЕБНЫЙ_ПРЕФИКС.test(item.full_name)) continue;
    fixtures.informationRegister = item.full_name;
    break;
  }

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
    // 074c1e0 — correlation_id в успешном ответе: связка «ответ → запись аудита»
    // перестала быть привилегией упавших вызовов. Проверяется ниже вторым
    // условием этого же маркера, поэтому since двигается вместе с модулем (#92).
    //
    // since=2e66706: правка добавила экспортную пробу ПоддерживаетЗамерСтадийИмпл.
    // Своего наблюдаемого признака у неё НЕТ ПО КОНСТРУКЦИИ — на полном комплекте
    // поведение тождественно прежнему, проба различима только при рассинхроне с
    // MCP_Query. Свежесть этой волны публикации доказывает маркер MCP_HTTPService
    // (ранний отказ несёт stages), а совместность комплекта — правило манифеста:
    // модули публикуются атомарно. Двигать since без такой оговорки нельзя —
    // иначе маркер утверждал бы то, чего не проверяет.
    //
    // since=fb5440b: волна паспорта 14.08 добавила в модуль регистрацию и схему
    // get_database_passport_full и переписала схему сокращённого. Своего признака у
    // этого маркера нет — он про stage и correlation_id, — но публикацию модуля
    // доказывает маркер MCP_Tools_Impl «паспорт пересобран»: незарегистрированный в
    // MCP_Tools тул вернул бы unknown_tool, то есть проверка тула проверяет и схему.
    //
    // since=df9be84: ревизия 2026-08-14.2 сменила контракт конверта — состав
    // privacy.config_warnings заменён счётчиком. Признак свой и наблюдаемый прямо,
    // проверяется третьим условием ниже. Коммит сам требовал маркера («контракт
    // ответа изменился после публикации .14.1, поэтому маркер обязан различать
    // сборки»), но маркер тогда не тронули — отсюда красный аудит свежести.
    // since=7635ab7: правка описания get_audit_log (метрики размера в контракте
    // инструмента). Своего признака у этого маркера снова нет, но публикацию
    // MCP_Tools доказывает условие query_chars у маркера стадий MCP_Audit: поле
    // проходит через схему инструмента, и старый MCP_Tools его бы не объявил.
    since: "7635ab7",
    what: "stage при отказе; correlation_id в успешном ответе; предупреждения политики счётчиком",
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
      if (!stage) {
        return { status: "fail", note: `stage отсутствует и на верхнем уровне, и в error (ключи: ${Object.keys(r ?? {}).join(", ") || "нет"})` };
      }
      // Вторая половина маркера: успешный ответ несёт id своей записи аудита.
      // Без него get_audit_log не может точечно выбрать запись своего же вызова.
      const okCall = await callTool(options, "get_current_user_context", {});
      if (okCall?.ok !== true) {
        return { status: "fail", note: "get_current_user_context не ответил ok=true для проверки correlation_id" };
      }
      if (typeof okCall.correlation_id !== "string" || okCall.correlation_id.length === 0) {
        return { status: "fail", note: "в успешном ответе нет correlation_id — опубликован MCP_Tools до правки" };
      }
      // Третья половина (df9be84): конверт отдаёт предупреждения политики счётчиком,
      // а не составом. Признак парный по конструкции — мало увидеть счётчик, надо
      // убедиться, что состав НЕ уехал наружу и что он доступен там, куда указывает
      // сам ответ. Иначе «починка сокрытием» прошла бы за исправление.
      const паспорт = await callTool(options, "get_database_passport", {});
      const pv = паспорт?.privacy ?? {};
      if (typeof pv.config_warnings_count !== "number") {
        return { status: "fail", note: "в паспорте нет privacy.config_warnings_count — опубликован MCP_Tools до 2026-08-14.2" };
      }
      if (Array.isArray(pv.config_warnings)) {
        return { status: "fail", note: `состав предупреждений политики всё ещё в ответе паспорта (${pv.config_warnings.length} строк) — правка .14.2 не опубликована` };
      }
      const состав = (okCall?.privacy?.config_warnings ?? []).length;
      if (pv.config_warnings_count !== состав) {
        return { status: "fail", note: `счётчик ${pv.config_warnings_count} не сходится с составом в get_current_user_context (${состав})` };
      }
      return { status: "pass", note: `stage=${stage}, correlation_id есть, предупреждений политики ${состав} счётчиком` };
    },
  },
  {
    module: "MCP_Query",
    // 9d2a227 — таймер запроса переведён на миллисекунды; маркер миллисекунд
    // отдельный (MCP_Audit), здесь двигается только доказательство свежести файла.
    //
    // since=84152ff: текст правила основной таблицы разделён по виду регистра.
    // В отличие от прошлой правки (условная вставка _perf, не наблюдаемая на полном
    // комплекте) эта наблюдаема прямо — вторым условием маркера ниже.
    // since=a93f799: правка запрета данных в журнале тронула четыре записи ЖР в
    // этом модуле (execute_failed, pre_flight_resolution, privacy_*_failed).
    // Наблюдаемого снаружи признака у неё нет — тексты ушли ИЗ журнала, а журнал
    // наружу и не отдавался. Свежесть комплекта доказывают ревизия 2026-08-14.3
    // (MCP_Config, явная сверка) и query_chars у маркера стадий; содержимое самих
    // записей проверяется просмотром ЖР изнутри 1С. Возможность маркера прежняя.
    since: "a93f799",
    what: "объявленное исключение // СТАНДАРТ-ИСКЛЮЧЕНИЕ признаётся",
    async run(options, fixtures) {
      if (!fixtures.register) return { status: "skip", note: "в базе нет регистра бухгалтерии" };
      const query = "ВЫБРАТЬ ПЕРВЫЕ 1 Рег.Период КАК Период\n"
        + "// СТАНДАРТ-ИСКЛЮЧЕНИЕ: base_register_table_without_vt_check — маркер деплой-гейта, "
        + "проверяется признание объявленного исключения\n"
        + `ИЗ ${fixtures.register} КАК Рег`;
      const r = await callTool(options, "validate_1c_query", { query, strict: true, explain: true });
      const codes = (r?.errors ?? []).map((item) => item.code);
      if (r?.valid !== true) {
        return { status: "fail", note: `valid=${r?.valid}, codes: ${codes.join(", ") || "нет"}` };
      }

      // Второе условие: текст правила обязан говорить на языке ТОГО ЖЕ вида
      // регистра. Прежний текст был написан для бухгалтерии и приходил в том числе
      // на регистр сведений, где нет ни Обороты, ни ДвиженияССубконто, ни субконто.
      // Это и есть наблюдаемый признак публикации правки: сообщение адресное.
      if (!fixtures.informationRegister) {
        return { status: "pass", note: "исключение признано (регистра сведений нет — текст правила не проверен)" };
      }
      const свед = await callTool(options, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Рег.Период КАК Период ИЗ ${fixtures.informationRegister} КАК Рег`,
        strict: true,
      });
      const текст = (свед?.errors ?? [])
        .filter((item) => item.code === "base_register_table_without_vt_check")
        .map((item) => String(item.message ?? "")).join(" ");
      if (!текст) {
        return { status: "pass", note: "исключение признано (правило на регистре сведений не сработало)" };
      }
      if (/ДвиженияССубконто|субконто/i.test(текст)) {
        return { status: "fail", note: "текст правила для регистра сведений говорит про субконто и"
          + " ДвиженияССубконто — опубликован MCP_Query ДО разделения сообщения по виду регистра" };
      }
      if (!/СрезПоследних|СрезПервых/i.test(текст)) {
        return { status: "fail", note: "текст правила для регистра сведений не называет СрезПоследних/СрезПервых" };
      }
      return { status: "pass", note: "исключение признано; текст правила адресован виду регистра" };
    },
  },
  {
    module: "MCP_Tools_Impl",
    // ff68c4e добавил в модуль обёртку GetAuditLog — её публикацию доказывает не
    // этот маркер, а маркер MCP_Audit «тайминги аудита читаются наружу»: вызов
    // get_audit_log проходит через MCP_Tools_Impl.GetAuditLog, со старым модулем
    // он падал бы unknown_tool. Здесь двигается только since (кейс R-8 ТЗ по #92:
    // возможность модуля проверяется маркером другого модуля).
    // since=84152ff: паспорт объявляет исключение в своих запросах и не вкладывает
    // payload валидации в предупреждения. Своего дешёвого признака у правки нет —
    // проверка стоит полного вызова паспорта (около минуты), для смоук-гейта это
    // дорого. Публикацию волны доказывает маркер MCP_Query (текст правила по виду
    // регистра), совместность комплекта — правило манифеста.
    //
    // 14.08: оговорка выше исчерпана — у паспорта появился свой мгновенный маркер
    // (см. «паспорт пересобран» ниже), потому что запросов к данным он больше не
    // делает. Этот маркер остаётся на карте счетов: она к паспорту не относится и
    // проверяет другую половину модуля. Кейс контракт-теста
    // get_database_passport_no_self_rejection снят вместе с предметом — собственных
    // запросов к данным у паспорта нет, значит нет и класса «сервер зарезал сам себя».
    //
    // since=fb5440b: модуль правлен волной паспорта. Карта счетов к паспорту не
    // относится и своим признаком его свежесть не доказывает — это делает соседний
    // маркер «паспорт пересобран» на том же модуле.
    since: "fb5440b",
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
    module: "MCP_Tools_Impl",
    // Паспорт пересобран 14.08: два инструмента, ни один не обращается к данным.
    // Прежняя правка паспорта своего дешёвого признака не имела — проверка стоила
    // полного вызова около минуты, и маркер модуля держался на карте счетов. Теперь
    // признак мгновенный и ПАРНЫЙ: новый тул объявлен в схеме (MCP_Tools) и отвечает
    // новым составом (MCP_Tools_Impl). Со старой публикацией любая половина падает:
    // unknown_tool на полном паспорте либо секции данных в сокращённом.
    since: "fb5440b",
    what: "паспорт пересобран: перепись метаданных отвечает, сокращённый без данных",
    async run(options) {
      const полный = await callTool(options, "get_database_passport_full", {});
      const счетчики = полный?.metadata_counts;
      if (!счетчики || typeof счетчики !== "object") {
        return { status: "fail", note: `get_database_passport_full не отдал metadata_counts`
          + ` (${полный?.error_code ?? полный?.error?.error_code ?? "нет кода"}) — модуль до пересборки паспорта` };
      }
      const видов = Object.keys(счетчики).length;
      if (видов !== 11) {
        return { status: "fail", note: `в metadata_counts ${видов} видов вместо 11` };
      }
      // Вторая половина: сокращённый данных больше не отдаёт. Проверяется отсутствие
      // КЛЮЧЕЙ — пустой массив organizations означал бы, что секция жива.
      const кратко = await callTool(options, "get_database_passport", {});
      const данные = ["organizations", "data_period", "accounting_registers", "closed_periods"]
        .filter((ключ) => кратко?.[ключ] !== undefined);
      if (данные.length > 0) {
        return { status: "fail", note: `сокращённый паспорт вернул данные: ${данные.join(", ")}`
          + " — опубликован MCP_Tools_Impl до пересборки" };
      }
      const регистры = счетчики.РегистрыСведений ?? "?";
      return { status: "pass", note: `перепись: 11 видов, регистров сведений ${регистры};`
        + ` сокращённый без секций данных, символов ${JSON.stringify(кратко ?? {}).length}` };
    },
  },
  {
    module: "MCP_Config",
    // Свежесть ЭТОГО модуля доказывает не маркер, а явная сверка ревизии выше
    // (privacy.engine_revision == РевизияPrivacyДвижка рабочего дерева): ревизия
    // живёт именно здесь, поэтому проверка сильнее любого поведенческого признака.
    // since=fb5440b: ревизия поднята до 2026-08-14.1 волной паспорта; сверка ревизии
    // выше и есть доказательство свежести этого модуля.
    // since=df9be84: ревизия поднята до 2026-08-14.2 (предупреждения политики
    // счётчиком). Довод прежний и он сильнее поведенческого признака: ревизия живёт
    // в этом модуле, значит сверка `код == контур` доказывает его свежесть точно.
    // since=9a38576: ревизия поднята до 2026-08-14.3 (запрет данных в журнале).
    // Довод тот же и он здесь самый сильный: ревизия живёт в этом модуле, поэтому
    // явная сверка `код == контур` доказывает его свежесть точно — а для правки,
    // невидимой снаружи, это вообще единственный внешний маркер.
    since: "9a38576",
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
    // since=fb5440b: сам справочник волной паспорта не менялся, но свежесть маркера
    // считается по пути MCP_Config.bsl (см. path ниже), а тот правлен ревизией.
    // since=df9be84: по той же причине — ревизия .14.2 снова тронула MCP_Config.bsl.
    // since=9a38576: и снова, ревизией .14.3 (запрет данных в журнале).
    // Справочник от этого не изменился; движется только отметка свежести пути.
    since: "9a38576",
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
    // Правка 91b31af (рубильник гасит первый эшелон) наблюдаема только при
    // непустой политике И выключенном рубильнике — состояние контура, а не
    // свойство сборки, поэтому маркером её не проверить. Свежесть выводится из
    // ревизии и правила атомарной публикации комплекта (манифест): MCP_Security
    // выкладывается вместе с MCP_Config, чью ревизию гейт сверяет точно.
    since: "91b31af",
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
  {
    module: "MCP_Audit",
    // since=7635ab7: возможность маркера прежняя (миллисекундный таймер), но
    // модуль правился позже — запретом данных в журнале (a93f799) и метриками
    // размера (7635ab7). Свежесть ЭТОЙ правки доказывает маркер стадий ниже,
    // условием query_chars; здесь отметка двигается, чтобы аудит #92 не считал
    // маркер устаревшим при живой проверке.
    since: "7635ab7",
    what: "duration_ms измеряется в миллисекундах, а не в секундах",
    async run(options, fixtures) {
      if (!fixtures.catalog) return { status: "skip", note: "нет справочника для замера" };
      // Прежняя сборка считала длительность как разность ДАТ (секундная точность),
      // умноженную на 1000, поэтому физически умела вернуть только кратные 1000.
      // Значение строго внутри (0, 1000) старая сборка выдать не может — это признак.
      // Признак парный по конструкции: duration_ms собирает MCP_Query через единый
      // таймер MCP_Audit, поэтому старым может оказаться любой из двух модулей.
      const пробы = [];
      for (let i = 0; i < 3; i += 1) {
        const начало = Date.now();
        const r = await callTool(options, "run_1c_query", {
          query: `ВЫБРАТЬ ПЕРВЫЕ 100 Т.Ссылка КАК Ссылка ИЗ ${fixtures.catalog} КАК Т`,
          limit: 100,
        });
        if (typeof r?.duration_ms === "number") пробы.push({ d: r.duration_ms, rtt: Date.now() - начало });
      }
      if (пробы.length === 0) return { status: "fail", note: "run_1c_query не вернул duration_ms" };
      const показ = пробы.map((p) => `${p.d}/rtt ${p.rtt}`).join(", ");
      if (пробы.some((p) => p.d > 0 && p.d % 1000 !== 0)) {
        return { status: "pass", note: `duration_ms=${показ} — миллисекундный таймер опубликован` };
      }
      // Кратные 1000 при round-trip меньше секунды невозможны у новой сборки:
      // серверная часть не может быть длиннее полного обмена.
      if (пробы.some((p) => p.d >= 1000 && p.rtt < 1000)) {
        return { status: "fail", note: `duration_ms=${показ} — секундное квантование при коротком обмене:`
          + " опубликован старый таймер (MCP_Audit либо MCP_Query)" };
      }
      // Ноль — обычный ответ СТАРОЙ сборки: секундная точность не крадёт долю
      // секунды, а обнуляет её. Замер 12.08 на BUH: duration_ms=0 при обмене
      // 484-833 мс. Миллисекундный таймер при таком обмене нулём ответить не
      // может — серверная часть заведомо длиннее миллисекунды.
      const ОБМЕН_ДОКАЗЫВАЮЩИЙ_МС = 300;
      if (пробы.some((p) => p.d === 0 && p.rtt >= ОБМЕН_ДОКАЗЫВАЮЩИЙ_МС)) {
        return { status: "fail", note: `duration_ms=${показ} — ноль при обмене от`
          + ` ${ОБМЕН_ДОКАЗЫВАЮЩИЙ_МС} мс: опубликован секундный таймер (MCP_Audit либо MCP_Query)` };
      }
      return { status: "skip", note: `duration_ms=${показ} — обмен слишком короткий, чтобы отличить`
        + " миллисекундный ноль от секундного: повторить на прогретом контуре" };
    },
  },
  {
    module: "MCP_Audit",
    // since=7635ab7: та же причина, что у соседнего маркера миллисекунд —
    // возможность прежняя, отметка свежести двигается за модулем.
    since: "7635ab7",
    what: "тайминги аудита читаются наружу: tool get_audit_log",
    async run(options) {
      // Маркер парный по конструкции: имя события собирается из реестра
      // инструментов, поэтому старый MCP_Tools (без ИменаИнструментов) обвалит
      // выборку до отказов, а старый MCP_Audit не знает самого метода чтения.
      const r = await callTool(options, "get_audit_log", { minutes_back: 5, limit: 5 });
      if (r?.ok !== true) {
        return { status: "fail", note: `${r?.error_code ?? "нет ok"}: ${String(r?.message ?? "").slice(0, 100)}` };
      }
      if (r.source_available !== true) {
        // Право просмотра журнала — свойство пользователя, а не свежести сборки.
        return { status: "skip", note: "source_available=false: нет права просмотра журнала регистрации" };
      }
      if (!Array.isArray(r.events) || !Array.isArray(r.by_tool)) {
        return { status: "fail", note: "ответ без массивов events/by_tool — опубликован неполный комплект" };
      }
      // Утечка аргументов — не косметика: журнал хранит текст запроса без маскирования.
      const утечка = (r.events ?? []).find((e) => ["arguments", "raw_json", "message"]
        .some((k) => Object.prototype.hasOwnProperty.call(e, k)));
      if (утечка) {
        return { status: "fail", note: "событие аудита отдаёт аргументы или текст ошибки — маска обойдена" };
      }
      // Правка 2eea2fa: outcome действует и на HTTP-слой. До неё outcome:"error"
      // возвращал все успешные MCP.http_request — имя события исхода не кодирует,
      // и фильтр применялся только к событиям инструментов.
      const ошибки = await callTool(options, "get_audit_log",
        { minutes_back: 60, outcome: "error", include_http: true, limit: 100 });
      if (ошибки?.ok !== true) {
        return { status: "fail", note: `outcome:"error" вернул ${ошибки?.error_code ?? "не ok"}` };
      }
      const штатные = (ошибки.events ?? []).filter((e) => e.kind === "http_request"
        && ["success", "notification", "method_not_allowed"].includes(e.outcome));
      if (штатные.length > 0) {
        return { status: "fail", note: `outcome:"error" отдал ${штатные.length} штатных HTTP-записей — опубликован MCP_Audit до правки фильтра` };
      }
      return { status: "pass", note: `events=${r.events.length}, scanned=${r.scanned_events}, фильтр исхода на HTTP держит` };
    },
  },
  {
    module: "MCP_Audit",
    // since=7635ab7: правка запрета данных в журнале (a93f799) наблюдаемого
    // признака не имеет по конструкции, поэтому её доказывает СЛЕДСТВИЕ —
    // метрики размера в выдаче, добавленные 7635ab7. Условие ниже.
    since: "7635ab7",
    what: "профилирование стадий и метрики размера: stages/counters + query_chars, ответ — нет ключа _perf",
    async run(options, fixtures) {
      // Маркер парный по конструкции (правило #92): stages пишет связка
      // MCP_Tools+MCP_Query+MCP_Audit, читает наружу MCP_Audit, а q_* добавляет
      // MCP_Query — старым может оказаться любой модуль комплекта, и разбивка
      // просто исчезнет (все обёртки замера — no-op с фолбэком). Поэтому
      // проверяется наблюдаемое поведение: запись СВОЕГО вызова содержит стадии
      // обоих слоёв. Вторая половина маркера — контракт ответа (R-4): служебный
      // ключ _perf в ответ клиенту не просачивается (новый MCP_Query со старым
      // MCP_Tools отдал бы его).
      if (!fixtures.catalog) return { status: "skip", note: "нет справочника для замера" };
      const r = await callTool(options, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 20 Т.Ссылка КАК Ссылка ИЗ ${fixtures.catalog} КАК Т`,
        limit: 20,
      });
      if (r?.ok !== true) return { status: "fail", note: `run_1c_query не ответил ok=true (${r?.error_code ?? ""})` };
      if (Object.prototype.hasOwnProperty.call(r, "_perf")) {
        return { status: "fail", note: "в ответе клиенту остался служебный ключ _perf — опубликован новый MCP_Query со старым MCP_Tools" };
      }
      if (typeof r.correlation_id !== "string" || r.correlation_id.length === 0) {
        return { status: "fail", note: "нет correlation_id — запись аудита не выбрать точечно" };
      }
      await new Promise((s) => setTimeout(s, 1500));
      const audit = await callTool(options, "get_audit_log", {
        minutes_back: 10, correlation_id: r.correlation_id, include_http: false, limit: 5,
      });
      if (audit?.ok !== true) return { status: "fail", note: `get_audit_log: ${audit?.error_code ?? "нет ok"}` };
      if (audit.source_available !== true) {
        return { status: "skip", note: "source_available=false: нет права просмотра журнала регистрации" };
      }
      const event = (audit.events ?? []).find((e) => e.kind === "tool");
      if (!event) return { status: "fail", note: "запись своего вызова не найдена по correlation_id" };
      const stages = event.stages;
      if (!stages || typeof stages !== "object") {
        return { status: "fail", note: "в событии аудита нет stages — опубликован старый комплект замера (MCP_Audit/MCP_Tools)" };
      }
      const toolMissing = ["access_check", "tool_impl", "masking", "serialize"].filter((k) => stages[k] === undefined);
      if (toolMissing.length > 0) {
        return { status: "fail", note: `stages без стадий слоя вызова: ${toolMissing.join(", ")} — MCP_Tools старый` };
      }
      if (stages.q_db_execute === undefined || stages.q_encode_rows === undefined) {
        return { status: "fail", note: "stages без q_db_execute/q_encode_rows — MCP_Query старый" };
      }
      const counters = event.counters ?? {};
      if (counters.q_ref_cells === undefined) {
        return { status: "fail", note: "counters без q_ref_cells — MCP_Values или MCP_Query старый" };
      }
      // Запрет данных в журнале (2026-08-14.3). Сама правка снаружи не наблюдаема
      // ничем: arguments и error.message get_audit_log не отдавал и до неё. Поэтому
      // наблюдаемым признаком служит то, ЧЕМ заменили аргументы в записи — метрики
      // размера. У старой сборки в событии лежал сырой JSON аргументов, наружу он
      // не шёл, и query_chars у неё взяться неоткуда.
      if (typeof event.query_chars !== "number") {
        return { status: "fail", note: "в событии нет query_chars — MCP_Audit до запрета данных в журнале (2026-08-14.3)" };
      }
      return { status: "pass", note: `стадий: ${Object.keys(stages).length},`
        + ` q_db_execute=${stages.q_db_execute} мс, q_encode_rows=${stages.q_encode_rows} мс,`
        + ` q_ref_cells=${counters.q_ref_cells}, query_chars=${event.query_chars}` };
    },
  },
  {
    module: "MCP_HTTPService",
    // Коммит, которым маркер введён (2e66706 — правка фолбэка HTTP-аудита).
    // «HEAD» здесь стоять не может: аудит свежести сверяет since с последним
    // коммитом модуля, а подвижная ссылка это сравнение обессмысливает.
    // since=a93f799: из MCP.http_service.error убран текст исключения — он
    // цитировал тело запроса. Как и у MCP_Query, признака снаружи нет: событие
    // ошибки транспорта наружу не отдаётся. Возможность маркера прежняя.
    since: "a93f799",
    what: "профилирование транспортного слоя: MCP.http_request несёт stages и response_chars",
    async run(options) {
      // Парный сосед маркера стадий: тот проверяет слой ВЫЗОВА и потому доказывает
      // свежесть MCP_Audit/MCP_Tools/MCP_Query/MCP_Values, но про транспорт молчит.
      // Старый MCP_HTTPService или MCP_JSONRPC в комплекте — и разбивка http_*/rpc_*
      // молча исчезает при зелёном гейте: болезнь #92 в исходной формулировке.
      // Цена не теоретическая — именно HTTP-слой ловит время, которого нет ни в
      // одном вызове инструмента (разбор JSON-RPC, установка сеанса).
      const probe = await callTool(options, "get_current_user_context", {});
      const размерТела = последнийРазмерТелаЗапроса;
      if (probe?.ok !== true) {
        return { status: "fail", note: "get_current_user_context не ответил ok=true" };
      }
      await new Promise((s) => setTimeout(s, 1500));

      const audit = await callTool(options, "get_audit_log",
        { minutes_back: 10, include_http: true, limit: 200 });
      if (audit?.ok !== true) return { status: "fail", note: `get_audit_log: ${audit?.error_code ?? "нет ok"}` };
      if (audit.source_available !== true) {
        return { status: "skip", note: "source_available=false: нет права просмотра журнала регистрации" };
      }
      // Связывание то же, что в mcp_perf_profile.mjs: по длине своего тела.
      // events отсортированы по дате по убыванию — свежайшее совпадение и есть наше.
      const свои = (audit.events ?? []).filter((e) => e.kind === "http_request"
        && e.request_chars === размерТела);
      if (свои.length === 0) {
        return { status: "fail", note: `запись MCP.http_request с request_chars=${размерТела} не найдена —`
          + " HTTP-аудит не пишется (проверьте MCP.http_audit.failed в журнале)" };
      }
      const запись = свои[0];
      const stages = запись.stages;
      if (!stages || typeof stages !== "object") {
        return { status: "fail", note: "в записи MCP.http_request нет stages —"
          + " опубликован старый MCP_HTTPService" };
      }
      if (stages.rpc_handle === undefined) {
        return { status: "fail", note: "в stages нет rpc_handle — опубликован старый MCP_JSONRPC"
          + ` (есть: ${Object.keys(stages).join(", ")})` };
      }
      if (stages.http_guard === undefined && stages.http_body_read === undefined) {
        return { status: "fail", note: "в stages нет ни http_guard, ни http_body_read —"
          + " опубликован старый MCP_HTTPService" };
      }
      if (запись.response_chars === undefined) {
        return { status: "fail", note: "в записи нет response_chars — опубликован старый"
          + " MCP_HTTPService либо MCP_Audit" };
      }
      // ВТОРАЯ ПОЛОВИНА МАРКЕРА — та, что доказывает публикацию ИМЕННО этой правки.
      //
      // Всё выше проверяет стадии транспорта, а они появились ревизией раньше и на
      // полном комплекте видны и БЕЗ этой правки: такой маркер зелен на старом
      // MCP_HTTPService и потому свежести не доказывает (#92 в чистом виде).
      // Наблюдаемое отличие правки — ранние отказы POST теперь несут накопленные
      // стадии: до неё запись protocol_version_rejected приходила без stages.
      // Запрос шлём БЕЗ заголовка версии протокола — это и есть ранний отказ.
      const отказ = await запросСНеподдерживаемойВерсией(options);
      if (отказ.status < 400) {
        return { status: "fail", note: `запрос с неподдерживаемой версией протокола не отклонён (HTTP ${отказ.status})` };
      }
      await new Promise((s) => setTimeout(s, 1500));
      const журналОтказов = await callTool(options, "get_audit_log",
        { minutes_back: 10, include_http: true, limit: 200, outcome: "protocol_version_rejected" });
      const отказныеЗаписи = (журналОтказов?.events ?? [])
        .filter((e) => e.kind === "http_request" && e.outcome === "protocol_version_rejected");
      if (отказныеЗаписи.length === 0) {
        return { status: "fail", note: "запись protocol_version_rejected не найдена в журнале" };
      }
      const свежийОтказ = отказныеЗаписи[0];
      if (!свежийОтказ.stages || свежийОтказ.stages.http_guard === undefined) {
        return { status: "fail", note: "ранний отказ POST не несёт stages.http_guard —"
          + " опубликован MCP_HTTPService ДО правки фолбэка HTTP-аудита" };
      }

      return { status: "pass", note: `rpc_handle=${stages.rpc_handle} мс,`
        + ` стадий транспорта: ${Object.keys(stages).length},`
        + ` request/response chars: ${запись.request_chars}/${запись.response_chars};`
        + ` ранний отказ несёт http_guard=${свежийОтказ.stages.http_guard} мс` };
    },
  },
];

// Запрос к /rpc с ЗАВЕДОМО НЕПОДДЕРЖИВАЕМОЙ версией протокола — воспроизводит
// ранний отказ protocol_version_rejected.
//
// Именно неподдерживаемая версия, а НЕ отсутствие заголовка: по коду
// ВерсияПротоколаРазрешена пустой заголовок разрешён (Возврат Истина), и запрос
// без него проходит штатно — первая редакция этого маркера ошибалась именно тут.
//
// Отдельная функция, а не флаг у rpc(): rpc() обязан всегда слать корректные
// заголовки, иначе его случайное переиспользование ломало бы прочие маркеры.
function запросСНеподдерживаемойВерсией(options) {
  const target = new URL(options.url);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "1999-01-01",
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
    `src/HTTPServices/${module}.bsl`,
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
