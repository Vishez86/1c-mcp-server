// ВНИМАНИЕ: это текст скрипта в .txt, чтобы не зависеть от порядка мержа PR.
// Перед запуском: скопировать в scripts/post_deploy_verify.mjs (UTF-8, без BOM).
// Требуется node (C:\Program Files\nodejs\node.exe), кириллица только внутри файла,
// не в аргументах PowerShell.

// Проверка после деплоя расширения: PR #59, #63, #65. (#64 по решению
// пользователя не проверяется — у него есть свои контрактные кейсы.)
//
// Покрывает то, что до деплоя проверить было нельзя: 10 серверных правил
// предвалидатора из #63 и три фикса из #65 (issue #60/#61/#62). Для каждого
// правила есть ТРИГГЕР (код обязан появиться) и КОНТРОЛЬ (код обязан
// отсутствовать) — у правил severity=error ложное срабатывание опаснее пропуска,
// поэтому контролей не меньше, чем триггеров.
//
// Запуск:
//   node scripts/post_deploy_verify.mjs
//   node scripts/post_deploy_verify.mjs --json reports/post_deploy_verify.latest.json
//   MCP_URL=https://host/BASE/hs/mcp/rpc node scripts/post_deploy_verify.mjs
//
// Метаданные не захардкожены: справочник, регистр бухгалтерии и ссылочный
// реквизит выясняются через discovery, кейс без нужной фикстуры уходит в SKIP.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { служебныйОбъект } from "./mcp_fixtures.mjs";

const URL_MCP = process.env.MCP_URL || "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const BASIC = process.env.MCP_BASIC || "";
const jsonFlagIndex = process.argv.indexOf("--json");
const JSON_OUT = jsonFlagIndex > -1 ? process.argv[jsonFlagIndex + 1] : "";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "mcp-protocol-version": "2025-06-18",
};
if (BASIC) HEADERS.authorization = `Basic ${Buffer.from(BASIC).toString("base64")}`;

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(URL_MCP, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null, raw: text.slice(0, 500) };
  }
}

async function callTool(name, args) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  if (body?.error) return { ok: false, error: body.error };
  const structured = body?.result?.structuredContent;
  if (structured) return { ok: true, data: structured };
  const textPayload = body?.result?.content?.[0]?.text;
  try {
    return { ok: true, data: JSON.parse(textPayload ?? "null") };
  } catch {
    return { ok: true, data: { raw: textPayload } };
  }
}

const codesOf = (validation) => [
  ...(validation?.errors ?? []).map((item) => item.code),
  ...(validation?.warnings ?? []).map((item) => item.code).filter(Boolean),
];

// ---------------------------------------------------------------- discovery

const fixtures = { catalog: null, accountingRegister: null, refAttribute: null, subcontoChart: null };

async function discover() {
  // Регистр бухгалтерии: поле называется register (не full_name/name).
  //
  // Берётся НЕ первый из паспорта, а первый, чьи Остатки публикуют поля, которыми
  // пользуются контрольные кейсы (ТЗ-2 R-5). Прежний «первый» на ERP давал
  // КорректировкиНалоговойБазы — у него нет ресурса Сумма, и кейс правила
  // vt_filter_in_external_where фильтровал по СуммаОстатокДт, которого в его ВТ не
  // существует. Проверка не могла отличить работающее правило от сломанного и
  // годами стояла с пометкой AWAITING-DEPLOY «ложное срабатывание» (#147).
  // Состав регистров — из перечисления метаданных, а не из паспорта: с 14.08
  // паспорт секции accounting_registers не отдаёт (удалена вместе с пробами данных).
  const списокРегистров = await callTool("list_metadata_objects",
    { kinds: ["РегистрБухгалтерии"], limit: 20 });
  const registers = (списокРегистров.data?.objects ?? []).map((o) => ({ register: o.full_name }));
  const ОБЯЗАТЕЛЬНЫЕ_ПОЛЯ_ОСТАТКОВ = ["Субконто1", "СуммаОстатокДт"];
  for (const item of registers.slice(0, 8)) {
    const имя = item.register;
    if (!имя || служебныйОбъект(имя)) continue;
    const структура = await callTool("get_metadata_structure", {
      type: имя.includes(".") ? имя : `РегистрБухгалтерии.${имя}`,
      include_virtual_tables: true,
    });
    const остатки = (структура.data?.metadata?.register_schema?.virtual_tables ?? [])
      .find((v) => v?.name === "Остатки")?.common_fields ?? [];
    if (!fixtures.accountingRegister) fixtures.accountingRegister = имя; // запас
    if (ОБЯЗАТЕЛЬНЫЕ_ПОЛЯ_ОСТАТКОВ.every((f) => остатки.includes(f))) {
      fixtures.accountingRegister = имя;
      fixtures.accountingRegisterFields = остатки;
      break;
    }
  }

  // Фильтр видов метаданных называется kinds. Незнакомый аргумент сервер молча
  // игнорирует и отдаёт первые объекты подряд, поэтому ошибка в имени параметра
  // проявляется как «подобрался документ вместо справочника».
  const catalogs = await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 50 });
  for (const item of catalogs.data?.objects ?? []) {
    const fullName = item.full_name;
    if (!fullName || item.supports_query === false) continue;
    // Служебные объекты MCP фикстурой быть не могут (ТЗ-2 R-1): латиница
    // сортируется раньше кириллицы, поэтому MCP_Маскирование идёт первым в
    // discovery, а любой запрос к нему блокирует правило mixed_script.
    if (служебныйОбъект(fullName)) continue;
    const structure = await callTool("get_metadata_structure", {
      type: fullName,
      include_standard_attributes: true,
      include_tabular_sections: false,
    });
    const meta = structure.data?.metadata ?? {};
    if (meta.supports_ref !== true) continue;
    if (!fixtures.catalog) fixtures.catalog = fullName;
    // value_types содержит ПРЕДСТАВЛЕНИЯ типов («Юридическое / физическое лицо»), а не
    // полные имена метаданных, поэтому ссылочность по ним не определить. Берём реквизит
    // по имени из набора стандартных ссылочных: они есть в типовых конфигурациях и
    // гарантированно ссылочные.
    const names = new Set((meta.attributes ?? []).filter((a) => a.allowed !== false).map((a) => a.name));
    for (const candidate of ["Родитель", "Владелец", "Ответственный", "Организация", "ГоловнойКонтрагент"]) {
      if (names.has(candidate)) {
        fixtures.catalog = fullName;
        fixtures.refAttribute = candidate;
        break;
      }
    }
    if (fixtures.refAttribute) break;
  }

  // План видов характеристик берём из живой таблицы-компаньона .Субконто:
  // тип значения поля Вид и есть нужный ПВХ, без догадок по имени.
  if (fixtures.accountingRegister) {
    const probe = await callTool("run_1c_query", {
      query: `ВЫБРАТЬ ПЕРВЫЕ 1 С.Вид КАК Вид ИЗ ${fixtures.accountingRegister}.Субконто КАК С`,
      limit: 1,
    });
    fixtures.subcontoChart = probe.data?.rows?.[0]?.Вид?.type ?? null;
  }
}

// ---------------------------------------------------------------- cases

// Гомоглифный идентификатор: кириллические О,А,И с латинскими C,T,K внутри —
// собран из явных кодов, чтобы в файле не было визуально неотличимой строки.
const HOMOGLYPH = "ВТОCTАTKИ";

function buildCases() {
  const cases = [];
  const catalog = fixtures.catalog;
  const register = fixtures.accountingRegister;
  const chart = fixtures.subcontoChart;
  const refAttr = fixtures.refAttribute;

  const add = (entry) => cases.push(entry);

  // ---------------- #63: style_yo_letter_forbidden
  add({
    pr: "#63", rule: "style_yo_letter_forbidden", kind: "триггер",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Счёт ИЗ ${catalog} КАК Т`,
    expectCode: "style_yo_letter_forbidden",
  });
  add({
    pr: "#63", rule: "style_yo_letter_forbidden", kind: "контроль: Ё только в литерале",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${catalog} КАК Т ГДЕ "Ёлка" <> "Сосна"`,
    forbidCode: "style_yo_letter_forbidden",
  });

  // ---------------- #63 → #145: temporary_table_identifier_mixed_script
  // Правило снято с сервера ревизией 2026-08-17.1 (#145, решение 13.08: класс
  // «стиль» судит внешний чекер query_style_check.mjs — его самотест держит
  // триггер гомоглифов). Кейс перевёрнут из expectCode в forbidCode и ловит
  // ОТКАТ: сборка до снятия выдаёт mixed_script на гомоглифах, и кейс падает.
  add({
    pr: "#145", rule: "temporary_table_identifier_mixed_script", kind: "контроль: правило снято с сервера",
    need: catalog,
    query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка ПОМЕСТИТЬ ${HOMOGLYPH} ИЗ ${catalog} КАК Т; `
      + `ВЫБРАТЬ ПЕРВЫЕ 1 ${HOMOGLYPH}.Ссылка ИЗ ${HOMOGLYPH} КАК ${HOMOGLYPH}`,
    forbidCode: "temporary_table_identifier_mixed_script",
  });
  add({
    pr: "#63", rule: "temporary_table_identifier_mixed_script", kind: "контроль: чистая кириллица",
    need: catalog,
    query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТОстатки ИЗ ${catalog} КАК Т; `
      + "ВЫБРАТЬ ПЕРВЫЕ 1 ВТОстатки.Ссылка ИЗ ВТОстатки КАК ВТОстатки",
    forbidCode: "temporary_table_identifier_mixed_script",
  });
  add({
    pr: "#63", rule: "temporary_table_identifier_mixed_script", kind: "контроль: NULL/UUID разрешены",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 УНИКАЛЬНЫЙИДЕНТИФИКАТОР(Т.Ссылка) КАК UUID ИЗ ${catalog} КАК Т `
      + "ГДЕ НЕ Т.Ссылка ЕСТЬ NULL",
    forbidCode: "temporary_table_identifier_mixed_script",
  });

  // ---------------- #63: vt_signature_too_many_positions
  add({
    pr: "#63", rule: "vt_signature_too_many_positions", kind: "триггер: 5 позиций у Остатки",
    need: register,
    // Пятая позиция ЗАПОЛНЕНА: висящая запятая допустима и позицией не считается,
    // поэтому «(&Дата, , , , )» правило не отклоняет — это осознанное поведение.
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , , , Субконто1 <> НЕОПРЕДЕЛЕНО) КАК Данные`,
    expectCode: "vt_signature_too_many_positions",
  });
  add({
    pr: "#63", rule: "vt_signature_too_many_positions", kind: "контроль: висящая запятая позицией не считается",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет ИЗ ${register}.Остатки(&Дата, , , , ) КАК Данные`,
    forbidCode: "vt_signature_too_many_positions",
  });
  add({
    pr: "#63", rule: "vt_signature_too_many_positions", kind: "контроль: 4 позиции",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет ИЗ ${register}.Остатки(&Дата, , , ) КАК Данные`,
    forbidCode: "vt_signature_too_many_positions",
  });

  // ---------------- #63: vt_subconto_condition_in_account_position
  add({
    pr: "#63", rule: "vt_subconto_condition_in_account_position", kind: "триггер: Субконто1 в позиции условия по счёту",
    need: register && catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, Субконто1 <> ЗНАЧЕНИЕ(${catalog}.ПустаяСсылка), , ) КАК Данные`,
    expectCode: "vt_subconto_condition_in_account_position",
  });
  add({
    pr: "#63", rule: "vt_subconto_condition_in_account_position", kind: "контроль: то же условие в последней позиции",
    need: register && catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , , Субконто1 <> ЗНАЧЕНИЕ(${catalog}.ПустаяСсылка)) КАК Данные`,
    forbidCode: "vt_subconto_condition_in_account_position",
  });

  // ---------------- #63: subconto_inline_literal_instead_of_array_param
  add({
    pr: "#63", rule: "subconto_inline_literal_instead_of_array_param", kind: "триггер: инлайн-литерал вида субконто",
    need: register && chart,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      // Инлайн-МАССИВ — минимум два ЗНАЧЕНИЕ() внутри одной скобки: одиночная ссылка
      // в этой позиции законна (параметр принимает ссылку либо массив).
      + `ИЗ ${register}.Остатки(&Дата, , (ЗНАЧЕНИЕ(${chart}.ВидПервый), ЗНАЧЕНИЕ(${chart}.ВидВторой)), ) КАК Данные`,
    expectCode: "subconto_inline_literal_instead_of_array_param",
  });
  add({
    pr: "#63", rule: "subconto_inline_literal_instead_of_array_param", kind: "контроль: одиночная ссылка законна",
    need: register && chart,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , ЗНАЧЕНИЕ(${chart}.ВидПервый), ) КАК Данные`,
    forbidCode: "subconto_inline_literal_instead_of_array_param",
  });
  add({
    pr: "#63", rule: "subconto_inline_literal_instead_of_array_param", kind: "контроль: именованный параметр",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , &ВидыСубконто, ) КАК Данные`,
    forbidCode: "subconto_inline_literal_instead_of_array_param",
  });

  // ---------------- #63: direct_join_with_virtual_table
  add({
    pr: "#63", rule: "direct_join_with_virtual_table", kind: "триггер: СОЕДИНЕНИЕ прямо с ВТ",
    need: register && catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${catalog} КАК Т `
      + `ЛЕВОЕ СОЕДИНЕНИЕ ${register}.Остатки(&Дата, , , ) КАК Данные `
      + "ПО Данные.Счет = Т.Ссылка",
    expectCode: "direct_join_with_virtual_table",
  });
  add({
    pr: "#63", rule: "direct_join_with_virtual_table", kind: "контроль: ВТ материализована в временную таблицу",
    need: register && catalog,
    query: `ВЫБРАТЬ Данные.Счет КАК Счет ПОМЕСТИТЬ ВТОстаткиСчетов `
      + `ИЗ ${register}.Остатки(&Дата, , , ) КАК Данные; `
      + `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${catalog} КАК Т `
      + "ЛЕВОЕ СОЕДИНЕНИЕ ВТОстаткиСчетов КАК О ПО О.Счет = Т.Ссылка",
    forbidCode: "direct_join_with_virtual_table",
  });

  // ---------------- #63: vt_filter_in_external_where
  // Флаги awaitingDeploy сняты 17.08 после приёмки ревизий 2026-08-17.3…7 на ВСЕХ
  // трёх контурах (прогоны: ERP и BUH PASS=46, ZUP PASS=22/SKIP=24 без провалов).
  // Пока флаг стоит, кейс не может покраснеть — а проверка, которая не краснеет,
  // сигналом не является (тот же довод, что у паспорта ниже, дефект оснастки 14.08).
  add({
    pr: "#63", rule: "vt_filter_in_external_where", kind: "триггер: отбор по полю ВТ во внешнем ГДЕ",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет ИЗ ${register}.Остатки(&Дата, , , ) КАК Данные `
      + "ГДЕ Данные.Субконто1 <> НЕОПРЕДЕЛЕНО",
    expectCode: "vt_filter_in_external_where",
  });
  add({
    pr: "#63", rule: "vt_filter_in_external_where", kind: "контроль: отбор в параметрах ВТ",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , , Субконто1 <> НЕОПРЕДЕЛЕНО) КАК Данные`,
    forbidCode: "vt_filter_in_external_where",
  });
  add({
    pr: "#63", rule: "vt_filter_in_external_where", kind: "контроль: отбор по РЕСУРСУ в ГДЕ законен",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет ИЗ ${register}.Остатки(&Дата, , , ) КАК Данные `
      + "ГДЕ Данные.СуммаОстатокДт <> 0",
    forbidCode: "vt_filter_in_external_where",
  });
  // ---------------- #147: неизвестное поле ВТ — диагноз за pre-flight, а не совет о переносе
  // Ревизия 2026-08-17.3: правило сверяет поле с составом ВТ ДО совета. Кейс ловит
  // и ОТКАТ: сборка до правки отвечает vt_filter_in_external_where на поле,
  // которого в ВТ нет, — с невыполнимым советом «перенесите отбор в параметры».
  // Триггер правила на существующем измерении держит кейс #63 выше (Субконто1).
  add({
    pr: "#147", rule: "vt_filter_in_external_where", kind: "контроль: неизвестное поле ВТ пропускается к pre-flight",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет ИЗ ${register}.Остатки(&Дата, , , ) КАК Данные `
      + "ГДЕ Данные.ЗаведомоНетТакогоПоляВТ <> 0",
    forbidCode: "vt_filter_in_external_where",
  });

  // ---------------- #150 Д-5: защита ВЫБОР…ЕСТЬNULL признаётся (ревизия 2026-08-17.7)
  // Пакет самодостаточен (обе ВТ из Справочник.Валюты) и не зависит от фикстур —
  // need: true, потому что пустой need означает «фикстуры нет» и уводит кейс в SKIP.
  add({
    pr: "#150", rule: "outer_join_field_without_isnull", kind: "контроль: поле в ИНАЧЕ защищено ЕСТЬNULL из КОГДА",
    need: true,
    query: "ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наценка КАК Наценка ПОМЕСТИТЬ ВТОснова ИЗ Справочник.Валюты КАК Т; "
      + "ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наценка КАК Наценка ПОМЕСТИТЬ ВТДоп ИЗ Справочник.Валюты КАК Т; "
      + "ВЫБРАТЬ ВЫБОР КОГДА ЕСТЬNULL(Доп.Наценка, 0) = 0 ТОГДА 0 ИНАЧЕ 100 / Доп.Наценка КОНЕЦ КАК П "
      + "ИЗ ВТОснова КАК Осн ЛЕВОЕ СОЕДИНЕНИЕ ВТДоп КАК Доп ПО Осн.Ссылка = Доп.Ссылка",
    forbidCode: "outer_join_field_without_isnull",
  });
  add({
    pr: "#150", rule: "outer_join_field_without_isnull", kind: "триггер: без защиты правило живо",
    need: true,
    query: "ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наценка КАК Наценка ПОМЕСТИТЬ ВТОснова ИЗ Справочник.Валюты КАК Т; "
      + "ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наценка КАК Наценка ПОМЕСТИТЬ ВТДоп ИЗ Справочник.Валюты КАК Т; "
      + "ВЫБРАТЬ 100 / Доп.Наценка КАК П "
      + "ИЗ ВТОснова КАК Осн ЛЕВОЕ СОЕДИНЕНИЕ ВТДоп КАК Доп ПО Осн.Ссылка = Доп.Ссылка",
    expectCode: "outer_join_field_without_isnull",
  });

  // ---------------- #150 Д-2: арность ДвиженияССубконто (замер 17.08 — 4 позиции)
  // Правило арности распространено на ДвиженияССубконто ревизией 2026-08-17.6:
  // прежде и 3, и 7 позиций давали valid=true, а платформа на 5+ отвечала
  // «Неверные параметры». Контроль держит правило от пережёсткости на законных
  // четырёх позициях.
  add({
    pr: "#150", rule: "vt_signature_too_many_positions", kind: "триггер: 5 позиций у ДвиженияССубконто",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Регистратор КАК Регистратор `
      + `ИЗ ${register}.ДвиженияССубконто(&Дата, &Дата, ИСТИНА, ИСТИНА, ИСТИНА) КАК Данные`,
    expectCode: "vt_signature_too_many_positions",
  });
  add({
    pr: "#150", rule: "vt_signature_too_many_positions", kind: "контроль: 4 позиции законны",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Регистратор КАК Регистратор `
      + `ИЗ ${register}.ДвиженияССубконто(&Дата, &Дата, ИСТИНА, ИСТИНА) КАК Данные`,
    forbidCode: "vt_signature_too_many_positions",
  });

  // ---------------- #63: base_register_table_without_vt_check + механизм исключений
  add({
    pr: "#63", rule: "base_register_table_without_vt_check", kind: "триггер: основная таблица регистра",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Записи.Счет КАК Счет ИЗ ${register} КАК Записи`,
    expectCode: "base_register_table_without_vt_check",
  });
  add({
    pr: "#63", rule: "base_register_table_without_vt_check", kind: "контроль: объявленное исключение с обоснованием",
    need: register,
    query: "ВЫБРАТЬ ПЕРВЫЕ 1 Записи.Счет КАК Счет\n"
      + "ИЗ\n"
      + "// СТАНДАРТ-ИСКЛЮЧЕНИЕ: base_register_table_without_vt_check —\n"
      + "// нужен Регистратор вместе с периодом, ни одна ВТ этого регистра не отдаёт оба поля\n"
      + `${register} КАК Записи`,
    forbidCode: "base_register_table_without_vt_check",
  });
  add({
    pr: "#63", rule: "base_register_table_without_vt_check", kind: "контроль: маркер-штамп без обоснования не спасает",
    need: register,
    query: "ВЫБРАТЬ ПЕРВЫЕ 1 Записи.Счет КАК Счет\n"
      + "ИЗ\n"
      + "// СТАНДАРТ-ИСКЛЮЧЕНИЕ: base_register_table_without_vt_check\n"
      + `${register} КАК Записи`,
    expectCode: "base_register_table_without_vt_check",
  });

  // ---------------- #63: outer_join_field_without_isnull
  add({
    pr: "#63", rule: "outer_join_field_without_isnull", kind: "триггер: поле внешнего соединения без ЕСТЬNULL",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т1.Ссылка КАК Ссылка, Т2.ПометкаУдаления КАК Метка ИЗ ${catalog} КАК Т1 `
      + `ЛЕВОЕ СОЕДИНЕНИЕ ${catalog} КАК Т2 ПО Т2.Ссылка = Т1.Ссылка `
      + "ГДЕ Т2.ПометкаУдаления = ЛОЖЬ",
    expectCode: "outer_join_field_without_isnull",
  });
  add({
    pr: "#63", rule: "outer_join_field_without_isnull", kind: "контроль: обёрнуто в ЕСТЬNULL",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т1.Ссылка КАК Ссылка, ЕСТЬNULL(Т2.ПометкаУдаления, ЛОЖЬ) КАК Метка `
      + `ИЗ ${catalog} КАК Т1 `
      + `ЛЕВОЕ СОЕДИНЕНИЕ ${catalog} КАК Т2 ПО Т2.Ссылка = Т1.Ссылка `
      + "ГДЕ ЕСТЬNULL(Т2.ПометкаУдаления, ЛОЖЬ) = ЛОЖЬ",
    forbidCode: "outer_join_field_without_isnull",
  });

  // ---------------- #63: empty_reference_not_filtered
  add({
    pr: "#63", rule: "empty_reference_not_filtered", kind: "триггер: ЕСТЬ НЕ NULL по ссылочному реквизиту",
    need: catalog && refAttr,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${catalog} КАК Т ГДЕ Т.${refAttr} ЕСТЬ НЕ NULL`,
    expectCode: "empty_reference_not_filtered",
  });
  add({
    pr: "#63", rule: "empty_reference_not_filtered", kind: "контроль: парная проверка пустой ссылки",
    need: catalog && refAttr,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${catalog} КАК Т `
      + `ГДЕ Т.${refAttr} ЕСТЬ НЕ NULL И Т.${refAttr} <> ЗНАЧЕНИЕ(${catalog}.ПустаяСсылка)`,
    forbidCode: "empty_reference_not_filtered",
  });

  // ---------------- найдено при прогоне 28.07, фиксы в этом же PR
  add({
    pr: "прогон", rule: "explicit_limit_not_numeric", kind: "ПЕРВЫЕ N + числовая константа в выборке валидны",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 1 КАК ЕстьДанные ИЗ ${catalog} КАК Т`,
    forbidCode: "explicit_limit_not_numeric",
  });
  add({
    pr: "прогон", rule: "explicit_limit_not_numeric", kind: "контроль: нечисловой лимит по-прежнему отклоняется",
    need: catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ &Лимит Т.Ссылка КАК Ссылка ИЗ ${catalog} КАК Т`,
    expectCode: "explicit_limit_not_numeric",
  });
  add({
    pr: "прогон", rule: "get_accounting_entries", kind: "инструмент сырых проводок работает",
    need: register, tool: "get_accounting_entries",
    toolArgs: { period_from: "2025-01-01", period_to: "2025-01-31", limit: 1 },
  });
  // Кейс «период данных регистра без period_error» снят 14.08 вместе с предметом:
  // паспорт периода не считает и запросов к данным не делает, поэтому класс
  // «сервер зарезал сам себя собственным правилом» в этом инструменте невозможен.
  // Взамен проверяется новый контракт: сокращённый паспорт данных не отдаёт.
  // Флаг awaitingDeploy снят 14.08 после публикации волны 2026-08-14.2 на ВСЕХ трёх
  // контурах (проверено: 39 инструментов, оба паспорта, секций данных ноль). Пока
  // флаг стоял, кейс не мог покраснеть — а проверка, которая не краснеет, сигналом
  // не является; это отмечено дефектом оснастки в приёмке ERP 14.08.
  add({
    pr: "прогон", rule: "get_database_passport", kind: "сокращённый паспорт без данных",
    need: true, tool: "get_database_passport", toolArgs: {},
    passportNoDataOk: true,
  });

  // ---------------- снимок tools/list: диагноз устаревшей схемы у клиента
  // Ревизия 2026-08-17.9, разбор жалобы 17.08 «схема паспорта несёт старые
  // параметры, get_database_passport_full в списке нет»: живой tools/list на всех
  // трёх был свежим, старую схему держал кеш клиента. Сервер дотягивается до
  // такого клиента только warnings'ами ответа, поэтому вызов по именам удалённой
  // пересборкой 14.08 схемы называет причину и лечение (переподключить клиента).
  // Флаги awaitingDeploy снять после публикации 2026-08-17.9 на всех трёх.
  add({
    pr: "прогон", rule: "passport_stale_tools_list", kind: "триггер: имя из удалённой схемы → диагноз снимка tools/list",
    need: true, awaitingDeploy: true, tool: "get_database_passport",
    toolArgs: { include_information_registers: true },
    passportStaleHint: "expected",
  });
  add({
    pr: "прогон", rule: "passport_stale_tools_list", kind: "контроль: имя вне удалённой схемы диагноз не поднимает",
    need: true, awaitingDeploy: true, tool: "get_database_passport",
    toolArgs: { bogus_probe_flag: true },
    passportStaleHint: "forbidden",
  });

  // ---------------- #65 / issue #60
  add({
    pr: "#65", rule: "issue #60", kind: "составной ИНДЕКСИРОВАТЬ ПО валиден",
    need: catalog,
    query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.ПометкаУдаления КАК Метка ПОМЕСТИТЬ ВТСоставнойИндекс `
      + `ИЗ ${catalog} КАК Т ИНДЕКСИРОВАТЬ ПО Ссылка, Метка; `
      + "ВЫБРАТЬ ПЕРВЫЕ 1 ВТСоставнойИндекс.Ссылка ИЗ ВТСоставнойИндекс КАК ВТСоставнойИндекс",
    forbidCode: "unknown_query_source",
    expectValid: true,
  });
  add({
    pr: "#65", rule: "issue #60", kind: "защита: неизвестный источник по-прежнему отклоняется",
    need: true,
    query: "ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ НеобъявленнаяТаблицаПроверки КАК Т",
    expectCode: "unknown_query_source",
  });

  // ---------------- #65 / issue #61
  const dropBody = (destroy) => `ВЫБРАТЬ Т.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТПервая ИЗ ${catalog} КАК Т; `
    + "ВЫБРАТЬ ВТПервая.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТВторая ИЗ ВТПервая КАК ВТПервая; "
    + `${destroy} ВТПервая; `
    + "ВЫБРАТЬ ПЕРВЫЕ 1 ВТВторая.Ссылка ИЗ ВТВторая КАК ВТВторая";
  add({
    pr: "#65", rule: "issue #61", kind: "кириллический УНИЧТОЖИТЬ валиден",
    need: catalog, query: dropBody("УНИЧТОЖИТЬ"), expectValid: true,
  });
  add({
    pr: "#65", rule: "issue #61", kind: "англ. DROP валиден (был forbidden_keyword)",
    need: catalog, query: dropBody("DROP"), forbidCode: "forbidden_keyword", expectValid: true,
  });
  add({
    pr: "#65", rule: "issue #61", kind: "защита: DROP TABLE <объект> отклоняется",
    need: catalog,
    query: `ВЫБРАТЬ Т.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТПервая ИЗ ${catalog} КАК Т; `
      + `DROP TABLE ${catalog}; `
      + "ВЫБРАТЬ ПЕРВЫЕ 1 ВТПервая.Ссылка ИЗ ВТПервая КАК ВТПервая",
    expectCode: "drop_target_not_temporary_table",
  });
  add({
    pr: "#65", rule: "issue #61", kind: "англ. пакет с INTO распознаётся как работа с ВТ",
    need: catalog,
    query: `SELECT T.Ссылка AS Ref INTO ВТАнгл FROM ${catalog} AS T; `
      + "SELECT FIRST 1 ВТАнгл.Ref FROM ВТАнгл AS ВТАнгл",
    forbidCode: "batch_query_forbidden",
  });

  // ---------------- #65 / issue #62
  add({
    pr: "#65", rule: "issue #62", kind: "ССЫЛКА <Тип> в параметрах ВТ не считается разыменованием",
    need: register && catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , , Субконто1 ССЫЛКА ${catalog}) КАК Данные`,
    forbidCode: "vt_param_field_error",
  });
  add({
    pr: "#65", rule: "issue #62", kind: "ТИП(<Тип>) в параметрах ВТ не считается разыменованием",
    need: register && catalog,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , , ТИПЗНАЧЕНИЯ(Субконто1) = ТИП(${catalog})) КАК Данные`,
    forbidCode: "vt_param_field_error",
  });
  add({
    pr: "#65", rule: "issue #62", kind: "защита: настоящее разыменование через точку отклоняется",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, Счет.Код ПОДОБНО "01%", , ) КАК Данные`,
    expectCode: "vt_param_field_error",
  });
  add({
    pr: "#65", rule: "issue #62", kind: "защита: разыменование внутри ТИПЗНАЧЕНИЯ отклоняется",
    need: register,
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
      + `ИЗ ${register}.Остатки(&Дата, , , ТИПЗНАЧЕНИЯ(Субконто1.Владелец) = ТИП(Строка)) КАК Данные`,
    expectCode: "vt_param_field_error",
  });

  return cases;
}

// ---------------------------------------------------------------- #59 схема

async function checkSchemaDefaults() {
  const { body } = await rpc("tools/list", {});
  const tools = body?.result?.tools ?? [];
  const tool = tools.find((item) => item.name === "get_accounting_balances");
  if (!tool) return { name: "#59 default у булевых флагов get_accounting_balances", status: "SKIP", note: "tool не найден" };
  const properties = tool.inputSchema?.properties ?? {};
  const flags = ["include_query", "include_column_types", "include_navigation_url"];
  const missing = flags.filter((flag) => properties[flag]?.default !== false);
  return {
    name: "#59 default у булевых флагов get_accounting_balances",
    status: missing.length ? "FAIL" : "PASS",
    note: missing.length ? `нет default:false у ${missing.join(", ")}` : `все три флага: default=false`,
  };
}

async function checkTransportVersionHeader() {
  const response = await fetch(URL_MCP, {
    method: "POST",
    headers: { ...HEADERS, "mcp-protocol-version": "1999-01-01" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} }),
  });
  return {
    name: "предсуществующий провал: неподдерживаемая версия протокола → 400",
    status: response.status === 400 ? "PASS" : "KNOWN-FAIL",
    note: `HTTP ${response.status} (ожидается 400; до этих PR отдавал 500)`,
  };
}

// ---------------------------------------------------------------- runner

async function runCase(entry) {
  if (!entry.need) {
    return { ...entry, status: "SKIP", note: "нет фикстуры (справочник/регистр/ссылочный реквизит)" };
  }

  // Кейсы уровня инструмента, а не текста запроса.
  if (entry.tool) {
    const call = await callTool(entry.tool, entry.toolArgs ?? {});
    const data = call.data ?? {};
    if (entry.passportNoDataOk) {
      // Проверяется отсутствие КЛЮЧЕЙ, а не пустота значений: пустой массив
      // organizations означал бы, что секция жива и однажды наполнится снова.
      const секции = ["organizations", "data_period", "accounting_registers", "closed_periods",
        "accumulation_registers", "information_registers", "calculation_registers"];
      const вернулись = секции.filter((ключ) => data[ключ] !== undefined);
      if (вернулись.length) {
        return { ...entry, status: "FAIL", note: `паспорт вернул данные: ${вернулись.join(", ")}` };
      }
      const имя = data.configuration?.name ?? "";
      return имя
        ? { ...entry, status: "PASS", note: `данных нет, конфигурация: ${имя}, символов: ${JSON.stringify(data).length}` }
        : { ...entry, status: "FAIL", note: "нет configuration.name — паспорт не назвал базу" };
    }
    if (entry.passportStaleHint) {
      const warnings = Array.isArray(data.warnings) ? data.warnings.map(String) : [];
      // Базовый warning обязан называть переданные имена в ОБОИХ случаях: диагноз
      // снимка — дополнение к нему, а не замена.
      const названо = Object.keys(entry.toolArgs).every((имя) => warnings.some((w) => w.includes(имя)));
      if (!названо) {
        return { ...entry, status: "FAIL", note: `warnings не назвал переданные аргументы: ${JSON.stringify(warnings).slice(0, 160)}` };
      }
      const диагноз = warnings.some((w) => w.includes("tools/list") && w.includes("устаревш"));
      if (entry.passportStaleHint === "expected" && !диагноз) {
        return { ...entry, status: "FAIL", note: `нет диагноза устаревшего снимка tools/list: ${JSON.stringify(warnings).slice(0, 200)}` };
      }
      if (entry.passportStaleHint === "forbidden" && диагноз) {
        return { ...entry, status: "FAIL", note: "диагноз снимка поднялся на имени вне удалённой схемы — отпечаток дырявый" };
      }
      return { ...entry, status: "PASS", note: `warnings: ${warnings.length}, диагноз снимка ${диагноз ? "есть" : "нет"} — как ожидалось` };
    }
    const failed = call.ok === false || data.ok === false;
    return failed
      ? { ...entry, status: "FAIL", note: `${data.error_code ?? call.error?.code ?? "отказ"}: ${String(data.message ?? "").slice(0, 160)}` }
      : { ...entry, status: "PASS", note: `ok, строк: ${data.row_count ?? data.rows?.length ?? "-"}` };
  }
  const validation = await callTool("validate_1c_query", {
    query: entry.query,
    parameters: { Дата: { kind: "datetime", value: new Date(Date.UTC(2026, 0, 1)).toISOString() } },
    strict: true,
    explain: true,
  });
  if (!validation.ok) {
    return { ...entry, status: "ERROR", note: `JSON-RPC error: ${validation.error?.code} ${validation.error?.message ?? ""}` };
  }
  const data = validation.data ?? {};
  const codes = codesOf(data);
  const problems = [];
  if (entry.expectCode && !codes.includes(entry.expectCode)) {
    problems.push(`нет ожидаемого ${entry.expectCode}; получено: ${codes.join(", ") || "(пусто)"}`);
  }
  if (entry.forbidCode && codes.includes(entry.forbidCode)) {
    problems.push(`ложное срабатывание ${entry.forbidCode}`);
  }
  if (entry.expectValid === true && data.valid !== true) {
    problems.push(`valid=${data.valid}, ошибки: ${(data.errors ?? []).map((error) => error.code).join(", ")}`);
  }
  return {
    ...entry,
    status: problems.length ? "FAIL" : "PASS",
    note: problems.join(" | ") || `codes: ${codes.join(", ") || "(нет)"}`,
    valid: data.valid,
  };
}

async function main() {
  console.log(`endpoint: ${URL_MCP}`);
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "post-deploy-verify", version: "1.0" },
  });
  if (!init.body?.result) {
    console.error("initialize не прошёл:", JSON.stringify(init).slice(0, 400));
    process.exit(2);
  }

  await discover();
  console.log("фикстуры:", JSON.stringify(fixtures));
  console.log("");

  const results = [];
  results.push(await checkSchemaDefaults());
  for (const entry of buildCases()) results.push(await runCase(entry));
  results.push(await checkTransportVersionHeader());

  let currentPr = "";
  for (const result of results) {
    const pr = result.pr ?? "";
    if (pr !== currentPr) {
      currentPr = pr;
      if (pr) console.log(`\n──────── ${pr}`);
    }
    const awaiting = result.status === "FAIL" && result.awaitingDeploy;
    const mark = awaiting ? "⧗" : { PASS: "✔", FAIL: "✘", SKIP: "○", ERROR: "!", "KNOWN-FAIL": "△" }[result.status];
    const title = result.rule ? `${result.rule} — ${result.kind}` : result.name;
    console.log(`${mark} ${title}${awaiting ? "  [ждёт деплоя фикса]" : ""}\n    ${result.note}`);
    if (awaiting) result.status = "AWAITING-DEPLOY";
  }

  const tally = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nитог: ${Object.entries(tally).map(([key, value]) => `${key}=${value}`).join("  ")}`);

  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ endpoint: URL_MCP, fixtures, tally, results }, null, 2), "utf8");
    console.log(`отчёт: ${JSON_OUT}`);
  }

  process.exit((tally.FAIL ?? 0) + (tally.ERROR ?? 0) > 0 ? 1 : 0);
}

await main();
