Правильная архитектура: **не давать Claude/ChatGPT самостоятельно “гуглить” контрагентов**, а сделать у вас backend-сервис проверки контрагентов и отдать его наружу как MCP-инструмент. Claude/ChatGPT должны быть **интерфейсом и языковым планировщиком**, а не источником юридически значимых фактов.

## Рекомендуемая схема

```text
Claude Desktop / ChatGPT Cloud
        |
        | Remote MCP over HTTPS + OAuth
        v
MCP Gateway / Agent API
        |
        +--> 1C: топ должников, суммы, договоры, ИНН/ОГРН
        |
        +--> Counterparty Risk Service
                |
                +--> ФНС / ЕГРЮЛ
                +--> ЕФРСБ / Федресурс
                +--> платные API: Контур.Фокус, СПАРК, DaData, API-ФНС и т.п.
                +--> кэш, журнал проверок, доказательная база
```

**Где реализовать “агента”:** в отдельном backend-сервисе, а не внутри Claude/ChatGPT и не только в 1C. 1C пусть остаётся источником учетных данных. MCP-сервер пусть предоставляет Claude/ChatGPT строго типизированные инструменты.

MCP как раз предназначен для подключения LLM-приложений к внешним системам и инструментам; официальная спецификация описывает его как открытый протокол для интеграции AI-приложений с внешними источниками данных и tools. ([modelcontextprotocol.io][1]) OpenAI также прямо описывает remote MCP servers как способ подключать модели через интернет к новым источникам данных и возможностям. ([developers.openai.com][2])

## Какой вариант я бы выбрал

Я бы сделал **отдельный сервис “ПроверкаКонтрагентов”** на **TypeScript/Node.js, Python/FastAPI или Go**, а существующий 1C MCP-сервер использовал бы как один из источников данных.

Почему не только 1C:

1. В 1C можно сделать HTTP-запросы к ФНС/Федресурсу/платным API, но сложнее нормально поддерживать OAuth, retries, rate limits, очереди, observability, структурированные MCP-схемы, версионирование API и защиту публичного HTTPS endpoint.
2. Проверка контрагентов — это отдельный домен: источники, кэш, правила риска, журнал доказательств, версии алгоритма проверки.
3. Вам понадобится одинаковая логика для ChatGPT, Claude, 1C-форм, регламентных заданий и, возможно, веб-интерфейса. Поэтому лучше вынести её из конкретного LLM-клиента.

Оптимально:

```text
1C MCP Server
  - get_top_debtors
  - get_counterparty_by_inn
  - maybe create_risk_check_task

Counterparty Risk Service
  - check_counterparty_status
  - check_counterparties_status_batch
  - build_debtors_status_report

Public MCP Gateway
  - OAuth
  - scopes
  - audit
  - rate limit
  - tool schemas
```

## Какие MCP tools сделать

Не делайте слишком мелкий tool типа `search_in_internet(query)`. Это опасно и нестабильно. Делайте бизнес-инструменты.

Минимальный набор:

```json
{
  "get_top_debtors": {
    "description": "Вернуть топ должников из 1C",
    "input": {
      "limit": "number",
      "as_of_date": "date",
      "min_debt": "number"
    }
  }
}
```

```json
{
  "check_counterparty_status": {
    "description": "Проверить правовой статус контрагента по ИНН/ОГРН",
    "input": {
      "inn": "string",
      "ogrn": "string | optional"
    },
    "output": {
      "legal_status": "active | liquidation | liquidated | reorganized | bankrupt | unknown",
      "status_date": "date",
      "sources": "array",
      "confidence": "high | medium | low",
      "raw_evidence_id": "string"
    }
  }
}
```

```json
{
  "build_debtors_status_report": {
    "description": "Построить отчет по топ должникам и проверить их правовой статус",
    "input": {
      "limit": "number",
      "as_of_date": "date",
      "include_bankruptcy": "boolean"
    }
  }
}
```

Главный инструмент для пользователя должен быть именно **`build_debtors_status_report`**. Тогда Claude/ChatGPT делает один понятный вызов, а не 20 хаотичных интернет-поисков.

## Источники данных

Для российских юрлиц базовый источник — **ЕГРЮЛ/ЕГРИП ФНС**. Сервис ФНС предоставляет бесплатные электронные выписки по конкретному ЮЛ/ИП, подписанные усиленной квалифицированной электронной подписью, а сведения в сервисе актуализируются ежедневно. ([egrul.nalog.ru][3])

Для промышленной интеграции ФНС отдельно описывает режим доступа к сведениям ЕГРЮЛ/ЕГРИП в виде файлов для информационных систем: полные сведения, ежедневные изменения, XML-архивы, атрибуты доступа. Также важно, что новые форматы ЕГРЮЛ 4.08 и ЕГРИП 4.07 вступили в силу с 1 февраля 2026 года, а с 1 августа 2026 года останутся только они. ([nalog.gov.ru][4])

Для банкротства источник — **ЕФРСБ / Федресурс**, официальный портал раскрытия сведений о процедурах банкротства. ([bankrot.fedresurs.ru][5])

Практически я бы сделал так:

| Задача                                                     | Источник                                         |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Действующее / ликвидировано / в ликвидации / реорганизация | ЕГРЮЛ ФНС                                        |
| Банкротство                                                | ЕФРСБ / Федресурс                                |
| Массовые проверки, SLA, антикапча, нормализация            | платный API-провайдер                            |
| Доказательная база                                         | сохранять выписку, JSON, дату проверки, источник |
| Быстрые повторные проверки                                 | кэш в PostgreSQL/Redis                           |

## Как подключать к Claude и ChatGPT

Для Claude лучше использовать **remote connector**, если сервер должен быть доступен в Claude Web, Desktop и других клиентах. Anthropic прямо указывает, что custom connector через remote MCP подключается из облачной инфраструктуры Anthropic, а не с локального устройства, даже если пользователь работает в Claude Desktop. Поэтому ваш MCP endpoint должен быть достижим из интернета или через allowlist IP Anthropic. ([support.anthropic.com][6])

Для ChatGPT используйте **remote MCP / Apps SDK**. В Apps SDK MCP-сервер публикует tools, модель вызывает их во время разговора, а сервер возвращает структурированный результат. OpenAI рекомендует Streamable HTTP и описывает, что MCP даёт multiclient support, structured content и OAuth 2.1 auth. ([developers.openai.com][7])

## Безопасность

Ваш текущий факт “сервер HTTPS смотрит в открытый интернет” — это главный риск. Я бы не публиковал 1C MCP напрямую.

Нужен слой перед 1C:

```text
Internet
  |
WAF / API Gateway / Reverse Proxy
  |
OAuth 2.1 / OIDC / mTLS / IP allowlist / rate limit
  |
MCP Gateway
  |
Internal network
  |
1C + Risk Service
```

Для ChatGPT Apps SDK OpenAI ожидает OAuth 2.1-поток, совместимый с MCP authorization spec: MCP-сервер проверяет access token на каждом запросе, а ChatGPT действует как OAuth-клиент с PKCE. ([developers.openai.com][8]) OpenAI также указывает, что сервер должен сам проверять подпись токена, issuer, audience, expiration и scopes; эта ответственность лежит на вашем сервере, не на ChatGPT. ([developers.openai.com][8])

Минимальные меры:

1. **Не открывать 1C напрямую.** Только gateway.
2. **OAuth/OIDC по пользователям.** Пользователь Claude/ChatGPT должен маппиться на пользователя вашей системы.
3. **Scopes:** например `debtors:read`, `counterparties:check`, `reports:generate`.
4. **Read-only tools по умолчанию.** Никаких записей в 1C без отдельного подтверждения.
5. **Audit log:** кто спросил, какие контрагенты проверены, какие источники использованы, какой ответ отдан.
6. **Rate limiting и batch limits.** Например, не больше 100 контрагентов за запрос.
7. **No raw SQL / no arbitrary query.** Только заранее заданные бизнес-операции.
8. **Prompt-injection isolation:** текст с сайтов и выписок — это данные, а не инструкции для модели.

## Что должен делать агент на примере

Пользователь пишет в Claude:

> дай мне топ 10 должников и проверь их статус

Правильный execution flow:

1. Claude вызывает `build_debtors_status_report({ limit: 10, include_bankruptcy: true })`.
2. Ваш backend получает из 1C топ должников.
3. Для каждого должника нормализует ИНН/ОГРН.
4. Проверяет ЕГРЮЛ: действующее, ликвидация, ликвидировано, реорганизация.
5. Проверяет ЕФРСБ: есть ли банкротные процедуры.
6. Сохраняет evidence: дата, источник, raw response, ссылка/идентификатор выписки.
7. Возвращает Claude структурированный JSON.
8. Claude только оформляет отчет человеческим языком.

## Технологии

Мой рекомендуемый стек:

**MCP Gateway:**
TypeScript + `@modelcontextprotocol/sdk` или Python + FastMCP.

**Risk Service:**
Python/FastAPI или Go. Python удобнее для парсинга, интеграций и быстрых MVP; Go лучше, если нужен высоконагруженный надежный сервис.

**Очереди:**
RabbitMQ, Redis Queue, Celery/RQ или Temporal, если будут долгие массовые проверки.

**Хранилище:**
PostgreSQL для результатов проверок, Redis для short-term cache.

**Интеграция с 1C:**
HTTP-сервисы 1C, OData, регламентные задания, обмен через очередь или внутренний REST API.

**Документирование tools:**
JSON Schema, OpenAPI для внутренних API, MCP tool descriptions для LLM.

## MVP-план

1. Сделать один backend endpoint: `POST /counterparty/check-batch`.
2. Подключить к нему ФНС/платный API для ЕГРЮЛ.
3. Добавить таблицу `counterparty_status_checks`.
4. Сделать MCP tool `check_counterparties_status_batch`.
5. Сделать MCP tool `get_top_debtors` из 1C.
6. Затем объединить в high-level tool `build_debtors_status_report`.
7. Подключить Claude remote connector.
8. После стабилизации подключить ChatGPT Apps/remote MCP.
9. Добавить ЕФРСБ/Федресурс и risk scoring.

## Итоговая рекомендация

**Агента реализуйте как backend workflow + MCP tools.**
**1C оставьте системой учета и источником должников.**
**Claude/ChatGPT используйте как conversational UI.**
**Юридические статусы проверяйте через официальные или коммерческие API, а не через свободный web search модели.**

Самое правильное название такого компонента: **Counterparty Risk MCP Service** или **Сервис проверки контрагентов**, а не просто “агент в Claude”.

[1]: https://modelcontextprotocol.io/specification/2025-06-18 "Specification - Model Context Protocol"
[2]: https://developers.openai.com/api/docs/mcp "Building MCP servers for ChatGPT Apps and API integrations"
[3]: https://egrul.nalog.ru/about.html "Предоставление сведений из ЕГРЮЛ/ЕГРИП"
[4]: https://www.nalog.gov.ru/rn77/service/egrip2/egrip_vzayim/ "Интеграция сведений из ЕГРЮЛ и ЕГРИП в информационные системы  заинтересованных лиц (описание модели взаимодействия) |  ФНС России  | 77 город Москва"
[5]: https://bankrot.fedresurs.ru/?utm_source=chatgpt.com "ЕФРСБ - Федресурс"
[6]: https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp "Get started with custom connectors using remote MCP | Claude Help Center"
[7]: https://developers.openai.com/apps-sdk/concepts/mcp-server "MCP – Apps SDK | OpenAI Developers"
[8]: https://developers.openai.com/apps-sdk/build/auth "Authentication – Apps SDK | OpenAI Developers"
