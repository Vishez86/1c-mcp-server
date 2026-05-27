# Установка Universal 1C MCP Server

## Требования

- 1С:Предприятие 8.3.18 и выше.
- Опубликованная база на веб-сервере (IIS или Apache).
- Возможность создания HTTP-сервиса и общих модулей в конфигурации или расширении.
- Для Claude web/custom connector сервер должен быть доступен из публичного интернета по HTTPS.

## Шаги установки

### 1. Создайте расширение конфигурации

В режиме `Конфигуратор`:

1. Откройте основную конфигурацию.
2. `Конфигурация → Расширения → Добавить` → имя `MCP`, префикс `MCP_`.
3. Откройте конфигурацию расширения.

### 2. Загрузите общие модули

Создайте в расширении следующие общие модули и скопируйте в них содержимое из `src/CommonModules/`:

| Имя модуля | Файл | Свойства |
|---|---|---|
| `MCP_Config` | `MCP_Config.bsl` | Сервер |
| `MCP_Errors` | `MCP_Errors.bsl` | Сервер |
| `MCP_Audit` | `MCP_Audit.bsl` | Сервер |
| `MCP_Values` | `MCP_Values.bsl` | Сервер |
| `MCP_Security` | `MCP_Security.bsl` | Сервер |
| `MCP_Metadata` | `MCP_Metadata.bsl` | Сервер |
| `MCP_Query` | `MCP_Query.bsl` | Сервер |
| `MCP_Knowledge` | `MCP_Knowledge.bsl` | Сервер |
| `MCP_Registers` | `MCP_Registers.bsl` | Сервер |
| `MCP_Reports` | `MCP_Reports.bsl` | Сервер |
| `MCP_History` | `MCP_History.bsl` | Сервер |
| `MCP_JSONRPC` | `MCP_JSONRPC.bsl` | Сервер |
| `MCP_Tools` | `MCP_Tools.bsl` | Сервер |
| `MCP_Tools_Impl` | `MCP_Tools_Impl.bsl` | Сервер |

Для всех общих модулей расширения оставьте `Глобальный = Ложь` и `Привилегированный = Ложь`. Код обращается к экспортным методам явно через имя модуля, например `MCP_JSONRPC.ОбработатьЗапрос(...)`, поэтому глобальный контекст не нужен.

`MCP_Knowledge` содержит встроенную базу знаний из `doc/skills` для LLM: синтаксис языка запросов, функции, временные таблицы, составные типы, субконто и правила оптимизации. Модуль не читает markdown-файлы с диска во время работы 1С; справка поставляется вместе с расширением и доступна через `get_1c_query_guidance` и resources `1c://knowledge/query/*`.

### 3. Создайте HTTP-сервис

`HTTP-сервисы → Добавить`:

- Имя: `MCP`
- Корневой URL: `mcp`
- Шаблоны URL:
  - `rpc` → `/rpc`
- Методы шаблона `rpc`:
  - `POST_rpc` (HTTP-метод: POST)
  - `GET_rpc` (HTTP-метод: GET, возвращает 405 если SSE-канал не используется)
  - `DELETE_rpc` (HTTP-метод: DELETE, возвращает 405 для stateless endpoint)
  - `OPTIONS_rpc` (HTTP-метод: OPTIONS, для CORS preflight, опционально)

В модуль HTTP-сервиса скопируйте содержимое `src/HTTPServices/MCP_HTTPService.bsl`.

### 4. Опубликуйте сервис

`Администрирование → Публикация на веб-сервере`. Убедитесь, что включена публикация HTTP-сервисов.

После публикации сервис доступен по адресу:

```
http(s)://<сервер>/<база>/hs/mcp/rpc
```

### 5. Создайте сервисного пользователя

`Администрирование → Пользователи` (или раздел в типовой конфигурации):

- Создайте пользователя, например `mcp_service`.
- Назначьте ролей минимально необходимый набор, обеспечивающий **только чтение** нужных объектов.
- Включите аутентификацию по паролю или OS.
- Включите `mcp_service` в группу доступа с разрешением запуска HTTP-сервисов.

Если используется промежуточный Python-сервер с OAuth/per-session креденшилами, этот пункт выполняется для каждой учетной записи 1С, которой разрешён MCP-доступ. HTTP-сервис 1С должен исполняться именно под пользователем, переданным proxy; сервер MCP не кэширует права между запросами и возвращает `auth_context.cache_policy.cacheable=false` в каждом tool-result.

При нехватке прав 1С tool возвращает `isError=true`, `error.code=access_denied` и блок `authorization` с `retry_policy=do_not_retry_same_request_without_reauth_or_permission_change`. Пользовательскому агенту надо объяснить отказ и не повторять тот же запрос без перелогина или изменения прав.

### 6. Настройте allowlist

Содержимое `config/allowlist.json` нужно перенести в константу `MCP_Allowlist` с типом `СтрокаНеограниченнойДлины`.

В модуле `MCP_Config` функция `Allowlist()` читает константу `MCP_Allowlist`. При необходимости адаптируйте её под хранение allowlist в регистре сведений.

### 7. Настройте серверный конфиг

`config/server_config.json` — это шаблон runtime-настроек для константы 1С `MCP_ServerConfig`. Сервер **не читает файл с диска** во время работы: содержимое JSON нужно перенести в базу.

Создайте константу:

- Имя: `MCP_ServerConfig`
- Тип: `СтрокаНеограниченнойДлины`
- Значение: содержимое `config/server_config.json`

Минимальный рабочий пример:

```json
{
  "http": {
    "allowed_origins": []
  },
  "web_client": {
    "base_url": "https://laba-1c.astondevs.ru/BUH_KORP"
  },
  "privacy": {
    "masked_fields": [],
    "organization_aliases": {
      "enabled": false,
      "prefix": "Орг-",
      "include_navigation_url": true
    },
    "person_aliases": {
      "enabled": false,
      "physical_person_prefix": "ФЛ-",
      "employee_prefix": "Сотр-",
      "include_navigation_url": true
    }
  },
  "limits": {
    "max_limit": 1000,
    "max_query_rows": 1000,
    "max_report_rows": 5000,
    "max_tabular_section_rows": 100,
    "max_register_rows": 1000,
    "query_timeout_seconds": 15,
    "report_timeout_seconds": 60,
    "max_result_json_bytes": 5242880,
    "max_searched_types_per_call": 100,
    "max_string_length_in_response": 10000
  }
}
```

Роль файла:

- `http.allowed_origins` управляет CORS-проверкой HTTP-сервиса.
- `web_client.base_url` задаёт корневой URL web-клиента для кликабельных ссылок на объекты.
- `privacy.masked_fields` задаёт список полей, значения которых нельзя передавать в LLM.
- `limits.*` задаёт серверные верхние границы для tools, запросов, отчётов, регистров, размера ответа и длины строк.
- Если константа отсутствует или поле не задано, используются значения по умолчанию из `MCP_Config`.
- Неизвестные поля в `limits` игнорируются.

Поля `http`:

| Поле | Значение |
|---|---|
| `allowed_origins: []` | Не ограничивать Origin. Удобно для server-to-server MCP-клиентов и тестов. |
| `allowed_origins: ["https://example.com"]` | Разрешить только указанные browser origins. Используйте точные scheme + host + port. |
| `allowed_origins: ["*"]` | Разрешить любой Origin явно. Для production лучше указывать конкретные origins. |

Поле `web_client.base_url` задаёт корневой URL web-клиента 1С. Если оно заполнено, ссылки `ObjectRef.navigation_url` возвращаются как кликабельные HTTP(S)-ссылки вида `https://.../e1cib/data/<Тип>?ref=<uuid>`, а исходная `e1cib/data/...` сохраняется в `e1cib_navigation_url`. Если `restrict_data_access: true`, добавьте этот URL в `allowed_base_urls` allowlist.

Поля `privacy`:

| Поле | Где применяется |
|---|---|
| `masked_fields: []` | Маскирование отключено, ответы формируются как раньше. |
| `masked_fields: ["ФИО", "ДатаРождения", "НомерПаспорта"]` | Во всех JSON-ответах tools указанные поля маскируются перед передачей клиенту. Обычные значения заменяются на `XXXXXXX`, даты — на фиксированное значение `1900-01-01T00:00:00` (`01.01.1900`). |
| `organization_aliases.enabled: true` | Вместо полных названий `Справочник.Организации` LLM получает стабильные псевдонимы вида `Орг-453276`. UUID, тип ссылки и `navigation_url` сохраняются; при настроенном `web_client.base_url` это кликабельная web-ссылка. |
| `organization_aliases.prefix: "Орг-"` | Префикс псевдонима. Если поле пустое, используется `Орг-`. |
| `organization_aliases.include_navigation_url: true` | Документирует ожидаемый режим расшифровки через ссылку 1С; сервер сохраняет уже сформированные `navigation_url`, когда они доступны в ответе. |
| `person_aliases.enabled: true` | Вместо ФИО ссылок `Справочник.ФизическиеЛица` и `Справочник.Сотрудники*` LLM получает стабильные псевдонимы вида `ФЛ-453276` и `Сотр-453276`. UUID, тип ссылки и `navigation_url` сохраняются; при настроенном `web_client.base_url` это кликабельная web-ссылка. |
| `person_aliases.physical_person_prefix: "ФЛ-"` | Префикс псевдонима физического лица. |
| `person_aliases.employee_prefix: "Сотр-"` | Префикс псевдонима сотрудника. |

Сравнение имён полей регистронезависимое и не учитывает пробелы, дефисы, подчёркивания и суффиксы дубликатов колонок вида `#2`. Поэтому `Дата рождения`, `ДатаРождения` и `дата_рождения` считаются одним полем. Маскирование применяется рекурсивно к `structuredContent` и текстовому JSON-блоку MCP-ответа; оно не зависит от структуры конкретной базы.

Режим `organization_aliases` выключен по умолчанию. При включении сервер постобрабатывает все tool-ответы, ресурсы и диагностические JSON-данные: ссылочные значения организаций получают `presentation: "Орг-..."`, поля названий организации в том же объекте заменяются тем же кодом, а строковые поля, явно похожие на организацию без UUID/ссылки, заменяются на `Орг-скрыто`.

Режим `person_aliases` также выключен по умолчанию. При включении сервер заменяет `presentation` и поля ФИО у физических лиц и сотрудников псевдонимом, а паспортные данные, индивидуальный номер, страховой номер и дату рождения маскирует как чувствительные поля. Если строковое поле явно похоже на физлицо/сотрудника, но рядом нет UUID/ссылки, возвращается `ФЛ-скрыто`.

Если список не пустой, сервер также передаёт LLM явную служебную информацию:

- `privacy` в каждом успешном или ошибочном tool-result;
- `privacy` в `get_current_user_context` даже при отключённом маскировании;
- `server_hints` в `tools/list`;
- короткое предупреждение в описаниях tools.

Эта подсказка нужна, чтобы агент не тратил токены на попытки получить исходные значения полей, которые сервер намеренно заменяет маской.

Форма блока: `{ "enabled": true, "masked_fields": [...], "string_mask": "XXXXXXX", "date_mask": "1900-01-01T00:00:00", "organization_aliases": {"enabled": true, "prefix": "Орг-", "resolution": "open_navigation_url_in_1c"}, "person_aliases": {"enabled": true, "physical_person_prefix": "ФЛ-", "employee_prefix": "Сотр-", "resolution": "open_navigation_url_in_1c"}, "guidance": "..." }`.

Поля `limits`:

| Поле | Где применяется |
|---|---|
| `max_limit` | Верхняя граница обычных списков discovery/search. |
| `max_query_rows` | Максимум строк для `run_1c_query`; также ограничивает явный `ПЕРВЫЕ/TOP`. |
| `max_report_rows` | Максимум строк результата `run_1c_report`. |
| `max_tabular_section_rows` | Максимум строк табличных частей в `get_object_by_ref`. |
| `max_register_rows` | Максимум строк регистров и движений документов. |
| `query_timeout_seconds` | Бюджет выполнения пользовательских запросов 1С. |
| `report_timeout_seconds` | Бюджет выполнения отчётов. |
| `max_result_json_bytes` | Максимальный размер JSON-ответа tool. |
| `max_searched_types_per_call` | Ограничение перебора типов при UUID/reference search. |
| `max_string_length_in_response` | Усечение длинных строк в JSON-ответах. |

Что не настраивается через `MCP_ServerConfig`:

- Имя сервера, версия, версия MCP-протокола и `read_only` режим задаются кодом.
- Правила безопасности запросов, включая запрет изменения постоянных данных и разрешение временных таблиц, задаются кодом.
- Аудит всегда пишет события `MCP.*` best-effort; его настройки не вынесены в JSON.
- Возможности истории определяются динамически по конфигурации и правам пользователя.

После изменения константы повторите MCP-вызов. Перепубликовывать HTTP-сервис не нужно, если менялся только JSON в `MCP_ServerConfig`.

### 8. Проверьте установку

Из любого HTTP-клиента (Postman, curl) выполните:

```bash
curl -X POST https://<server>/<base>/hs/mcp/rpc \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -u "mcp_service:<password>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

Ожидаемый ответ:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "universal-1c-mcp", "version": "0.1.0" }
  }
}
```

Затем список tools:

```bash
curl -X POST https://<server>/<base>/hs/mcp/rpc \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -u "mcp_service:<password>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Проверка Streamable HTTP GET без SSE:

```bash
curl -i -X GET https://<server>/<base>/hs/mcp/rpc \
  -H "Accept: text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25"
```

Ожидаемый статус: `405 Method Not Allowed`.

### 9. Подключите MCP-клиента

Claude web/custom connector:

1. Откройте `Customize → Connectors`.
2. Добавьте custom connector типа Web.
3. Укажите URL:

```text
https://<server>/<base>/hs/mcp/rpc
```

Codex:

```bash
codex mcp add 1c --url https://<server>/<base>/hs/mcp/rpc
```

Или через `config.toml`:

```toml
[mcp_servers."1c"]
url = "https://<server>/<base>/hs/mcp/rpc"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

## Безопасность

- Включите HTTPS на веб-сервере. Без HTTPS Basic-аутентификация небезопасна.
- Ограничьте доступ по IP при необходимости.
- Регулярно ревизуйте `allowlist.json`.
- Просматривайте журнал регистрации по событиям `MCP.*`.

## Обновление

При обновлении модулей достаточно загрузить новые версии `.bsl` файлов в расширение и обновить конфигурацию базы.
