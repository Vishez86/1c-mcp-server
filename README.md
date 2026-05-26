# Universal 1C MCP Server (Read-Only)

Универсальный MCP-сервер для безопасного read-only доступа к данным и метаданным 1С:Предприятия 8. Постоянные данные не изменяются; временные таблицы языка запросов 1С разрешены как рабочая область выполнения аналитического запроса.

Сервер реализует протокол **Model Context Protocol (MCP) 2025-11-25** поверх HTTP-сервиса 1С и предоставляет LLM-агентам 23 read-only инструмента согласно спецификации `mcp_1c_tools_spec.md`.

## Возможности

- Полностью read-only: создание/изменение/удаление объектов невозможно.
- 23 tools: discovery → inspect → search → retrieve → explain → navigate → report → query guidance → data passport.
- Allowlist/denylist типов метаданных и полей.
- Маскирование заданных полей перед передачей ответа в LLM.
- Лимиты строк, времени и размера результата.
- Аудит всех вызовов с correlation_id.
- Универсальный — не зависит от конкретной конфигурации (УТ, ERP, БП и т.п.).
- LLM не должна выдумывать методы, сущности, таблицы и поля: все имена берутся из discovery/metadata tools, карты счетов или результата предыдущего вызова.
- Поддержка MCP Streamable HTTP: один endpoint `/rpc`, JSON-RPC 2.0, `202 Accepted` для notifications, `405` для GET/SSE при stateless-режиме.

## Реализованные tools

| № | Tool | Назначение |
|---:|---|---|
| 1 | `list_metadata_objects` | Список объектов метаданных |
| 2 | `get_metadata_structure` | Структура объекта метаданных |
| 3 | `run_1c_query` | Безопасный read-only запрос 1С |
| 4 | `validate_1c_query` | Проверка запроса до выполнения |
| 5 | `get_1c_query_guidance` | Универсальные подсказки по языку запросов 1С |
| 6 | `get_accounting_accounts_map` | Карта счетов и субконто плана счетов |
| 7 | `get_accounting_entries` | Бухгалтерские проводки с универсальным join к субконто |
| 8 | `get_inventory_balances_by_item` | Быстрые остатки товара по складам и организациям |
| 9 | `get_calculation_types_map` | Карта видов расчёта |
| 10 | `get_database_passport` | Паспорт фактических данных базы |
| 11 | `get_object_by_ref` | Получение объекта по типу и UUID |
| 12 | `find_object_by_id` | Поиск объекта по UUID без знания типа |
| 13 | `search_objects` | Поиск по строке/коду/ИНН/артикулу |
| 14 | `get_link_of_object` | Навигационная ссылка на объект |
| 15 | `find_references_to_object` | Поиск ссылок на объект |
| 16 | `get_enum_values` | Значения перечисления |
| 17 | `get_register_records` | Записи / срезы / остатки / обороты |
| 18 | `get_document_movements` | Движения документа по регистрам |
| 19 | `list_reports` | Список отчётов |
| 20 | `get_report_info` | Параметры и структура отчёта |
| 21 | `run_1c_report` | Выполнение отчёта |
| 22 | `get_object_history` | История объекта / журнал регистрации |
| 23 | `get_current_user_context` | Контекст пользователя и базы |

## Подробное описание tools

Все инструменты вызываются через MCP `tools/call`. В `arguments` передаются только параметры конкретного tool; `additionalProperties=false`, поэтому лишние поля лучше не отправлять. Успешный ответ всегда содержит `structuredContent.ok=true`; при ошибке возвращается `isError=true`, `structuredContent.ok=false` и блок `error { code, message, details, correlation_id }`. Если включён privacy-режим, в ответ добавляется `privacy`, совпадающие поля заменяются маской, а организации могут отображаться псевдонимами.

Общие ограничения для всех tools: учитываются права текущего пользователя 1С, allowlist/denylist метаданных, field-level ограничения, лимиты строк/таймаутов/размера JSON из `MCP_ServerConfig`. Имена объектов и полей нельзя угадывать: сначала используйте `list_metadata_objects`, `get_metadata_structure`, карту счетов или результат предыдущего вызова.

### `list_metadata_objects`

**Назначение:** discovery доступных объектов метаданных: справочников, документов, регистров, перечислений, отчётов и т.п.

**Параметры:** `kinds: string[]` фильтрует виды метаданных; `query: string` ищет по имени, синониму и комментарию; `include_not_allowed: boolean` доступен только MCP-admin; `include_details: boolean` добавляет комментарий; `limit: integer 1..1000 = 200`; `cursor: string` для следующей страницы.

**Пример:**

```json
{
  "kinds": ["Справочник", "Документ"],
  "query": "клиент",
  "include_details": true,
  "limit": 20
}
```

**Выходящая схема:** `objects[] { kind, name, full_name, synonym, comment?, allowed, readable, searchable, supports_ref, supports_query, resource_uri }`, `next_cursor`, `truncated`, `total_estimated`, опционально `domain_guidance`.

**Ограничения:** на больших конфигурациях полный обход метаданных может быть заметным; сужайте `kinds` и `query`. Запрещённые объекты не возвращаются, если нет прав администратора MCP.

### `get_metadata_structure`

**Назначение:** получить структуру конкретного объекта метаданных перед запросами, поиском, чтением регистров или объектов.

**Параметры:** обязательный `type: string` в формате `Справочник.Номенклатура`; флаги `include_standard_attributes`, `include_tabular_sections`, `include_forms`, `include_commands`, `include_query_names`, `include_sensitive_flags`, `include_virtual_tables`.

**Пример:**

```json
{
  "type": "РегистрНакопления.ТоварыНаСкладах",
  "include_virtual_tables": true,
  "include_tabular_sections": false
}
```

**Выходящая схема:** `metadata { kind, name, full_name, synonym, attributes[], standard_attributes[], tabular_sections[], register_schema?, query_table?, virtual_tables?, supports_ref?, supports_query? }`.

**Ограничения:** возвращаются только разрешённые поля и объекты. Формы и команды обычно не нужны LLM и могут увеличить ответ.

### `run_1c_query`

**Назначение:** выполнить безопасный read-only запрос на языке запросов 1С. Временные таблицы в пакетах разрешены как рабочая область, изменение постоянных данных запрещено.

**Параметры:** обязательный `query: string`; `parameters: object` с типизированными значениями `kind=string|number|boolean|date|datetime|uuid|ref|enum|array|null`; `limit: integer 1..1000 = 100`; `cursor`; `timeout_seconds: integer 1..60 = 15`; `validate_before_run`; `return_format: rows|table`; `include_column_types`.

**Пример:**

```json
{
  "query": "ВЫБРАТЬ ПЕРВЫЕ 10 Н.Ссылка, Н.Наименование ИЗ Справочник.Номенклатура КАК Н ГДЕ Н.Наименование ПОДОБНО &Шаблон",
  "parameters": { "Шаблон": { "kind": "string", "value": "%кабель%" } },
  "limit": 10
}
```

**Выходящая схема:** `columns[] { name, type_description }`, `rows[]`, `row_count`, `truncated`, `next_cursor`, `duration_ms`, `warnings[]`, опционально `query_guidance`. При ошибках запроса дополнительно возвращаются `error_code`, `hint`, `field`, `field_path`, `object`, `available_fields`, `suggestions`.

**Ограничения:** может выполняться долго на больших БД, особенно при широких `JOIN`, виртуальных таблицах без параметров и отсутствии индексов. Не используйте `ВЫБРАТЬ *`; сначала получите структуру метаданных и ограничивайте поля, период и `limit`.

### `validate_1c_query`

**Назначение:** проверить запрос до выполнения: read-only синтаксис, известные таблицы, параметры, доступ к объектам, рискованные конструкции.

**Параметры:** обязательный `query: string`; `parameters: object`; `strict: boolean`; `explain: boolean`.

**Пример:**

```json
{
  "query": "ВЫБРАТЬ Н.Ссылка ИЗ Справочник.Номенклатура КАК Н",
  "strict": true,
  "explain": true
}
```

**Выходящая схема:** `valid: boolean`, `errors[] { code, message, location?, hint?, see_also? }`, `warnings[]`, `detected_objects[]`, `detected_parameters[]`, `estimated_risk`, опционально `query_guidance` и `interaction_hint`.

**Ограничения:** валидация не заменяет фактическое выполнение: часть ошибок платформы 1С обнаружится только при `run_1c_query`.

### `get_1c_query_guidance`

**Назначение:** вернуть встроенные правила и подсказки по языку запросов 1С: временные таблицы, виртуальные таблицы, `ИМЕЮЩИЕ`, составные типы, субконто, параметры и производительность.

**Параметры:** `topic: string` или `auto`; `query: string` для контекстных подсказок; `intent: string`; `include_examples: boolean`; `max_sections: integer 1..12 = 6`.

**Пример:**

```json
{
  "topic": "virtual-tables",
  "intent": "получить остатки товаров на дату",
  "include_examples": true
}
```

**Выходящая схема:** `configuration_agnostic`, `source`, `topics[]`, `guidance[] { topic, title, text, examples? }`.

**Ограничения:** это справка, а не метаданные конкретной базы; прикладные имена всё равно нужно брать через discovery tools.

### `get_accounting_accounts_map`

**Назначение:** прочитать `ПланСчетов.<Имя>.ВидыСубконто` и вернуть соответствие счетов позициям `Субконто1/2/3`.

**Параметры:** `chart: string` полное имя плана счетов или краткое имя; `account_code_prefix: string`; `include_empty_subconto: boolean`; `limit: integer 1..1000 = 500`; `cursor`; `include_query: boolean`.

**Пример:**

```json
{
  "chart": "ПланСчетов.Хозрасчетный",
  "account_code_prefix": "41",
  "include_empty_subconto": true,
  "limit": 100
}
```

**Выходящая схема:** `chart`, `filter`, `tabular_section`, `source_of_truth`, `accounts[] { code, name, ref?, subconto[] }`, `total_accounts`, `next_cursor`, `truncated`, `warnings[]`, `guidance`, опционально `query_used`.

**Ограничения:** если доступно несколько планов счетов и `chart` не указан, tool вернёт `needs_chart=true`. На больших планах используйте `account_code_prefix` и пагинацию.

### `get_accounting_entries`

**Назначение:** быстрый универсальный путь для чтения проводок из основной таблицы `РегистрБухгалтерии.*` и, при необходимости, join к `РегистрБухгалтерии.*.Субконто`.

**Параметры:** `accounting_register`; `period_from`; `period_to`; `debit_account_code_prefixes`; `credit_account_code_prefixes`; `subconto_side: debit|credit`; `subconto_kind { kind:"ref", type, uuid }`; `subconto_value { kind:"ref", type, uuid }`; `group_by: string[]`; `include_zero`; `include_query`; `limit`; `cursor`.

**Пример:**

```json
{
  "accounting_register": "Хозрасчетный",
  "credit_account_code_prefixes": ["02"],
  "subconto_side": "credit",
  "group_by": ["period_month", "credit_subconto"],
  "include_query": true,
  "limit": 100
}
```

**Выходящая схема:** стандартная табличная схема `columns[]`, `rows[]`, `row_count`, плюс `accounting_register`, `mode`, `group_by`, `subconto_side`, `configuration_agnostic`, `guidance`, опционально `query_used`.

**Ограничения:** tool не содержит бизнес-логики ОС/ТМЦ/НДС. Для фильтра по виду субконто сначала получите реальный `subconto_kind` из `get_accounting_accounts_map` или metadata/query результата.

### `get_inventory_balances_by_item`

**Назначение:** быстрый путь для вопроса об остатках товара: найти номенклатуру, определить виды субконто и выполнить агрегированный запрос к бухгалтерскому регистру.

**Параметры:** `item_query: string` или `item_ref { type, uuid }`; `item_type`; `as_of: string` ISO-дата; `accounting_register`; `chart`; `account_code_prefixes: string[]`; `item_subconto_name`; `warehouse_subconto_name`; `include_zero`; `include_query`; `limit: integer 1..1000 = 100`.

**Пример:**

```json
{
  "item_query": "Кабель ВВГ",
  "as_of": "2026-05-23T00:00:00",
  "account_code_prefixes": ["41", "43"],
  "limit": 50
}
```

**Выходящая схема:** стандартная табличная схема `columns[]`, `rows[]`, `row_count`, плюс `item`, `item_search`, `as_of`, `accounting_register`, `chart`, `account_code_prefixes`, `subconto`, `totals`, `warnings[]`, опционально `query_used`.

**Ограничения:** ориентирован на бухгалтерские регистры и типовые субконто номенклатуры/складов. `account_code_prefixes` применяются для поиска видов субконто и как фильтр остатков по коду счёта. Если в базе другой план счетов или названия видов субконто, передайте их явно.

### `get_calculation_types_map`

**Назначение:** получить реальные виды расчёта из `ПланВидовРасчета.<Имя>` для ЗУП-подобных конфигураций.

**Параметры:** `plan: string`; `code_prefix: string`; `limit: integer 1..1000 = 500`; `cursor`; `include_query: boolean`.

**Пример:**

```json
{
  "plan": "ПланВидовРасчета.Начисления",
  "code_prefix": "ОКЛ",
  "limit": 50
}
```

**Выходящая схема:** `plan`, `filter`, `calculation_types[] { code, name, ref?, ... }`, `total_calculation_types`, `next_cursor`, `truncated`, `warnings[]`, `guidance`, опционально `query_used`.

**Ограничения:** если доступно несколько планов и `plan` не указан, вернётся `needs_plan=true`. На больших планах используйте `code_prefix`.

### `get_database_passport`

**Назначение:** диагностический паспорт фактических данных: активные организации, период данных, закрытые периоды, заполненность регистров.

**Параметры:** `accounting_register`; флаги `include_organizations`, `include_period`, `include_closed_periods`, `include_accumulation_registers`, `include_information_registers`, `include_calculation_registers`, `include_empty_registers`, `force_refresh`; лимиты `organization_limit`, `accounting_register_limit`, `accumulation_register_limit`, `information_register_limit`, `calculation_register_limit`.

**Пример:**

```json
{
  "include_organizations": true,
  "include_period": true,
  "include_accumulation_registers": false,
  "include_information_registers": false,
  "force_refresh": false
}
```

**Выходящая схема:** `generated_at`, `configuration_agnostic`, `read_only`, `cache_hit`, `cache_age_seconds`, `warnings[]`, опционально `organizations[]`, `data_period`, `accounting_registers[]`, `closed_periods[]`, `accumulation_registers`, `information_registers`, `calculation_registers` и detail-разделы.

**Ограничения:** потенциально самый тяжёлый discovery tool на больших БД, потому что проверяет множество регистров. Выключайте лишние `include_*` и не используйте `force_refresh` без необходимости. В универсальной поставке кэш явно помечается через `cache_hit/cache_age_seconds`.

### `get_object_by_ref`

**Назначение:** получить объект по точному типу и UUID ссылки.

**Параметры:** обязательные `type`, `uuid`; `fields: string[]`; `include_standard_fields`; `include_tabular_sections`; `tabular_sections: string[]`; `tabular_section_row_limit: integer 1..1000 = 100`; `tabular_section_cursor`; `include_navigation_url`.

**Пример:**

```json
{
  "type": "Справочник.Номенклатура",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "fields": ["Код", "Наименование", "Артикул"],
  "include_tabular_sections": false
}
```

**Выходящая схема:** `found`, `object { ref, standard_fields, fields, tabular_sections, tabular_sections_paging }`; если объект не найден, `object=null`.

**Ограничения:** работает только для ссылочных объектов с разрешённым типом. Табличные части могут быть большими; включайте их выборочно и используйте курсор.

### `find_object_by_id`

**Назначение:** найти объект по UUID, когда тип неизвестен.

**Параметры:** обязательный `uuid`; `types: string[]`; `kinds: string[]`; `limit: integer 1..100 = 10`; `cursor`; `include_deleted`.

**Пример:**

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "kinds": ["Справочник", "Документ"],
  "limit": 5
}
```

**Выходящая схема:** `found`, `matches[] { ref, standard_fields }`, `searched_types_count`, `types_truncated`, `truncated`, `next_cursor`, `warnings[]`.

**Ограничения:** может быть долгим, если не задать `types`/`kinds`, потому что перебирает разрешённые ссылочные типы. Перебор ограничен `max_searched_types_per_call`.

### `search_objects`

**Назначение:** человеко-ориентированный поиск объектов по строке, коду, номеру, ИНН, артикулу и разрешённым поисковым полям.

**Параметры:** обязательный `query`; `types`; `kinds`; `search_fields`; `filters`; `date_from`; `date_to`; `limit: integer 1..100 = 20`; `cursor`; `include_deleted`; `include_fields`; `match_mode: auto|exact|prefix|contains`.

**Пример:**

```json
{
  "query": "7701234567",
  "types": ["Справочник.Контрагенты"],
  "include_fields": ["ИНН", "КПП", "Наименование"],
  "match_mode": "exact"
}
```

**Выходящая схема:** `matches[] { ref, score, matched_fields[], fields }`, `truncated`, `next_cursor`.

**Ограничения:** поиск по многим типам может быть дорогим. `filters` объявлен в схеме, но универсальная реализация сейчас в основном использует строковый поиск и период для документов; для сложных фильтров лучше `run_1c_query` после проверки метаданных.

### `get_link_of_object`

**Назначение:** получить навигационные ссылки на объект 1С: `e1cib` и, при разрешённом `base_url`, ссылку web-клиента.

**Параметры:** обязательные `type`, `uuid`; `link_type: auto|e1cib|web_client|thin_client`; `base_url`; `include_presentation`.
Если `base_url` не передан, используется `web_client.base_url` из `MCP_ServerConfig`.

**Пример:**

```json
{
  "type": "Документ.ЗаказКлиента",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "link_type": "auto",
  "base_url": "https://1c.example.com/base"
}
```

**Выходящая схема:** `found`, `ref`, `presentation?`, `links[] { type, url, description }`, `warnings[]`.

**Ограничения:** `base_url` должен быть HTTP(S) и разрешён в allowlist. `thin_client` в универсальной реализации может вернуть предупреждение о неподдержанном формате.

### `find_references_to_object`

**Назначение:** найти объекты, которые ссылаются на заданную ссылку.

**Параметры:** обязательный `target { type, uuid }`; `search_in_types`; `search_in_kinds`; `period_from`; `period_to`; `limit_per_type: integer 1..100 = 20`; `max_types: integer 1..200 = 50`; `cursor`; `include_counts`; `include_samples`.

**Пример:**

```json
{
  "target": {
    "type": "Справочник.Номенклатура",
    "uuid": "550e8400-e29b-41d4-a716-446655440000"
  },
  "search_in_kinds": ["Документ"],
  "include_samples": true
}
```

**Выходящая схема:** `target`, `references[] { source_type, field_path, count, samples[], truncated }`, `searched_types_count`, `truncated`, `next_cursor`, `warnings[]`.

**Ограничения:** зависит от доступности штатного `НайтиПоСсылкам` и прав пользователя. Fallback может быть неполным; при недоступности сервер явно добавляет предупреждение.

### `get_enum_values`

**Назначение:** получить значения перечисления.

**Параметры:** обязательный `type` в формате `Перечисление.<Имя>`; `include_order`; `include_empty`; `limit: integer 1..1000 = 1000`; `cursor`.

**Пример:**

```json
{
  "type": "Перечисление.ВидыЦен",
  "include_order": true,
  "include_empty": true
}
```

**Выходящая схема:** `type`, `values[] { name, presentation, order? }`, `next_cursor`, `truncated`, `total_estimated`.

**Ограничения:** работает только с разрешёнными `Перечисление.*`; UUID-поиск к значениям перечислений не применяется.

### `get_register_records`

**Назначение:** универсальное чтение регистров: записи, срезы первых/последних, остатки, обороты, остатки и обороты.

**Параметры:** обязательные `register_type: РегистрСведений|РегистрНакопления|РегистрБухгалтерии|РегистрРасчета`, `register`, `mode: records|slice_first|slice_last|balance|turnovers|balance_and_turnovers|turnovers_debit_credit`; `period`; `period_from`; `period_to`; `filters`; `dimensions`; `resources`; `attributes`; `order_by`; `limit: integer 1..1000 = 100`; `cursor`.

**Пример:**

```json
{
  "register_type": "РегистрНакопления",
  "register": "ТоварыНаСкладах",
  "mode": "balance",
  "period": "2026-05-23T00:00:00",
  "dimensions": ["Номенклатура", "Склад"],
  "resources": ["Количество"],
  "limit": 100
}
```

**Выходящая схема:** `register`, `mode`, `columns[] { name, type_description }`, `rows[]`, `row_count`, `truncated`, `next_cursor`, `query_used`, `duration_ms`.

**Ограничения:** режимы зависят от вида регистра. Для `slice_*` и `balance` нужен `period`; для оборотов нужны `period_from` и `period_to`. Виртуальные таблицы на больших регистрах могут выполняться долго, особенно без фильтров по измерениям.

### `get_document_movements`

**Назначение:** получить движения документа-регистратора по регистрам.

**Параметры:** обязательные `document_type`, `uuid`; `registers: string[]`; `include_empty_registers`; `include_totals_effect`; `row_limit_per_register: integer 1..1000 = 200`; `cursor`; `row_cursor`.

**Пример:**

```json
{
  "document_type": "Документ.РеализацияТоваровУслуг",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "include_empty_registers": false,
  "row_limit_per_register": 100
}
```

**Выходящая схема:** `found`, `document`, `movements[] { register, register_type, rows[], row_count, truncated, next_row_cursor }`, `truncated`, `next_cursor`.

**Ограничения:** доступность зависит от прав на документ и регистры. Документы с большим количеством движений нужно читать постранично через `cursor`/`row_cursor`.

### `list_reports`

**Назначение:** discovery доступных отчётов и вариантов.

**Параметры:** `query`; `include_variants`; `include_not_allowed` только MCP-admin; `limit: integer 1..500 = 100`; `cursor`.

**Пример:**

```json
{
  "query": "продажи",
  "include_variants": true,
  "limit": 10
}
```

**Выходящая схема:** `reports[] { type, name, synonym, description, allowed, execution_supported, execution_reason, has_custom_pre_compose, variants? }`, `next_cursor`, `truncated`, `total_estimated`, опционально `interaction_hint` и `domain_guidance`.

**Ограничения:** возвращает только метаданные отчётов, не выполняет их. Для отчётной аналитики сначала выберите отчёт/вариант, затем вызывайте `get_report_info`.

### `get_report_info`

**Назначение:** получить параметры, варианты и поддерживаемые форматы вывода отчёта.

**Параметры:** обязательный `report`; `variant`; `include_schema`; `include_variants`; `include_default_settings`.

**Пример:**

```json
{
  "report": "Отчет.Продажи",
  "variant": "ПродажиПоКонтрагентам",
  "include_default_settings": true
}
```

**Выходящая схема:** `report`, `synonym`, `variants[]`, `has_custom_pre_compose`, `report_parameter_source`, `parameters[] { name, presentation, type_description, required, default_value }`, `output_formats[]`, `warnings[]`, опционально `domain_guidance`.

**Ограничения:** подробная схема СКД в универсальном адаптере может не возвращаться даже при `include_schema=true`; тогда в `warnings` будет явное сообщение.

### `run_1c_report`

**Назначение:** выполнить разрешённый отчёт 1С через СКД и вернуть табличный результат.

**Параметры:** обязательный `report`; `variant`; `parameters: object`; `output_format: table|json|text`; `limit: integer 1..1000 = 200`; `cursor`; `timeout_seconds: integer 1..180 = 60`; `include_totals`.

**Пример:**

```json
{
  "report": "Отчет.Продажи",
  "variant": "Основной",
  "parameters": {
    "ДатаНачала": { "kind": "date", "value": "2026-01-01" },
    "ДатаОкончания": { "kind": "date", "value": "2026-05-23" }
  },
  "limit": 200
}
```

**Выходящая схема:** `report`, `variant`, `execution_supported`, `columns[]`, `rows[]`, `totals`, `row_count`, `truncated`, `next_cursor`, `total_estimated`, `duration_ms`, `pre_compose_applied`, `warnings[]`, `parameters_used`.

**Ограничения:** отчёты СКД могут выполняться существенно дольше прямых узких запросов, особенно с широкими периодами и детализацией. Используйте параметры периода, небольшой `limit` и `timeout_seconds`.

### `get_object_history`

**Назначение:** получить историю объекта из журнала регистрации и/или подсистемы версионирования, если они доступны.

**Параметры:** обязательный `target { type, uuid }`; `mode: auto|versions|event_log|status_changes`; `period_from`; `period_to`; `include_diff`; `limit: integer 1..500 = 100`; `cursor`.

**Пример:**

```json
{
  "target": {
    "type": "Документ.ЗаказКлиента",
    "uuid": "550e8400-e29b-41d4-a716-446655440000"
  },
  "mode": "event_log",
  "period_from": "2026-01-01T00:00:00",
  "limit": 50
}
```

**Выходящая схема:** `supported`, `target`, `events[] { timestamp, user, event_type, description, diff }`, `truncated`, `next_cursor`, `capabilities { versions, event_log, diff }`.

**Ограничения:** журнал регистрации требует соответствующих прав 1С. `diff` в универсальной реализации не поддержан (`capabilities.diff=false`); если источники истории недоступны, tool возвращает `supported=false` или пустой список без фатальной ошибки.

### `get_current_user_context`

**Назначение:** получить текущий контекст пользователя, базы, версии сервера, лимитов и summary доступных метаданных.

**Параметры:** `include_roles`; `include_limits`; `include_allowed_metadata_summary`; `include_server_info`.

**Пример:**

```json
{
  "include_roles": true,
  "include_limits": true,
  "include_allowed_metadata_summary": true,
  "include_server_info": true
}
```

**Выходящая схема:** `user { name, full_name, roles? }`, `infobase { name, synonym, configuration_name, configuration_version, platform_version, host }`, `mcp_server { name, version, read_only, tools[] }`, `limits`, `privacy`, `allowed_metadata_summary { objects_count, kinds }`.

**Ограничения:** не заменяет `list_metadata_objects`, потому что возвращает только summary. Роли и сведения о пользователе могут быть ограничены правами и политикой безопасности.

## Структура проекта

```
1c MCP/
├── README.md                  -- этот файл
├── INSTALL.md                 -- инструкция по установке в 1С
├── ARCHITECTURE.md            -- описание архитектуры
├── config/
│   ├── allowlist.json         -- пример allowlist метаданных
│   └── server_config.json     -- пример лимитов и настроек
└── src/
    ├── HTTPServices/
    │   └── MCP_HTTPService.bsl              -- HTTP-сервис, точка входа
    └── CommonModules/
        ├── MCP_Config.bsl                   -- конфигурация и лимиты
        ├── MCP_JSONRPC.bsl                  -- JSON-RPC 2.0 + MCP dispatcher
        ├── MCP_Errors.bsl                   -- единая модель ошибок
        ├── MCP_Security.bsl                 -- allowlist, права, ограничения
        ├── MCP_Audit.bsl                    -- аудит вызовов
        ├── MCP_Values.bsl                   -- кодирование значений 1С в JSON
        ├── MCP_Metadata.bsl                 -- обход метаданных
        ├── MCP_Query.bsl                    -- безопасные запросы 1С
        ├── MCP_Knowledge.bsl                -- встроенные правила языка запросов 1С для LLM
        ├── MCP_Registers.bsl                -- работа с регистрами
        ├── MCP_Reports.bsl                  -- работа с отчётами (СКД)
        ├── MCP_History.bsl                  -- история объектов
        ├── MCP_Tools.bsl                    -- описания и dispatcher tools
        └── MCP_Tools_Impl.bsl               -- реализация tools
```

## Транспорт

HTTP-сервис `MCP` реализует Streamable HTTP endpoint:

```
http(s)://<сервер>/<база>/hs/mcp/rpc
```

Поддерживаемые HTTP-методы:

```
POST     -- JSON-RPC request / notification / response
GET      -- 405 Method Not Allowed, если не нужен server-to-client SSE
DELETE   -- 405 Method Not Allowed, сессии транспорта не создаются
OPTIONS  -- CORS preflight
```

Поддерживаемые JSON-RPC методы:

```
initialize           -- инициализация сессии
notifications/initialized -- lifecycle notification после initialize
tools/list           -- список инструментов
tools/call           -- вызов инструмента
resources/list       -- список ресурсов (необязательно)
resources/read       -- чтение ресурса
ping                 -- ping
```

## Встроенная база знаний для LLM

Сервер отдаёт знания из `doc/skills` через MCP, чтобы агент мог составлять запросы 1С без привязки к конкретной конфигурации:

- tool `get_1c_query_guidance` возвращает короткие контекстные подсказки по теме или черновику запроса;
- tool `get_accounting_accounts_map` читает live-таблицу `ПланСчетов.<Имя>.ВидыСубконто` и возвращает `accounts[].subconto[]`, чтобы агент не угадывал позиции `Субконто1/2/3`;
- tool `get_calculation_types_map` читает `ПланВидовРасчета.<Имя>` и возвращает реальные виды расчёта для ЗУП-подобных конфигураций;
- tool `get_database_passport` возвращает фактический срез данных: активные организации, горизонт записей, закрытые периоды при наличии регистра дат запрета и заполненность регистров накопления/сведений/расчёта; параметр `force_refresh` принудительно пересчитывает паспорт, а поля `cache_hit`/`cache_age_seconds` показывают состояние кэша или его отсутствие в универсальной read-only поставке;
- `validate_1c_query` и `run_1c_query` добавляют `query_guidance` и структурированные подсказки ошибок, если запрос содержит временные таблицы, агрегаты, субконто, составные ссылки, `NULL`, JOIN или другие рискованные конструкции;
- resources `1c://knowledge/query/*` дают полную встроенную справку: syntax, functions, optimization, temporary-tables, compound-types, subconto, parameters, reports-vs-query, report-fast-path, payroll.

Главное правило этой базы знаний: сначала получить метаданные через `list_metadata_objects` / `get_metadata_structure`, затем писать запрос по фактическим именам объектов и полей текущей базы.

## Быстрый старт

1. Установите расширение конфигурации (см. `INSTALL.md`).
2. Опубликуйте HTTP-сервис на веб-сервере (IIS/Apache).
3. Настройте `config/allowlist.json` под свою конфигурацию.
4. Создайте сервисного пользователя 1С с минимальными правами.
5. Подключите MCP-клиента к `http(s)://.../hs/mcp/rpc`.

См. подробности в `INSTALL.md`.

## Полный доступ для тестирования

Для локального стенда или демо-базы удобно открыть чтение всех стандартных объектов метаданных. Постоянные данные при этом всё равно остаются read-only: сервер не выполняет запись, проведение, удаление или изменение прикладных объектов; временные таблицы разрешены только как рабочая область запроса.

Важно: `config/server_config.json` настраивает CORS/HTTP и лимиты выполнения. Доступ к объектам метаданных задаётся allowlist-конфигом, который сервер читает из константы 1С `MCP_Allowlist` или из примера `config/allowlist.json`.

## Защита персональных данных

В `MCP_ServerConfig` можно указать поля, значения которых нельзя передавать в LLM:

```json
{
  "web_client": {
    "base_url": "https://laba-1c.astondevs.ru/BUH_KORP"
  },

  "privacy": {
    "masked_fields": ["ФИО", "ДатаРождения", "НомерПаспорта", "ПерсональныйНомер"],
    "organization_aliases": {
      "enabled": true,
      "prefix": "Орг-",
      "include_navigation_url": true
    },
    "person_aliases": {
      "enabled": true,
      "physical_person_prefix": "ФЛ-",
      "employee_prefix": "Сотр-",
      "include_navigation_url": true
    }
  }
}
```

`web_client.base_url` задаёт корневой URL web-клиента 1С. Если он заполнен, `ObjectRef.navigation_url` возвращается как кликабельная HTTP(S)-ссылка вида `https://.../e1cib/data/<Тип>?ref=<uuid>`, а исходная ссылка платформы сохраняется в `e1cib_navigation_url`. Для стендов с включённым `restrict_data_access: true` этот URL также нужно добавить в `allowed_base_urls` allowlist.

Если `masked_fields` отсутствует или пустой, сервер отдаёт данные как раньше. Если список заполнен, совпадающие поля маскируются во всех tool-ответах: обычные значения заменяются на `XXXXXXX`, даты — на `1900-01-01T00:00:00` (`01.01.1900`). Сравнение имён регистронезависимое и не учитывает пробелы, дефисы и подчёркивания, поэтому правило остаётся общим и не привязано к конкретной конфигурации 1С.

`organization_aliases` по умолчанию выключен. Если включить `enabled: true`, сервер заменяет полные названия `Справочник.Организации` на стабильные коды вида `Орг-453276` во всех tool-ответах, ресурсах и диагностических JSON-данных. Ссылки сохраняют `type`, `uuid`, `ref` и доступный `navigation_url`; при настроенном `web_client.base_url` это конечная ссылка web-клиента, пригодная для открытия из чата. Если в произвольном результате есть только строковое поле, явно похожее на организацию, но нет UUID/ссылки, сервер возвращает `Орг-скрыто`.

`person_aliases` по умолчанию выключен. Если включить `enabled: true`, сервер заменяет `presentation` и поля ФИО у `Справочник.ФизическиеЛица` и `Справочник.Сотрудники*` стабильными кодами вида `ФЛ-453276` или `Сотр-453276`. При настроенном `web_client.base_url` `navigation_url` у таких ссылок тоже становится кликабельной web-ссылкой. Паспортные данные, индивидуальный номер, страховой номер и дата рождения маскируются как чувствительные поля. Если в произвольном результате есть только строковое поле, явно похожее на физлицо/сотрудника, но нет UUID/ссылки, сервер возвращает `ФЛ-скрыто`.

Когда privacy-режим включен, сервер явно сообщает об этом LLM: добавляет `privacy` в каждый tool-result, возвращает `privacy` в `get_current_user_context`, а также добавляет короткую подсказку в `tools/list`/описания tools. Агент должен считать перечисленные поля, названия организаций и ФИО/персональные реквизиты намеренно недоступными и не пытаться обходить политику альтернативными запросами.

Форма служебного блока: `{ "enabled": true, "masked_fields": [...], "string_mask": "XXXXXXX", "date_mask": "1900-01-01T00:00:00", "organization_aliases": {"enabled": true, "prefix": "Орг-", "resolution": "open_navigation_url_in_1c"}, "person_aliases": {"enabled": true, "physical_person_prefix": "ФЛ-", "employee_prefix": "Сотр-", "resolution": "open_navigation_url_in_1c"}, "guidance": "..." }`.

Минимальный allowlist для полного тестового доступа:

```json
{
  "restrict_data_access": false,
  "default_policy": "allow",
  "allowed_kinds": [
    "Справочник",
    "Документ",
    "Перечисление",
    "РегистрСведений",
    "РегистрНакопления",
    "РегистрБухгалтерии",
    "РегистрРасчета",
    "ПланСчетов",
    "ПланВидовХарактеристик",
    "ПланВидовРасчета",
    "ПланОбмена",
    "БизнесПроцесс",
    "Задача",
    "Отчет"
  ],
  "denied_objects": [],
  "allowed_metadata": {},
  "allowed_base_urls": []
}
```

Быстрый порядок настройки:

1. Скопируйте JSON выше в константу 1С `MCP_Allowlist` или замените им содержимое `config/allowlist.json` перед переносом настроек в базу.
2. В `config/server_config.json` для тестов задайте разумные лимиты строк, размера ответа и таймаутов. Read-only политика и правила временных таблиц задаются в коде сервера, а не в JSON-конфиге.
3. Используйте отдельного сервисного пользователя и тестовую базу. Для продуктивной базы верните явные `denied_objects`, `hidden_fields` и точечный `allowed_metadata`.

## Версия

- MCP-протокол: `2025-11-25`
- Сервер: `0.1.0`
- Платформа 1С: `8.3.18+` (используется ЗаписьJSON, HTTP-сервисы, ОписаниеТипов).
