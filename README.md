# Universal 1C MCP Server (Read-Only)

Универсальный MCP-сервер для безопасного read-only доступа к данным и метаданным 1С:Предприятия 8. Постоянные данные не изменяются; временные таблицы языка запросов 1С разрешены как рабочая область выполнения аналитического запроса.

Сервер реализует протокол **Model Context Protocol (MCP) 2025-11-25** поверх HTTP-сервиса 1С и предоставляет LLM-агентам 17 read-only инструментов согласно спецификации `mcp_1c_tools_spec.md`.

## Возможности

- Полностью read-only: создание/изменение/удаление объектов невозможно.
- 17 tools: discovery → inspect → search → retrieve → explain → navigate → report.
- Allowlist/denylist типов метаданных и полей.
- Лимиты строк, времени и размера результата.
- Аудит всех вызовов с correlation_id.
- Универсальный — не зависит от конкретной конфигурации (УТ, ERP, БП и т.п.).
- Поддержка MCP Streamable HTTP: один endpoint `/rpc`, JSON-RPC 2.0, `202 Accepted` для notifications, `405` для GET/SSE при stateless-режиме.

## Реализованные tools

| № | Tool | Назначение |
|---:|---|---|
| 1 | `list_metadata_objects` | Список объектов метаданных |
| 2 | `get_metadata_structure` | Структура объекта метаданных |
| 3 | `run_1c_query` | Безопасный read-only запрос 1С |
| 4 | `validate_1c_query` | Проверка запроса до выполнения |
| 5 | `get_object_by_ref` | Получение объекта по типу и UUID |
| 6 | `find_object_by_id` | Поиск объекта по UUID без знания типа |
| 7 | `search_objects` | Поиск по строке/коду/ИНН/артикулу |
| 8 | `get_link_of_object` | Навигационная ссылка на объект |
| 9 | `find_references_to_object` | Поиск ссылок на объект |
| 10 | `get_enum_values` | Значения перечисления |
| 11 | `get_register_records` | Записи / срезы / остатки / обороты |
| 12 | `get_document_movements` | Движения документа по регистрам |
| 13 | `list_reports` | Список отчётов |
| 14 | `get_report_info` | Параметры и структура отчёта |
| 15 | `run_1c_report` | Выполнение отчёта |
| 16 | `get_object_history` | История объекта / журнал регистрации |
| 17 | `get_current_user_context` | Контекст пользователя и базы |

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
        ├── MCP_Registers.bsl                -- работа с регистрами
        ├── MCP_Reports.bsl                  -- работа с отчётами (СКД)
        ├── MCP_History.bsl                  -- история объектов
        ├── MCP_Tools.bsl                    -- описания и dispatcher tools
        └── MCP_Tools_Impl.bsl               -- реализация всех 17 tools
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

## Быстрый старт

1. Установите расширение конфигурации (см. `INSTALL.md`).
2. Опубликуйте HTTP-сервис на веб-сервере (IIS/Apache).
3. Настройте `config/allowlist.json` под свою конфигурацию.
4. Создайте сервисного пользователя 1С с минимальными правами.
5. Подключите MCP-клиента к `http(s)://.../hs/mcp/rpc`.

См. подробности в `INSTALL.md`.

## Полный доступ для тестирования

Для локального стенда или демо-базы удобно открыть чтение всех стандартных объектов метаданных. Постоянные данные при этом всё равно остаются read-only: сервер не выполняет запись, проведение, удаление или изменение прикладных объектов; временные таблицы разрешены только как рабочая область запроса.

Важно: `config/server_config.json` настраивает лимиты, транспорт и политику валидации запросов. Доступ к объектам метаданных задаётся allowlist-конфигом, который сервер читает из константы 1С `MCP_Allowlist` или из примера `config/allowlist.json`.

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
2. В `config/server_config.json` для тестов оставьте `read_only: true`, `allow_temporary_tables: true`, разумные лимиты строк и таймаутов.
3. Используйте отдельного сервисного пользователя и тестовую базу. Для продуктивной базы верните явные `denied_objects`, `hidden_fields` и точечный `allowed_metadata`.

## Версия

- MCP-протокол: `2025-11-25`
- Сервер: `0.1.0`
- Платформа 1С: `8.3.18+` (используется ЗаписьJSON, HTTP-сервисы, ОписаниеТипов).
