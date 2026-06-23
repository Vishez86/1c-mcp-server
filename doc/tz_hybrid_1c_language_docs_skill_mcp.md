# ТЗ: гибридный skill + MCP для документации по языку 1С

**Статус:** Draft
**Дата:** 2026-06-22
**Приоритет:** Medium
**Компонент:** `skills/1c-query-language` + встроенный read-only индекс секций в 1С MCP
**Целевая версия документации:** `1С:Предприятие 8.3.37`

---

## 1. Цель

Сделать гибридный механизм передачи LLM документации по языку 1С:

- `skill` остается коротким маршрутизатором и набором правил поведения;
- существующий 1С MCP отдает релевантные фрагменты документации по запросу;
- документация включается в поставку как сгенерированный read-only индекс секций, а не как markdown целиком в tool description;
- provenance фиксирует версию платформы, источники и границы применимости.

Целевой результат: агент умеет отвечать на вопросы и писать запросы 1С с опорой на документацию `8.3.37`, не загружая в контекст весь справочник целиком.

---

## 2. Проблема

Сейчас справочник `skills/1c-query-language` хранится как markdown skill:

```text
skills/1c-query-language/
  SKILL.md
  references/*.md
```

Это удобно для локального использования, но при сложных задачах агент может читать большие файлы целиком. Например, `query-syntax.md` содержит десятки тысяч символов, хотя для конкретного вопроса обычно нужны 1-3 секции.

Текущее поведение:

```text
Пользователь спрашивает про СрезПоследних
  -> skill активируется
  -> агент читает один или несколько больших reference-файлов
  -> в контекст попадает много нерелевантного текста
```

Целевое поведение:

```text
Пользователь спрашивает про СрезПоследних
  -> skill активируется
  -> skill предписывает искать через tools существующего 1С MCP
  -> search_1c_language_docs возвращает 3-5 релевантных секций
  -> read_1c_language_doc_section догружает только нужную секцию
```

Ожидаемый эффект: меньше расход токенов на точечных вопросах, один деплой 1С MCP без отдельного documentation-сервера и лучшее масштабирование при добавлении BSL, СКД, управляемых форм, БСП и новых версий платформы.

---

## 3. Границы решения

Входит в скоуп:

- read-only tools документации внутри существующего 1С MCP;
- build-time генерация BSL-индекса секций из markdown-файлов `skills/1c-query-language/references`;
- включение сгенерированного индекса в поставку расширения 1С;
- tools для поиска, чтения секций, списка тем и provenance;
- MCP resources для прямого `@`-доступа к index/reference/section;
- обновление `SKILL.md`, чтобы он направлял агента к MCP при доступности сервера;
- контрактные проверки формата MCP-ответов;
- оценка расхода токенов и ограничение размера выдачи.

Не входит в скоуп:

- изменение живых 1С data-tools (`run_1c_query`, `get_metadata_structure` и т.п.);
- выполнение запросов 1С;
- хранение markdown целиком в tool descriptions;
- отдельный Node/Python/stdio MCP как обязательная часть production-деплоя;
- runtime-чтение произвольных файлов с диска из 1С;
- автоматическое скачивание закрытой ИТС-документации;
- поддержка версий платформы кроме `8.3.37`, кроме архитектурной готовности к версиям.

---

## 4. Архитектура

### 4.1 Роль skill

`skills/1c-query-language/SKILL.md` должен оставаться коротким и выполнять роль маршрутизатора:

- когда использовать справочник;
- версия по умолчанию: `8.3.37`;
- критичные правила, которые должны быть в контексте сразу;
- порядок действий: сначала проверить metadata через 1С tools, затем писать запрос;
- если доступны tools документации в 1С MCP, искать подробности через них;
- если MCP недоступен, читать локальные reference-файлы напрямую.

Skill не должен содержать весь справочник целиком.

### 4.2 Роль 1С MCP

Документационные tools должны жить в существующем 1С MCP endpoint вместе с остальными read-only tools. Для клиента это один MCP-сервер, но внутри него появляется отдельный read-only corpus по языку 1С.

Принципиальное требование: **не помещать полный markdown или полный справочник в tool description**. Tool descriptions остаются короткими. Полный текст хранится в сгенерированном индексе секций и возвращается только через search/read tools с лимитами.

Рекомендуемый BSL-компонент:

```text
src/CommonModules/MCP_Knowledge.bsl                  # существующие краткие guidance
src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl      # сгенерированный read-only индекс секций
src/CommonModules/MCP_Tools.bsl                      # registry/schema/dispatch новых tools
src/CommonModules/MCP_Tools_Impl.bsl                 # вызов search/read/list/provenance
scripts/generate_1c_language_docs_bsl.mjs            # build-time генератор из markdown
```

Источник генерации:

```text
skills/1c-query-language/SKILL.md
skills/1c-query-language/references/version-provenance.md
skills/1c-query-language/references/query-syntax.md
skills/1c-query-language/references/functions-and-expressions.md
skills/1c-query-language/references/virtual-tables.md
skills/1c-query-language/references/accumulation-register.md
skills/1c-query-language/references/info-register.md
skills/1c-query-language/references/chart-of-accounts.md
skills/1c-query-language/references/bsl-query-api.md
```

Сгенерированный BSL-модуль должен содержать только области, процедуры и функции. В `src/CommonModules/*.bsl` запрещены top-level `Перем` и любой исполняемый код в шапке модуля.

### 4.3 Разделение ответственности

| Компонент | Отвечает за | Не отвечает за |
|---|---|---|
| Skill | триггеры, правила поведения, критичные ограничения, fallback | поиск по полной базе и ранжирование |
| 1C MCP documentation tools | поиск, чтение секций, provenance, версионирование | live metadata конкретной базы |
| 1C MCP data-tools | фактические метаданные и данные базы | общую документацию языка |

---

## 5. API MCP tools

### 5.1 `list_1c_language_doc_topics`

Возвращает карту доступных тем.

Вход:

```json
{
  "version": "8.3.37",
  "domain": "query-language"
}
```

Параметры:

| Параметр | Тип | Обязательный | По умолчанию | Описание |
|---|---|---:|---|---|
| `version` | string | нет | `8.3.37` | Версия платформы |
| `domain` | string | нет | `query-language` | Домен документации |

Ответ:

```json
{
  "ok": true,
  "version": "8.3.37",
  "domain": "query-language",
  "topics": [
    {
      "id": "query-syntax",
      "title": "Синтаксис языка запросов 1С",
      "section_count": 42,
      "resource_uri": "1c-docs://8.3.37/query-language/query-syntax"
    }
  ]
}
```

### 5.2 `search_1c_language_docs`

Ищет релевантные секции по запросу пользователя.

Вход:

```json
{
  "query": "СрезПоследних условие в параметре и ГДЕ",
  "version": "8.3.37",
  "domain": "query-language",
  "top_k": 5,
  "max_chars_per_result": 1800
}
```

Параметры:

| Параметр | Тип | Обязательный | По умолчанию | Ограничения | Описание |
|---|---|---:|---|---|---|
| `query` | string | да | - | `1..500` символов | Поисковый запрос |
| `version` | string | нет | `8.3.37` | allowlist версий | Версия платформы |
| `domain` | string | нет | `query-language` | allowlist доменов | Домен документации |
| `top_k` | integer | нет | `5` | `1..10` | Число результатов |
| `max_chars_per_result` | integer | нет | `1800` | `500..4000` | Максимальный размер одного фрагмента |

Ответ:

```json
{
  "ok": true,
  "version": "8.3.37",
  "query": "СрезПоследних условие в параметре и ГДЕ",
  "results": [
    {
      "section_id": "info-register.md#kritichnoe-otlichie-gde-vs-parametr-uslovie",
      "title": "Критичное отличие: ГДЕ vs параметр Условие",
      "source_file": "references/info-register.md",
      "resource_uri": "1c-docs://8.3.37/query-language/info-register#kritichnoe-otlichie-gde-vs-parametr-uslovie",
      "score": 0.91,
      "excerpt": "..."
    }
  ],
  "truncated": false
}
```

Правила:

- результаты сортируются по релевантности;
- `excerpt` не должен превышать `max_chars_per_result`;
- каждый результат должен содержать `section_id`, `title`, `source_file`, `resource_uri`;
- если найдено мало уверенных результатов, вернуть пустой массив и пояснение в `notes`, а не нерелевантный текст.

### 5.3 `read_1c_language_doc_section`

Возвращает полную секцию по `section_id` или `resource_uri`.

Вход:

```json
{
  "section_id": "info-register.md#kritichnoe-otlichie-gde-vs-parametr-uslovie",
  "max_chars": 8000
}
```

Параметры:

| Параметр | Тип | Обязательный | По умолчанию | Ограничения | Описание |
|---|---|---:|---|---|---|
| `section_id` | string | нет | - | - | ID секции из search/list |
| `resource_uri` | string | нет | - | `1c-docs://...` | URI ресурса |
| `max_chars` | integer | нет | `8000` | `1000..20000` | Максимальный размер ответа |

Должен быть указан ровно один из параметров: `section_id` или `resource_uri`.

Ответ:

```json
{
  "ok": true,
  "version": "8.3.37",
  "section_id": "info-register.md#kritichnoe-otlichie-gde-vs-parametr-uslovie",
  "title": "Критичное отличие: ГДЕ vs параметр Условие",
  "source_file": "references/info-register.md",
  "content": "...",
  "truncated": false,
  "next_cursor": null
}
```

Если секция превышает `max_chars`, вернуть начало секции, `truncated=true` и `next_cursor`.

### 5.4 `get_1c_language_doc_provenance`

Возвращает версию, источники и правила разрешения конфликтов.

Вход:

```json
{
  "version": "8.3.37",
  "domain": "query-language"
}
```

Ответ:

```json
{
  "ok": true,
  "version": "8.3.37",
  "domain": "query-language",
  "source_file": "references/version-provenance.md",
  "content": "...",
  "rules": {
    "default_version": "8.3.37",
    "official_docs_priority": "highest_for_syntax",
    "live_metadata_priority": "highest_for_infobase_specific_fields"
  }
}
```

---

## 6. MCP resources

Сервер должен отдавать resources для прямого подключения через `@`-упоминания в клиентах, которые это поддерживают.

Рекомендуемые URI:

```text
1c-docs://8.3.37/query-language/index
1c-docs://8.3.37/query-language/provenance
1c-docs://8.3.37/query-language/query-syntax
1c-docs://8.3.37/query-language/functions-and-expressions
1c-docs://8.3.37/query-language/virtual-tables
1c-docs://8.3.37/query-language/accumulation-register
1c-docs://8.3.37/query-language/info-register
1c-docs://8.3.37/query-language/chart-of-accounts
1c-docs://8.3.37/query-language/bsl-query-api
```

Resources могут возвращать целый файл, но tools должны по умолчанию возвращать секции и выдержки.

---

## 7. Индексация и чанкинг

### 7.1 Единица индексации

Базовая единица индексации - markdown-секция:

- заголовок `#` или `##` создает крупную тему;
- заголовок `###` создает вложенную секцию;
- секция наследует контекст родительских заголовков;
- таблицы и примеры кода должны оставаться внутри той секции, где они описывают правило.

### 7.2 Metadata секции

Каждый chunk должен иметь:

```json
{
  "section_id": "query-syntax.md#vybrat-spisok-polei",
  "title": "ВЫБРАТЬ - список полей",
  "heading_path": ["Синтаксис языка запросов 1С", "ВЫБРАТЬ - список полей"],
  "source_file": "references/query-syntax.md",
  "version": "8.3.37",
  "domain": "query-language",
  "tags": ["select", "syntax", "fields"]
}
```

### 7.3 Поиск

Минимальный вариант:

- lexical search по заголовкам, тексту и tags;
- нормализация регистра;
- поддержка русских и английских синонимов из локального словаря.

Желательный вариант:

- hybrid search: lexical BM25 + embeddings;
- rerank по совпадению заголовков и tags;
- штраф за слишком большие/общие секции.

### 7.4 Словарь синонимов

Добавить минимальную карту:

```json
{
  "case": ["ВЫБОР", "КОГДА", "ТОГДА"],
  "join": ["СОЕДИНЕНИЕ", "ЛЕВОЕ СОЕДИНЕНИЕ", "ВНУТРЕННЕЕ СОЕДИНЕНИЕ"],
  "null": ["NULL", "ЕСТЬNULL", "ЕСТЬ NULL"],
  "slice last": ["СрезПоследних", "РегистрСведений"],
  "balance": ["Остатки", "ОстаткиИОбороты"],
  "turnover": ["Обороты", "ОборотыДтКт"],
  "temporary table": ["ПОМЕСТИТЬ", "Временные таблицы", "МенеджерВТ"]
}
```

### 7.5 Генерация BSL-индекса

Markdown-файлы не читаются в runtime из 1С. Они являются source-of-truth для build-time генератора.

Генератор `scripts/generate_1c_language_docs_bsl.mjs` должен:

- прочитать allowlist markdown-файлов из `skills/1c-query-language`;
- разбить их на секции по правилам чанкинга;
- построить stable `section_id`, `resource_uri`, `heading_path`, `tags`, `content`;
- сгенерировать BSL-модуль `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`;
- экранировать строки BSL корректно, включая кавычки, переносы строк и backticks;
- не генерировать top-level `Перем` и исполняемый код вне процедур/функций;
- добавить в модуль export-функции для списка секций, чтения секции, provenance и поиска.

Минимальный shape секции внутри сгенерированного модуля:

```json
{
  "section_id": "query-syntax.md#vybrat-spisok-polei",
  "resource_uri": "1c-docs://8.3.37/query-language/query-syntax#vybrat-spisok-polei",
  "title": "ВЫБРАТЬ - список полей",
  "source_file": "references/query-syntax.md",
  "heading_path": ["Синтаксис языка запросов 1С", "ВЫБРАТЬ - список полей"],
  "version": "8.3.37",
  "domain": "query-language",
  "tags": ["select", "syntax", "fields"],
  "content": "..."
}
```

Сгенерированный модуль может строить массив секций при каждом вызове. Кэш между вызовами не нужен, пока нет безопасного внешнего сессионного хранилища. Если позже потребуется кэш, он должен быть вынесен за пределы top-level переменных общего модуля.

---

## 8. Токены и лимиты

MCP не убирает расход токенов полностью: токены тратятся на tool descriptions, аргументы и результат tool. Выигрыш появляется за счет того, что результат ограничен релевантными секциями.

Требования:

- description каждого MCP tool держать коротким, до 1-2 абзацев;
- полный markdown/полный corpus запрещено помещать в `tools/list`, `description`, `inputSchema.description` или стартовые server instructions;
- не отдавать полный файл через search;
- `search_1c_language_docs` по умолчанию возвращает не более `5` результатов;
- один excerpt по умолчанию не больше `1800` символов;
- `read_1c_language_doc_section` по умолчанию не больше `8000` символов;
- если ответ урезан, возвращать `truncated=true` и `next_cursor`;
- skill должен рекомендовать сначала search, затем read только нужной секции.

Ориентировочный профиль:

| Сценарий | Skill-only | Hybrid skill + MCP |
|---|---:|---:|
| Точечный вопрос по одной теме | 5k-20k токенов при чтении крупных файлов | 1k-4k токенов |
| Сложный запрос с 3 темами | 15k-50k токенов | 4k-12k токенов |
| Полный аудит справочника | сопоставимо | сопоставимо или дороже из-за нескольких calls |

Итог: гибрид лучше для повседневных точечных вопросов и хуже для задач, где действительно нужно прочитать весь corpus.

---

## 9. Изменения в `SKILL.md`

После появления MCP добавить в `skills/1c-query-language/SKILL.md` раздел:

```md
## MCP retrieval

Если в текущем 1С MCP доступны tools документации, не читай большие reference-файлы целиком.

Порядок:
1. Для точечных вопросов вызови `search_1c_language_docs`.
2. Если нужен полный фрагмент, вызови `read_1c_language_doc_section`.
3. При сомнении в версии или источнике вызови `get_1c_language_doc_provenance`.
4. Для фактических полей конкретной базы используй 1С metadata/data tools, а не справочник.
```

До появления MCP текущий fallback остается: читать `references/*.md` напрямую.

---

## 10. Установка и упаковка

### 10.1 Production-поставка через 1С MCP

Production-вариант должен поставляться вместе с текущим 1С MCP-расширением:

- markdown-справочник хранится в репозитории как редактируемый source-of-truth;
- перед сборкой/поставкой запускается генератор `scripts/generate_1c_language_docs_bsl.mjs`;
- генератор обновляет `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`;
- `MCP_Tools.bsl` регистрирует новые documentation tools;
- `MCP_Tools_Impl.bsl` вызывает экспортные функции сгенерированного knowledge-модуля;
- клиент подключается к тому же 1С MCP endpoint, дополнительных MCP-серверов не требуется.

Этот вариант упрощает deployment: обновление документации распространяется вместе с обновлением расширения. Цена решения - для изменения справочника нужен новый build/deploy расширения.

### 10.2 Локальный/dev-вариант

Отдельный Node/Python/stdio MCP допускается только как dev-вариант для экспериментов с чанкингом, embeddings или быстрым preview до деплоя расширения. Он не является обязательной частью production-архитектуры.

### 10.3 Claude plugin

Если нужен удобный rollout в Claude Code, plugin должен бандлить:

- skill `1c-query-language`;
- конфигурацию подключения к существующему 1С MCP endpoint, если это уместно для команды;
- marketplace/install metadata при необходимости.

Plugin - это упаковка. Логика поиска остается в 1С MCP, а правила поведения - в skill.

---

## 11. Безопасность

- Documentation tools внутри 1С MCP работают только со сгенерированным read-only индексом секций.
- Запрещено принимать произвольный путь файла от клиента или читать markdown/runtime-файлы с диска.
- `resource_uri` должен разбираться только по известной схеме `1c-docs://`.
- Входные параметры валидируются до чтения.
- Ошибки возвращаются как tool error с диагностикой, без stack trace и абсолютных путей, если это не debug-режим.
- Documentation tools не обращаются в интернет.
- Documentation tools не выполняют пользовательский BSL и не запускают запросы 1С.
- Сгенерированный BSL-модуль не содержит top-level `Перем`.

---

## 12. Формат ошибок

Типовые ошибки:

```json
{
  "ok": false,
  "error": {
    "code": "unsupported_version",
    "message": "Версия документации не поддерживается.",
    "details": {
      "requested_version": "8.3.28",
      "supported_versions": ["8.3.37"]
    }
  }
}
```

Коды:

| Код | Когда |
|---|---|
| `unsupported_version` | запрошена неподдерживаемая версия |
| `unsupported_domain` | запрошен неизвестный домен |
| `section_not_found` | секция не найдена |
| `invalid_resource_uri` | URI не соответствует allowlist |
| `invalid_arguments` | ошибка входных параметров |
| `index_not_ready` | индекс не построен или поврежден |

---

## 13. Контрактные тесты

Добавить тесты для documentation MCP:

1. `list_1c_language_doc_topics`
   - `ok=true`;
   - есть тема `query-syntax`;
   - каждый topic содержит `id`, `title`, `section_count`, `resource_uri`.

2. `search_1c_language_docs`
   - запрос `СрезПоследних ГДЕ Условие` возвращает `info-register`;
   - запрос `АБС функция` возвращает `functions-and-expressions`;
   - запрос `ОборотыДтКт КоличествоОборот` возвращает `virtual-tables`;
   - `excerpt.length <= max_chars_per_result`.

3. `read_1c_language_doc_section`
   - секция из search читается по `section_id`;
   - при маленьком `max_chars` возвращает `truncated=true`;
   - неизвестная секция возвращает `section_not_found`.

4. `get_1c_language_doc_provenance`
   - возвращает `version=8.3.37`;
   - содержит источник `version-provenance.md`;
   - содержит правила приоритетов источников.

5. Resources
   - `1c-docs://8.3.37/query-language/index` доступен;
   - `1c-docs://8.3.37/query-language/provenance` доступен;
   - неизвестный URI отклоняется.

6. Лимиты
   - `top_k=0`, `top_k=999`, `max_chars_per_result=1` дают валидационную ошибку;
   - search не возвращает полный файл.

---

## 14. Критерии приемки

| # | Критерий | Проверка |
|---:|---|---|
| 1 | Skill продолжает работать без MCP | Отключить MCP и задать вопрос по запросам 1С |
| 2 | При доступном MCP агент использует search/read вместо чтения крупных файлов | Проверить trace/tool calls |
| 3 | Поиск возвращает релевантные секции по ключевым темам | Контрактные тесты search |
| 4 | Ответы содержат version/provenance | Проверить structuredContent |
| 5 | Нельзя прочитать произвольный файл через path traversal | Негативный тест resource_uri/section_id |
| 6 | Лимиты выдачи соблюдаются | Тесты `max_chars*`, `top_k`, `truncated` |
| 7 | Documentation tools не выполняют live-запросы 1С | Static review и тесты без обращения к `run_1c_query` |
| 8 | Документация и skill явно говорят: metadata конкретной базы проверять через 1С tools | Review `SKILL.md` |
| 9 | Сгенерированный BSL-модуль не содержит top-level `Перем` | `rg -n "^\s*Перем\b" src/CommonModules -S` |

---

## 15. Definition of Done

Готово, когда:

- создан генератор `scripts/generate_1c_language_docs_bsl.mjs`;
- сгенерирован read-only модуль `src/CommonModules/MCP_Knowledge_1CQueryDocs.bsl`;
- модуль индексирует секции из `skills/1c-query-language/references` на build-time, а не читает markdown в runtime;
- реализованы tools `list_1c_language_doc_topics`, `search_1c_language_docs`, `read_1c_language_doc_section`, `get_1c_language_doc_provenance`;
- реализованы MCP resources `1c-docs://8.3.37/query-language/...`;
- `SKILL.md` обновлен под гибридный порядок использования;
- контрактные тесты проходят локально;
- проверено, что `src/CommonModules` не получил top-level `Перем`;
- в README или install-инструкции описано, что documentation tools поставляются внутри 1С MCP, а skill без MCP может читать markdown fallback.
