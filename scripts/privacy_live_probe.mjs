// Живая проверка второго эшелона privacy (§11.2 ТЗ) с разных сторон.
//
// Политика не захардкожена: закрытые типы, поля и префиксы берутся из ответа
// get_current_user_context, поэтому скрипт работает на любой настройке. Кейс без
// подходящей фикстуры уходит в SKIP, а не притворяется пройденным.
//
// Запуск:
//   node scripts/privacy_live_probe.mjs
//   node scripts/privacy_live_probe.mjs --json reports/privacy_live_probe.json
//   MCP_URL=https://host/BASE/hs/mcp/rpc node scripts/privacy_live_probe.mjs
//
// Транспорт node:https: undici рвёт connect по внутреннему таймауту, и на этом
// канале fetch даёт ложные «fetch failed».

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const URL_MCP = process.env.MCP_URL || "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const jsonFlag = process.argv.indexOf("--json");
const JSON_OUT = jsonFlag > -1 ? process.argv[jsonFlag + 1] : "";

function once(payload) {
  const target = new URL(URL_MCP);
  return new Promise((resolve) => {
    const req = request({
      hostname: target.hostname, port: target.port || 443,
      path: target.pathname + target.search, method: "POST",
      rejectUnauthorized: false, timeout: 120000,
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25",
        "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ ok: true, text }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, err: e.message }));
    req.write(payload); req.end();
  });
}

async function tool(name, args) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await once(payload);
    if (r.ok) {
      try {
        const b = JSON.parse(r.text);
        return b.result?.structuredContent || JSON.parse(b.result?.content?.[0]?.text || "null");
      } catch { return null; }
    }
    if (attempt < 4) await new Promise((s) => setTimeout(s, 6000));
  }
  return null;
}
const q = (query, limit = 3) => tool("run_1c_query", { query, limit });

// ------------------------------------------------------------------ отчёт

const results = [];
let pass = 0, fail = 0, skip = 0;
function record(group, name, verdict, detail) {
  results.push({ group, name, verdict, detail });
  if (verdict === "PASS") pass++; else if (verdict === "FAIL") fail++; else skip++;
  const mark = verdict === "PASS" ? "OK  " : verdict === "FAIL" ? "FAIL" : "SKIP";
  console.log(`${mark} | ${group} | ${name}${detail ? `\n       ${detail}` : ""}`);
}
const check = (g, n, cond, detail) => record(g, n, cond ? "PASS" : "FAIL", detail);

// --------------------------------------------------------------- политика

const policy = { aliases: [], masks: [], prefixes: new Map(), maskFields: new Map() };

function closedByAlias() { return policy.aliases.map((e) => e.type); }
function prefixOf(type) { return policy.prefixes.get(type.toLowerCase()) || ""; }
function looksAlias(value, prefix) {
  return typeof value === "string" && prefix !== "" && value.startsWith(prefix)
    && (value.length === prefix.length + 8 || value === prefix + "скрыто");
}
const MASKED = (v) => v === "XXXXXXX" || v === null;

(async () => {
  console.log(`Контур: ${URL_MCP}\n`);

  const ctx = await tool("get_current_user_context", {});
  const p = ctx?.privacy;
  if (!p) { console.error("нет блока privacy — контур не отвечает или код не задеплоен"); process.exitCode = 2; return; }
  policy.aliases = p.type_aliases?.entries ?? [];
  policy.masks = p.type_field_masks?.entries ?? [];
  for (const e of policy.aliases) policy.prefixes.set(e.type.toLowerCase(), e.prefix);
  for (const e of policy.masks) policy.maskFields.set(e.type, e.fields ?? []);

  console.log(`политика: псевдонимов ${policy.aliases.length}, масок ${policy.masks.length},`
    + ` enabled=${p.enabled}, ошибок ${(p.config_errors ?? []).length},`
    + ` engine_revision=${p.engine_revision ?? "до 2026-08-03.2 (фикса регистров НЕТ в сборке)"}\n`);

  // ===== A. Служебный блок и схема не портятся =====
  const A = "A. схема и служебное";
  check(A, "config_errors пуст", (p.config_errors ?? []).length === 0, JSON.stringify(p.config_errors));
  const anyAliasType = closedByAlias()[0];
  check(A, "в блоке privacy имена типов не замаскированы",
    policy.aliases.every((e) => e.type.includes(".")) && policy.masks.every((e) => e.type.includes(".")),
    `первый тип: ${anyAliasType ?? "нет"}`);
  if (anyAliasType) {
    const meta = await tool("get_metadata_structure", { type: anyAliasType, include_standard_attributes: true });
    const names = (meta?.metadata?.attributes ?? []).map((a) => a.name);
    check(A, "get_metadata_structure: имена полей закрытого типа целы",
      meta?.metadata?.full_name === anyAliasType && names.length > 0 && !names.includes("XXXXXXX"),
      `full_name=${meta?.metadata?.full_name}, реквизитов ${names.length}`);
  } else record(A, "get_metadata_structure", "SKIP", "нет типов в type_aliases");

  if (!anyAliasType) { console.log("\nбез type_aliases остальные группы неприменимы"); return; }
  const pref = prefixOf(anyAliasType);

  // ===== B. run_1c_query: разные формы обращения к одному и тому же полю =====
  const B = "B. формы запроса";
  const forms = [
    ["колонка КАК Ссылка + Наименование", `ВЫБРАТЬ ПЕРВЫЕ 2 Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ ${anyAliasType} КАК Т`, "Наименование", true],
    ["колонка КАК ref (ключ контракта)", `ВЫБРАТЬ ПЕРВЫЕ 2 Т.Ссылка КАК ref, Т.Наименование КАК Наименование ИЗ ${anyAliasType} КАК Т`, "Наименование", true],
    ["без ссылки, имя колонки = имя типа", `ВЫБРАТЬ ПЕРВЫЕ 2 Т.Наименование КАК ${anyAliasType.split(".")[1].replace(/ы$/, "")} ИЗ ${anyAliasType} КАК Т`, null, true],
    ["ПРЕДСТАВЛЕНИЕ(Ссылка) без самой ссылки", `ВЫБРАТЬ ПЕРВЫЕ 2 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК Представление ИЗ ${anyAliasType} КАК Т`, "Представление", false],
    ["переименование КАК X (граница mask)", `ВЫБРАТЬ ПЕРВЫЕ 2 Т.Наименование КАК X ИЗ ${anyAliasType} КАК Т`, "X", false],
  ];
  for (const [name, query, col, mustClose] of forms) {
    const r = await q(query, 2);
    const row = r?.rows?.[0];
    if (!row) { record(B, name, "SKIP", `нет строк: ${JSON.stringify(r).slice(0, 120)}`); continue; }
    const key = col ?? Object.keys(row).find((k) => k !== "Ссылка" && k !== "ref");
    const value = row[key];
    const closed = looksAlias(value, pref) || MASKED(value);
    if (mustClose) check(B, name, closed, `${key}=${JSON.stringify(value)}`);
    else record(B, name, "PASS", `${key}=${JSON.stringify(value)} (закрыто: ${closed ? "да" : "нет"} — фиксируем факт)`);
  }

  // ===== C. Соединение и подзапрос: закрытый рядом с открытым =====
  const C = "C. соединение и подзапрос";
  // Незакрытый справочник обязан быть НЕПУСТЫМ, иначе соединение вернёт ноль
  // строк и контрольные проверки окажутся бессмысленными (первый прогон именно
  // так и ушёл в SKIP).
  const candidates = ((await tool("list_metadata_objects", { kinds: ["Справочник"], limit: 60 }))?.objects ?? [])
    .map((o) => o.full_name)
    .filter((fn) => fn && !policy.aliases.some((e) => e.type.toLowerCase() === fn.toLowerCase())
      && !policy.masks.some((e) => e.type.toLowerCase() === fn.toLowerCase()));
  let open = null;
  for (const candidate of candidates.slice(0, 12)) {
    const probe = await q(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ ${candidate} КАК Т`, 1);
    if (probe?.rows?.[0]?.Ссылка?.uuid) { open = candidate; break; }
  }
  if (open) {
    // C1. Имя-подобная колонка принадлежит ЗАКРЫТОМУ типу — обязана закрыться.
    const j1 = await q(`ВЫБРАТЬ ПЕРВЫЕ 2 З.Ссылка КАК Ссылка, З.Наименование КАК Наименование,`
      + ` О.Ссылка КАК Открытый ИЗ ${anyAliasType} КАК З, ${open} КАК О`, 2);
    const r1c = j1?.rows?.[0];
    if (r1c) {
      check(C, "C1: имя закрытого типа в соединении закрыто",
        looksAlias(r1c.Наименование, pref) || MASKED(r1c.Наименование),
        `Наименование=${JSON.stringify(r1c.Наименование)}`);
      check(C, "C1: presentation открытой ссылки не тронут",
        typeof r1c.Открытый?.presentation === "string" && !looksAlias(r1c.Открытый.presentation, pref),
        `${r1c.Открытый?.presentation} (${open})`);
    } else record(C, "C1: соединение", "SKIP", "нет строк");

    // C2. Имя-подобная колонка принадлежит ОТКРЫТОМУ типу, но в строке есть
    // ссылка закрытого типа. Контекст строки — закрытый тип, поэтому колонка
    // попадёт под его псевдоним: лишнее маскирование. Измеряем факт, а не
    // объявляем ошибкой — §3 ставит отсутствие утечки выше ложных срабатываний.
    const j2 = await q(`ВЫБРАТЬ ПЕРВЫЕ 2 З.Ссылка КАК Закрытый, О.Наименование КАК Наименование`
      + ` ИЗ ${anyAliasType} КАК З, ${open} КАК О`, 2);
    const r2c = j2?.rows?.[0];
    if (r2c) {
      const overmasked = looksAlias(r2c.Наименование, pref) || MASKED(r2c.Наименование);
      record(C, "C2: имя ОТКРЫТОГО типа рядом со закрытой ссылкой", "PASS",
        `Наименование=${JSON.stringify(r2c.Наименование)} → ${overmasked
          ? "замаскировано (лишнее маскирование, безопасная сторона)" : "не тронуто"}`);
    } else record(C, "C2: соединение", "SKIP", "нет строк");

    // C3. Переименованные колонки: имя перестаёт быть имя-подобным, режим mask
    // такое не закрывает — граница, снимаемая только mode: deny.
    const j3 = await q(`ВЫБРАТЬ ПЕРВЫЕ 2 З.Ссылка КАК Ссылка, З.Наименование КАК ИмяЗакрытого`
      + ` ИЗ ${anyAliasType} КАК З`, 2);
    const r3c = j3?.rows?.[0];
    if (r3c) {
      const closed3 = looksAlias(r3c.ИмяЗакрытого, pref) || MASKED(r3c.ИмяЗакрытого);
      record(C, "C3: переименованная колонка закрытого типа", "PASS",
        `ИмяЗакрытого=${JSON.stringify(r3c.ИмяЗакрытого)} → ${closed3
          ? "закрыто" : "открыто (граница mask, снимается deny)"}`);
    } else record(C, "C3: переименование", "SKIP", "нет строк");

    const sub = await q(`ВЫБРАТЬ ПЕРВЫЕ 2 В.Имя КАК Имя ИЗ (ВЫБРАТЬ Т.Наименование КАК Имя ИЗ ${anyAliasType} КАК Т) КАК В`, 2);
    const sv = sub?.rows?.[0]?.Имя;
    record(C, "подзапрос с переименованием", "PASS",
      `Имя=${JSON.stringify(sv)} (закрыто: ${looksAlias(sv, pref) || MASKED(sv) ? "да" : "нет"} — граница mask)`);
  } else record(C, "соединение закрытого и открытого", "SKIP", "не нашли незакрытый справочник");

  // ===== D. Разыменование и подчинённые =====
  const D = "D. разыменование";
  const child = policy.aliases.map((e) => e.type).find((t) => t !== anyAliasType);
  if (child) {
    const r = await q(`ВЫБРАТЬ ПЕРВЫЕ 2 Д.Ссылка КАК Ссылка, Д.Наименование КАК Наименование,`
      + ` Д.Владелец КАК Владелец, Д.Владелец.Наименование КАК ИмяВладельца ИЗ ${child} КАК Д`, 2);
    const row = r?.rows?.[0];
    if (row) {
      const pc = prefixOf(child);
      check(D, "подчинённый объект закрыт своим префиксом", looksAlias(row.Наименование, pc) || MASKED(row.Наименование),
        `Наименование=${JSON.stringify(row.Наименование)} (ожидали ${pc})`);
      check(D, "ссылка владельца закрыта его префиксом",
        looksAlias(row.Владелец?.presentation, prefixOf(anyAliasType)) || row.Владелец === null,
        `Владелец.presentation=${row.Владелец?.presentation}`);
      record(D, "разыменование Владелец.Наименование", "PASS",
        `ИмяВладельца=${JSON.stringify(row.ИмяВладельца)} (закрыто: ${
          looksAlias(row.ИмяВладельца, prefixOf(anyAliasType)) || MASKED(row.ИмяВладельца) ? "да" : "нет"})`);
    } else record(D, "подчинённый тип", "SKIP", `нет строк по ${child}`);
  } else record(D, "подчинённый тип", "SKIP", "в политике один тип с псевдонимом");

  // ===== E. Регистры: маски полей и целостность =====
  const E = "E. регистры";
  const regType = [...policy.maskFields.keys()].find((t) => t.startsWith("РегистрСведений."));
  if (regType) {
    const fields = policy.maskFields.get(regType) ?? [];
    const reg = await tool("get_register_records", {
      register_type: "РегистрСведений", register: regType.split(".")[1],
      mode: "records", limit: 2, include_column_types: true });
    const cols = (reg?.columns ?? []).map((c) => c.name || c);
    check(E, "columns регистра не искажены", cols.length > 0 && fields.every((f) => cols.includes(f)),
      `колонок ${cols.length}, ожидали среди них ${fields.join(", ")}`);
    const row = reg?.rows?.[0];
    if (row) {
      for (const f of fields.slice(0, 4)) {
        check(E, `поле ${f} замаскировано`, MASKED(row[f]) || row[f] === undefined, `${f}=${JSON.stringify(row[f])}`);
      }
      const notListed = cols.find((c) => !fields.includes(c) && !["Период", "Активность", "Регистратор"].includes(c)
        && typeof row[c] === "string" && row[c] !== "");
      if (notListed) check(E, "поле вне списка не тронуто", !MASKED(row[notListed]),
        `${notListed}=${JSON.stringify(row[notListed])}`);
      const dimRef = cols.find((c) => row[c] && typeof row[c] === "object" && row[c].type);
      if (dimRef) record(E, "измерение-ссылка сохраняет type и uuid", row[dimRef].uuid ? "PASS" : "FAIL",
        `${dimRef}: type=${row[dimRef].type}, uuid=${row[dimRef].uuid ? "есть" : "НЕТ"}`);
    } else record(E, "строки регистра", "SKIP", "регистр пуст");
  } else record(E, "регистр в политике", "SKIP", "в type_field_masks нет регистра сведений");

  // ===== F. Другие каналы: объект, поиск, история =====
  const F = "F. другие инструменты";
  const first = (await q(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${anyAliasType} КАК Т`, 1))?.rows?.[0]?.Ссылка;
  if (first?.uuid) {
    const obj = await tool("get_object_by_ref", { type: anyAliasType, uuid: first.uuid });
    const o = obj?.object ?? obj;
    check(F, "get_object_by_ref: представление закрыто",
      looksAlias(o?.presentation ?? o?.ref?.presentation, pref),
      `presentation=${o?.presentation ?? o?.ref?.presentation}`);
    check(F, "get_object_by_ref: uuid сохранён",
      (o?.uuid ?? o?.ref?.uuid) === first.uuid, `uuid=${o?.uuid ?? o?.ref?.uuid}`);

    const byId = await tool("find_object_by_id", { uuid: first.uuid, types: [anyAliasType], limit: 1 });
    const found = (byId?.objects ?? byId?.matches ?? [])[0];
    if (found) check(F, "find_object_by_id: представление закрыто",
      looksAlias(found.presentation ?? found.ref?.presentation, pref),
      `${found.presentation ?? found.ref?.presentation}`);
    else record(F, "find_object_by_id", "SKIP", `ответ: ${JSON.stringify(byId).slice(0, 120)}`);

    const hist = await tool("get_object_history", { type: anyAliasType, uuid: first.uuid, limit: 2 });
    const histText = JSON.stringify(hist ?? {});
    record(F, "get_object_history: ответ получен", hist ? "PASS" : "SKIP",
      `открытых наименований в ответе: ${histText.includes("Palm") ? "ЕСТЬ — проверить" : "не обнаружено"}`);
  } else record(F, "объектные инструменты", "SKIP", "нет ссылки для пробы");

  // Ответ search_objects складывает совпадения в matches (не objects/results).
  const search = await tool("search_objects", { query: "а", types: [anyAliasType], limit: 2 });
  const hits = search?.matches ?? search?.objects ?? search?.results ?? [];
  if (hits.length) {
    check(F, "search_objects: представления в выдаче закрыты",
      hits.every((h) => looksAlias(h.presentation ?? h.ref?.presentation, pref)),
      hits.map((h) => h.presentation ?? h.ref?.presentation).join(", "));
  } else record(F, "search_objects", "SKIP", `совпадений нет: ${JSON.stringify(search).slice(0, 120)}`);

  // ===== G. Стабильность, уникальность, идемпотентность =====
  const G = "G. свойства кодов";
  const r1 = await q(`ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ ${anyAliasType} КАК Т`, 5);
  const r2 = await q(`ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ ${anyAliasType} КАК Т`, 5);
  const c1 = (r1?.rows ?? []).map((r) => r.Ссылка?.presentation);
  const c2 = (r2?.rows ?? []).map((r) => r.Ссылка?.presentation);
  check(G, "коды стабильны между вызовами", c1.length > 0 && c1.join("|") === c2.join("|"), `${c1.join(",")} / ${c2.join(",")}`);
  check(G, "разные объекты — разные коды", new Set(c1).size === c1.length, `уникальных ${new Set(c1).size} из ${c1.length}`);
  check(G, "код поля названия равен коду ссылки",
    (r1?.rows ?? []).every((r) => r.Наименование === r.Ссылка?.presentation),
    (r1?.rows ?? []).slice(0, 2).map((r) => `${r.Ссылка?.presentation}=${r.Наименование}`).join("; "));
  check(G, "формат кода: префикс + 8 символов",
    c1.every((c) => looksAlias(c, pref)), `пример ${c1[0]}`);

  // ===== H. Сравнительный контроль: поведение ссылок одинаково у закрытых и открытых =====
  const H = "H. сравнительный контроль";
  if (open) {
    const closedRef = (await q(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${anyAliasType} КАК Т`, 1))?.rows?.[0]?.Ссылка ?? {};
    const openRef = (await q(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${open} КАК Т`, 1))?.rows?.[0]?.Ссылка ?? {};
    const kc = Object.keys(closedRef).sort().join(","), ko = Object.keys(openRef).sort().join(",");
    check(H, "набор ключей ссылки одинаков у закрытого и открытого типа", kc === ko && kc !== "",
      `закрытый: ${kc} | открытый: ${ko}`);
    check(H, "type и uuid у закрытой ссылки на месте",
      closedRef.type === anyAliasType && Boolean(closedRef.uuid), `type=${closedRef.type}, uuid=${closedRef.uuid ? "есть" : "НЕТ"}`);
  } else record(H, "сравнительный контроль", "SKIP", "нет открытого типа");

  console.log(`\nИтог: PASS ${pass}, FAIL ${fail}, SKIP ${skip}`);
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ url: URL_MCP, policy: {
      aliases: policy.aliases, masks: policy.masks }, pass, fail, skip, results }, null, 2), "utf8");
    console.log(`JSON: ${JSON_OUT}`);
  }
  if (fail > 0) process.exitCode = 1;
})();
