// JS-порт МИГРАЦИИ политики маскирования (§7.1 ТЗ каталога, §9 п.2 приёмки):
// ИмпортироватьИзServerConfigНаСервере формы MCP_НастройкаМаскирования.
//
// Отвечает офлайн на вопрос приёмки «эквивалентна ли эффективная политика ДО
// (константа + спецрежимы движка) и ПОСЛЕ (справочник, только явные записи)»:
// живьём это можно снять лишь после деплоя, а дефект миграции к тому моменту
// уже был бы дефектом контура. Сравнение нормализованное; допустимая разница —
// только отсутствие упразднённых ключей organization_aliases/person_aliases.
//
// Модель «ДО» повторяет УДАЛЁННЫЕ ветки движка по состоянию 6019cb0:
//   - organization_aliases.enabled закрывал Справочник.Организации;
//   - person_aliases.enabled закрывал ФизическиеЛица/Сотрудники/Пользователи,
//     их подчинённые справочники (R-12) и зашитый список чувствительных полей
//     (MCP_Config.bsl:412-421 той ревизии).
// Модель «ПОСЛЕ» читает только type_aliases/type_field_masks — как движок
// ревизии 2026-08-11.1.
//
// Метаданные — заглушка: порт проверяет ЛОГИКУ миграции, не разрешение имён
// живого контура. Живая приёмка (§9 п.5-9) обязательна.
//
//   node scripts/privacy_catalog_migration_port.mjs

const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s_\-.]/g, "").replace(/ё/g, "е");

// ---- Заглушка метаданных: типовой зарплатный контур в миниатюре ------------
const META = {
  catalogs: {
    "Организации": { owners: [], fields: ["Наименование", "НаименованиеПолное", "ИНН", "КПП"] },
    "ФизическиеЛица": { owners: [], fields: ["Наименование", "Фамилия", "Имя", "Отчество", "ИНН", "СтраховойНомер", "ДатаРождения"] },
    "Сотрудники": { owners: [], fields: ["Наименование", "НаименованиеСлужебное", "ИндивидуальныйНомер"] },
    "Пользователи": { owners: [], fields: ["Наименование"] },
    // Подчинённый типу персон — материализация R-12 обязана его закрыть.
    "РодственникиФизическихЛиц": { owners: ["Справочник.ФизическиеЛица"], fields: ["Наименование", "ДатаРождения", "СтепеньРодства"] },
    // Подчинённый НЕ-персоне — под материализацию НЕ подпадает (решение 06.08.2026).
    "ДоговорыКонтрагентов": { owners: ["Справочник.Контрагенты"], fields: ["Наименование", "Номер"] },
    "Контрагенты": { owners: [], fields: ["Наименование", "НаименованиеПолное", "ИНН"] },
  },
};
const metaFind = (fullName) => {
  const m = /^Справочник\.(.+)$/u.exec(String(fullName ?? ""));
  return m ? META.catalogs[m[1]] ?? null : null;
};

// Зашитый список чувствительных полей упразднённого режима персон (:412-421).
const SENSITIVE = ["Фамилия", "Имя", "Отчество", "СерияПаспорта", "НомерПаспорта",
  "ИндивидуальныйНомер", "СтраховойНомер", "ДатаРождения"];

// ---- Порт миграции (зеркало ИмпортироватьИзServerConfigНаСервере) ----------
export function migrate(privacy) {
  const out = {};
  const aliases = [];
  const masks = [];
  const aliasIdx = new Map();
  const maskIdx = new Map();

  if (Array.isArray(privacy.masked_fields)) out.masked_fields = privacy.masked_fields;
  for (const rec of privacy.type_aliases ?? []) {
    if (rec && typeof rec === "object") { aliases.push(rec); aliasIdx.set(norm(rec.type), rec); }
  }
  for (const rec of privacy.type_field_masks ?? []) {
    if (rec && typeof rec === "object") { masks.push(rec); maskIdx.set(norm(rec.type), rec); }
  }

  const addAlias = (type, prefix) => {
    if (!metaFind(type) || aliasIdx.has(norm(type))) return;
    const rec = { type, prefix };
    aliases.push(rec); aliasIdx.set(norm(type), rec);
  };
  const addSensitiveMask = (type) => {
    const meta = metaFind(type);
    if (!meta) return;
    const present = SENSITIVE.filter((f) => meta.fields.some((mf) => norm(mf) === norm(f)));
    if (!present.length) return;
    const existing = maskIdx.get(norm(type));
    if (existing) {
      const have = new Set((existing.fields ?? []).map(norm));
      for (const f of present) if (!have.has(norm(f))) (existing.fields ??= []).push(f);
    } else {
      const rec = { type, fields: present };
      masks.push(rec); maskIdx.set(norm(type), rec);
    }
  };

  if (privacy.organization_aliases?.enabled) {
    addAlias("Справочник.Организации", privacy.organization_aliases.prefix || "Орг-");
  }

  if (privacy.person_aliases?.enabled) {
    const persons = [
      ["ФизическиеЛица", privacy.person_aliases.physical_person_prefix || "ФЛ-"],
      ["Сотрудники", privacy.person_aliases.employee_prefix || "Сотр-"],
      ["Пользователи", privacy.person_aliases.user_prefix || "Польз-"],
    ].filter(([name]) => META.catalogs[name]);
    const personFull = persons.map(([name]) => `Справочник.${name}`);

    for (const [name, prefix] of persons) {
      addAlias(`Справочник.${name}`, prefix);
      addSensitiveMask(`Справочник.${name}`);
    }
    // Материализация R-12. Префикс — от имени подчинённого (ПрефиксПоУмолчанию),
    // не «префикс физлиц»: дубль префикса отклоняется валидатором уникальности,
    // и запись молча не применилась бы — тихая утечка вместо материализации.
    for (const [name, meta] of Object.entries(META.catalogs)) {
      const full = `Справочник.${name}`;
      if (aliasIdx.has(norm(full))) continue;
      const subordinated = meta.owners.some((o) => personFull.some((p) => norm(p) === norm(o)));
      if (!subordinated) continue;
      addAlias(full, `${name}-`);
      addSensitiveMask(full);
    }
  }

  if (aliases.length) out.type_aliases = aliases;
  if (masks.length) out.type_field_masks = masks;
  out.publish_details = privacy.publish_details ?? true;
  return out;
}

// ---- Эффективный образ ДО: удалённые ветки движка (6019cb0) ----------------
function effectiveBefore(privacy) {
  const closedTypes = new Set();
  const closedFields = new Map(); // normType -> Set(norm field)
  const addField = (type, field) => {
    const key = norm(type);
    if (!closedFields.has(key)) closedFields.set(key, new Set());
    closedFields.get(key).add(norm(field));
  };

  for (const rec of privacy.type_aliases ?? []) closedTypes.add(norm(rec.type));
  for (const rec of privacy.type_field_masks ?? []) {
    closedTypes.add(norm(rec.type));
    for (const f of rec.fields ?? []) addField(rec.type, f);
  }
  if (privacy.organization_aliases?.enabled) closedTypes.add(norm("Справочник.Организации"));
  if (privacy.person_aliases?.enabled) {
    const personFull = ["ФизическиеЛица", "Сотрудники", "Пользователи"]
      .filter((n) => META.catalogs[n]).map((n) => `Справочник.${n}`);
    const closed = [...personFull];
    for (const [name, meta] of Object.entries(META.catalogs)) {
      if (meta.owners.some((o) => personFull.some((p) => norm(p) === norm(o)))) {
        closed.push(`Справочник.${name}`);
      }
    }
    for (const t of closed) {
      closedTypes.add(norm(t));
      const meta = metaFind(t);
      for (const f of SENSITIVE) {
        if (meta.fields.some((mf) => norm(mf) === norm(f))) addField(t, f);
      }
    }
  }
  return { closedTypes, closedFields };
}

// ---- Эффективный образ ПОСЛЕ: только явные записи (2026-08-11.1) -----------
function effectiveAfter(privacy) {
  const closedTypes = new Set();
  const closedFields = new Map();
  for (const rec of privacy.type_aliases ?? []) closedTypes.add(norm(rec.type));
  for (const rec of privacy.type_field_masks ?? []) {
    closedTypes.add(norm(rec.type));
    for (const f of rec.fields ?? []) {
      const key = norm(rec.type);
      if (!closedFields.has(key)) closedFields.set(key, new Set());
      closedFields.get(key).add(norm(f));
    }
  }
  return { closedTypes, closedFields };
}

// ---- Кейсы ------------------------------------------------------------------
const FIXTURE = {
  masked_fields: ["ИНН", "КПП"],
  organization_aliases: { enabled: true, prefix: "Орг-" },
  person_aliases: { enabled: true, physical_person_prefix: "ФЛ-", employee_prefix: "Сотр-", user_prefix: "Польз-" },
  type_aliases: [{ type: "Справочник.Контрагенты", prefix: "Контр-" }],
  type_field_masks: [
    { type: "Справочник.Контрагенты", fields: ["НаименованиеПолное"], core_whitelist_foreign: ["НаименованиеБанка"] },
    // Тип персоны УЖЕ имеет запись масок — миграция обязана ОБЪЕДИНИТЬ поля.
    { type: "Справочник.ФизическиеЛица", fields: ["ИНН"] },
  ],
  publish_details: true,
};

let fails = 0;
const check = (ok, name, detail = "") => {
  if (!ok) fails += 1;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}${detail ? ` — ${detail}` : ""}`);
};

const migrated = migrate(FIXTURE);
const before = effectiveBefore(FIXTURE);
const after = effectiveAfter(migrated);

// 1. Набор закрытых типов совпадает.
const missTypes = [...before.closedTypes].filter((t) => !after.closedTypes.has(t));
const extraTypes = [...after.closedTypes].filter((t) => !before.closedTypes.has(t));
check(missTypes.length === 0, "закрытые ДО типы закрыты и ПОСЛЕ", missTypes.join(", "));
check(extraTypes.length === 0, "лишних закрытых типов ПОСЛЕ нет", extraTypes.join(", "));

// 2. Каждое закрытое ДО поле закрыто и ПОСЛЕ (включая объединение записей).
let missingFields = [];
for (const [type, fields] of before.closedFields) {
  for (const f of fields) {
    if (!after.closedFields.get(type)?.has(f)) missingFields.push(`${type}.${f}`);
  }
}
check(missingFields.length === 0, "чувствительные поля материализованы", missingFields.join(", "));

// 3. Подчинённый персонам закрыт явной записью, подчинённый НЕ-персоне — нет.
check(after.closedTypes.has(norm("Справочник.РодственникиФизическихЛиц")),
  "R-12 материализован: подчинённый персонам получил запись");
check(!after.closedTypes.has(norm("Справочник.ДоговорыКонтрагентов")),
  "подчинённый НЕ-персоне записи не получил (решение 06.08.2026)");

// 4. Префиксы уникальны — иначе читатель отклонит запись и подчинённый откроется.
const prefixes = (migrated.type_aliases ?? []).map((r) => String(r.prefix).toLowerCase());
check(new Set(prefixes).size === prefixes.length, "префиксы мигрированных записей уникальны",
  prefixes.join(", "));
const collide = prefixes.filter((p, i) => prefixes.some((q, j) => i !== j && (p.startsWith(q) || q.startsWith(p))));
check(collide.length === 0, "ни один префикс не является началом другого", collide.join(", "));

// 5. Упразднённые ключи в мигрированную политику не переносятся.
check(migrated.organization_aliases === undefined && migrated.person_aliases === undefined,
  "organization_aliases/person_aliases в мигрированной политике отсутствуют");

// 6. Доп-ключи записей (core_whitelist_*) пережили миграцию.
const contr = (migrated.type_field_masks ?? []).find((r) => norm(r.type) === norm("Справочник.Контрагенты"));
check(Array.isArray(contr?.core_whitelist_foreign), "доп-ключи записей сохранены (M-14)");

// 7. Существующая запись масок физлиц объединена, а не задвоена.
const fl = (migrated.type_field_masks ?? []).filter((r) => norm(r.type) === norm("Справочник.ФизическиеЛица"));
check(fl.length === 1, "запись масок физлиц одна (объединение, не дубль)");
check((fl[0]?.fields ?? []).some((f) => norm(f) === norm("ИНН"))
  && (fl[0]?.fields ?? []).some((f) => norm(f) === norm("Фамилия")),
  "объединённая запись содержит и явные, и материализованные поля");

// 8. Выключенные режимы ничего не добавляют.
const migratedOff = migrate({ ...FIXTURE, organization_aliases: { enabled: false }, person_aliases: { enabled: false } });
check(!(migratedOff.type_aliases ?? []).some((r) => norm(r.type) === norm("Справочник.Организации")),
  "organization_aliases.enabled=false не добавляет запись (ERP-специфика B-3: покрытие не добавляется втихую)");

console.log("");
console.log(`Итог порта миграции: ${fails === 0 ? "PASS" : "FAIL"} (провалов: ${fails})`);
console.log("Порт проверяет логику миграции на заглушке метаданных; живая приёмка (§9 п.5-9) обязательна.");
process.exit(fails === 0 ? 0 : 1);
