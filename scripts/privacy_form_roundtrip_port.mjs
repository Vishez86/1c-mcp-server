// JS-порт КРУГОВОГО теста обработки MCP_MaskingRule (§9 п.3 приёмки):
// прочитать политику в «форму» → «Записать» без изменений → канонизированный
// JSON эквивалентен исходному. Зеркалит серверные процедуры формы
// ПрочитатьПолитикуВФорму и СобратьПолитику на уровне данных: строки дерева —
// записи с ключами Псевдоним/Префикс/ПомеченныеПоля/ДопКлючи*, записи вне
// конфигурации — отдельный список.
//
// Round-trip обязан сохранять (M-14, M-23):
//   - неизвестные ключи privacy (включая упразднённые organization_aliases /
//     person_aliases — от них избавляет импорт, а не молчаливая потеря);
//   - записи с типами, которых нет в метаданных базы;
//   - дополнительные ключи записей (core_whitelist_foreign и т.п.).
//
// Метаданные — заглушка. Живая приёмка обязательна.
//
//   node scripts/privacy_form_roundtrip_port.mjs

const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s_\-.]/g, "").replace(/ё/g, "е");

// Типы «этой конфигурации» — всё остальное уходит в «Записи вне конфигурации».
const KNOWN_TYPES = [
  "Справочник.Контрагенты",
  "Справочник.Проекты",
  "Справочник.ФизическиеЛица",
  "РегистрСведений.ДокументыФизическихЛиц",
];
const knownIdx = new Map(KNOWN_TYPES.map((t) => [norm(t), t]));

// ---- Зеркало ПрочитатьПолитикуВФорму ----------------------------------------
export function readIntoForm(policyText) {
  const form = {
    rows: new Map(),      // norm type -> { type, alias, prefix, aliasExtra, fields, maskExtra }
    outside: [],          // { section, type, prefix, fields, extra }
    maskedFields: [],
    publishDetails: true,
    otherKeys: {},
    error: "",
  };
  if (!String(policyText ?? "").trim()) return form;

  let data;
  try {
    data = JSON.parse(policyText);
  } catch (error) {
    form.error = `битый JSON: ${error.message}`;
    return form;
  }
  const privacy = data?.privacy;
  if (!privacy || typeof privacy !== "object") return form;

  const row = (type) => {
    const key = norm(type);
    if (!form.rows.has(key)) {
      form.rows.set(key, { type: knownIdx.get(key), alias: false, prefix: "", aliasExtra: {}, fields: [], maskExtra: {} });
    }
    return form.rows.get(key);
  };
  const extraOf = (rec, drop) => Object.fromEntries(
    Object.entries(rec).filter(([k]) => !drop.includes(k.toLowerCase())),
  );

  for (const rec of privacy.type_aliases ?? []) {
    if (!rec || typeof rec !== "object") continue;
    const extra = extraOf(rec, ["type", "prefix"]);
    if (knownIdx.has(norm(rec.type))) {
      const r = row(rec.type);
      r.alias = true;
      r.prefix = String(rec.prefix ?? "");
      r.aliasExtra = extra;
    } else {
      form.outside.push({ section: "type_aliases", type: rec.type, prefix: String(rec.prefix ?? ""), fields: [], extra });
    }
  }

  for (const rec of privacy.type_field_masks ?? []) {
    if (!rec || typeof rec !== "object") continue;
    const extra = extraOf(rec, ["type", "fields"]);
    const fields = (rec.fields ?? []).map((f) => String(f)).filter(Boolean);
    if (knownIdx.has(norm(rec.type))) {
      const r = row(rec.type);
      r.fields = fields;
      r.maskExtra = extra;
    } else {
      form.outside.push({ section: "type_field_masks", type: rec.type, prefix: "", fields, extra });
    }
  }

  for (const f of privacy.masked_fields ?? []) {
    const name = String(f).trim();
    if (name) form.maskedFields.push(name);
  }
  form.publishDetails = typeof privacy.publish_details === "boolean" ? privacy.publish_details : true;

  for (const [key, value] of Object.entries(privacy)) {
    if (["masked_fields", "type_aliases", "type_field_masks", "publish_details"].includes(key)) continue;
    form.otherKeys[key] = value;
  }

  return form;
}

// ---- Зеркало СобратьПолитику -------------------------------------------------
export function collectFromForm(form) {
  const privacy = {};
  if (form.maskedFields.length) privacy.masked_fields = [...form.maskedFields];

  const aliases = [];
  const masks = [];
  for (const r of form.rows.values()) {
    if (r.alias) {
      const prefix = r.prefix.trim();
      if (!prefix) throw new Error(`у типа ${r.type} включён псевдоним без префикса`);
      aliases.push({ type: r.type, prefix, ...r.aliasExtra });
    }
    if (r.fields.length) {
      masks.push({ type: r.type, fields: [...r.fields], ...r.maskExtra });
    }
  }
  for (const o of form.outside) {
    if (o.section === "type_aliases") aliases.push({ type: o.type, prefix: o.prefix, ...o.extra });
    else masks.push({ type: o.type, fields: [...o.fields], ...o.extra });
  }
  if (aliases.length) privacy.type_aliases = aliases;
  if (masks.length) privacy.type_field_masks = masks;
  privacy.publish_details = form.publishDetails;
  for (const [key, value] of Object.entries(form.otherKeys)) {
    if (privacy[key] === undefined) privacy[key] = value;
  }
  return JSON.stringify({ privacy }, null, 2);
}

// ---- Канонизация для сравнения ------------------------------------------------
// Порядок записей и ключей несущественен; отсутствующий publish_details = true;
// пустые массивы эквивалентны отсутствию ключа.
export function canonical(policyText) {
  const empty = { masked_fields: [], type_aliases: [], type_field_masks: [], publish_details: true, other: {} };
  if (!String(policyText ?? "").trim()) return empty;
  const privacy = JSON.parse(policyText)?.privacy ?? {};
  const sortRec = (rec) => {
    const out = {};
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      out[key.toLowerCase()] = Array.isArray(v) ? v.map((x) => norm(x)).sort() : v;
    }
    return out;
  };
  const records = (list) => (list ?? []).map(sortRec)
    .sort((a, b) => String(a.type ?? "").localeCompare(String(b.type ?? "")));
  const other = {};
  for (const [key, value] of Object.entries(privacy)) {
    if (["masked_fields", "type_aliases", "type_field_masks", "publish_details"].includes(key)) continue;
    other[key] = value;
  }
  return {
    masked_fields: (privacy.masked_fields ?? []).map(norm).sort(),
    type_aliases: records(privacy.type_aliases),
    type_field_masks: records(privacy.type_field_masks),
    publish_details: typeof privacy.publish_details === "boolean" ? privacy.publish_details : true,
    other,
  };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Кейсы ------------------------------------------------------------------
const CASES = [
  {
    name: "M1 полный состав: псевдонимы, маски, панель",
    policy: {
      privacy: {
        masked_fields: ["ИНН", "КПП"],
        type_aliases: [
          { type: "Справочник.Контрагенты", prefix: "Контр-" },
          { type: "Справочник.Проекты", prefix: "Проект-" },
        ],
        type_field_masks: [
          { type: "Справочник.Проекты", fields: ["Наименование", "Код", "Руководитель"] },
          { type: "РегистрСведений.ДокументыФизическихЛиц", fields: ["Серия", "Номер"] },
        ],
        publish_details: true,
      },
    },
  },
  {
    name: "M2 доп-ключи записей сохраняются (M-14)",
    policy: {
      privacy: {
        type_field_masks: [{
          type: "Справочник.Контрагенты",
          fields: ["НаименованиеПолное"],
          core_whitelist_foreign: ["НаименованиеБанка"],
          core_whitelist_classifiers: ["НаименованиеОКВЭД"],
        }],
        type_aliases: [{ type: "Справочник.Контрагенты", prefix: "Контр-", mode: "mask" }],
      },
    },
  },
  {
    name: "M3 записи вне конфигурации сохраняются (M-23)",
    policy: {
      privacy: {
        type_aliases: [{ type: "Справочник.НетТакогоТипа", prefix: "Нет-" }],
        type_field_masks: [{ type: "Документ.ЧужойДокумент", fields: ["Комментарий"], custom: 42 }],
      },
    },
  },
  {
    name: "M4 неизвестные и упразднённые ключи privacy сохраняются (M-14, M-2)",
    policy: {
      privacy: {
        type_aliases: [{ type: "Справочник.Проекты", prefix: "Проект-" }],
        person_aliases: { enabled: true, physical_person_prefix: "ФЛ-" },
        organization_aliases: { enabled: false },
        future_key: { nested: [1, 2, 3] },
      },
    },
  },
  {
    name: "M5 пустая политика — законное состояние",
    policy: null, // пустой текст
  },
  {
    name: "M6 publish_details=false переживает круг",
    policy: { privacy: { masked_fields: ["Телефон"], publish_details: false } },
  },
];

let fails = 0;
const check = (ok, name, detail = "") => {
  if (!ok) fails += 1;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}${detail ? ` — ${detail}` : ""}`);
};

for (const testCase of CASES) {
  const sourceText = testCase.policy === null ? "" : JSON.stringify(testCase.policy, null, 2);
  const form = readIntoForm(sourceText);
  if (form.error) {
    check(false, testCase.name, form.error);
    continue;
  }
  const collected = collectFromForm(form);
  const same = equal(canonical(sourceText), canonical(collected));
  check(same, testCase.name, same ? "" : `канон разошёлся:\nДО:    ${JSON.stringify(canonical(sourceText))}\nПОСЛЕ: ${JSON.stringify(canonical(collected))}`);
}

// M7: битый JSON — форма сообщает об ошибке и не собирает «пустую» политику молча.
const broken = readIntoForm("{ это не json");
check(broken.error !== "", "M7 битый JSON даёт ошибку формы, а не пустую политику");

// M8: псевдоним без префикса — запись не выполняется (ошибка валидации §6.5).
const noPrefix = readIntoForm(JSON.stringify({ privacy: { type_aliases: [{ type: "Справочник.Проекты", prefix: "" }] } }));
let threw = false;
try { collectFromForm(noPrefix); } catch { threw = true; }
check(threw, "M8 пустой префикс при включённом псевдониме — ошибка сборки");

console.log("");
console.log(`Итог кругового порта: ${fails === 0 ? "PASS" : "FAIL"} (провалов: ${fails})`);
console.log("Порт зеркалит чтение/сборку формы на заглушке метаданных; живой круг на контуре обязателен (§9 п.9).");
process.exit(fails === 0 ? 0 : 1);
