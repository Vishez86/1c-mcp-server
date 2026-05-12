# Universal 1C MCP Server (Read-Only)

Универсальный MCP-сервер для безопасного read-only доступа к данным и метаданным 1С:Предприятия 8.

Сервер реализует протокол **Model Context Protocol (MCP) 2025-11-25** поверх HTTP-сервиса 1С и предоставляет LLM-агентам 17 read-only инструментов согласно спецификации `mcp_1c_tools_spec.md`.

## Возможности

- Полностью read-only: создание/изменение/удаление объектов невозможно.
- 17 tools: discovery → inspect → search → retrieve → explain → navigate → report.
- Allowlist/denylist типов метаданных и полей.
- Лимиты строк, времени и размера результата.
- Аудит всех вызовов с correlation_id.
- Универсальный — не зависит от конкретной конфигурации (УТ, ERP, БП и т.п.).
- Поддержка JSON-RPC 2.0 поверх HTTP.

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

HTTP-сервис `MCP` принимает POST-запросы по адресу:

```
http(s)://<сервер>/<база>/hs/mcp/rpc
```

Поддерживаемые JSON-RPC методы:

```
initialize           -- инициализация сессии
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

## Версия

- MCP-протокол: `2025-11-25`
- Сервер: `0.1.0`
- Платформа 1С: `8.3.18+` (используется ЗаписьJSON, HTTP-сервисы, ОписаниеТипов).
