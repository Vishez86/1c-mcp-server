# Спецификация MCP-сервера для 1С: 30 read-only tools

**Версия документа:** 0.1  
**Дата:** 2026-05-12  
**Назначение:** подробная техническая спецификация для разработки универсального read-only MCP-сервера поверх 1С.

---

## 1. Границы системы

MCP-сервер предоставляет LLM-клиенту безопасный доступ к данным и метаданным 1С. Базовый режим — **read-only**.

Запрещено в базовой версии:

- создавать, изменять или удалять объекты;
- записывать, проводить или отменять проведение документов;
- выполнять произвольный код 1С;
- запускать внешние обработки с побочными эффектами;
- обходить права пользователя 1С;
- возвращать чувствительные поля вне allowlist.

Сервер должен покрывать цепочку: discovery → inspect → search → retrieve → explain → navigate → report.

---

## 2. Опора на MCP

Рекомендуемая версия протокола: **MCP 2025-11-25**.

Официальные разделы:

- Tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Base protocol / JSON-RPC: https://modelcontextprotocol.io/specification/2025-11-25/basic
- Resources: https://modelcontextprotocol.io/specification/2025-11-25/server/resources

Практические требования:

- сервер объявляет capability `tools`;
- tools возвращаются через `tools/list`;
- tool вызывается через `tools/call`;
- каждый tool имеет `name`, `title`, `description`, `inputSchema`;
- формат результата выбирается настройкой `response.tool_result_mode`: `text_only`, `structured_only` или `both`;
- в режимах `structured_only` и `both` каждый tool указывает `outputSchema`;
- в режиме `text_only` tools не указывают `outputSchema`, а полный JSON результата возвращается только в `content[].text`;
- в режиме `both` результат tool возвращать в `content` и `structuredContent`; сериализованный JSON дублировать в `TextContent` для совместимости с клиентами/proxy, которые не передают structured-часть модели;
- прикладные ошибки возвращать как `isError: true`, а не как JSON-RPC error, если JSON-RPC запрос был корректен;
- JSON Schema по умолчанию считать 2020-12;
- входные данные валидировать до обращения к 1С.

---

## 3. Общий формат результата

Успех в режиме `text_only` по умолчанию:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"ok\":true,\"rows\":[...]}"
    }
  ],
  "isError": false
}
```

Успех в режиме `structured_only` или `both`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Краткое описание результата."
    }
  ],
  "structuredContent": {
    "ok": true,
    "auth_context": {
      "user_name": "ivanov",
      "infobase_name": "ERP",
      "configuration_version": "2.5.19.123",
      "identity_key": "ivanov@ERP#2.5.19.123",
      "generated_at": "2026-05-27T12:00:00",
      "cache_policy": {
        "cacheable": false,
        "revalidate_each_call": true
      }
    }
  },
  "isError": false
}
```

Ошибка исполнения tool в режиме `structured_only` или `both`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Ошибка: type_not_allowed. Доступ к типу запрещён."
    }
  ],
  "structuredContent": {
    "ok": false,
    "auth_context": {
      "user_name": "ivanov",
      "identity_key": "ivanov@ERP#2.5.19.123",
      "cache_policy": {
        "cacheable": false,
        "revalidate_each_call": true
      }
    },
    "authorization": {
      "reason_code": "mcp_type_not_allowed",
      "denied_operation": "tool_call",
      "denied_type": "Документ.ЗарплатаКВыплате",
      "retry_policy": "do_not_retry_same_request_without_reauth_or_permission_change"
    },
    "error": {
      "code": "type_not_allowed",
      "message": "Доступ к типу запрещён.",
      "details": {
        "type": "Документ.ЗарплатаКВыплате"
      },
      "correlation_id": "7f8e6d3a-2b34-4d85-9de9-ecb5e9aa1c11"
    }
  },
  "isError": true
}
```

JSON-RPC error использовать только для ошибок протокола: malformed JSON, неизвестный method, неизвестный tool name, ошибка авторизации транспорта, фатальная ошибка до запуска tool.

В режиме `text_only` та же структура ошибки возвращается сериализованным JSON в `content[].text` без `structuredContent`.

Для ошибок прав доступа используется MCP tool error, а не JSON-RPC error. `error.code=access_denied` означает отказ платформенных прав 1С или coarse MCP-доступа; `authorization.retry_policy` всегда запрещает повтор того же запроса без перелогина или изменения прав. В `text_only` диагностика находится в JSON внутри `content[]`; в `both` она дополнительно дублируется в текстовом блоке, чтобы LLM получила причину отказа даже через proxy, который не сохраняет `structuredContent`.

---

## 4. Общие типы

### 4.1. MetadataFullName

Полное имя объекта метаданных 1С:

```text
Справочник.Номенклатура
Справочник.Контрагенты
Документ.ЗаказКлиента
РегистрСведений.ЦеныНоменклатуры
РегистрНакопления.ТоварыНаСкладах
Перечисление.ВидыЦен
Отчет.Продажи
```

Поддерживаемые виды метаданных:

```text
Справочник, Документ, Перечисление, РегистрСведений, РегистрНакопления,
РегистрБухгалтерии, РегистрРасчета, ПланСчетов, ПланВидовХарактеристик,
ПланВидовРасчета, ПланОбмена, БизнесПроцесс, Задача, Отчет, Обработка
```

### 4.2. ObjectRef

```json
{
  "type": "Справочник.Номенклатура",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "presentation": "Товар 1",
  "navigation_url": "https://1c.example.com/base/e1cib/data/...",
  "navigation_url_kind": "web_client",
  "e1cib_navigation_url": "e1cib/data/..."
}
```

Если `web_client.base_url` не настроен, `navigation_url` остаётся обычной `e1cib/data/...` ссылкой и `navigation_url_kind` равен `e1cib`.

### 4.3. EnumRef

```json
{
  "type": "Перечисление.ВидыЦен",
  "name": "Оптовая",
  "presentation": "Оптовая"
}
```

### 4.4. QueryParameterValue

Все параметры запросов, фильтров и отчётов передаются типизированно:

```json
{
  "kind": "ref",
  "type": "Справочник.Номенклатура",
  "uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

Поддерживаемые `kind`:

```text
string, number, boolean, date, datetime, uuid, ref, enum, array, null
```

### 4.5. Кодирование значений 1С в JSON

| Тип 1С | JSON |
|---|---|
| Строка | string |
| Число | number или string для точной decimal-семантики |
| Булево | boolean |
| Дата | ISO 8601 string |
| Неопределено / Null | null |
| УникальныйИдентификатор | string |
| Ссылка | ObjectRef |
| ПеречислениеСсылка | EnumRef |
| Массив | array |
| Структура / Соответствие | object |
| ТаблицаЗначений | { columns, rows } |
| ДвоичныеДанные | omitted по умолчанию, base64 только по явной политике |
| ХранилищеЗначения | metadata object без содержимого по умолчанию |

---

## 5. Security layer

Сервер должен иметь общий слой безопасности для всех tools.

Общее правило для LLM-клиента: не выдумывать методы, сущности, таблицы и поля.
Все прикладные имена нужно получать через `list_metadata_objects`,
`get_metadata_structure`, `get_accounting_accounts_map`, `get_database_passport`
или из результата предыдущего tool-вызова.

Обязательно:

1. Аутентификация MCP-клиента.
2. Работа от имени реального пользователя 1С или строго ограниченного сервисного пользователя.
3. Allowlist типов метаданных.
4. Denylist чувствительных объектов и реквизитов.
5. Field-level ограничения.
6. Ограничения строк, времени и размера результата.
7. Аудит всех вызовов.
8. Correlation ID для каждой операции.
9. Маскирование персональных данных.
10. Невозможность обойти allowlist через `run_1c_query`.

При per-user proxy каждый HTTP-запрос к 1С считается отдельным сеансом текущей учетной записи. Сервер обязан проверять платформенные права 1С на каждом вызове и добавлять `auth_context.cache_policy.cacheable=false`; LLM не должна переносить результаты discovery или отказы доступа между разными логинами. Отказы платформы вида “Недостаточно прав”, “Отсутствуют права”, `Access denied` нормализуются в `access_denied`.

`authorization.reason_code`:

| Reason | Значение |
|---|---|
| `1c_access_denied` | отказ платформенных прав 1С / RLS / прикладной проверки |
| `mcp_type_not_allowed` | тип запрещён allowlist/denylist MCP |
| `mcp_field_not_allowed` | поле запрещено политикой MCP |
| `mcp_tool_not_allowed` | tool запрещён политикой MCP |

Маскирование персональных данных настраивается в `MCP_ServerConfig`:

```json
{
  "privacy": {
    "masked_fields": ["ФИО", "ДатаРождения", "НомерПаспорта"],
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
    }
  }
}
```

Если список пустой или отсутствует, ответы не меняются. Если список заполнен,
security layer рекурсивно заменяет значения совпадающих полей перед формированием
`content[].text` и, если режим результата его использует, `structuredContent`: обычные значения — на `XXXXXXX`, даты —
на фиксированное значение `1900-01-01T00:00:00`. Сравнение имён полей
регистронезависимое и не привязано к конкретной конфигурации 1С.

`privacy.organization_aliases` по умолчанию выключен. Если `enabled=true`, security
layer заменяет полные названия `Справочник.Организации` стабильными псевдонимами
вида `Орг-453276` во всех tool-ответах, resource JSON и диагностических данных.
Ссылки организаций продолжают содержать `type`, `uuid`, `ref` и доступный
`navigation_url`; пользователь расшифровывает код, открывая ссылку в 1С. Если
произвольный запрос или отчёт вернул только строку, явно похожую на организацию,
без UUID/ссылки, значение заменяется на `Орг-скрыто`.

`privacy.person_aliases` по умолчанию выключен. Если `enabled=true`, security
layer заменяет `presentation` и поля ФИО у `Справочник.ФизическиеЛица` и
`Справочник.Сотрудники*`, а также `presentation` у `Справочник.Пользователи`
стабильными псевдонимами вида `ФЛ-453276`, `Сотр-453276` или `Польз-453276`.
Паспортные данные, индивидуальный номер, страховой номер и дата рождения
маскируются как чувствительные поля. Ссылки продолжают содержать
`type`, `uuid`, `ref` и доступный `navigation_url`, чтобы пользователь мог
открыть объект в 1С.

При активном маскировании сервер обязан явно сообщать об этом LLM-клиенту:
добавлять `privacy` в каждый tool-result, возвращать `privacy` в
`get_current_user_context`, добавлять `server_hints` в `tools/list` и короткую
инструкцию в описания tools. Инструкция должна указывать, что исходные значения
перечисленных полей, названия организаций, ФИО и персональные реквизиты намеренно
недоступны и их не нужно пытаться получать альтернативными запросами.

Рекомендуемые лимиты по умолчанию:

| Параметр | Значение |
|---|---:|
| max_limit | 1000 |
| max_query_rows | 1000 |
| max_report_rows | 5000 |
| max_tabular_section_rows | 100 |
| max_register_rows | 1000 |
| query_timeout_seconds | 15 |
| report_timeout_seconds | 60 |
| max_result_json_bytes | 5 MB |
| max_searched_types_per_call | 100 |
| max_string_length_in_response | 10000 |

Пример dev allowlist для тестовых стендов без чувствительных данных:

```json
{
  "restrict_data_access": false,
  "default_policy": "allow",
  "denied_objects": [],
  "allowed_metadata": {
    "Справочник.Номенклатура": {
      "read": true,
      "search_fields": ["Код", "Наименование", "Артикул"],
      "default_fields": ["Код", "Наименование", "Артикул", "ЕдиницаИзмерения"],
      "hidden_fields": []
    },
    "Справочник.Контрагенты": {
      "read": true,
      "search_fields": ["Код", "Наименование", "ИНН", "КПП"],
      "default_fields": ["Код", "Наименование", "ИНН", "КПП"],
      "hidden_fields": []
    }
  }
}
```

Для тестовых стендов без чувствительных данных используйте `restrict_data_access=false`:
сервер не применяет denylist/field-level фильтрацию данных, но продолжает проверять
read-only синтаксис, безопасность имён, лимиты строк/времени и размер результата.

Для production-режима используйте отдельный пример `config/allowlist.prod.example.json`:
там включён `restrict_data_access=true`, `default_policy=deny`, denylist типовых
чувствительных объектов и пример `hidden_fields`. Текущий `config/allowlist.json`
оставлен permissive намеренно для тестирования работоспособности.

---

## 6. Итоговый список tools

| № | Tool | Назначение | Приоритет |
|---:|---|---|---|
| 1 | `list_metadata_objects` | Получить список объектов метаданных 1С | P0 |
| 2 | `get_metadata_structure` | Получить структуру объекта метаданных | P0 |
| 3 | `search_metadata_fields` | Найти поля метаданных без чтения полной структуры | P0 |
| 4 | `count_event_subscriptions_by_event` | Посчитать подписки на события по событиям | P0 |
| 5 | `list_event_subscriptions` | Получить подписки на события | P0 |
| 6 | `run_1c_query` | Выполнить безопасный read-only запрос 1С | P0 |
| 7 | `validate_1c_query` | Проверить запрос 1С до выполнения | P0 |
| 8 | `get_1c_query_guidance` | Получить универсальные подсказки по языку запросов 1С | P0 |
| 9 | `list_registers` | Получить компактный список регистров и поддерживаемых режимов | P0 |
| 10 | `get_accounting_accounts_map` | Получить карту счетов и субконто плана счетов | P0 |
| 11 | `get_accounting_balances` | Получить бухгалтерские остатки и обороты | P0 |
| 12 | `get_accounting_balances_by_subconto_age` | Получить aging бухгалтерских остатков по выбранному субконто | P0 |
| 13 | `compare_accounting_balances_by_subconto` | Сравнить два набора остатков по одной аналитике | P0 |
| 14 | `get_accounting_entries` | Получить бухгалтерские проводки с универсальным join к субконто | P0 |
| 15 | `get_inventory_balances_by_item` | Получить быстрые остатки товара по складам и организациям | P0 |
| 16 | `get_calculation_types_map` | Получить карту видов расчёта плана видов расчёта | P0 |
| 17 | `get_database_passport` | Получить паспорт фактических данных базы | P0 |
| 18 | `get_object_by_ref` | Получить объект по типу и UUID ссылки | P0 |
| 19 | `find_object_by_id` | Найти объект по UUID без знания типа | P0 |
| 20 | `search_objects` | Поиск объектов по строке, коду, номеру, ИНН, артикулу | P0 |
| 21 | `get_link_of_object` | Получить навигационную ссылку на объект | P1 |
| 22 | `find_references_to_object` | Найти ссылки на объект | P1 |
| 23 | `get_enum_values` | Получить значения перечисления | P0 |
| 24 | `get_register_records` | Получить записи, срезы, остатки и обороты регистров | P0 |
| 25 | `get_document_movements` | Получить движения документа по регистрам | P0 |
| 26 | `list_reports` | Получить список доступных отчётов | P1 |
| 27 | `get_report_info` | Получить параметры и структуру отчёта | P1 |
| 28 | `run_1c_report` | Выполнить отчёт 1С | P1 |
| 29 | `get_object_history` | Получить историю объекта, версии или события журнала | P2 |
| 30 | `get_current_user_context` | Получить текущий контекст пользователя и базы | P0 |

---

# 7. Подробная спецификация tools


---

## 7.1. `list_metadata_objects`

**Title:** Получить список объектов метаданных 1С  
**Priority:** P0

### Назначение

Discovery tool. Возвращает справочники, документы, регистры, перечисления, отчёты и другие объекты метаданных, которые доступны текущему пользователю и разрешены политикой MCP-сервера.

### Когда использовать

Когда агенту нужно понять состав конфигурации, подобрать тип объекта для поиска или построить дальнейший план чтения данных.

### Когда не использовать

Не использовать для получения структуры конкретного объекта — для этого есть get_metadata_structure.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "kinds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Фильтр по видам метаданных: Справочник, Документ, РегистрСведений, РегистрНакопления, Перечисление, Отчет и т.д."
    },
    "query": {
      "type": "string",
      "description": "Поиск по имени, синониму или комментарию."
    },
    "include_not_allowed": {
      "type": "boolean",
      "default": false,
      "description": "Вернуть запрещённые объекты с allowed=false. Только для MCP-admin."
    },
    "include_details": {
      "type": "boolean",
      "default": false,
      "description": "Синоним, комментарий, иерархичность, периодичность, поддержка ссылок."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 200
    },
    "cursor": {
      "type": "string",
      "description": "Курсор пагинации."
    }
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "objects": [
    {
      "kind": "Справочник",
      "name": "Контрагенты",
      "full_name": "Справочник.Контрагенты",
      "synonym": "Контрагенты",
      "allowed": true,
      "readable": true,
      "searchable": true,
      "supports_ref": true,
      "supports_query": true,
      "resource_uri": "1c://metadata/Справочник.Контрагенты"
    }
  ],
  "next_cursor": "string|null",
  "total_estimated": "integer|null"
}
```

### Пример `tools/call` arguments

```json
{
  "kinds": [
    "Справочник",
    "Документ"
  ],
  "query": "клиент",
  "include_details": true,
  "limit": 20
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "objects": [
    {
      "kind": "Справочник",
      "name": "Контрагенты",
      "full_name": "Справочник.Контрагенты",
      "synonym": "Контрагенты",
      "comment": "Партнёры и контрагенты",
      "allowed": true,
      "readable": true,
      "searchable": true,
      "supports_ref": true,
      "supports_query": true,
      "resource_uri": "1c://metadata/Справочник.Контрагенты"
    }
  ],
  "next_cursor": null,
  "total_estimated": 1
}
```

### Валидация

- limit не выше глобального max_limit.
- include_not_allowed=true только для администратора MCP.
- Учитывать allowlist/denylist и права 1С.
- Не раскрывать технические объекты, если они скрыты политикой.

### Заметки по реализации 1С

- Обходить Метаданные.Справочники, Метаданные.Документы, Метаданные.РегистрыСведений и т.д.
- supports_ref=true для справочников, документов, планов, бизнес-процессов и задач.
- Возвращать результат без обязательного серверного кеша; реализация кеширования опциональна и не является частью runtime-конфига.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.2. `get_metadata_structure`

**Title:** Получить структуру объекта метаданных  
**Priority:** P0

### Назначение

Возвращает реквизиты, стандартные реквизиты, табличные части, измерения/ресурсы регистров и query names объекта метаданных.

### Когда использовать

Перед построением запроса, чтением объекта, поиском по полям, чтением регистров или генерацией отчётных фильтров.

### Когда не использовать

Не использовать для полного списка объектов — для этого list_metadata_objects.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "description": "Полное имя: Справочник.Номенклатура, Документ.ЗаказКлиента, РегистрНакопления.ТоварыНаСкладах."
    },
    "include_standard_attributes": {
      "type": "boolean",
      "default": true
    },
    "include_tabular_sections": {
      "type": "boolean",
      "default": true
    },
    "include_forms": {
      "type": "boolean",
      "default": false
    },
    "include_commands": {
      "type": "boolean",
      "default": false
    },
    "include_query_names": {
      "type": "boolean",
      "default": true
    },
    "include_sensitive_flags": {
      "type": "boolean",
      "default": true
    },
    "include_virtual_tables": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "type"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "metadata": {
    "kind": "Справочник",
    "name": "Контрагенты",
    "full_name": "Справочник.Контрагенты",
    "synonym": "Контрагенты",
    "query_table": "Справочник.Контрагенты",
    "supports_ref": true,
    "hierarchical": true,
    "attributes": [
      {
        "name": "ИНН",
        "synonym": "ИНН",
        "type_description": "Строка(12)",
        "value_types": [
          "Строка"
        ],
        "allowed": true,
        "sensitive": false,
        "searchable": true,
        "query_name": "ИНН"
      }
    ],
    "standard_attributes": [
      {
        "name": "Код"
      },
      {
        "name": "Наименование"
      }
    ],
    "tabular_sections": [],
    "register_schema": null
  }
}
```

### Пример `tools/call` arguments

```json
{
  "type": "Справочник.Контрагенты",
  "include_tabular_sections": true,
  "include_query_names": true
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "metadata": {
    "kind": "Справочник",
    "name": "Контрагенты",
    "full_name": "Справочник.Контрагенты",
    "synonym": "Контрагенты",
    "query_table": "Справочник.Контрагенты",
    "supports_ref": true,
    "hierarchical": true,
    "attributes": [
      {
        "name": "ИНН",
        "type_description": "Строка(12)",
        "value_types": [
          "Строка"
        ],
        "allowed": true,
        "sensitive": false,
        "searchable": true,
        "query_name": "ИНН"
      }
    ],
    "standard_attributes": [
      {
        "name": "Код",
        "type_description": "Строка"
      },
      {
        "name": "Наименование",
        "type_description": "Строка"
      }
    ],
    "tabular_sections": []
  }
}
```

### Валидация

- type должен существовать.
- type должен быть разрешён allowlist.
- Скрытые реквизиты не возвращать или помечать allowed=false в зависимости от политики.
- Права текущего пользователя должны проверяться до формирования ответа.

### Заметки по реализации 1С

- Использовать объект метаданных: Метаданные.Справочники.Номенклатура и аналоги.
- ОписаниеТипов преобразовывать в читаемый type_description и список value_types.
- Для табличных частей возвращать имя, синоним и список реквизитов.
- Для регистров отдельно возвращать dimensions, resources, attributes, periodicity.
- Для регистров накопления дополнительно возвращать `resources_by_mode`:
  `records` содержит базовые ресурсы, `turnovers` - имена с суффиксом
  `Оборот`, `balance` - с суффиксом `Остаток`,
  `balance_and_turnovers` - `НачальныйОстаток`, `Оборот`,
  `КонечныйОстаток`.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.3. `run_1c_query`

**Title:** Выполнить безопасный read-only запрос 1С  
**Priority:** P0

### Назначение

Выполняет запрос языка запросов 1С с параметрами и возвращает табличный результат. Это самый мощный и самый рискованный read-only tool.

### Когда использовать

Сложная аналитика, агрегаты, соединения, нестандартные выборки, когда search_objects/get_register_records/run_1c_report недостаточны.

### Когда не использовать

Не использовать для простого поиска по имени, номеру, коду или UUID. Не использовать без validate_1c_query.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Текст запроса 1С. Только read-only."
    },
    "parameters": {
      "type": "object",
      "description": "Параметры запроса в формате QueryParameterValue."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 100
    },
    "timeout_seconds": {
      "type": "integer",
      "minimum": 1,
      "maximum": 60,
      "default": 15
    },
    "validate_before_run": {
      "type": "boolean",
      "description": "Compatibility flag only: security validation is always enforced server-side.",
      "default": true
    },
    "return_format": {
      "type": "string",
      "enum": [
        "rows",
        "table"
      ],
      "default": "rows"
    },
    "include_column_types": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "columns": [
    {
      "name": "Ссылка",
      "type_description": "СправочникСсылка.Контрагенты"
    }
  ],
  "rows": [
    {
      "Ссылка": {
        "type": "Справочник.Контрагенты",
        "uuid": "...",
        "presentation": "ООО Ромашка"
      }
    }
  ],
  "row_count": "integer",
  "truncated": "boolean",
  "duration_ms": "integer",
  "warnings": [
    "string"
  ]
}
```

Для запросов, которые по тексту выглядят как аналитика движений, стоимости,
остатков, закупок, продаж, ТМЦ, материалов, сырья, МБП, НМА, основных средств,
себестоимости, прибыли или рентабельности, `validate_1c_query` и `run_1c_query`
могут дополнительно вернуть `domain_guidance`. Это не глобальный промпт:
подсказка появляется только в релевантном контексте и напоминает учитывать
возвраты, сторно и знак движений без привязки к конкретной структуре
конфигурации.

Для запросов по бухгалтерским субконто `domain_guidance` может дополнительно
напомнить, что поля `Субконто*`, `СубконтоДт*` и `СубконтоКт*` имеют
обобщённый ссылочный тип и уже доступны через бухгалтерские виртуальные
таблицы. Отдельного открытия конкретного вида субконто в MCP не требуется.
Чтобы понять, какая позиция `Субконто1/2/3` соответствует нужной аналитике
для конкретного счёта, нужно вызвать `get_accounting_accounts_map`; он читает
live-таблицу `ПланСчетов.<ИмяПлана>.ВидыСубконто` и возвращает `position`. При
соединении независимых подзапросов по таким полям рекомендуется выводить
`УникальныйИдентификатор(Субконто...) КАК ...UUID` и соединять подзапросы
по UUID, оставляя саму ссылку отдельным полем для представления.

Если успешный `run_1c_query` по бухгалтерской виртуальной таблице
`Остатки`/`Обороты` использует позиционные поля `Субконто1/2/3` или
`СубконтоДт/Кт1/2/3` и возвращает `row_count=0`, сервер должен добавить
компактный `warnings[]` без дополнительного discovery: возможна неверно
угаданная позиция аналитики, проверьте её через `get_accounting_accounts_map`
с узким `account_code_prefix` или используйте профильный бухгалтерский
shortcut.

### Пример `tools/call` arguments

```json
{
  "query": "ВЫБРАТЬ ПЕРВЫЕ 10 Контрагенты.Ссылка КАК Ссылка, Контрагенты.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Контрагенты ГДЕ Контрагенты.Наименование ПОДОБНО &Query",
  "parameters": {
    "Query": {
      "kind": "string",
      "value": "%Ромашка%"
    }
  },
  "limit": 10,
  "validate_before_run": true
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "columns": [
    {
      "name": "Ссылка",
      "type_description": "СправочникСсылка.Контрагенты"
    },
    {
      "name": "Наименование",
      "type_description": "Строка"
    }
  ],
  "rows": [
    {
      "Ссылка": {
        "type": "Справочник.Контрагенты",
        "uuid": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
        "presentation": "ООО Ромашка"
      },
      "Наименование": "ООО Ромашка"
    }
  ],
  "row_count": 1,
  "truncated": false,
  "duration_ms": 42,
  "warnings": []
}
```

### Валидация

- Всегда выполнять server-side security validation перед выполнением; `validate_before_run=false` не может обходить allowlist.
- Явный `ПЕРВЫЕ/TOP` должен быть числовым литералом и не превышать `max_query_rows`.
- Запретить обращение к denylist-объектам и скрытым полям.
- Запретить `ВЫБРАТЬ *` / alias wildcard (`Т.*`).
- Пакетные запросы разрешены только для временных таблиц. `ПОМЕСТИТЬ`,
  `ИНДЕКСИРОВАТЬ ПО` и `УНИЧТОЖИТЬ` допустимы как операции над временными
  таблицами; финальная команда пакета должна быть `ВЫБРАТЬ/SELECT`, потому что
  сервер возвращает только финальный табличный результат.
- Параметры устанавливать только через УстановитьПараметр, без конкатенации пользовательского ввода.
- Ограничивать строки, время и размер JSON.
- Постоянные данные остаются read-only: запретить `ИЗМЕНИТЬ`,
  `ДЛЯ ИЗМЕНЕНИЯ`, `UPDATE`, `INSERT`, `DELETE`, `DROP`, `ПРАВА ДОСТУПА`.
- Для условий по агрегатам использовать ключевое слово 1С `ИМЕЮЩИЕ`.
  Опечатка/калька `ИМЕЯ` должна диагностироваться валидатором до выполнения.
- При ошибке выполнения добавлять структурированные поля `error_code`, `message`,
  `hint`, `available_fields`, `see_also`. Если запрос был остановлен
  валидацией, возвращать `validation_errors[]` с `code`, `message`, `location`,
  `hint`, `see_also`.
- При `row_count=0` для бухгалтерских виртуальных таблиц с позиционными
  `Субконто*` добавлять warning о возможном несовпадении позиции аналитики со
  счётом; этот warning не должен включать полный `query_guidance` сам по себе.
- `query_guidance`, `domain_guidance` и вложенное `validation.query_guidance`
  возвращать в успешном ответе только при `include_guidance=true`. При ошибке
  выполнения диагностический guidance возвращается принудительно независимо от
  флага.

Пример временной таблицы:

```1c
ВЫБРАТЬ
    Организации.Ссылка КАК Ссылка,
    УникальныйИдентификатор(Организации.Ссылка) КАК UUID
ПОМЕСТИТЬ ВТОрганизации
ИЗ
    Справочник.Организации КАК Организации
ИНДЕКСИРОВАТЬ ПО
    UUID;

ВЫБРАТЬ ПЕРВЫЕ 10
    ВТОрганизации.Ссылка КАК Ссылка,
    ВТОрганизации.UUID КАК UUID
ИЗ
    ВТОрганизации КАК ВТОрганизации
```

Пример фильтрации агрегатов:

```1c
ВЫБРАТЬ
    х.Регистратор КАК Документ,
    СУММА(х.КоличествоДт) КАК Количество
ИЗ
    РегистрБухгалтерии.<ИмяРегистра> КАК х
СГРУППИРОВАТЬ ПО
    х.Регистратор
ИМЕЮЩИЕ
    СУММА(х.КоличествоДт) > 0
```

### Заметки по реализации 1С

- Использовать объект Запрос.
- Параметры декодировать из QueryParameterValue в реальные значения 1С.
- Результат обходить выборкой и останавливать после limit.
- Ссылки и перечисления кодировать через общий Encode1CValue.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.4. `validate_1c_query`

**Title:** Проверить запрос 1С до выполнения  
**Priority:** P0

### Назначение

Проверяет синтаксис, используемые объекты, параметры, риски и политики безопасности запроса до run_1c_query.

### Когда использовать

Перед каждым нестандартным запросом, особенно если запрос составлен LLM-агентом.

### Когда не использовать

Не считать единственной защитой. Нужны allowlist, права 1С, лимиты и аудит.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string"
    },
    "parameters": {
      "type": "object"
    },
    "strict": {
      "type": "boolean",
      "default": true
    },
    "explain": {
      "type": "boolean",
      "default": false
    },
    "include_guidance": {
      "type": "boolean",
      "default": false,
      "description": "Включить query_guidance/domain_guidance в ответ. По умолчанию false; explain=true остается legacy-синонимом opt-in."
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "valid": "boolean",
  "errors": [
    {
      "code": "string",
      "message": "string",
      "location": "string|null"
    }
  ],
  "warnings": [
    "string"
  ],
  "detected_objects": [
    "Справочник.Контрагенты"
  ],
  "detected_parameters": [
    "Query"
  ],
  "query_guidance": [
    {
      "id": "metadata_first",
      "title": "Сначала проверьте метаданные",
      "instruction": "string",
      "resource_uri": "1c://knowledge/query",
      "configuration_agnostic": true
    }
  ],
  "estimated_risk": "low|medium|high|blocked"
}
```

`query_guidance` и `domain_guidance` присутствуют только при `include_guidance=true`
или legacy `explain=true`.

### Пример `tools/call` arguments

```json
{
  "query": "ВЫБРАТЬ Контрагенты.Ссылка ИЗ Справочник.Контрагенты КАК Контрагенты",
  "strict": true,
  "include_guidance": true
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "valid": true,
  "errors": [],
  "warnings": [
    "Запрос не содержит явного ограничения ПЕРВЫЕ N. Будет применён server-side limit."
  ],
  "detected_objects": [
    "Справочник.Контрагенты"
  ],
  "detected_parameters": [],
  "query_guidance": [
    {
      "id": "metadata_first",
      "title": "Сначала проверьте метаданные",
      "instruction": "Не угадывайте имена объектов, реквизитов, табличных частей, регистров и ресурсов. Сначала используйте list_metadata_objects/get_metadata_structure, затем составляйте запрос по фактическим query names текущей базы.",
      "resource_uri": "1c://knowledge/query",
      "severity": "high",
      "configuration_agnostic": true
    }
  ],
  "estimated_risk": "low"
}
```

### Валидация

- Определить таблицы метаданных, использованные в запросе.
- Проверить их по allowlist.
- Определить параметры &ИмяПараметра и сравнить с parameters.
- Проверить запрещённые конструкции.
- Проверить потенциально тяжёлые full-scan запросы.
- При `include_guidance=true` вернуть `query_guidance`/`domain_guidance` из встроенной базы знаний `doc/skills`; `explain=true` поддерживается как legacy-синоним.

### Заметки по реализации 1С

- В 1С нет удобного публичного AST запроса; использовать комбинацию parser/regex + компиляция Запрос.
- При возможности выполнять dry-run с ПЕРВЫЕ 0/1 только после проверки безопасности.
- Возвращать диагностические warnings, чтобы агент мог исправить запрос.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.5. `get_1c_query_guidance`

**Title:** Получить подсказки по языку запросов 1С
**Priority:** P0

### Назначение

Возвращает встроенные универсальные правила из `doc/skills`: синтаксис, функции, временные таблицы, составные типы, субконто, оптимизация и ограничения read-only MCP.

### Когда использовать

- Перед сложным `run_1c_query`.
- После ошибки `validate_1c_query`, если агенту нужно понять, как переписать запрос.
- Когда пользователь просит объяснить синтаксис или ограничения языка запросов 1С.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "Тема или auto: metadata-first, query-structure, virtual-tables, temporary-tables, joins, grouping-and-having, functions, compound-types, subconto, null-handling, parameters, reports-vs-query, report-fast-path, performance-pitfalls, mcp-query-safety."
    },
    "query": {
      "type": "string",
      "description": "Черновик запроса 1С для контекстных подсказок."
    },
    "intent": {
      "type": "string",
      "description": "Описание аналитической задачи пользователя."
    },
    "include_examples": {
      "type": "boolean"
    },
    "max_sections": {
      "type": "integer",
      "minimum": 1,
      "maximum": 12,
      "default": 6
    }
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": true,
  "configuration_agnostic": true,
  "source": "doc/skills",
  "topics": [
    {
      "id": "temporary-tables",
      "title": "Временные таблицы",
      "summary": "string",
      "resource_uri": "1c://knowledge/query/temporary-tables"
    }
  ],
  "guidance": [
    {
      "id": "temporary_tables_read_only",
      "title": "Временные таблицы разрешены",
      "instruction": "string",
      "resource_uri": "1c://knowledge/query/temporary-tables",
      "severity": "high",
      "configuration_agnostic": true
    }
  ]
}
```

### Общие правила

- Tool не обращается к данным конкретной базы и не зависит от структуры конфигурации.
- Примеры должны быть шаблонными: `<Источник>`, `<ИмяРегистра>`, `<Реквизит>`.
- Тема `parameters` должна явно показывать, что строки/числа/булево можно передавать напрямую, а даты/ссылки/перечисления/массивы передаются через `QueryParameterValue`: `{"kind":"datetime","value":"..."}`, `{"kind":"ref","type":"<ПолныйТип>","uuid":"<UUID>"}`, `{"kind":"enum","type":"<Тип>","name":"<Имя>"}`, `{"kind":"array","value":[...]}`.
- Тема `report-fast-path` должна направлять агента к минимальному discovery для отчетной аналитики: узкие `search_objects`/`list_metadata_objects`, `list_reports` с малым `limit`, специализированные карты (`get_accounting_accounts_map`, `get_calculation_types_map`), бухгалтерские shortcuts (`get_accounting_balances_by_subconto_age`, `compare_accounting_balances_by_subconto`) для aging/пересечений остатков и отказ от широкого `get_database_passport(force_refresh=true)` без необходимости.
- Темы `subkonto` и `accounting-register-patterns` должны включать high-severity guidance с id `accounting-register-turnovers-fields`: `ЗНАЧЕНИЕ(ПланСчетов.<Имя>.*)` принимает только имена предопределённых элементов, конкретные счета передаются UUID-параметрами из `get_accounting_accounts_map`; для виртуальной таблицы `Обороты` использовать поля `СуммаОборотДт`/`СуммаОборотКт` и параметр `Субконто`, а `ОборотыДтКт` применять только для анализа корреспонденции.
- Темы `virtual-tables`, `subkonto` и `accounting-register-patterns` должны включать high-severity guidance с id `accounting-balance-vs-turnover`: `Остатки` применяются для долга/задолженности/сальдо/остатка на дату, `Обороты` — только для движения за период, `ОстаткиИОбороты` — когда нужны начальное/конечное сальдо и обороты вместе. Для "на конец 2024" использовать дату остатка `ДАТАВРЕМЯ(2025, 1, 1)`.
- Тема `payroll` должна включать high-severity guidance с id `payroll-salary-source-selection`: для зарплаты за период сначала предпочитать зарплатный отчёт/расчётные регистры ЗУП; если доступен только бухгалтерский регистр, начисленная зарплата по счёту 70 обычно берётся из кредитового оборота 70 (`СуммаОборотКт`) через виртуальную таблицу `Обороты`, а дебетовый оборот 70 нельзя называть начислением.
- Полная справка доступна также через resources `1c://knowledge/query/*`.

---

## 7.6. `get_accounting_accounts_map`

**Title:** Получить карту счетов и субконто
**Priority:** P0

### Назначение

Универсально читает live-таблицу `ПланСчетов.<Имя>.ВидыСубконто`, чтобы агент видел актуальное соответствие счёта позициям `Субконто1/2/3` без угадывания структуры конкретной базы. Metadata не является источником истины для порядка субконто: пользователь может изменить порядок аналитик в 1С:Предприятии.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "chart": {
      "type": "string",
      "description": "Полное имя плана счетов. Если не указано и доступен один ПланСчетов.*, он выбирается автоматически."
    },
    "account_code_prefix": {
      "type": "string"
    },
    "include_empty_subconto": {
      "type": "boolean",
      "default": false
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 500
    },
    "cursor": {
      "type": "string"
    },
    "include_query": {
      "type": "boolean"
    },
    "include_guidance": {
      "type": "boolean",
      "default": false,
      "description": "Включить guidance/domain_guidance в успешный ответ. По умолчанию false."
    }
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": true,
  "chart": "ПланСчетов.<Имя>",
  "tabular_section": "ВидыСубконто",
  "tabular_section_found": true,
  "source_of_truth": "ПланСчетов.<Имя>.ВидыСубконто",
  "columns": [],
  "rows": [],
  "accounts": [
    {
      "account": {"type": "ПланСчетов.<Имя>", "uuid": "...", "presentation": "<КодСчета>"},
      "code": "<КодСчета>",
      "name": "<НаименованиеСчета>",
      "uuid": "...",
      "subconto": [
        {
          "position": 1,
          "name": "<ВидСубконто1>",
          "uuid": "...",
          "sum": true,
          "qty": false,
          "currency": false,
          "turnovers_only": false,
          "ref": {"type": "ПланВидовХарактеристик.<Имя>", "uuid": "..."}
        }
      ],
      "subconto_count": 1
    }
  ],
  "total_accounts": 312,
  "truncated": false,
  "next_cursor": null,
  "configuration_agnostic": true,
  "guidance": "Позиция строки ВидыСубконто соответствует позиции Субконто1/2/3."
}
```

### Правила

- Tool не знает заранее имена счетов и не содержит типовых кодов счетов.
- Если доступно несколько планов счетов и `chart` не указан, tool возвращает `needs_chart=true` и список кандидатов.
- Для чтения используется запрос к `ПланСчетов.<Имя>.ВидыСубконто`; metadata используется только для выбора/проверки доступного плана счетов.
- Поле `position` — это `НомерСтроки`; `position=1` означает `Субконто1`, `position=2` означает `Субконто2`, `position=3` означает `Субконто3`.
- Счета без строк `ВидыСубконто` включаются в `accounts[]` только при `include_empty_subconto=true`.
- `rows` сохраняет плоскую таблицу для обратной совместимости, а `accounts[].subconto[]` даёт LLM готовую карту `счёт -> позиция -> вид субконто`.
- `total_accounts` показывает общее количество счетов в выбранном плане/фильтре, чтобы агент понимал, нужна ли пагинация.
- Если ответ обрезан по `limit`, сервер возвращает непустой `next_cursor`; повторный вызов с этим cursor продолжает чтение без угадывания смещения.
- Постоянные данные не изменяются.

---

## 7.6.1. `get_accounting_balances_by_subconto_age`

**Title:** Остатки по возрасту субконто
**Priority:** P0

### Назначение

Универсальный конфигурационно-агностичный tool для aging бухгалтерских остатков: вызывающая сторона передает регистр, префиксы счетов, сторону остатка и виды/позиции субконто. Сервер строит запрос к `РегистрБухгалтерии.<Имя>.Остатки`, считает возраст по дате выбранного `СубконтоN` и возвращает агрегированные бакеты плюс детализацию.

Tool не содержит знаний о дебиторке, кредиторке, авансах или конкретных счетах. Бизнес-смысл задает агент или пользователь через `account_code_prefixes`, `balance_side` и выбранные виды субконто.

### Вход

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
  "extra_subconto_indexes": [2, 3],
  "age_buckets": [90, 180, 365],
  "min_age_days": 0,
  "min_amount": 10000,
  "order_by": "amount_desc",
  "include_query": false,
  "include_guidance": false,
  "limit": 100
}
```

Обязательные поля: `account_code_prefixes`, `balance_side`, `subconto_kinds`. `subconto_kinds` принимает строки с `Наименование` вида субконто из `get_accounting_accounts_map` или готовые `QueryParameterValue` ссылки `kind=ref`; строки сервер резолвит в `ПланВидовХарактеристик.ВидыСубконтоХозрасчетные` до выполнения запроса. Если `accounting_register` не указан, сервер выбирает доступный бухгалтерский регистр или `Хозрасчетный`, если он есть и доступен. Если `as_of` не указан, используется текущая дата сервера. Если `age_buckets` не указан, используются `[90, 180, 365]`.

### Выход

```json
{
  "ok": true,
  "accounting_register": "РегистрБухгалтерии.<Имя>",
  "as_of": "2026-06-29T23:59:59",
  "balance_side": "debit",
  "account_code_prefixes": ["62"],
  "group_subconto_index": 1,
  "age_subconto_index": 3,
  "bucket_rows": [
    {"bucket": ">365", "amount": 1000000, "row_count": 3}
  ],
  "rows": [
    {
      "account_code": "62.01",
      "account": {},
      "group_subconto": {},
      "group_subconto_uuid": "...",
      "age_subconto": {},
      "age_date": "2025-01-01T00:00:00",
      "age_days": 545,
      "amount": 1000000
    }
  ],
  "row_count": 1,
  "truncated": false,
  "next_cursor": null,
  "duration_ms": 42,
  "warnings": [],
  "configuration_agnostic": true
}
```

При `include_query=true` возвращается `query_used.detail` и `query_used.buckets`. При `include_guidance=true` возвращается пояснение, что tool не интерпретирует счета и аналитики предметно.

### Правила

- Перед вызовом агент должен получить реальные виды субконто через `get_accounting_accounts_map`; порядок массива `subconto_kinds` определяет поля `Субконто1/2/3` виртуальной таблицы.
- Если строковый вид субконто не найден в `ПланВидовХарактеристик.ВидыСубконтоХозрасчетные`, tool возвращает `invalid_arguments` со списком доступных значений и не запускает основной запрос.
- `balance_side=debit` использует `СуммаОстатокДт`, `balance_side=credit` использует `СуммаОстатокКт`.
- Возраст считается по реквизиту `Дата` значения выбранного `СубконтоN`; если аналитика не имеет даты, такой сценарий нужно выполнять обычным `run_1c_query` после discovery.
- `min_amount` фильтрует детализацию и бакеты; при значении `0` нулевые остатки не возвращаются.
- Постоянные данные не изменяются.

---

## 7.6.2. `compare_accounting_balances_by_subconto`

**Title:** Сравнить два набора остатков по субконто
**Priority:** P0

### Назначение

Универсальный конфигурационно-агностичный tool для поиска пересечений двух наборов бухгалтерских остатков по одной аналитике. Вызывающая сторона задает оба набора счетов и стороны Дт/Кт; сервер агрегирует `Остатки` и соединяет наборы по `УникальныйИдентификатор(СубконтоN)`.

Tool не знает, что левый или правый набор означает дебиторку, кредиторку, авансы или другой бизнес-смысл.

### Вход

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
  "include_query": false,
  "include_guidance": false,
  "limit": 100
}
```

Обязательные поля: `subconto_kinds`, `left_account_code_prefixes`, `left_balance_side`, `right_account_code_prefixes`, `right_balance_side`. `subconto_kinds` принимает строки с `Наименование` вида субконто или готовые `QueryParameterValue` ссылки `kind=ref`; строки сервер резолвит в `ПланВидовХарактеристик.ВидыСубконтоХозрасчетные` до выполнения запроса. Если `match_subconto_index` не указан, используется `1`.

### Выход

```json
{
  "ok": true,
  "accounting_register": "РегистрБухгалтерии.<Имя>",
  "as_of": "2026-06-29T23:59:59",
  "match_subconto_index": 1,
  "left_balance_side": "debit",
  "right_balance_side": "credit",
  "left_account_code_prefixes": ["62"],
  "right_account_code_prefixes": ["60"],
  "rows": [
    {
      "subconto": {},
      "subconto_uuid": "...",
      "left_amount": 100000,
      "right_amount": 50000,
      "left_accounts": "62.01",
      "right_accounts": "60.01"
    }
  ],
  "row_count": 1,
  "truncated": false,
  "next_cursor": null,
  "duration_ms": 31,
  "warnings": [],
  "configuration_agnostic": true
}
```

При `include_query=true` возвращается `query_used`. При `include_guidance=true` возвращается пояснение, что tool сравнивает произвольные наборы остатков без предметной интерпретации счетов.

### Правила

- `subconto_kinds` задает порядок аналитик виртуальной таблицы `Остатки`; не угадывать позиции, сначала использовать `get_accounting_accounts_map`.
- Если строковый вид субконто не найден, tool возвращает `invalid_arguments` со списком доступных значений и не запускает основной запрос.
- Сравнение выполняется по UUID выбранного `СубконтоN`, чтобы одинаковые представления разных ссылок не склеивались.
- `min_amount` применяется к каждой стороне отдельно; при значении `0` строки с нулем по стороне не возвращаются.
- Для задач с периодическими движениями, документами или корреспонденцией использовать `get_accounting_entries`, `get_register_records` или `run_1c_query`.
- Постоянные данные не изменяются.

---

## 7.6.3. `get_inventory_balances_by_item`

**Title:** Остатки товара по складам и организациям
**Priority:** P0

### Назначение

Высокоуровневый быстрый tool для типового вопроса "остатки товара в разрезе складов и организаций". Заменяет цепочку `search_objects -> get_accounting_accounts_map -> run_1c_query` одним MCP-вызовом: находит номенклатуру, читает виды субконто `Номенклатура` и `Склады` из `ПланСчетов.<Имя>.ВидыСубконто`, затем выполняет агрегированный read-only запрос к `РегистрБухгалтерии.<Имя>.Остатки`.

### Вход

```json
{
  "item_query": "Пирог тирольский с черникой",
  "item_ref": {"type": "Справочник.Номенклатура", "uuid": "..."},
  "item_type": "Справочник.Номенклатура",
  "as_of": "2026-05-22T23:59:59",
  "accounting_register": "РегистрБухгалтерии.Хозрасчетный",
  "chart": "ПланСчетов.Хозрасчетный",
  "account_code_prefixes": ["41", "43"],
  "item_subconto_name": "Номенклатура",
  "warehouse_subconto_name": "Склады",
  "include_zero": false,
  "include_query": false,
  "limit": 100
}
```

`item_query` или `item_ref` обязательны. Если `item_ref` передан, поиск номенклатуры пропускается. Если `as_of` не передан, используется текущая дата сервера. Если `chart`/`accounting_register` не указаны, tool выбирает `Хозрасчетный`, если он доступен; при нескольких неоднозначных объектах требует явное имя.

### Выход

Возвращает `columns`, `rows`, `row_count`, `totals`, `item`, `as_of`, `accounting_register`, `chart`, `subconto`, `warnings`. Строки агрегированы по `Организация` и `Склад`, с ресурсами `КоличествоОстаток` и `СуммаОстаток`.

### Правила

- Tool остаётся read-only и использует только параметры запроса.
- Позиции `Субконто1/2` не угадываются: порядок задаётся параметром виртуальной таблицы `Субконто` как массив `[Номенклатура, Склады]`.
- `account_code_prefixes` используются не только для поиска видов субконто, но и как фильтр итоговых остатков по `Счет.Код`.
- Для произвольной бухгалтерской аналитики остаётся основной путь `get_accounting_accounts_map -> validate_1c_query -> run_1c_query`.

---

## 7.7. `get_calculation_types_map`

**Title:** Получить карту видов расчёта
**Priority:** P0

### Назначение

Универсально читает `ПланВидовРасчета.<Имя>`, чтобы агент видел реальные виды начислений, удержаний и расчётов с UUID. Используется для ЗУП-подобных конфигураций перед запросами к `РегистрРасчета.*`.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "plan": {"type": "string"},
    "code_prefix": {"type": "string"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 500},
    "cursor": {"type": "string"},
    "include_query": {"type": "boolean"}
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": true,
  "plan": "ПланВидовРасчета.<Имя>",
  "calculation_types": [
    {"code": "Оклад", "name": "Оплата по окладу", "uuid": "...", "ref": {}}
  ],
  "total_calculation_types": 100,
  "truncated": false,
  "next_cursor": null,
  "configuration_agnostic": true
}
```

### Правила

- Tool не содержит типовых имён ЗУП и не угадывает виды расчёта.
- Если доступно несколько `ПланВидовРасчета.*` и `plan` не указан, возвращает `needs_plan=true`.
- UUID из ответа можно передавать как ссылочный параметр `{ "type": "ПланВидовРасчета.<Имя>", "uuid": "..." }`.
- Для запроса "зарплата сотрудников за период" сначала проверять зарплатный отчёт и `РегистрРасчета.*`; бухгалтерский fallback по счёту 70 допустим только как приближение и должен использовать кредитовый оборот 70 для начислений, а не дебетовый оборот.

---

## 7.8. `get_database_passport`

**Title:** Получить паспорт фактических данных базы
**Priority:** P0

### Назначение

Возвращает срез фактического состояния базы: активные организации из бухгалтерских регистров, горизонт записей бухгалтерских регистров и флаги заполненности регистров накопления. Это не метаданные и не отчёт по конкретной конфигурации, а универсальная стартовая ориентация для LLM.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "accounting_register": {"type": "string"},
    "include_organizations": {"type": "boolean"},
    "include_period": {"type": "boolean"},
    "include_closed_periods": {"type": "boolean"},
    "include_accumulation_registers": {"type": "boolean"},
    "organization_limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
    "accounting_register_limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
    "accumulation_register_limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100},
    "include_empty_registers": {"type": "boolean"},
    "force_refresh": {"type": "boolean"}
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": true,
  "configuration_agnostic": true,
  "read_only": true,
  "organizations": [
    {"name": "Организация", "inn": "...", "kpp": "...", "uuid": "...", "type": "Справочник.Организации", "ref": {}, "source_register": "РегистрБухгалтерии.<Имя>"}
  ],
  "data_period": {
    "first_entry": "<ДатаПервойЗаписи>",
    "last_entry": "<ДатаПоследнейЗаписи>",
    "total_entries": 12453,
    "source_register": "РегистрБухгалтерии.<Имя>"
  },
  "closed_periods": [],
  "accounting_registers": [
    {"register": "РегистрБухгалтерии.<Имя>", "first_entry": "...", "last_entry": "...", "total_entries": 12453, "has_organization_field": true}
  ],
  "accumulation_registers": {
    "with_data": ["<ИмяРегистра>"],
    "empty": ["<ИмяРегистра>"]
  },
  "accumulation_registers_detail": [
    {"register": "РегистрНакопления.<Имя>", "name": "<ИмяРегистра>", "has_data": true}
  ],
  "accumulation_registers_checked": 100,
  "cache_hit": false,
  "cache_age_seconds": 0,
  "warnings": []
}
```

### Правила

- Tool не предполагает наличие `Хозрасчетный`, `Организации` или типовых регистров: он перебирает доступные метаданные и проверяет поля перед запросом.
- `organizations` строится по фактическим строкам бухгалтерских регистров, а не по всему справочнику организаций.
- `closed_periods` читается из `РегистрСведений.ДатыЗапретаИзменения`, если он есть и разрешён allowlist; если регистра нет или он пуст, возвращается пустой массив.
- Если серверная среда допускает session-cache без записи постоянных данных, раздел `accumulation_registers` может кэшироваться на 10-15 минут. В read-only окружении без безопасного состояния сервер возвращает `cache_hit=false`, `cache_age_seconds=0`; `force_refresh=true` всегда требует пересчёта.
- Постоянные данные не изменяются.

---

## 7.8. `get_object_by_ref`

**Title:** Получить объект по типу и UUID ссылки  
**Priority:** P0

### Назначение

Точно получает ссылочный объект 1С по полному имени типа метаданных и UUID.

### Когда использовать

Когда известны и type, и uuid: например Справочник.Номенклатура + GUID.

### Когда не использовать

Если тип неизвестен — сначала find_object_by_id. Для простого поиска по имени — search_objects.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string"
    },
    "uuid": {
      "type": "string"
    },
    "fields": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "include_standard_fields": {
      "type": "boolean",
      "default": true
    },
    "include_tabular_sections": {
      "type": "boolean",
      "default": false
    },
    "tabular_sections": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "tabular_section_row_limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 100
    },
    "include_navigation_url": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "type",
    "uuid"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "found": "boolean",
  "object": {
    "ref": "ObjectRef",
    "standard_fields": {},
    "fields": {},
    "tabular_sections": {}
  }
}
```

### Пример `tools/call` arguments

```json
{
  "type": "Справочник.Номенклатура",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "fields": [
    "Код",
    "Наименование",
    "Артикул"
  ],
  "include_tabular_sections": false
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "found": true,
  "object": {
    "ref": {
      "type": "Справочник.Номенклатура",
      "uuid": "550e8400-e29b-41d4-a716-446655440000",
      "presentation": "Товар 1",
      "navigation_url": "e1cib/data/..."
    },
    "standard_fields": {
      "Код": "000000001",
      "Наименование": "Товар 1",
      "ПометкаУдаления": false
    },
    "fields": {
      "Артикул": "A-001"
    },
    "tabular_sections": {}
  }
}
```

### Валидация

- type должен быть ссылочным и разрешённым.
- uuid должен быть корректным UUID.
- fields и tabular_sections только из allowlist.
- Ограничивать табличные части по строкам и полям.

### Заметки по реализации 1С

- Получить менеджер: Справочники[Имя], Документы[Имя] и т.п.
- Сформировать Новый УникальныйИдентификатор(uuid).
- Получить ссылку через Менеджер.ПолучитьСсылку(УИД).
- Для документов с большими табличными частями лучше читать верхние поля запросом, а объект загружать только когда нужны ТЧ.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.9. `find_object_by_id`

**Title:** Найти объект по UUID без знания типа  
**Priority:** P0

### Назначение

Ищет UUID по разрешённым ссылочным типам и возвращает найденные кандидаты.

### Когда использовать

Когда пользователь или внешняя система дали только GUID без типа объекта.

### Когда не использовать

Не использовать, если type известен: get_object_by_ref быстрее и безопаснее.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "uuid": {
      "type": "string"
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "kinds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 10
    },
    "include_deleted": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "uuid"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "found": "boolean",
  "matches": [
    {
      "ref": "ObjectRef",
      "standard_fields": {}
    }
  ],
  "searched_types_count": "integer",
  "truncated": "boolean"
}
```

### Пример `tools/call` arguments

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "kinds": [
    "Справочник",
    "Документ"
  ],
  "limit": 10
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "found": true,
  "matches": [
    {
      "ref": {
        "type": "Справочник.Номенклатура",
        "uuid": "550e8400-e29b-41d4-a716-446655440000",
        "presentation": "Товар 1"
      },
      "standard_fields": {
        "Код": "000000001",
        "Наименование": "Товар 1"
      }
    }
  ],
  "searched_types_count": 42,
  "truncated": false
}
```

### Валидация

- Искать только по разрешённым ссылочным типам.
- Ограничивать количество типов и общее время поиска.
- Не выполнять тяжёлый ПолучитьОбъект для каждого типа без нужды.
- Уважать include_deleted.

### Заметки по реализации 1С

- Простой вариант: перебор менеджеров + ПолучитьСсылку + проверка существования.
- Оптимальный вариант: query per type по Ссылка=&Ссылка, возвращая только представление и стандартные поля.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.10. `search_objects`

**Title:** Поиск объектов по строке, коду, номеру, ИНН, артикулу  
**Priority:** P0

### Назначение

Главный human-friendly search tool. Ищет ссылочные объекты по полям, понятным пользователю.

### Когда использовать

Контрагенты по ИНН, товары по артикулу, документы по номеру, справочники по наименованию.

### Когда не использовать

Не использовать для произвольной аналитики. Для сложных выборок run_1c_query.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string"
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "kinds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "search_fields": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "filters": {
      "type": "object"
    },
    "date_from": {
      "type": "string",
      "format": "date"
    },
    "date_to": {
      "type": "string",
      "format": "date"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20
    },
    "include_deleted": {
      "type": "boolean",
      "default": false
    },
    "include_fields": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "match_mode": {
      "type": "string",
      "enum": [
        "auto",
        "exact",
        "prefix",
        "contains"
      ],
      "default": "auto"
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "matches": [
    {
      "ref": "ObjectRef",
      "score": 1.0,
      "matched_fields": [
        "ИНН"
      ],
      "fields": {}
    }
  ],
  "truncated": "boolean"
}
```

### Пример `tools/call` arguments

```json
{
  "query": "7700000000",
  "types": [
    "Справочник.Контрагенты"
  ],
  "search_fields": [
    "ИНН"
  ],
  "include_fields": [
    "Код",
    "Наименование",
    "ИНН",
    "КПП"
  ],
  "limit": 10
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "matches": [
    {
      "ref": {
        "type": "Справочник.Контрагенты",
        "uuid": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
        "presentation": "ООО Ромашка"
      },
      "score": 1.0,
      "matched_fields": [
        "ИНН"
      ],
      "fields": {
        "Код": "0000123",
        "Наименование": "ООО Ромашка",
        "ИНН": "7700000000",
        "КПП": "770001001"
      }
    }
  ],
  "truncated": false
}
```

### Валидация

- Искать только по search_fields allowlist.
- Если types не передан — использовать ограниченный набор популярных типов.
- contains-поиск ограничивать и применять после exact/prefix.
- Для документов учитывать период date_from/date_to, если задан.

### Заметки по реализации 1С

- Для справочников по умолчанию: Код, Наименование + configured fields.
- Для документов: Номер, Дата, Контрагент и configured fields.
- score: exact=1.0, prefix=0.8, contains=0.5, fuzzy=0.3.
- При наличии полнотекстового поиска можно использовать его как backend.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.11. `get_link_of_object`

**Title:** Получить навигационную ссылку на объект  
**Priority:** P1

### Назначение

Возвращает e1cib/web-client/thin-client ссылки на объект 1С, чтобы пользователь мог открыть его в интерфейсе.

### Когда использовать

После get_object_by_ref/search_objects, когда нужно дать пользователю ссылку.

### Когда не использовать

Не использовать как проверку существования объекта — для этого get_object_by_ref.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string"
    },
    "uuid": {
      "type": "string"
    },
    "link_type": {
      "type": "string",
      "enum": [
        "auto",
        "e1cib",
        "web_client",
        "thin_client"
      ],
      "default": "auto"
    },
    "base_url": {
      "type": "string",
      "description": "Базовый URL web-клиента из allowlist. Если не передан, используется web_client.base_url из MCP_ServerConfig."
    },
    "include_presentation": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "type",
    "uuid"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "found": "boolean",
  "ref": "ObjectRef",
  "links": [
    {
      "type": "e1cib",
      "url": "e1cib/data/...",
      "description": "Навигационная ссылка 1С"
    }
  ]
}
```

### Пример `tools/call` arguments

```json
{
  "type": "Документ.ЗаказКлиента",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "link_type": "auto",
  "base_url": "https://1c.example.com/erp"
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "found": true,
  "ref": {
    "type": "Документ.ЗаказКлиента",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "presentation": "Заказ клиента 000000123 от 12.05.2026",
    "navigation_url": "https://1c.example.com/erp/e1cib/data/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82.%D0%97%D0%B0%D0%BA%D0%B0%D0%B7%D0%9A%D0%BB%D0%B8%D0%B5%D0%BD%D1%82%D0%B0?ref=...",
    "navigation_url_kind": "web_client",
    "e1cib_navigation_url": "e1cib/data/Документ.ЗаказКлиента?ref=..."
  },
  "links": [
    {
      "type": "e1cib",
      "url": "e1cib/data/Документ.ЗаказКлиента?ref=...",
      "description": "Навигационная ссылка 1С"
    },
    {
      "type": "web_client",
      "url": "https://1c.example.com/erp/e1cib/data/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82.%D0%97%D0%B0%D0%BA%D0%B0%D0%B7%D0%9A%D0%BB%D0%B8%D0%B5%D0%BD%D1%82%D0%B0?ref=...",
      "description": "Ссылка для web-клиента"
    }
  ]
}
```

### Валидация

- Объект должен быть разрешён и доступен.
- base_url принимать только из allowlist.
- Не генерировать ссылки на запрещённые объекты.

### Заметки по реализации 1С

- Использовать стандартные механизмы формирования навигационных ссылок, если доступны.
- Web URL часто зависит от публикации базы и конфигурации — нужен adapter.
- Если ссылка не поддержана, вернуть links=[] и warning, не ошибку.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.12. `find_references_to_object`

**Title:** Найти ссылки на объект  
**Priority:** P1

### Назначение

Ищет документы, справочники, регистры и табличные части, где есть ссылка на target object.

### Когда использовать

Где используется номенклатура/контрагент/договор, можно ли удалять объект, какие документы ссылаются на объект.

### Когда не использовать

Для движений конкретного документа использовать get_document_movements.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string"
        },
        "uuid": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "uuid"
      ]
    },
    "search_in_types": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "search_in_kinds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "period_from": {
      "type": "string",
      "format": "date"
    },
    "period_to": {
      "type": "string",
      "format": "date"
    },
    "limit_per_type": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20
    },
    "max_types": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "default": 50
    },
    "include_counts": {
      "type": "boolean",
      "default": true
    },
    "include_samples": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "target"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "target": "ObjectRef",
  "references": [
    {
      "source_type": "Документ.ЗаказКлиента",
      "field_path": "Контрагент",
      "count": 12,
      "samples": [
        {
          "ref": "ObjectRef"
        }
      ],
      "truncated": true
    }
  ],
  "searched_types_count": "integer",
  "truncated": "boolean"
}
```

### Пример `tools/call` arguments

```json
{
  "target": {
    "type": "Справочник.Контрагенты",
    "uuid": "6f9619ff-8b86-d011-b42d-00cf4fc964ff"
  },
  "search_in_kinds": [
    "Документ",
    "РегистрСведений"
  ],
  "period_from": "2026-01-01",
  "period_to": "2026-05-12",
  "limit_per_type": 10
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "target": {
    "type": "Справочник.Контрагенты",
    "uuid": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
    "presentation": "ООО Ромашка"
  },
  "references": [
    {
      "source_type": "Документ.ЗаказКлиента",
      "field_path": "Контрагент",
      "count": 12,
      "samples": [
        {
          "ref": {
            "type": "Документ.ЗаказКлиента",
            "uuid": "550e8400-e29b-41d4-a716-446655440000",
            "presentation": "Заказ клиента 000000123"
          }
        }
      ],
      "truncated": true
    }
  ],
  "searched_types_count": 18,
  "truncated": false
}
```

### Валидация

- Target и источники поиска должны быть разрешены.
- Для больших регистров/документов требовать период или ограничивать max_types.
- Скрытые references не возвращать, либо возвращать только count.
- Строго ограничивать samples.

### Заметки по реализации 1С

- Составить карту реквизитов ссылочного типа по метаданным.
- Для верхних реквизитов и табличных частей выполнять безопасные запросы.
- field_path для ТЧ: Товары.Номенклатура; для регистров: Измерение.Номенклатура.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.13. `get_enum_values`

**Title:** Получить значения перечисления  
**Priority:** P0

### Назначение

Возвращает значения Перечисление.* для построения фильтров, параметров запросов и отчётов.

### Когда использовать

Когда нужно понять допустимые enum-значения: статусы, виды цен, виды операций.

### Когда не использовать

Не использовать для справочников — это search_objects/list_metadata_objects.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "description": "Перечисление.ВидыЦен"
    },
    "include_order": {
      "type": "boolean",
      "default": true
    },
    "include_empty": {
      "type": "boolean",
      "default": false
    }
  },
  "required": [
    "type"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "type": "Перечисление.ВидыЦен",
  "values": [
    {
      "name": "Оптовая",
      "presentation": "Оптовая",
      "order": 1
    }
  ]
}
```

### Пример `tools/call` arguments

```json
{
  "type": "Перечисление.ВидыЦен"
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "type": "Перечисление.ВидыЦен",
  "values": [
    {
      "name": "Оптовая",
      "presentation": "Оптовая",
      "order": 1
    },
    {
      "name": "Розничная",
      "presentation": "Розничная",
      "order": 2
    }
  ]
}
```

### Валидация

- type должен начинаться с Перечисление.
- Перечисление должно быть разрешено.
- Учитывать права и policy для чувствительных перечислений.

### Заметки по реализации 1С

- Обойти значения перечисления через менеджер Перечисления[Имя].
- Вернуть name, presentation, order.
- Кешировать результат, так как перечисления меняются редко.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.14. `get_register_records`

**Title:** Получить записи, срезы, остатки и обороты регистров  
**Priority:** P0

### Назначение

Универсальный tool для чтения регистров: records, slice_first, slice_last, balance, turnovers, balance_and_turnovers, turnovers_debit_credit.

### Когда использовать

Остатки товаров, цены, статусы, настройки на дату, обороты за период, записи регистра по объекту.

### Когда не использовать

Не использовать для движений одного документа — get_document_movements удобнее.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "register_type": {
      "type": "string",
      "enum": [
        "РегистрСведений",
        "РегистрНакопления",
        "РегистрБухгалтерии",
        "РегистрРасчета"
      ]
    },
    "register": {
      "type": "string"
    },
    "mode": {
      "type": "string",
      "enum": [
        "records",
        "slice_first",
        "slice_last",
        "balance",
        "turnovers",
        "balance_and_turnovers",
        "turnovers_debit_credit"
      ]
    },
    "period": {
      "type": "string",
      "description": "Дата/момент для records/slice/balance."
    },
    "period_from": {
      "type": "string"
    },
    "period_to": {
      "type": "string"
    },
    "filters": {
      "type": "object",
      "description": "Фильтры по измерениям, реквизитам, регистратору."
    },
    "dimensions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "resources": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "attributes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "order_by": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 100
    }
  },
  "required": [
    "register_type",
    "register",
    "mode"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "register": "РегистрНакопления.ТоварыНаСкладах",
  "mode": "balance",
  "columns": [
    {
      "name": "Склад",
      "type_description": "СправочникСсылка.Склады"
    }
  ],
  "rows": [
    {}
  ],
  "row_count": "integer",
  "truncated": "boolean",
  "query_used": "string|null"
}
```

### Пример `tools/call` arguments

```json
{
  "register_type": "РегистрНакопления",
  "register": "ТоварыНаСкладах",
  "mode": "balance",
  "period": "2026-05-12T23:59:59+02:00",
  "filters": {
    "Номенклатура": {
      "kind": "ref",
      "type": "Справочник.Номенклатура",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  },
  "dimensions": [
    "Склад",
    "Номенклатура"
  ],
  "resources": [
    "КоличествоОстаток"
  ],
  "limit": 100
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "register": "РегистрНакопления.ТоварыНаСкладах",
  "mode": "balance",
  "columns": [
    {
      "name": "Склад",
      "type_description": "СправочникСсылка.Склады"
    },
    {
      "name": "КоличествоОстаток",
      "type_description": "Число"
    }
  ],
  "rows": [
    {
      "Склад": {
        "type": "Справочник.Склады",
        "uuid": "11111111-1111-1111-1111-111111111111",
        "presentation": "Основной склад"
      },
      "КоличествоОстаток": 15
    }
  ],
  "row_count": 1,
  "truncated": false,
  "query_used": "ВЫБРАТЬ ..."
}
```

### Валидация

- Регистр должен быть разрешён.
- mode должен соответствовать типу регистра.
- slice_first/slice_last/balance требуют period.
- turnovers/balance_and_turnovers/turnovers_debit_credit требуют period_from и period_to.
- Фильтры, dimensions, resources, attributes только из metadata structure и allowlist.
- Для ресурсов регистров накопления можно передавать базовое имя ресурса из
  metadata (`НДС`), а сервер в виртуальных режимах автоматически подставит имя
  поля 1С: `НДСОборот` для `turnovers`, `НДСОстаток` для `balance`,
  `НДСНачальныйОстаток`/`НДСОборот`/`НДСКонечныйОстаток` для
  `balance_and_turnovers`. Явно суффиксованные имена также допустимы, если
  базовый ресурс разрешён.
- limit обязателен.

### Заметки по реализации 1С

- РегистрСведений.<Имя>.СрезПоследних(...) для slice_last.
- РегистрСведений.<Имя>.СрезПервых(...) для slice_first.
- РегистрНакопления.<Имя>.Обороты(...) для всех регистров накопления.
- РегистрНакопления.<Имя>.Остатки(...) и ОстаткиИОбороты(...) только для
  регистров накопления вида `Остатки`; для оборотных регистров эти таблицы не
  рекламируются в `virtual_tables`.
- Имена ресурсов в виртуальных таблицах зависят от режима; используйте
  `get_metadata_structure.register_schema.resources_by_mode` или передавайте
  базовые имена ресурсов, чтобы сервер сам применил суффикс режима.
- РегистрБухгалтерии.<Имя>.Остатки(...) для остатков по счетам и субконто;
  используйте `Субконто1/2/3`, `КоличествоОстаток`, `СуммаОстаток` для
  аналитики остатков, долга, задолженности и сальдо в разрезе доступных
  субконто. Вид аналитики для позиции
  `СубконтоN` определяется настройками счёта в плане счетов, обычно через
  `ПланСчетов.<ИмяПлана>.ВидыСубконто`; не предполагается, что поля
  `ВидСубконтоN` есть в виртуальной таблице. При JOIN между независимыми
  подзапросами по субконто используйте `УникальныйИдентификатор(СубконтоN)`.
- РегистрБухгалтерии.<Имя>.Обороты(...) для оборотов по счетам и субконто.
  Таблица содержит поля `СуммаОборотДт` / `СуммаОборотКт` и аналогичные поля
  других ресурсов. Параметр фильтрации по виду субконто называется `Субконто`,
  не `ВидСубконто`; он принимает ссылку или массив `ПланВидовХарактеристик`.
  Не используйте `Обороты` как замену остатков на дату: обороты показывают
  только движение внутри периода и не включают входящее сальдо до `ПериодНачало`.
- РегистрБухгалтерии.<Имя>.ОстаткиИОбороты(...) для начальных/конечных остатков
  и оборотов по счетам и субконто за период.
  Для "на конец 2024 года" дата остатка обычно `ДАТАВРЕМЯ(2025, 1, 1)`,
  чтобы включить движения 31.12.2024.
- РегистрБухгалтерии.<Имя>.ОборотыДтКт(...) для корреспонденции Дт/Кт; используйте поля
  СубконтоДт1/2/3 и СубконтоКт1/2/3 именно здесь, а не в основной таблице регистра.
  Вид аналитики для позиции определяется настройками соответствующего счёта Дт/Кт
  в плане счетов, обычно через `ПланСчетов.<ИмяПлана>.ВидыСубконто`.
  Для соединения независимых подзапросов выводите UUID через
  `УникальныйИдентификатор(СубконтоДтN/СубконтоКтN)` и соединяйте по нему.
  `ОборотыДтКт` нужна для анализа корреспонденции двух счетов, а не как замена
  обычной таблицы `Обороты`.
- `ЗНАЧЕНИЕ(ПланСчетов.<Имя>.*)` принимает только имя предопределённого элемента
  плана счетов. Код счета (`62`, `62.01`, `41.01`) не является именем
  предопределённого элемента; субсчета с точкой в коде в типовых конфигурациях
  не предопределены. Конкретный счет передавайте как `kind=ref` параметр,
  полученный из `get_accounting_accounts_map`.
- РегистрСведений.<Имя>.СрезПервых/СрезПоследних рекламируются только для
  периодических регистров сведений.
- Для РегистрРасчета `virtual_tables` содержит явный `unsupported=true`, пока
  универсальное описание виртуальных таблиц расчёта не реализовано.
- Для records использовать основную таблицу регистра.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.15. `get_document_movements`

**Title:** Получить движения документа по регистрам  
**Priority:** P0

### Назначение

Возвращает записи регистров, сформированные конкретным документом-регистратором.

### Когда использовать

Объяснить, что сделал документ: какие остатки/продажи/взаиморасчёты он изменил.

### Когда не использовать

Не использовать для произвольных остатков по товару — get_register_records.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "document_type": {
      "type": "string",
      "description": "Документ.РеализацияТоваровУслуг"
    },
    "uuid": {
      "type": "string"
    },
    "registers": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "include_empty_registers": {
      "type": "boolean",
      "default": false
    },
    "include_totals_effect": {
      "type": "boolean",
      "default": false
    },
    "row_limit_per_register": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 200
    }
  },
  "required": [
    "document_type",
    "uuid"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "found": "boolean",
  "document": "ObjectRef",
  "movements": [
    {
      "register": "РегистрНакопления.ТоварыНаСкладах",
      "register_type": "РегистрНакопления",
      "rows": [
        {}
      ],
      "row_count": 1,
      "truncated": false
    }
  ]
}
```

### Пример `tools/call` arguments

```json
{
  "document_type": "Документ.РеализацияТоваровУслуг",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "registers": [
    "РегистрНакопления.ТоварыНаСкладах",
    "РегистрНакопления.Продажи"
  ],
  "row_limit_per_register": 100
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "found": true,
  "document": {
    "type": "Документ.РеализацияТоваровУслуг",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "presentation": "Реализация 000000123 от 12.05.2026"
  },
  "movements": [
    {
      "register": "РегистрНакопления.ТоварыНаСкладах",
      "register_type": "РегистрНакопления",
      "rows": [
        {
          "Период": "2026-05-12T12:00:00+02:00",
          "Активность": true,
          "ВидДвижения": "Расход",
          "Количество": 2
        }
      ],
      "row_count": 1,
      "truncated": false
    }
  ]
}
```

### Валидация

- Документ и регистры должны быть разрешены.
- Если документ не проведён, отсутствие движений — не ошибка.
- Ограничить строки по каждому регистру.
- Не раскрывать движения запрещённых регистров.

### Заметки по реализации 1С

- Универсальный способ: запросы к регистрам с фильтром Регистратор=&ДокументСсылка.
- Список потенциальных регистров брать из metadata или из конфигурационного allowlist.
- Для каждого регистра кодировать строки через Encode1CValue.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.16. `list_reports`

**Title:** Получить список доступных отчётов  
**Priority:** P1

### Назначение

Discovery tool для отчётов: возвращает доступные Отчет.* и варианты, если возможно.

### Когда использовать

Когда пользователь просит отчёт, но точное имя отчёта неизвестно.

### Когда не использовать

Не использовать для параметров конкретного отчёта — get_report_info.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string"
    },
    "include_variants": {
      "type": "boolean",
      "default": true
    },
    "include_not_allowed": {
      "type": "boolean",
      "default": false
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "default": 100
    },
    "cursor": {
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "reports": [
    {
      "type": "Отчет.Продажи",
      "name": "Продажи",
      "synonym": "Продажи",
      "description": "Анализ продаж",
      "allowed": true,
      "execution_supported": true,
      "execution_reason": "skd",
      "has_custom_pre_compose": true,
      "variants": [
        {
          "name": "ПродажиПоКонтрагентам",
          "presentation": "Продажи по контрагентам"
        }
      ]
    }
  ],
  "domain_guidance": [
    {
      "id": "returns_and_storno",
      "applies_to": "Аналитика продаж, закупок, складских движений, ТМЦ, материалов, сырья, МБП, НМА, основных средств, себестоимости, прибыли и рентабельности.",
      "instruction": "Для аналитики движений, стоимости, остатков, закупок, продаж, себестоимости, прибыли и рентабельности считайте показатели с учётом возвратов и сторно...",
      "configuration_agnostic": true
    }
  ],
  "next_cursor": "string|null"
}
```

### Пример `tools/call` arguments

```json
{
  "query": "продажи",
  "include_variants": true,
  "limit": 20
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "reports": [
    {
      "type": "Отчет.Продажи",
      "name": "Продажи",
      "synonym": "Продажи",
      "description": "Анализ продаж",
      "allowed": true,
      "variants": [
        {
          "name": "ПродажиПоКонтрагентам",
          "presentation": "Продажи по контрагентам"
        }
      ]
    }
  ],
  "domain_guidance": [
    {
      "id": "returns_and_storno",
      "applies_to": "Аналитика продаж, закупок, складских движений, ТМЦ, материалов, сырья, МБП, НМА, основных средств, себестоимости, прибыли и рентабельности.",
      "instruction": "Для аналитики движений, стоимости, остатков, закупок, продаж, себестоимости, прибыли и рентабельности считайте показатели с учётом возвратов и сторно...",
      "configuration_agnostic": true
    }
  ],
  "next_cursor": null
}
```

### Валидация

- Возвращать только разрешённые отчёты.
- include_not_allowed только для MCP-admin.
- Пользовательские варианты учитывать по правам владельца/пользователя.
- `domain_guidance` добавлять только для контекста движений/стоимости/остатков,
  где возможны возвраты или сторно: продажи, закупки, ТМЦ, материалы, сырьё,
  МБП, НМА, основные средства, складские движения, себестоимость, прибыль,
  рентабельность. Для кадровых и прочих нерелевантных запросов поле не
  возвращать.

### Заметки по реализации 1С

- Метаданные.Отчеты для базового списка.
- Для СКД попытаться получить варианты настроек.
- Для типовых конфигураций может понадобиться adapter вариантов отчётов.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.17. `get_report_info`

**Title:** Получить параметры и структуру отчёта  
**Priority:** P1

### Назначение

Возвращает параметры, варианты, default settings, output formats и подсказки запуска отчёта.

### Когда использовать

Перед run_1c_report, чтобы агент понял обязательные параметры и допустимые значения.

### Когда не использовать

Не использовать для поиска отчётов — list_reports.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "report": {
      "type": "string",
      "description": "Отчет.Продажи"
    },
    "variant": {
      "type": "string"
    },
    "include_schema": {
      "type": "boolean",
      "default": true
    },
    "include_variants": {
      "type": "boolean",
      "default": true
    },
    "include_default_settings": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "report"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "report": "Отчет.Продажи",
  "synonym": "Продажи",
  "variants": [
    {}
  ],
  "parameters": [
    {
      "name": "ПериодНачало",
      "presentation": "Начало периода",
      "type": "Дата",
      "type_description": "Дата",
      "required": true,
      "default_value": null,
      "default": null,
      "allowed_values": []
    }
  ],
  "output_formats": [
    "table",
    "json",
    "text"
  ]
}
```

### Пример `tools/call` arguments

```json
{
  "report": "Отчет.Продажи",
  "variant": "ПродажиПоКонтрагентам",
  "include_schema": true
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "report": "Отчет.Продажи",
  "synonym": "Продажи",
  "variants": [
    {
      "name": "ПродажиПоКонтрагентам",
      "presentation": "Продажи по контрагентам"
    }
  ],
  "parameters": [
    {
      "name": "ПериодНачало",
      "presentation": "Начало периода",
      "type_description": "Дата",
      "required": true,
      "default": null,
      "allowed_values": []
    }
  ],
  "output_formats": [
    "table",
    "json",
    "text"
  ]
}
```

### Валидация

- Отчёт и вариант должны быть разрешены.
- Не раскрывать чувствительные default-фильтры.
- Если отчёт не СКД и нет adapter, вернуть supported=false или ограниченную info.
- При `include_schema=true` читать параметры из `СхемаКомпоновкиДанных.Параметры`
  и, если они там не раскрыты, из
  `КомпоновщикНастроекКомпоновкиДанных.Настройки.ПараметрыДанных`.
- Если у менеджера отчёта есть универсальная пара
  `ПустыеПараметрыКомпоновкиОтчета`/`ПередКомпоновкойМакета`, вернуть
  `has_custom_pre_compose=true`, добавить параметры из пустой структуры в
  `parameters` и выставить `report_parameter_source=custom_pre_compose_and_skd`.
- Ссылочные параметры отчётов передаются в `run_1c_report` объектом
  `{"type":"<ПолныйТип>","uuid":"<UUID>"}`. UUID организаций берётся из
  `get_database_passport`, UUID счетов - из `get_accounting_accounts_map`.

### Заметки по реализации 1С

- Для СКД получать параметры из схемы компоновки данных.
- Для нестандартных отчётов сначала использовать общий pre-compose hook
  `ПустыеПараметрыКомпоновкиОтчета`/`ПередКомпоновкойМакета`; adapter per report
  нужен только если отчёт не следует этому контракту.
- Возвращать параметры в том же формате, который принимает run_1c_report.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.18. `run_1c_report`

**Title:** Выполнить отчёт 1С  
**Priority:** P1

### Назначение

Выполняет разрешённый отчёт и возвращает результат как table/json/text.

### Когда использовать

Пользовательские аналитические запросы, где уже есть готовый отчёт 1С.

### Когда не использовать

Не использовать для одноразовой выборки, когда проще безопасный query или get_register_records.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "report": {
      "type": "string"
    },
    "variant": {
      "type": "string"
    },
    "parameters": {
      "type": "object",
      "description": "Параметры отчёта в формате QueryParameterValue."
    },
    "output_format": {
      "type": "string",
      "enum": [
        "table",
        "json",
        "text"
      ],
      "default": "table"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "default": 200
    },
    "timeout_seconds": {
      "type": "integer",
      "minimum": 1,
      "maximum": 180,
      "default": 60
    },
    "include_totals": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "report"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "report": "Отчет.Продажи",
  "variant": "string|null",
  "parameters_used": {},
  "columns": [
    {}
  ],
  "rows": [
    {}
  ],
  "totals": {},
  "row_count": "integer",
  "truncated": "boolean",
  "duration_ms": "integer",
  "warnings": [
    "string"
  ]
}
```

### Пример `tools/call` arguments

```json
{
  "report": "Отчет.Продажи",
  "variant": "ПродажиПоКонтрагентам",
  "parameters": {
    "ПериодНачало": {
      "kind": "date",
      "value": "2026-05-01"
    },
    "ПериодОкончание": {
      "kind": "date",
      "value": "2026-05-12"
    }
  },
  "output_format": "table",
  "limit": 1000
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "report": "Отчет.Продажи",
  "variant": "ПродажиПоКонтрагентам",
  "columns": [
    {
      "name": "Контрагент",
      "type_description": "СправочникСсылка.Контрагенты"
    },
    {
      "name": "Сумма",
      "type_description": "Число"
    }
  ],
  "rows": [
    {
      "Контрагент": {
        "type": "Справочник.Контрагенты",
        "uuid": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
        "presentation": "ООО Ромашка"
      },
      "Сумма": 125000
    }
  ],
  "totals": {
    "Сумма": 125000
  },
  "row_count": 1,
  "truncated": false,
  "duration_ms": 880,
  "warnings": []
}
```

### Валидация

- Отчёт/вариант разрешён.
- Параметры соответствуют get_report_info.
- Для тяжёлых отчётов требовать период.
- Ограничивать timeout, строки, размер результата.
- Не возвращать расшифровки запрещённых данных.

### Заметки по реализации 1С

- Для СКД: компоновщик настроек + процессор компоновки данных.
- Перед компоновкой вызывать общий pre-compose hook отчёта, если менеджер
  поддерживает `ПустыеПараметрыКомпоновкиОтчета` и `ПередКомпоновкойМакета`;
  возвращать флаг `pre_compose_applied`.
- Иерархические отчёты разворачивать в rows с level, parent_path, is_group.
- Для нестандартных отчётов без такого hook использовать adapters.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.19. `get_object_history`

**Title:** Получить историю объекта, версии или события журнала  
**Priority:** P2

### Назначение

Возвращает версии объекта, события журнала регистрации или конфигурационно-специфичную историю статусов.

### Когда использовать

Кто изменил документ, когда провели/отменили проведение, почему изменился статус или реквизит.

### Когда не использовать

Не обещать diff, если в базе нет версионирования. История может быть недоступна.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string"
        },
        "uuid": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "uuid"
      ]
    },
    "mode": {
      "type": "string",
      "enum": [
        "auto",
        "versions",
        "event_log",
        "status_changes"
      ],
      "default": "auto"
    },
    "period_from": {
      "type": "string",
      "format": "date-time"
    },
    "period_to": {
      "type": "string",
      "format": "date-time"
    },
    "include_diff": {
      "type": "boolean",
      "default": false
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "default": 100
    }
  },
  "required": [
    "target"
  ],
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "supported": "boolean",
  "target": "ObjectRef",
  "events": [
    {
      "timestamp": "2026-05-12T12:10:00+02:00",
      "user": "Иванов И.И.",
      "event_type": "write",
      "description": "Объект записан",
      "diff": null
    }
  ],
  "truncated": "boolean",
  "capabilities": {
    "versions": true,
    "event_log": true,
    "diff": false
  }
}
```

### Пример `tools/call` arguments

```json
{
  "target": {
    "type": "Документ.ЗаказКлиента",
    "uuid": "550e8400-e29b-41d4-a716-446655440000"
  },
  "mode": "auto",
  "period_from": "2026-01-01T00:00:00+02:00",
  "period_to": "2026-05-12T23:59:59+02:00",
  "include_diff": false,
  "limit": 50
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "supported": true,
  "target": {
    "type": "Документ.ЗаказКлиента",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "presentation": "Заказ клиента 000000123"
  },
  "events": [
    {
      "timestamp": "2026-05-12T12:10:00+02:00",
      "user": "Иванов И.И.",
      "event_type": "write",
      "description": "Объект записан",
      "diff": null
    },
    {
      "timestamp": "2026-05-12T12:15:00+02:00",
      "user": "Иванов И.И.",
      "event_type": "post",
      "description": "Документ проведён",
      "diff": null
    }
  ],
  "truncated": false,
  "capabilities": {
    "versions": true,
    "event_log": true,
    "diff": false
  }
}
```

### Валидация

- История может содержать персональные данные — проверять права.
- Для event_log требовать период.
- include_diff=true разрешать только при явной политике.
- Если история не поддерживается, вернуть ok=true, supported=false.

### Заметки по реализации 1С

- Источники: подсистема версионирования, журнал регистрации, регистры истории статусов.
- Сделать adapter architecture: HistoryProviderВерсионирование, HistoryProviderЖурналРегистрации, HistoryProviderРегистрыИстории.
- Маскировать чувствительные поля в diff.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

## 7.20. `get_current_user_context`

**Title:** Получить текущий контекст пользователя и базы  
**Priority:** P0

### Назначение

Возвращает пользователя, роли, базу, конфигурацию, версию MCP-сервера, read-only режим, лимиты и summary разрешённых метаданных.

### Когда использовать

В начале сессии, при диагностике доступа, при выборе безопасного плана действий агентом.

### Когда не использовать

Не использовать как substitute для list_metadata_objects, если нужен полный список объектов.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "include_roles": {
      "type": "boolean",
      "default": true
    },
    "include_limits": {
      "type": "boolean",
      "default": true
    },
    "include_allowed_metadata_summary": {
      "type": "boolean",
      "default": true
    },
    "include_server_info": {
      "type": "boolean",
      "default": true
    }
  },
  "additionalProperties": false
}
```

### Output Shape

```json
{
  "ok": "boolean",
  "user": {
    "name": "ivanov",
    "full_name": "Иванов Иван Иванович",
    "roles": [
      "МенеджерПродаж"
    ]
  },
  "infobase": {
    "name": "ERP_Production",
    "configuration_name": "1C:ERP",
    "configuration_version": "2.5.19.123",
    "platform_version": "8.3.25"
  },
  "mcp_server": {
    "name": "universal-1c-mcp",
    "version": "0.1.0",
    "read_only": true,
    "tools": [
      "..."
    ]
  },
  "limits": {},
  "allowed_metadata_summary": {}
}
```

### Пример `tools/call` arguments

```json
{
  "include_roles": true,
  "include_limits": true,
  "include_allowed_metadata_summary": true
}
```

### Пример `structuredContent`

```json
{
  "ok": true,
  "user": {
    "name": "ivanov",
    "full_name": "Иванов Иван Иванович",
    "roles": [
      "МенеджерПродаж",
      "ПользовательMCP"
    ]
  },
  "auth_context": {
    "user_name": "ivanov",
    "infobase_name": "ERP_Production",
    "configuration_version": "2.5.19.123",
    "identity_key": "ivanov@ERP_Production#2.5.19.123",
    "generated_at": "2026-05-27T12:00:00",
    "cache_policy": {
      "cacheable": false,
      "revalidate_each_call": true
    }
  },
  "authorization_policy": {
    "per_1c_session": true,
    "rights_are_user_specific": true,
    "cacheable": false,
    "revalidate_each_call": true,
    "access_denied_retry_policy": "do_not_retry_same_request_without_reauth_or_permission_change"
  },
  "infobase": {
    "name": "ERP_Production",
    "configuration_name": "1C:ERP",
    "configuration_version": "2.5.19.123",
    "platform_version": "8.3.25"
  },
  "mcp_server": {
    "name": "universal-1c-mcp",
    "version": "0.1.0",
    "read_only": true,
    "tools": [
      "list_metadata_objects",
      "get_metadata_structure",
      "run_1c_query",
      "validate_1c_query",
      "get_1c_query_guidance",
      "get_accounting_accounts_map",
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
      "get_current_user_context"
    ]
  },
  "limits": {
    "max_query_rows": 1000,
    "query_timeout_seconds": 15,
    "max_report_rows": 5000
  },
  "allowed_metadata_summary": {
    "objects_count": 128,
    "kinds": {
      "Справочник": 42,
      "Документ": 31,
      "РегистрСведений": 28,
      "РегистрНакопления": 15,
      "Отчет": 12
    }
  }
}
```

### Валидация

- Не раскрывать роли или полное имя, если политика безопасности запрещает.
- Не возвращать полный allowlist, если он чувствителен.
- Всегда возвращать read_only=true/false явно.

### Заметки по реализации 1С

- Информацию о пользователе брать из текущего сеанса 1С.
- Версии платформы и конфигурации возвращать из системной информации/метаданных.
- Лимиты брать из конфигурации MCP-сервера.

### Ошибки

Типовые error codes: `invalid_arguments`, `metadata_not_found`, `type_not_allowed`, `field_not_allowed`, `object_not_found`, `access_denied`, `result_too_large`, `internal_error`. Для этого tool могут быть добавлены специализированные коды, описанные в разделе 9.


---

# 8. Рекомендуемые MCP Resources

Часть статичного контекста лучше дополнительно представить как MCP resources:

```text
1c://metadata
1c://metadata/Справочник.Номенклатура
1c://metadata/Документ.ЗаказКлиента
1c://metadata/РегистрНакопления.ТоварыНаСкладах
1c://report/Отчет.Продажи
1c://report/Отчет.Продажи/variant/ПродажиПоКонтрагентам
1c://context/current-user
1c://knowledge/query
1c://knowledge/query/syntax
1c://knowledge/query/functions
1c://knowledge/query/optimization
1c://knowledge/query/temporary-tables
1c://knowledge/query/compound-types
1c://knowledge/query/subkonto
```

Resources подходят для схем, метаданных, описаний отчётов и документации. Tools подходят для действий: поиск, чтение, выполнение запросов и отчётов.

Knowledge resources возвращают встроенные правила из `doc/skills`. Они не описывают структуру конкретной базы, а дают LLM общие правила языка запросов 1С и ограничения MCP: сначала проверять метаданные, не использовать `ВЫБРАТЬ *`, применять `ИМЕЮЩИЕ`, сужать составные ссылки через `ССЫЛКА`/`ВЫРАЗИТЬ`, использовать временные таблицы как read-only рабочую область запроса.

---

# 9. Коды ошибок

| Code | Когда использовать |
|---|---|
| `invalid_arguments` | Не прошла JSON Schema валидация arguments |
| `unknown_tool` | Tool не существует |
| `metadata_not_found` | Объект метаданных не найден |
| `type_not_allowed` | Тип запрещён allowlist |
| `field_not_allowed` | Реквизит запрещён |
| `field_not_found` | Реквизит не найден |
| `object_not_found` | Объект не найден |
| `access_denied` | Недостаточно прав 1С или MCP |
| `query_validation_failed` | Запрос не прошёл проверку |
| `query_timeout` | Превышено время запроса |
| `result_too_large` | Результат слишком большой |
| `report_not_found` | Отчёт не найден |
| `report_variant_not_found` | Вариант отчёта не найден |
| `report_timeout` | Превышено время выполнения отчёта |
| `register_mode_not_supported` | Регистр не поддерживает режим |
| `history_not_supported` | История недоступна |
| `internal_error` | Непредвиденная ошибка |

Пример платформенного отказа прав:

```json
{
  "ok": false,
  "authorization": {
    "reason_code": "1c_access_denied",
    "denied_operation": "query_execute",
    "retry_policy": "do_not_retry_same_request_without_reauth_or_permission_change",
    "platform_message": "Недостаточно прав..."
  },
  "error": {
    "code": "access_denied",
    "message": "Ошибка выполнения запроса 1С: Недостаточно прав...",
    "authorization": {
      "reason_code": "1c_access_denied",
      "denied_operation": "query_execute",
      "retry_policy": "do_not_retry_same_request_without_reauth_or_permission_change"
    }
  }
}
```

Для ошибок выполнения `run_1c_query` сервер должен возвращать структурированные поля в JSON результата (`content[].text` в `text_only`, `structuredContent` в `structured_only`/`both`) и дублировать их в `error`, а исходную диагностику сохранять в `error.details.parsed_details.diagnostics`:

```json
{
  "ok": false,
  "error_code": "subconto_wrong_table",
  "field": "СубконтоДт1",
  "field_path": "<ИмяРегистра>.СубконтоДт1",
  "object": "РегистрБухгалтерии.<Имя>",
  "hint": "Субконто регистра бухгалтерии хранятся в отдельной физической таблице РегистрБухгалтерии.<Имя>.Субконто...",
  "see_also": "РегистрБухгалтерии.<Имя>.Субконто",
  "suggestions": ["..."],
  "available_fields": ["Период", "Регистратор", "НомерСтроки"],
  "available_fields_sample": []
}
```

Типовые ловушки, которые должны диагностироваться проактивно: `СубконтоДт1/СубконтоКт1` в основной таблице бухгалтерского регистра (`subconto_wrong_table`), `ИМЕЯ` вместо `ИМЕЮЩИЕ` (`syntax_imeyuschie`), `ПОМЕСТИТЬ` вне разрешённого пакетного запроса (`forbidden_polozhit`), неизвестная таблица (`table_not_found`), ошибка группировки (`grouping_error`), разыменование через точку внутри параметров виртуальной таблицы (`vt_param_field_error`), JOIN по ссылочным субконто вместо UUID или временной таблицы.

---

# 10. Рекомендуемый порядок работы агента

## Найти контрагента

1. `search_objects`
2. если найдено несколько — показать варианты пользователю;
3. `get_object_by_ref`;
4. `get_link_of_object`.

## Пользователь дал только GUID

1. `find_object_by_id`;
2. `get_object_by_ref`;
3. `get_link_of_object`.

## Остатки товара

1. `search_objects` для номенклатуры;
2. `get_register_records` с `mode=balance`;
3. при необходимости `get_link_of_object`.

## Объяснить документ

1. `get_object_by_ref`;
2. `get_document_movements`;
3. при необходимости `find_references_to_object`;
4. при необходимости `get_object_history`.

## Нестандартная аналитика

1. `list_metadata_objects`;
2. `get_metadata_structure`;
3. `validate_1c_query`;
4. `run_1c_query`.

## Отчёт

1. `list_reports`;
2. `get_report_info`;
3. `run_1c_report`.

---

# 11. Рекомендованная архитектура модулей 1С

```text
ОбщийМодуль.MCP_HTTP_Сервер
ОбщийМодуль.MCP_JSONRPC
ОбщийМодуль.MCP_Tools
ОбщийМодуль.MCP_Security
ОбщийМодуль.MCP_Metadata
ОбщийМодуль.MCP_Values
ОбщийМодуль.MCP_Query
ОбщийМодуль.MCP_Reports
ОбщийМодуль.MCP_Registers
ОбщийМодуль.MCP_History
ОбщийМодуль.MCP_Audit
```

Центральный dispatcher должен:

1. проверить авторизацию;
2. найти tool;
3. провалидировать arguments по JSON Schema;
4. проверить доступ к tool;
5. выполнить security checks;
6. выполнить прикладную функцию;
7. закодировать значения 1С в JSON;
8. записать аудит;
9. вернуть единый MCP tool result.

Псевдокод:

```1c
Функция ВыполнитьToolCall(ИмяТула, Аргументы, Контекст) Экспорт

    CorrelationID = Новый УникальныйИдентификатор();
    MCP_Security.ПроверитьДоступКТулу(ИмяТула, Контекст);
    MCP_JSON.ВалидироватьArguments(ИмяТула, Аргументы);

    Попытка
        Результат = MCP_Tools.ВыполнитьИнструмент(ИмяТула, Аргументы);
        MCP_Audit.ЗаписатьУспех(CorrelationID, ИмяТула, Аргументы, Результат);
        Возврат MCP_JSON.ToolResult(Результат, Ложь);
    Исключение
        Ошибка = MCP_Errors.FromException(ОписаниеОшибки(), CorrelationID);
        MCP_Audit.ЗаписатьОшибку(CorrelationID, ИмяТула, Аргументы, Ошибка);
        Возврат MCP_JSON.ToolResult(Ошибка, Истина);
    КонецПопытки;

КонецФункции
```

---

# 12. Definition of Done для MVP

MVP готов, если:

1. Все 30 tools возвращаются в `tools/list`.
2. У каждого tool есть корректный `inputSchema`.
3. Все tools возвращают `content` и `isError`; `structuredContent` возвращается в режимах `structured_only` и `both`.
4. Реализованы allowlist и denylist.
5. Реализован аудит вызовов.
6. `run_1c_query` не выполняется без проверки.
7. Любой результат ограничивается по строкам, времени и размеру.
8. Ошибки возвращаются в едином формате.
9. Есть smoke tests для поиска, чтения объекта, query, регистров, отчётов и ошибок доступа.
10. Сервер работает строго read-only.

---

# 13. Smoke tests

## Test 1: Context

```json
{
  "name": "get_current_user_context",
  "arguments": {}
}
```

Ожидание: `ok=true`, `read_only=true`, список tools содержит 30 tools.

## Test 2: Metadata

```json
{
  "name": "list_metadata_objects",
  "arguments": {"kinds": ["Справочник"], "limit": 10}
}
```

Ожидание: есть хотя бы один разрешённый справочник.

## Test 3: Structure

```json
{
  "name": "get_metadata_structure",
  "arguments": {"type": "Справочник.Номенклатура"}
}
```

Ожидание: возвращены стандартные поля и разрешённые реквизиты.

## Test 4: Search

```json
{
  "name": "search_objects",
  "arguments": {"query": "тест", "types": ["Справочник.Номенклатура"], "limit": 5}
}
```

Ожидание: нет ошибки, результат не больше 5 строк.

## Test 5: Query validation

```json
{
  "name": "validate_1c_query",
  "arguments": {
    "query": "ВЫБРАТЬ ПЕРВЫЕ 1 Номенклатура.Ссылка ИЗ Справочник.Номенклатура КАК Номенклатура"
  }
}
```

Ожидание: `valid=true`, если тип разрешён.

## Test 6: Forbidden query

```json
{
  "name": "validate_1c_query",
  "arguments": {
    "query": "ВЫБРАТЬ ПЕРВЫЕ 1 ФизическиеЛица.Ссылка ИЗ Справочник.ФизическиеЛица КАК ФизическиеЛица"
  }
}
```

Ожидание: `valid=false` или `estimated_risk=blocked`, если тип запрещён.

## Test 7: Object by ref

1. Найти объект через `search_objects`.
2. Передать его `type` и `uuid` в `get_object_by_ref`.
3. Получить `found=true`.

## Test 8: Register records

Вызвать `get_register_records` для разрешённого регистра.

Ожидание: `ok=true`, `rows` ограничены `limit`.

## Test 9: Report info

Вызвать `list_reports`, затем `get_report_info`.

Ожидание: параметры отчёта возвращаются структурированно.

## Test 10: Error format

Передать некорректный UUID в `get_object_by_ref`.

Ожидание: `isError=true`, `ok=false`, `error.code=invalid_arguments`; в `text_only` эти поля находятся в JSON внутри `content[].text`, в `structured_only`/`both` — в `structuredContent`.

---

# 14. Открытые проектные вопросы

1. Transport: HTTP или STDIO?
2. Пользователь 1С: impersonation, сервисный пользователь или текущий пользователь web-сеанса?
3. Где хранится allowlist/denylist?
4. Нужна ли маскировка персональных данных?
5. Нужны ли per-user quotas?
6. Какие отчёты требуют custom adapters?
7. Какие регистры считать безопасными для универсального чтения?
8. Поддерживать ли binary/base64?
9. Делать ли MCP resources сразу или только tools?
10. Какие версии платформы 1С поддерживаются?
11. Canonical timezone: UTC или зона информационной базы?
12. Где хранить аудит MCP-вызовов?

---

# 15. Приоритеты реализации

## P0

```text
get_current_user_context
list_metadata_objects
get_metadata_structure
get_enum_values
search_objects
find_object_by_id
get_object_by_ref
validate_1c_query
run_1c_query
get_register_records
get_document_movements
```

## P1

```text
get_link_of_object
find_references_to_object
list_reports
get_report_info
run_1c_report
```

## P2

```text
get_object_history
```

---

# 16. Итоговая архитектурная идея

- `list_metadata_objects` и `get_metadata_structure` дают агенту карту базы.
- `search_objects`, `find_object_by_id`, `get_object_by_ref` дают доступ к объектам.
- `get_register_records` и `get_document_movements` дают бизнес-факты.
- `validate_1c_query` и `run_1c_query` закрывают нестандартные случаи.
- `list_reports`, `get_report_info`, `run_1c_report` закрывают пользовательскую аналитику.
- `find_references_to_object`, `get_link_of_object`, `get_object_history` дают навигацию и объяснимость.
- `get_current_user_context` делает работу агента прозрачной и безопасной.

Сервер должен быть безопасным read-only фасадом над 1С, а не просто техническим API к базе.
