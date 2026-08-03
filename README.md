# Universal 1C MCP Server (Read-Only)

Универсальный MCP-сервер для безопасного read-only доступа к данным и метаданным 1С:Предприятия 8. Постоянные данные не изменяются; временные таблицы языка запросов 1С разрешены как рабочая область выполнения аналитического запроса.

Сервер реализует протокол **Model Context Protocol (MCP) 2025-11-25** поверх HTTP-сервиса 1С и предоставляет LLM-агентам 37 read-only инструментов согласно спецификации `mcp_1c_tools_spec.md`.

> **Минимальная версия платформы: 1С:Предприятие 8.3.10+.** Tool `get_query_examples` использует `ХешированиеДанных` и `СхемаЗапроса`, доступные с 8.3.10.

## Возможности

- Полностью read-only: создание/изменение/удаление объектов невозможно.
- 37 tools: discovery → inspect → search → retrieve → explain → navigate → report → query guidance → generated language docs → data passport → query examples → legal sources.
- Allowlist/denylist типов метаданных и полей.
- Маскирование заданных полей перед передачей ответа в LLM.
- Лимиты строк, времени и размера результата.
- Аудит всех вызовов с correlation_id.
- Универсальный — не зависит от конкретной конфигурации (УТ, ERP, БП и т.п.).
- LLM не должна выдумывать методы, сущности, таблицы и поля: все имена берутся из discovery/metadata tools, карты счетов или результата предыдущего вызова.
- Поддержка MCP Streamable HTTP: один endpoint `/rpc`, JSON-RPC 2.0, `202 Accepted` для notifications, `405` для GET/SSE при stateless-режиме.

См. вебинар [AI in 1C: How to Automate Routine Tasks and Speed Up Business Processes](https://www.youtube.com/live/acRb2MDiaSE).

## Реализованные tools

| № | Tool | Назначение |
|---:|---|---|
| 1 | `list_metadata_objects` | Список объектов метаданных |
| 2 | `get_metadata_structure` | Структура объекта метаданных |
| 3 | `search_metadata_fields` | Компактный поиск полей метаданных |
| 4 | `count_event_subscriptions_by_event` | Статистика подписок на события |
| 5 | `list_event_subscriptions` | Список подписок на события |
| 6 | `run_1c_query` | Безопасный read-only запрос 1С |
| 7 | `validate_1c_query` | Проверка запроса до выполнения |
| 8 | `get_1c_query_guidance` | Универсальные подсказки по языку запросов 1С |
| 9 | `list_1c_language_doc_topics` | Темы встроенной документации языка 1С 8.3.27 |
| 10 | `search_1c_language_docs` | Поиск по встроенной документации языка 1С |
| 11 | `read_1c_language_doc_section` | Чтение одной секции документации языка 1С |
| 12 | `get_1c_language_doc_provenance` | Версия и источники документации языка 1С |
| 13 | `list_registers` | Компактный список регистров |
| 14 | `get_accounting_accounts_map` | Карта счетов и субконто плана счетов |
| 15 | `get_accounting_balances` | Бухгалтерские остатки и обороты |
| 16 | `get_accounting_balances_by_subconto_age` | Aging бухгалтерских остатков по выбранному субконто |
| 17 | `compare_accounting_balances_by_subconto` | Сравнение двух наборов остатков по одной аналитике |
| 18 | `get_accounting_entries` | Бухгалтерские проводки с универсальным join к субконто |
| 19 | `get_inventory_balances_by_item` | Быстрые остатки товара по складам и организациям |
| 20 | `get_calculation_types_map` | Карта видов расчёта |
| 21 | `get_database_passport` | Паспорт фактических данных базы |
| 22 | `get_object_by_ref` | Получение объекта по типу и UUID |
| 23 | `find_object_by_id` | Поиск объекта по UUID без знания типа |
| 24 | `search_objects` | Поиск по строке/коду/ИНН/артикулу |
| 25 | `get_link_of_object` | Навигационная ссылка на объект |
| 26 | `find_references_to_object` | Поиск ссылок на объект |
| 27 | `get_enum_values` | Значения перечисления |
| 28 | `get_register_records` | Записи / срезы / остатки / обороты |
| 29 | `get_document_movements` | Движения документа по регистрам |
| 30 | `list_reports` | Список отчётов |
| 31 | `get_report_info` | Параметры и структура отчёта |
| 32 | `run_1c_report` | Выполнение отчёта |
| 33 | `get_object_history` | История объекта / журнал регистрации |
| 34 | `get_current_user_context` | Контекст пользователя и базы |
| 35 | `get_query_examples` | Проверенные шаблоны запросов для объекта (few-shot) |
| 36 | `list_legal_sources` | Реестр разрешённых правовых источников |
| 37 | `get_legal_source_guide` | Инструкция по работе с правовым источником |

> `list_legal_sources` / `get_legal_source_guide` — реестр разрешённых правовых источников и инструкции по работе с ними. Встроенные источники — два раздела pravo.gov.ru: `pravo_gov_ru` («Официальное опубликование», открытый API, первоначальные редакции) и `pravo_gov_ru_actual` («Тексты правовых актов с внесёнными изменениями», actual.pravo.gov.ru — актуальные консолидированные редакции кодексов и федеральных актов, включая будущие редакции). Обязательная политика для LLM-агентов: общий веб-поиск правовой информации и fallback на сторонние сайты запрещены; разрешён только прямой доступ к URL источника после `list_legal_sources` → `get_legal_source_guide`. При недоступности источника агент должен остановиться и сообщить, что норма не проверена. Политика передаётся уже в `initialize.instructions`, повторяется в `tools/list`, описаниях tools и их результатах. Реестр зашит в модуль `MCP_LegalSources`; при наличии в конфигурации регистра сведений `MCP_ПравовыеИсточники` его записи дополняют и переопределяют встроенные без обновления расширения (см. `INSTALL.md`).

> `get_query_examples` — единственный tool с классификацией **operational metadata write**: постоянные бизнес-данные 1С не изменяются, но сервер накапливает обезличенные шаблоны успешных `run_1c_query` в журнале регистрации (событие `MCP.QueryExample`) для переиспользования между сессиями агентов. Feature строго opt-in (`query_examples.enabled`, по умолчанию выключен).

## Подробное описание tools

Все инструменты вызываются через MCP `tools/call`. В `arguments` передаются только параметры конкретного tool; `additionalProperties=false`, поэтому лишние поля лучше не отправлять. Формат результата задаёт `response.tool_result_mode`: `text_only` возвращает полный JSON только в `content[].text` и не объявляет `outputSchema`; `structured_only` возвращает `structuredContent` и объявляет `outputSchema`; `both` возвращает оба канала и дублирует JSON в тексте. По умолчанию используется `text_only`, чтобы Claude Desktop/Windows точно видел значения без двойного расхода токенов. Для контрактных проверок `tools/list` и `tools/call` принимают JSON-RPC param `_response_mode=text_only|structured_only|both`, который временно переопределяет режим без изменения `arguments` конкретного tool. Каждый ответ содержит минимальный `auth_context.user_name`, `auth_context.identity_key` и `cache_policy.cacheable=false`; полный контекст доступен через `get_current_user_context` или `include_auth_context=true`. Если включён privacy-режим, в ответ добавляется `privacy`, совпадающие поля заменяются маской, а организации могут отображаться псевдонимами.

Общие ограничения для всех tools: учитываются права текущего пользователя 1С, allowlist/denylist метаданных, field-level ограничения, лимиты строк/таймаутов/размера JSON из `MCP_ServerConfig`. Имена объектов и полей нельзя угадывать: сначала используйте `list_metadata_objects`, `get_metadata_structure`, карту счетов или результат предыдущего вызова. Если вернулся `error.code=access_denied`, LLM должна объяснить пользователю нехватку прав и не повторять тот же запрос без перелогина или изменения прав.

Пример отказа доступа в режимах `structured_only` и `both`:

```json
{
  "isError": true,
  "structuredContent": {
    "ok": false,
    "auth_context": {
      "user_name": "ivanov",
      "identity_key": "ivanov@ERP#2.5.19.123",
      "cache_policy": { "cacheable": false, "revalidate_each_call": true }
    },
    "authorization": {
      "reason_code": "1c_access_denied",
      "denied_operation": "query_execute",
      "retry_policy": "do_not_retry_same_request_without_reauth_or_permission_change"
    },
    "error": { "code": "access_denied", "message": "Недостаточно прав текущей учетной записи 1С." }
  }
}
```

### `list_metadata_objects`

**Назначение:** discovery доступных объектов метаданных: справочников, документов, регистров, перечислений, отчётов и т.п.

**Параметры:** `kinds: string[]` фильтрует виды метаданных; `query: string` ищет по имени, синониму и комментарию; `include_not_allowed: boolean` доступен только MCP-admin; `include_details: boolean` добавляет комментарий; `limit: integer 1..1000 = 50`; `cursor: string` для следующей страницы.

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

### `count_event_subscriptions_by_event`

**Назначение:** компактно посчитать подписки на события по имени события, чтобы перед аудитом не выгружать полный список подписок.

**Параметры:** `include_top_handlers: boolean = false` добавляет топ модулей-обработчиков по каждому событию; `top_handlers_limit: integer 1..20 = 5`.

**Пример:**

```json
{
  "include_top_handlers": true,
  "top_handlers_limit": 5
}
```

**Выходящая схема:** `events[] { event, count, top_handlers?[] { module, count } }`, `event_count`, `subscription_count`, `include_top_handlers`, `top_handlers_limit?`, `guidance`.

**Ограничения:** это metadata discovery, а не чтение BSL-кода обработчика. Подписки с источниками, запрещенными allowlist/правами MCP, не возвращаются.

### `list_event_subscriptions`

**Назначение:** получить список подписок на события с точечными фильтрами по событию и обработчику.

**Параметры:** `event: string` exact match по имени события; `handler_contains: string` поиск подстроки в имени обработчика без учета регистра; `limit: integer 1..1000 = 50`; `cursor`.

**Пример:**

```json
{
  "event": "ПередЗаписью",
  "handler_contains": "ДатыЗапретаИзменения",
  "limit": 20
}
```

**Выходящая схема:** `subscriptions[] { name, synonym, comment, event, handler, handler_module, handler_routine, source, source_name, source_full_name }`, `subscription_count`, `total_estimated`, `truncated`, `next_cursor`, `filters`, `guidance`.

**Ограничения:** на больших конфигурациях сначала вызывайте `count_event_subscriptions_by_event`, затем сужайте список через `event` и `handler_contains`.

### `run_1c_query`

**Назначение:** выполнить безопасный read-only запрос на языке запросов 1С. Временные таблицы в пакетах разрешены как рабочая область, изменение постоянных данных запрещено.

**Параметры:** обязательный `query: string`; `parameters: object` с типизированными значениями `kind=string|number|boolean|date|datetime|uuid|ref|enum|array|null`; `limit: integer 1..1000 = 100`; `cursor`; `timeout_seconds: integer 1..60 = 15`; `validate_before_run` (legacy-флаг, серверная проверка всё равно выполняется); `return_format: rows|table`; `include_column_types`.

**Пример:**

```json
{
  "query": "ВЫБРАТЬ ПЕРВЫЕ 10 Н.Ссылка, Н.Наименование ИЗ Справочник.Номенклатура КАК Н ГДЕ Н.Наименование ПОДОБНО &Шаблон",
  "parameters": { "Шаблон": { "kind": "string", "value": "%кабель%" } },
  "limit": 10
}
```

**Выходящая схема:** `validation { ok, valid, errors[], warnings[] }`, `columns[] { name, type_description }`, `rows[]`, `row_count`, `truncated`, `next_cursor`, `duration_ms`, `warnings[]`, опционально `query_guidance` при `include_guidance=true` или диагностическом событии. При ошибках запроса дополнительно возвращаются `error_code`, `hint`, `field`, `field_path`, `object`, `available_fields`, `suggestions` и диагностический guidance.

Если бухгалтерский запрос к виртуальным таблицам `Остатки`/`Обороты` использует позиционные поля `Субконто1/2/3` и возвращает `0` строк, `warnings[]` дополнительно подскажет проверить позицию аналитики через `get_accounting_accounts_map` с узким `account_code_prefix`.

**Pre-flight отказ до вызова движка.** Часть ошибок отсекается ещё до `Запрос.Выполнить()`, поэтому вызов не тратит время на выполнение: несуществующая табличная часть в источнике `Документ.<Имя>.<ИмяТЧ>`, несуществующее поле, адресованное псевдонимом, и обращение к таблице константы не через `Значение`. Ответ: `error.code = validation_failed_before_run`, `stage = validation`, вложенный `error_code` = `tabular_part_not_found` либо `field_not_found`, плюс `available_fields` / `available_tabular_parts` и `did_you_mean` (до трёх ближайших валидных имён). Отключить проверку флагом `validate_before_run=false` нельзя.

Проверяется только первый сегмент пути: `Т.Ссылка.Дата` валидно, если у таблицы есть поле `Ссылка`. Имена сравниваются без учёта регистра. Всё, что валидатор не разобрал однозначно — временные таблицы, подзапросы, служебные таблицы платформы, — пропускается в движок без ошибки: ложный отказ валидного запроса хуже пропущенной проверки.

Если псевдоним источника совпадает с именем табличной части другой таблицы того же запроса, в `validation_warnings[]` приходит предупреждение с рекомендацией переименовать псевдоним — 1С может счесть такие обращения неоднозначными. Запрос при этом не блокируется, а предупреждение возвращается и при успехе, и при ошибке выполнения.

Падение уже отправленного в движок запроса возвращает `stage = query_execute` и код `query_execute_error` (либо уточняющие `field_not_found` / `access_denied`), но никогда не код со словом `validation`.

**Ограничения:** может выполняться долго на больших БД, особенно при широких `JOIN`, виртуальных таблицах без параметров и отсутствии индексов. Не используйте `ВЫБРАТЬ *`; сначала получите структуру метаданных и ограничивайте поля, период и `limit`.

### `validate_1c_query`

**Назначение:** проверить запрос до выполнения: read-only синтаксис, известные таблицы, параметры, доступ к объектам, рискованные конструкции.

**Параметры:** обязательный `query: string`; `parameters: object`; `strict: boolean`; `explain: boolean`; `include_guidance: boolean = false`.

**Пример:**

```json
{
  "query": "ВЫБРАТЬ Н.Ссылка ИЗ Справочник.Номенклатура КАК Н",
  "strict": true,
  "include_guidance": true
}
```

**Выходящая схема:** `valid: boolean`, `errors[] { code, message, location?, hint?, see_also? }`, `warnings[]`, `detected_objects[]`, `detected_parameters[]`, `estimated_risk`, опционально `query_guidance`/`domain_guidance` при `include_guidance=true` или legacy `explain=true`.

В `warnings[]` попадает и предупреждение о совпадении псевдонима с именем табличной части другой таблицы запроса — тот же детект, что и в `run_1c_query`.

**Ограничения:** валидация не заменяет фактическое выполнение: часть ошибок платформы 1С обнаружится только при `run_1c_query`. Проверка существования полей и табличных частей выполняется в `run_1c_query` до вызова движка, а не здесь: `validate_1c_query` возвращает статические ошибки и предупреждения.

### `get_1c_query_guidance`

**Назначение:** вернуть встроенные правила и подсказки по языку запросов 1С: временные таблицы, виртуальные таблицы, `ИМЕЮЩИЕ`, составные типы, субконто, параметры и производительность.

**Параметры:** `topic: string` или `auto`; `query: string` для контекстных подсказок; `intent: string`; `include_examples: boolean`; `max_sections: integer 1..12 = 3`.

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

### `list_1c_language_doc_topics`

**Назначение:** вернуть компактную карту встроенной документации по языку запросов 1С для выбранной версии. Сейчас предзагружена `8.3.27`.

**Параметры:** `version: string = "8.3.27"`; `domain: string = "query-language"`.

**Пример:**

```json
{
  "version": "8.3.27"
}
```

**Выходящая схема:** `version`, `domain`, `supported_versions[]`, `topics[] { version, domain, id, title, section_count, source_file, resource_uri }`.

**Ограничения:** tool не возвращает полный текст документации; для текста используйте `search_1c_language_docs` и `read_1c_language_doc_section`.

### `search_1c_language_docs`

**Назначение:** найти релевантные секции в сгенерированном read-only индексе документации языка запросов 1С.

**Параметры:** обязательный `query: string`; `version: string = "8.3.27"`; `domain: string = "query-language"`; `top_k: integer 1..10 = 5`; `max_chars_per_result: integer 500..4000 = 1800`.

**Пример:**

```json
{
  "query": "СрезПоследних ГДЕ Условие",
  "top_k": 5,
  "max_chars_per_result": 1200
}
```

**Выходящая схема:** `version`, `domain`, `supported_versions[]`, `query`, `results[] { version, domain, section_id, title, source_file, resource_uri, score, excerpt }`, `truncated`, опционально `notes`.

**Ограничения:** search возвращает только короткие выдержки. Полный markdown/corpus не находится в `tools/list` и не отдается через description, чтобы не тратить токены заранее.

### `read_1c_language_doc_section`

**Назначение:** прочитать одну секцию документации по `section_id` или `resource_uri`, полученному из поиска.

**Параметры:** ровно один из `section_id` или `resource_uri`; `version: string = "8.3.27"` и `domain: string = "query-language"` используются при чтении по `section_id`; при `resource_uri` версия берется из URI; `max_chars: integer 1000..20000 = 8000`; `cursor: string` для продолжения, если `truncated=true`.

**Пример:**

```json
{
  "section_id": "references/info-register.md#kritichnoe-otlichie-gde-vs-parametr-uslovie",
  "max_chars": 8000
}
```

**Выходящая схема:** `version`, `domain`, `supported_versions[]`, `section_id`, `title`, `source_file`, `resource_uri`, `heading_path`, `content`, `truncated`, `next_cursor`.

**Ограничения:** это документация платформы/методики; фактические поля конкретной базы всё равно проверяются через metadata/data tools.

### `get_1c_language_doc_provenance`

**Назначение:** вернуть версию, источники и правила разрешения конфликтов для встроенной документации.

**Параметры:** `version: string = "8.3.27"`; `domain: string = "query-language"`.

**Пример:**

```json
{
  "version": "8.3.27"
}
```

**Выходящая схема:** `version`, `domain`, `supported_versions[]`, `source_file`, `content`, `rules { default_version, supported_versions, official_docs_priority, live_metadata_priority }`.

**Ограничения:** если пользователь спрашивает про версию платформы, которой нет в `supported_versions`, агент должен явно сообщить, что такой корпус не встроен в текущую поставку.

### `get_accounting_accounts_map`

**Назначение:** прочитать `ПланСчетов.<Имя>.ВидыСубконто` и вернуть соответствие счетов позициям `Субконто1/2/3`.

**Параметры:** `chart: string` полное имя плана счетов или краткое имя; `account_code_prefix: string`; `include_empty_subconto: boolean`; `limit: integer 1..1000 = 500`; `cursor`; `include_query: boolean`; `include_guidance: boolean = false`.

**Пример:**

```json
{
  "chart": "ПланСчетов.Хозрасчетный",
  "account_code_prefix": "41",
  "include_empty_subconto": true,
  "limit": 100
}
```

**Выходящая схема:** `chart`, `filter`, `tabular_section`, `source_of_truth`, `accounts[] { code, name, ref?, subconto[] }`, `total_accounts`, `next_cursor`, `truncated`, `warnings[]`, опционально `guidance`, `domain_guidance`, `query_used`.

**Ограничения:** если доступно несколько планов счетов и `chart` не указан, tool вернёт `needs_chart=true`. На больших планах используйте `account_code_prefix` и пагинацию.

### `get_accounting_balances_by_subconto_age`

**Назначение:** универсальный быстрый путь для aging бухгалтерских остатков на дату по выбранному субконто. Вызывающая сторона задаёт регистр, префиксы счетов, сторону остатка и порядок видов субконто; сервер не интерпретирует счета как дебиторку, кредиторку или авансы.

**Параметры:** обязательные `account_code_prefixes: string[]`, `balance_side: debit|credit`, `subconto_kinds: string[]|QueryParameterValue[]`; опциональные `accounting_register`, `as_of`, `group_subconto_index: 1..3 = 1`, `age_subconto_index: 1..3 = 3`, `extra_subconto_indexes: integer[]`, `age_buckets: number[] = [90,180,365]`, `min_age_days`, `min_amount`, `order_by: amount_desc|age_desc|account`, `include_query`, `include_guidance`, `limit`, `cursor`.

**Пример:**

```json
{
  "accounting_register": "РегистрБухгалтерии.Хозрасчетный",
  "as_of": "2026-06-29T23:59:59",
  "account_code_prefixes": ["62.01", "62.21", "62.31"],
  "balance_side": "debit",
  "subconto_kinds": [
    "Контрагенты",
    "Договоры",
    "Документы расчетов с контрагентом"
  ],
  "group_subconto_index": 1,
  "age_subconto_index": 3,
  "age_buckets": [90, 180, 365],
  "min_amount": 10000,
  "limit": 50
}
```

**Выходящая схема:** `accounting_register`, `as_of`, `balance_side`, `account_code_prefixes`, `group_subconto_index`, `age_subconto_index`, `bucket_rows[]`, `rows[]`, `row_count`, `truncated`, `next_cursor`, `duration_ms`, `warnings[]`, `configuration_agnostic`, опционально `guidance`, `query_used { detail, buckets }`.

**Ограничения:** перед вызовом получите реальные виды субконто через `get_accounting_accounts_map`; порядок `subconto_kinds` задаёт порядок `Субконто1/2/3` в виртуальной таблице `Остатки`. Строковые значения резолвятся по `Наименование` в `ПланВидовХарактеристик.ВидыСубконтоХозрасчетные`; UUID можно передать явно через `kind=ref`. Возраст считается по дате выбранного субконто, поэтому `age_subconto_index` должен указывать на аналитику, у значения которой есть реквизит `Дата`.

### `compare_accounting_balances_by_subconto`

**Назначение:** универсально сравнить два набора бухгалтерских остатков на дату и найти пересечения по UUID выбранного субконто. Подходит для сценариев вида "по одному контрагенту есть остатки в двух разных наборах счетов", но бизнес-смысл наборов задаёт вызывающая сторона.

**Параметры:** обязательные `subconto_kinds: string[]|QueryParameterValue[]`, `left_account_code_prefixes: string[]`, `left_balance_side: debit|credit`, `right_account_code_prefixes: string[]`, `right_balance_side: debit|credit`; опциональные `accounting_register`, `as_of`, `match_subconto_index: 1..3 = 1`, `min_amount`, `include_query`, `include_guidance`, `limit`, `cursor`.

**Пример:**

```json
{
  "accounting_register": "РегистрБухгалтерии.Хозрасчетный",
  "as_of": "2026-06-29T23:59:59",
  "subconto_kinds": [
    "Контрагенты"
  ],
  "match_subconto_index": 1,
  "left_account_code_prefixes": ["62"],
  "left_balance_side": "debit",
  "right_account_code_prefixes": ["60"],
  "right_balance_side": "credit",
  "min_amount": 10000,
  "limit": 100
}
```

**Выходящая схема:** `accounting_register`, `as_of`, `match_subconto_index`, `left_balance_side`, `right_balance_side`, `left_account_code_prefixes`, `right_account_code_prefixes`, `rows[]`, `row_count`, `truncated`, `next_cursor`, `duration_ms`, `warnings[]`, `configuration_agnostic`, опционально `guidance`, `query_used`.

**Ограничения:** tool соединяет наборы по `УникальныйИдентификатор(СубконтоN)` и не содержит предметных правил конкретной конфигурации. Если нужная аналитика не первая, задайте `match_subconto_index` и передайте `subconto_kinds` в соответствующем порядке. Строковые значения резолвятся по `Наименование`; UUID можно передать явно через `kind=ref`.

### `get_accounting_entries`

**Назначение:** быстрый универсальный путь для чтения проводок из основной таблицы `РегистрБухгалтерии.*` и, при необходимости, join к `РегистрБухгалтерии.*.Субконто`.

**Параметры:** `accounting_register`; `period_from`; `period_to`; `debit_account_code_prefixes`; `credit_account_code_prefixes`; `subconto_side: debit|credit`; `subconto_kind { kind:"ref", type, uuid }`; `subconto_value { kind:"ref", type, uuid }`; `group_by: string[]`; `include_zero`; `include_query`; `include_guidance: boolean = false`; `limit`; `cursor`.

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

**Выходящая схема:** стандартная табличная схема `columns[]`, `rows[]`, `row_count`, плюс `accounting_register`, `mode`, `group_by`, `subconto_side`, `configuration_agnostic`, опционально `guidance`, `query_used`.

**Ограничения:** tool не содержит бизнес-логики ОС/ТМЦ/НДС. Для фильтра или группировки по виду субконто сначала получите реальный `subconto_kind` из `get_accounting_accounts_map` или metadata/query результата. Группировка по `debit_subconto`/`credit_subconto` без `subconto_kind` или `group_by=subconto_kind` отклоняется как неоднозначная: в одном поле могут смешаться контрагенты, договоры и документы расчетов. Для долга, задолженности и сальдо на дату используйте `Остатки`/`ОстаткиИОбороты`, а не проводки.

### `get_inventory_balances_by_item`

**Назначение:** быстрый путь для вопроса об остатках товара: найти номенклатуру, определить виды субконто и выполнить агрегированный запрос к бухгалтерскому регистру.

**Параметры:** `item_query: string` или `item_ref { type, uuid }`; `item_type`; `as_of: string` ISO-дата; `accounting_register`; `chart`; `account_code_prefixes: string[]`; `item_subconto_name`; `warehouse_subconto_name`; `include_zero`; `include_query`; `include_guidance: boolean = false`; `limit: integer 1..1000 = 100`.

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

**Ограничения:** режимы зависят от вида регистра. Для `slice_*` и `balance` нужен `period`; для оборотов нужны `period_from` и `period_to`. Для долга, задолженности, сальдо или остатка на дату используйте `balance`/`Остатки`, а не `turnovers`/`Обороты`: обороты показывают только движение за период и не включают входящее сальдо. Для "на конец 2024" дата остатка обычно `2025-01-01T00:00:00`. Для зарплаты за период сначала предпочитайте зарплатные отчёты/расчётные регистры; бухгалтерский fallback по счёту 70 для начислений строится по кредитовому обороту 70, а не по дебету 70. Виртуальные таблицы на больших регистрах могут выполняться долго, особенно без фильтров по измерениям.

### `get_document_movements`

**Назначение:** получить движения документа-регистратора по регистрам.

**Параметры:** обязательные `document_type`, `uuid`; `registers: string[]`; `include_empty_registers`; `include_totals_effect`; `row_limit_per_register: integer 1..1000 = 50`; `cursor`; `row_cursor`.

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

**Параметры:** `query`; `include_variants`; `include_not_allowed` только MCP-admin; `limit: integer 1..500 = 20`; `cursor`.

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

**Параметры:** обязательный `target { type, uuid }`; `mode: auto|versions|event_log|status_changes`; `period_from`; `period_to`; `include_diff`; `limit: integer 1..500 = 20`; `cursor`.

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

**Выходящая схема:** `user { name, full_name, roles? }`, `auth_context { user_name, infobase_name, configuration_version, identity_key, generated_at, cache_policy }`, `authorization_policy`, `infobase { name, synonym, configuration_name, configuration_version, platform_version, host }`, `mcp_server { name, version, read_only, tools[] }`, `limits`, `privacy`, `allowed_metadata_summary { objects_count, kinds }`.

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
├── scripts/
│   ├── generate_1c_language_docs_bsl.mjs -- генератор BSL-индекса документации
│   └── mcp_contract_test.mjs             -- контрактные проверки MCP
├── skills/
│   └── 1c-query-language/                -- markdown source-of-truth для справочника
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
        ├── MCP_Knowledge_1CQueryDocs.bsl    -- сгенерированный read-only индекс документации по версиям
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

Сервер отдаёт знания через MCP, чтобы агент мог составлять запросы 1С без привязки к конкретной конфигурации:

- tool `get_1c_query_guidance` возвращает короткие контекстные подсказки по теме или черновику запроса;
- tools `list_1c_language_doc_topics`, `search_1c_language_docs`, `read_1c_language_doc_section` и `get_1c_language_doc_provenance` работают со сгенерированным read-only индексом `MCP_Knowledge_1CQueryDocs.bsl`; сейчас в поставке предзагружена документация 1С `8.3.27`, а ответы возвращают `supported_versions`;
- tool `get_accounting_accounts_map` читает live-таблицу `ПланСчетов.<Имя>.ВидыСубконто` и возвращает `accounts[].subconto[]`, чтобы агент не угадывал позиции `Субконто1/2/3`;
- tool `get_calculation_types_map` читает `ПланВидовРасчета.<Имя>` и возвращает реальные виды расчёта для ЗУП-подобных конфигураций;
- для зарплатных запросов база знаний закрепляет порядок выбора источника: готовый зарплатный отчёт или расчётные регистры, затем бухгалтерский fallback по кредитовому обороту 70 через `Обороты`;
- tool `get_database_passport` возвращает фактический срез данных: активные организации, горизонт записей, закрытые периоды при наличии регистра дат запрета и заполненность регистров накопления/сведений/расчёта; параметр `force_refresh` принудительно пересчитывает паспорт, а поля `cache_hit`/`cache_age_seconds` показывают состояние кэша или его отсутствие в универсальной read-only поставке;
- `validate_1c_query` и `run_1c_query` возвращают `query_guidance` opt-in через `include_guidance=true`; при ошибках выполнения диагностический guidance возвращается принудительно;
- `run_1c_query` без дополнительного discovery добавляет компактный warning, если нулевой результат похож на неверно угаданную позицию бухгалтерского `Субконто1/2/3`;
- resources `1c://knowledge/query/*` дают полную встроенную справку: syntax, functions, optimization, temporary-tables, compound-types, subconto, parameters, reports-vs-query, report-fast-path, payroll.
- resources `1c-docs://<version>/query-language/*` дают доступ к сгенерированной документации по языку запросов 1С для версий из `supported_versions`; сейчас доступен префикс `1c-docs://8.3.27/query-language/*`.

Главное правило этой базы знаний: сначала получить метаданные через `list_metadata_objects` / `get_metadata_structure`, затем писать запрос по фактическим именам объектов и полей текущей базы.

### Генерация документации языка 1С

Markdown-источники справочника лежат в `skills/1c-query-language`. Production endpoint 1С не читает эти markdown-файлы с диска: перед поставкой они превращаются в обычный BSL-модуль `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`.

Генератор:

```powershell
node scripts\generate_1c_language_docs_bsl.mjs
```

Что делает генератор:

1. Читает список наборов документации `DOC_SETS` в `scripts/generate_1c_language_docs_bsl.mjs`. Каждый набор задает `version`, корневую папку и allowlist markdown-файлов.
2. Разбивает markdown на секции по заголовкам.
3. Формирует `version`, `domain`, `section_id`, `resource_uri`, `heading_path`, `tags` и `content`.
4. Генерирует `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`.
5. Не добавляет top-level `Перем`; массив секций строится внутри функций.

### Одновременная поддержка нескольких версий 1С

Каждая поддерживаемая версия платформы должна иметь отдельный markdown-корпус. Все корпуса собираются в один `MCP_Knowledge_1CQueryDocs.bsl`, но при list/search/read сервер всегда фильтрует данные по выбранной версии.

#### Шаг 1. Создайте каталог версии

Используйте единую структуру для всех версий:

```text
skills/1c-query-language/
  versions/
    8.3.27/
      SKILL.md
      references/
        version-provenance.md
        query-syntax.md
        functions-and-expressions.md
        ...
    8.3.28/
      SKILL.md
      references/
        version-provenance.md
        query-syntax.md
        functions-and-expressions.md
        ...
```

Скопируйте корпус ближайшей версии в новый каталог и затем внесите подтверждённые изменения синтаксиса, поведения платформы и примеров. Не добавляйте версию в генератор, пока её материалы не проверены.

Для каждой версии обязательно обновите `references/version-provenance.md`. Укажите:

- точную версию платформы;
- дату проверки;
- использованные источники;
- известные ограничения;
- отличия от соседних версий;
- правила разрешения конфликтов между документацией и live-метаданными.

#### Шаг 2. Зарегистрируйте версию в генераторе

Добавьте корпус в `DOC_SETS` файла `scripts/generate_1c_language_docs_bsl.mjs`:

```js
const DOC_SETS = [
  {
    version: "8.3.27",
    root: resolve(REPO_ROOT, "skills/1c-query-language/versions/8.3.27"),
    sourceFiles: SOURCE_FILES,
  },
  {
    version: "8.3.28",
    root: resolve(REPO_ROOT, "skills/1c-query-language/versions/8.3.28"),
    sourceFiles: SOURCE_FILES,
  },
];
```

Первый элемент `DOC_SETS` задаёт версию по умолчанию для клиентов, которые не передают `version`. Новую версию добавляйте в конец списка. Меняйте порядок только отдельным изменением после проверки клиентов.

Значения `version` должны быть уникальными. Все пути из `sourceFiles` должны существовать относительно `root`.

#### Шаг 3. Сгенерируйте BSL-индекс

```powershell
node scripts\generate_1c_language_docs_bsl.mjs
```

Генератор должен обновить `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`. Не редактируйте этот BSL-файл вручную.

#### Шаг 4. Добавьте контрактные проверки

В `scripts/mcp_contract_test.mjs` прогоните одинаковые проверки для каждой версии из `supported_versions`:

| Проверка | Ожидаемый результат |
|---|---|
| `list_1c_language_doc_topics(version=V)` | возвращает только темы версии `V`; все `topics[].version == V` |
| `search_1c_language_docs(query=..., version=V)` | все результаты относятся к `V`, URI начинаются с `1c-docs://V/` |
| `read_1c_language_doc_section(version=V, section_id=...)` | читает секцию именно из корпуса `V` |
| `read_1c_language_doc_section(resource_uri="1c-docs://V/...")` | берёт версию из URI и не подменяет её default-версией |
| `get_1c_language_doc_provenance(version=V)` | возвращает provenance и источники именно версии `V` |
| вызов с неизвестной версией | возвращает контролируемую ошибку, не данные другой версии |
| вызов без `version` | использует ожидаемый `DEFAULT_VERSION` |

Дополнительно проверьте, что одинаковый `section_id` в двух версиях возвращает разный контент через соответствующие `resource_uri`.

#### Шаг 5. Выполните проверки до деплоя

```powershell
node scripts\generate_1c_language_docs_bsl.mjs
node --check scripts\generate_1c_language_docs_bsl.mjs
node --check scripts\mcp_contract_test.mjs
rg -n "^\s*Перем\b" src\CommonModules -S
git diff --check
git diff -- skills\1c-query-language scripts\generate_1c_language_docs_bsl.mjs scripts\mcp_contract_test.mjs src\CommonModules\MCP_Knowledge_1CQueryDocs.bsl
```

Команда `rg` не должна найти объявления `Перем` на верхнем уровне общих модулей.

#### Шаг 6. Закоммитьте полный комплект

В один commit должны входить:

- каталог `skills/1c-query-language/versions/<version>`;
- изменение `DOC_SETS`;
- проверки в `scripts/mcp_contract_test.mjs`;
- сгенерированный `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`.

CI должен повторно запускать генератор и завершаться ошибкой, если после генерации появился diff.

#### Шаг 7. Задеплойте расширение и проверьте endpoint

```powershell
node scripts\mcp_contract_test.mjs --all-response-modes --out reports\mcp_contract_report.1c-korp.latest.json
```

До деплоя endpoint продолжает использовать предыдущую версию расширения и не может подтвердить новый корпус.

#### Публичный контракт версий

- `supported_versions` перечисляет все версии документации в поставке;
- аргумент `version` выбирает корпус;
- без `version` используется первый элемент `DOC_SETS`;
- неизвестная версия возвращает `invalid_arguments` без fallback;
- URI всегда содержит версию: `1c-docs://<version>/query-language/...`;
- удаление версии из `DOC_SETS` делает её URI недоступными и является breaking change.

Версия документации платформы и версия конфигурации базы — разные параметры. Синтаксис выбирается через `version`, а реальные объекты и поля БП/ERP/УТ проверяются через live metadata tools.

Генератор также запускается после любого изменения уже поддерживаемого корпуса, перед commit и перед сборкой расширения.

Короткий workflow для правки существующей версии:

```powershell
# 1. Изменить markdown-источник
notepad skills\1c-query-language\versions\8.3.28\references\query-syntax.md

# 2. Перегенерировать BSL-индекс
node scripts\generate_1c_language_docs_bsl.mjs

# 3. Проверить, что CommonModules не получили top-level Перем
rg -n "^\s*Перем\b" src\CommonModules -S

# 4. Проверить синтаксис JS-скриптов
node --check scripts\generate_1c_language_docs_bsl.mjs
node --check scripts\mcp_contract_test.mjs

# 5. Проверить diff и закоммитить вместе markdown + generated BSL
git diff -- skills\1c-query-language src\CommonModules\MCP_Knowledge_1CQueryDocs.bsl scripts\generate_1c_language_docs_bsl.mjs
```

Требования к системе, где вызывается генератор:

- Node.js с поддержкой ESM `.mjs`;
- доступ на чтение к репозиторию и запись в `src/CommonModules`;
- корректная UTF-8 обработка русского текста;
- Windows/PowerShell совместимость;
- интернет, 1С runtime и живой MCP endpoint не нужны.

В репозитории уже хранится сгенерированный `MCP_Knowledge_1CQueryDocs.bsl`, поэтому для первого использования после деплоя расширения ничего дополнительно генерировать не нужно.

### Установка skill для LLM-клиентов

`skills/1c-query-language` не является обязательной частью production-доступа к документации. После деплоя расширения основным источником справки становятся MCP tools:

- `list_1c_language_doc_topics`
- `search_1c_language_docs`
- `read_1c_language_doc_section`
- `get_1c_language_doc_provenance`

Skill нужен как routing-инструкция для агента: когда пользователь спрашивает про язык запросов 1С, виртуальные таблицы, `СрезПоследних`, `ОборотыДтКт`, `ИМЕЮЩИЕ`, `ПОМЕСТИТЬ` и похожие темы, агент должен сначала вызвать documentation tools, а не читать весь markdown или отвечать из памяти.

#### ChatGPT

В ChatGPT не требуется устанавливать локальный `skills/1c-query-language` как файловый skill. Подключайте опубликованный 1С MCP как remote MCP / custom connector, а routing-инструкцию добавьте в инструкции GPT/проекта/коннектора:

```text
Для вопросов по языку запросов 1С используй MCP tools:
list_1c_language_doc_topics, search_1c_language_docs,
read_1c_language_doc_section, get_1c_language_doc_provenance.
Не угадывай поля конкретной базы: сначала используй metadata/data tools.
Документация по умолчанию: 1С 8.3.27.
```

Если ChatGPT-клиент не поддерживает MCP в вашем окружении, используйте этот репозиторий как источник текста для project/custom instructions, но фактический retrieval по документации будет хуже, чем через MCP tools.

#### Codex

Для Codex в этом репозитории можно оставить папку:

```text
skills/1c-query-language/
```

Если среда Codex поддерживает repo-local skills, она сможет использовать `SKILL.md` как маршрутизатор. При этом основной путь всё равно такой:

1. Подключить 1С MCP endpoint.
2. Дать Codex доступ к MCP tools.
3. Оставить `skills/1c-query-language` в репозитории как подсказку поведения и fallback.
4. При изменении markdown-источников запустить `node scripts\generate_1c_language_docs_bsl.mjs`.

Если repo-local skills не поддерживаются, достаточно MCP tools плюс короткая инструкция из блока ChatGPT.

#### Claude Code

Для Claude Code skill можно использовать как project-level skill или упаковать в plugin, если ваша установка Claude Code это поддерживает. Минимальный вариант для проекта:

```text
skills/1c-query-language/
  SKILL.md
  references/*.md
```

Рекомендуемый порядок:

1. Подключить текущий 1С MCP endpoint.
2. Оставить `skills/1c-query-language` в репозитории.
3. В project instructions или plugin-инструкциях указать, что для документации языка 1С сначала используются `search_1c_language_docs` и `read_1c_language_doc_section`.
4. Использовать markdown `references/*.md` только если MCP tools недоступны.

#### Claude Desktop / Claude for Windows / Claude Web

Для Claude Desktop и Claude Web основной путь - remote MCP/custom connector к опубликованному 1С MCP endpoint. Локальная папка `skills/1c-query-language` сама по себе не развернет документацию внутри Claude Desktop.

Используйте один из вариантов:

- подключить remote MCP/custom connector и добавить routing-инструкцию в проект/чат;
- для Claude Code/плагина дополнительно включить `skills/1c-query-language`;
- если доступен только чат без MCP, вставить короткую routing-инструкцию вручную, но понимать, что tools документации вызываться не будут.

#### Короткая routing-инструкция

Эту инструкцию можно вставлять в ChatGPT custom GPT, Claude project instructions, Codex instructions или plugin manifest:

```text
Для вопросов по языку запросов 1С не отвечай из памяти. Сначала используй
search_1c_language_docs(version="8.3.27"). Если нужен полный фрагмент,
используй read_1c_language_doc_section. При сомнении в источнике используй
get_1c_language_doc_provenance. Имена объектов, полей, регистров и ресурсов
конкретной базы проверяй через 1С metadata/data tools.
```

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
      "user_prefix": "Польз-",
      "include_navigation_url": true
    },
    "type_aliases": [
      { "type": "Справочник.Контрагенты", "prefix": "Контр-" },
      { "type": "Справочник.Проекты", "prefix": "Проект-" }
    ],
    "type_field_masks": [
      { "type": "Справочник.Проекты", "fields": ["Наименование", "Код", "Руководитель"] },
      { "type": "Справочник.Контрагенты", "fields": ["НаименованиеПолное", "Телефон"] },
      { "type": "РегистрСведений.КонтактыКонтрагентов", "fields": ["Представление", "Значение"] }
    ]
  }
}
```

`web_client.base_url` задаёт корневой URL web-клиента 1С. Если он заполнен, `ObjectRef.navigation_url` возвращается как кликабельная HTTP(S)-ссылка вида `https://.../e1cib/data/<Тип>?ref=<uuid>`, а исходная ссылка платформы сохраняется в `e1cib_navigation_url`. Для стендов с включённым `restrict_data_access: true` этот URL также нужно добавить в `allowed_base_urls` allowlist.

Если `masked_fields` отсутствует или пустой, сервер отдаёт данные как раньше. Если список заполнен, совпадающие поля маскируются во всех tool-ответах: строки заменяются на `XXXXXXX`, даты — на `1900-01-01T00:00:00` (`01.01.1900`), числа и булево — на `null`, чтобы строка-маска не ломала типизацию числовой колонки. Сравнение имён регистронезависимое и не учитывает пробелы, дефисы и подчёркивания, поэтому правило остаётся общим и не привязано к конкретной конфигурации 1С.

`organization_aliases` по умолчанию выключен. Если включить `enabled: true`, сервер заменяет полные названия `Справочник.Организации` на стабильные коды вида `Орг-453276` во всех tool-ответах, ресурсах и диагностических JSON-данных. Ссылки сохраняют `type`, `uuid`, `ref` и доступный `navigation_url`; при настроенном `web_client.base_url` это конечная ссылка web-клиента, пригодная для открытия из чата. Если в произвольном результате есть только строковое поле, явно похожее на организацию, но нет UUID/ссылки, сервер возвращает `Орг-скрыто`.

`person_aliases` по умолчанию выключен. Если включить `enabled: true`, сервер заменяет `presentation` и поля ФИО у `Справочник.ФизическиеЛица`, `Справочник.Сотрудники*` и `Справочник.Пользователи` стабильными кодами вида `ФЛ-453276`, `Сотр-453276` или `Польз-453276`. При настроенном `web_client.base_url` `navigation_url` у таких ссылок тоже становится кликабельной web-ссылкой. Паспортные данные, индивидуальный номер, страховой номер и дата рождения маскируются как чувствительные поля. Если в произвольном результате есть только строковое поле, явно похожее на физлицо/сотрудника, но нет UUID/ссылки, сервер возвращает `ФЛ-скрыто`.

`type_aliases` и `type_field_masks` — адресные настройки: они действуют только у указанного полного имени типа, а не во всех объектах сразу. Обе секции по умолчанию пустые.

`type_aliases` — список `{ "type": "<Вид>.<Имя>", "prefix": "<Префикс>" }`. Для ссылок этого типа `presentation` и поля названия (`Наименование`, `НаименованиеПолное`, `Код`, `name`, `presentation` и подобные) заменяются стабильным 8-символьным кодом вида `Контр-85KYOVOH`; `type`, `uuid`, `ref` и `navigation_url` сохраняются, чтобы пользователь мог открыть объект в 1С. Код строится из uuid ссылки, поэтому работает для справочников, документов, планов счетов/видов характеристик/видов расчёта/обмена, бизнес-процессов и задач. Регистры и перечисления ссылки с uuid не имеют — такая запись игнорируется, а причина попадает в `privacy.config_warnings` ответа. Организации, физлица, сотрудники и пользователи в `type_aliases` тоже отклоняются с предупреждением: их анонимизируют `organization_aliases`/`person_aliases`, и второй псевдоним перезатирал бы уже выданные коды.

Обе секции поддерживают необязательный `mode`: `"mask"` (по умолчанию) маскирует значения в ответах, `"deny"` дополнительно жёстко запрещает обращения к закрытым полям в запросах — предвалидатор выдаёт отказ `privacy_denied_field` до выполнения, в любой позиции текста (выбор, отбор, сортировка, итоги, функции, переименование `КАК X`); работа со ссылками остаётся разрешённой. Принадлежность поля разрешается по источникам запроса, поэтому одноимённое поле незакрытого типа (`Номенклатура.Наименование` рядом с закрытыми Контрагентами) не блокируется; разыменование любой глубины (`Поставщик.Наименование`), обращения без псевдонима и `ПРЕДСТАВЛЕНИЕ()`/`ПРЕДСТАВЛЕНИЕССЫЛКИ()` над закрытой ссылкой закрыты. Неразборный запрос с упоминанием закрытого типа отклоняется консервативно. Те же правила действуют на параметры остальных инструментов: поиск по наименованию в закрытом типе (`search_objects`, `item_query`), отборы/сортировки/группировки регистров и бухгалтерских инструментов, включая разыменование (`Контрагент.Наименование`), и параметры отчёта, совпавшие с закрытым полем; работа по ссылке и uuid (`find_object_by_id`, `item_ref`) остаётся разрешённой. Отказы пишутся в аудит без закрываемых значений. Если у закрытого типа есть подчинённые справочники, не указанные в политике, сервер предупреждает об этом в `config_warnings`. Проблемная запись в режиме `deny` (неизвестный `mode`, тип или поле не найдены в метаданных, плохой префикс, нечитаемая секция) переводит политику в `config_error`: запросы отклоняются с кодом `privacy_config_error` до исправления настройки (fail-closed), причины возвращаются в `privacy.config_errors`. `privacy.publish_details: false` убирает из guidance перечень закрытых полей, оставляя только типы.

`type_field_masks` — список `{ "type": "<Вид>.<Имя>", "fields": ["Поле1", "Поле2"] }`. Перечисленные поля скрываются **только** у объектов этого типа: `Наименование` у `Справочник.Проекты` можно замаскировать, оставив `Наименование` у `Справочник.Контрагенты` открытым. Вид типа здесь любой, включая `РегистрСведений`, `РегистрНакопления` и `РегистрБухгалтерии` — строки регистра относятся к типу из поля `register` ответа. Если в списке есть имя-подобное поле (`Наименование`, `Код`, `name`, `presentation` и т.п.), то у ссылок этого типа скрывается и `presentation`, иначе название утекало бы через любую ссылку из другого объекта. Когда для того же типа настроен и `type_aliases`, вместо `XXXXXXX` подставляется псевдоним.

Тип объекта определяется по данным ответа: сама ссылка (`type` + `uuid`), полное имя регистра в `register` или `accounting_register`, вложенная ссылка в `ref`, `target` или `item`, а если ключей контракта нет — любая колонка, значение которой является ссылкой **настроенного в политике типа**. Последнее нужно для строк `run_1c_query`: там колонку со ссылкой называет автор запроса (`ВЫБРАТЬ К.Ссылка КАК Ссылка`), и без этого маски по типу к плоским колонкам строки не применялись бы. Ссылки незакрытых типов на этом шаге игнорируются намеренно: строка регистра содержит ссылки-измерения, и если бы контекст доставался им, строка теряла бы унаследованный тип регистра вместе с масками его полей. Поля и строки внутри объекта наследуют его тип, а вложенная ссылка другого типа наследование сбрасывает.

Плоские строки без ссылки закрываются отдельно. Запрос часто возвращает рядом с субконто ещё и колонку с названием (`Контрагент` со строкой вместо ссылки) — стабильный код построить не из чего, поэтому такое значение заменяется на `Контр-скрыто` (для `type_field_masks` без псевдонима — на `XXXXXXX`, и только если в `fields` есть имя-подобное поле). Колонка считается названием объекта, если её имя совпадает с именем объекта из настройки по достаточно длинному общему началу: `Контрагент` и `КонтрагентНаименование` относятся к `Контрагенты`, `Контр` — уже нет; имена объектов короче 5 символов в этом правиле не участвуют. Правило действует и на имя-подобный ключ, у которого имя типа стоит в сегменте пути (`Контрагент.Наименование`), — для обеих секций. Имя объекта берётся из самой privacy-настройки, поэтому правило работает на любой конфигурации.

**Чего маскирование не гарантирует.** Оно работает по именам полей, поэтому переименование колонки в запросе (`ВЫБРАТЬ Наименование КАК X`) обходит и `masked_fields`, и маски по типам, и псевдонимы: у плоской строки не остаётся ни имени, ни ссылки, по которым её можно опознать. Надёжно закрываются только ссылочные значения (`type` + `uuid`) — их тип виден в самих данных. Если поле или тип нужно закрыть гарантированно, это делается allowlist'ом: `hidden_fields` у типа или `denied_objects`, — там отказ выдаётся до выполнения запроса. Privacy-маскирование — второй эшелон для уже сформированных ответов. Свободный текст (`Комментарий`, `Примечание`) тоже может содержать название — такие поля перечисляются в `fields` явно. Одно юридическое лицо часто есть и в `Справочник.Организации`, и в `Справочник.Контрагенты`: чтобы название не утекло через второй справочник, настраивать нужно оба. Отчёты (`run_1c_report`) и произвольные плоские выборки без ссылок закрываются только правилом плоских колонок по имени.

Технические имена метаданных не маскируются: `type`, `full_name`, `kind`, `register`, `chart`, `plan`, `resource_uri` и похожие поля остаются валидными идентификаторами 1С. Privacy применяется к данным и представлениям ссылок, а не к схеме.

Когда privacy-режим включен, сервер явно сообщает об этом LLM: добавляет `privacy` в каждый tool-result, возвращает `privacy` в `get_current_user_context`, а также добавляет короткую подсказку в `tools/list`/описания tools. Агент должен считать перечисленные поля, названия организаций и ФИО/персональные реквизиты намеренно недоступными и не пытаться обходить политику альтернативными запросами.

Форма служебного блока: `{ "enabled": true, "masked_fields": [...], "string_mask": "XXXXXXX", "date_mask": "1900-01-01T00:00:00", "organization_aliases": {"enabled": true, "prefix": "Орг-", "resolution": "open_navigation_url_in_1c"}, "person_aliases": {"enabled": true, "physical_person_prefix": "ФЛ-", "employee_prefix": "Сотр-", "user_prefix": "Польз-", "resolution": "open_navigation_url_in_1c"}, "type_aliases": {"enabled": true, "entries": [{"type": "Справочник.Проекты", "prefix": "Проект-"}], "resolution": "open_navigation_url_in_1c"}, "type_field_masks": {"enabled": true, "entries": [{"type": "Справочник.Проекты", "fields": ["Наименование"]}]}, "config_warnings": [], "guidance": "..." }`.

### Per-user права и кэширование

При работе через промежуточный Python-сервер с per-session учетными данными каждый HTTP-запрос к 1С выполняется в контексте текущего пользователя 1С. Поэтому права проверяются на каждом вызове tool и в каждом ответе возвращается `auth_context.cache_policy.cacheable=false`. Если клиент перелогинился, прежние сведения о доступных объектах, отчетах и полях надо считать устаревшими.

Ошибки прав возвращаются как обычный MCP tool result с `isError=true`, `error.code=access_denied` и блоком `authorization`. В режиме `text_only` диагностика находится в JSON внутри `content[]`; в режиме `both` критичная диагностика дополнительно дублируется в `content[]` строкой `Диагностика JSON: ...`, потому что некоторые proxy-реализации MCP передают LLM только текстовый content и теряют `structuredContent`.

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
