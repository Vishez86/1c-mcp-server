# ТЗ: оператор `count_event_subscriptions_by_event` для 1c-meta MCP

**Статус:** Draft  
**Дата:** 2026-06-15  
**Приоритет:** Medium  
**Компонент:** `1c-meta` / `search_metadata` / template mode; адаптация в `1c-korp` MCP как отдельные tools  
**Связанный сценарий:** аудит подписок на события в конфигурации 1С  

> Важно: исходное ТЗ описывает template-оператор для `1c-meta`. В текущем репозитории `1c-mcp-server` нет `search_metadata` template mode, поэтому функциональность реализуется как два отдельных read-only MCP tools: `count_event_subscriptions_by_event` и `list_event_subscriptions`.

---

## 1. Цель

Добавить разведочный оператор `count_event_subscriptions_by_event`, который возвращает агрегированную статистику по подпискам на события: сколько подписок приходится на каждое событие, а опционально - какие модули-обработчики чаще всего встречаются внутри каждого события.

Оператор нужен для паттерна **statistics before data**: агент сначала получает компактную карту распределения, затем точечно запрашивает детали через `list_event_subscriptions`.

---

## 2. Проблема

Сейчас для аудитных вопросов агент вынужден выгружать полный список подписок:

```json
{ "op": "list_event_subscriptions", "limit": 500 }
```

На конфигурации БП КОРП это возвращает около 254 записей и может занимать порядка 30 000 токенов входящего контекста. При этом в конкретной задаче обычно нужны только 5-15 записей.

Текущее поведение:

```text
list_event_subscriptions(limit=500)
  -> 254 записи
  -> большой контекст
  -> агент фильтрует вручную
```

Целевое поведение:

```text
count_event_subscriptions_by_event()
  -> 8-10 строк статистики

list_event_subscriptions(event="Проведение")
  -> только релевантные подписки

list_event_subscriptions(event="ПередЗаписью", handler_contains="ДатыЗапретаИзменения")
  -> точечная выборка по событию и модулю
```

Ожидаемый эффект: сокращение контекста в аудитных запросах примерно в 10-15 раз.

---

## 3. Scope

Входит в скоуп:

- новый template-оператор `count_event_subscriptions_by_event` для `1c-meta` или одноименный MCP tool в `1c-korp`;
- опциональная агрегация top handlers по событию;
- фильтр `event` для `list_event_subscriptions`;
- фильтр `handler_contains` для `list_event_subscriptions`;
- документация в description `search_metadata`;
- контрактные и регрессионные проверки.

Не входит в скоуп:

- изменение формата существующего ответа `list_event_subscriptions`;
- фильтрация по объектам-источникам подписки;
- агрегации по ролям, HTTP-сервисам, регламентным заданиям и другим сущностям;
- миграция этого API в универсальный `1c-korp` MCP с отдельными tools.

---

## 4. API: новый оператор

### 4.1 Идентификатор

```json
{
  "op": "count_event_subscriptions_by_event"
}
```

В адаптации `1c-korp` MCP это отдельный tool `count_event_subscriptions_by_event`, а результат возвращается в стандартном MCP envelope в поле `events`.

### 4.2 Входные параметры

| Параметр | Тип | Обязательный | По умолчанию | Ограничения | Описание |
|---|---|---:|---|---|---|
| `op` | string | да | - | `count_event_subscriptions_by_event` | Имя оператора |
| `include_top_handlers` | boolean | нет | `false` | - | Добавить топ модулей-обработчиков для каждого события |
| `top_handlers_limit` | integer | нет | `5` | `1..20` | Максимальное число модулей в `top_handlers` на событие |

Если `include_top_handlers=false`, параметр `top_handlers_limit` игнорируется.

### 4.3 Минимальный ответ

```json
[
  { "event": "ПередЗаписью", "count": 98 },
  { "event": "ПриЗаписи", "count": 67 },
  { "event": "ПередУдалением", "count": 31 },
  { "event": "ОбработкаПолученияФормы", "count": 18 },
  { "event": "Заполнение", "count": 12 }
]
```

Правила:

- верхний уровень сортируется по `count DESC`, затем по `event ASC`;
- `event` всегда строка, пустые/null события не должны попадать в ответ без явного решения владельца данных;
- `count` всегда целое число больше нуля.

### 4.4 Расширенный ответ

```json
[
  {
    "event": "ПередЗаписью",
    "count": 98,
    "top_handlers": [
      { "module": "ОбменДаннымиСобытияБП", "count": 12 },
      { "module": "УправлениеДоступомСлужебный", "count": 8 },
      { "module": "РаботаСФайлами", "count": 6 }
    ]
  },
  {
    "event": "Проведение",
    "count": 5,
    "top_handlers": [
      { "module": "ПроведениеСервер", "count": 2 },
      { "module": "УчетЗарплаты", "count": 1 }
    ]
  }
]
```

Правила:

- `top_handlers` присутствует только при `include_top_handlers=true`;
- `top_handlers` сортируется по `count DESC`, затем по `module ASC`;
- длина `top_handlers` не превышает `top_handlers_limit`;
- сумма `top_handlers[].count` может быть меньше `count`, если обработчиков больше, чем лимит.

### 4.5 Пример вызова

```json
::template {
  "op": "count_event_subscriptions_by_event",
  "include_top_handlers": true,
  "top_handlers_limit": 5
}
```

---

## 5. Изменения `list_event_subscriptions`

Для полного сценария к оператору/tool `list_event_subscriptions` нужно добавить точечные фильтры.

### 5.1 Новый параметр `event`

```json
{
  "op": "list_event_subscriptions",
  "event": "Проведение",
  "limit": 50
}
```

| Параметр | Тип | Обязательный | Описание |
|---|---|---:|---|
| `event` | string | нет | Точное имя события. Exact match, case-sensitive |
| `handler_contains` | string | нет | Подстрока в имени обработчика. Case-insensitive |

Если `event` не указан, поведение `list_event_subscriptions` должно остаться прежним.

### 5.2 Комбинированный фильтр

```json
{
  "op": "list_event_subscriptions",
  "event": "ПередЗаписью",
  "handler_contains": "ДатыЗапретаИзменения",
  "limit": 20
}
```

Ожидание: возвращаются только подписки события `ПередЗаписью`, у которых обработчик содержит указанную подстроку без учета регистра.

---

## 6. Реализация

### 6.1 Минимальный режим

Пример Cypher-запроса:

```cypher
MATCH (s:EventSubscription)
WHERE s.event IS NOT NULL AND s.event <> ""
RETURN s.event AS event, count(s) AS count
ORDER BY count DESC, event ASC
```

### 6.2 Расширенный режим

```cypher
MATCH (s:EventSubscription)
WHERE s.event IS NOT NULL AND s.event <> ""
WITH s.event AS event, count(s) AS total_count

CALL {
  WITH event
  MATCH (s:EventSubscription)
  WHERE s.event = event
  WITH
    CASE
      WHEN s.handler_module IS NOT NULL AND s.handler_module <> ""
      THEN s.handler_module
      ELSE split(s.handler, ".")[0]
    END AS module,
    count(*) AS handler_count
  WHERE module IS NOT NULL AND module <> ""
  ORDER BY handler_count DESC, module ASC
  LIMIT $top_handlers_limit
  RETURN collect({ module: module, count: handler_count }) AS top_handlers
}

RETURN event, total_count AS count, top_handlers
ORDER BY total_count DESC, event ASC
```

Если в индексе `EventSubscription` модуль обработчика уже хранится отдельным полем, нужно использовать его. Если отдельного поля нет, модуль извлекается из `handler` как часть до первой точки:

```cypher
split(s.handler, ".")[0]
```

---

## 7. Документация в `search_metadata`

В description раздела Event subscription ops добавить:

```text
- count_event_subscriptions_by_event:
  { "op": "count_event_subscriptions_by_event",
    "include_top_handlers": false,
    "top_handlers_limit": 5 }
  -> Returns: [{ "event": "<ИмяСобытия>", "count": N,
                 "top_handlers": [{ "module": "<Модуль>", "count": N }, ...] }, ...]
  Notes:
  - top_handlers is only present when include_top_handlers=true
  - Use this BEFORE list_event_subscriptions to plan targeted queries
  - Use list_event_subscriptions(event=..., handler_contains=...) for details
```

---

## 8. Критерии приемки

| # | Критерий | Проверка |
|---:|---|---|
| 1 | Оператор без параметров возвращает список событий и счетчики | `count_event_subscriptions_by_event` |
| 2 | Ответ отсортирован по `count DESC`, затем `event ASC` | Проверить порядок массива |
| 3 | Сумма всех `count` равна числу подписок из полного `list_event_subscriptions` | Сравнить с `list_event_subscriptions(limit=9999).length` |
| 4 | `include_top_handlers=true` добавляет `top_handlers` для каждого события | Проверить наличие массива |
| 5 | `top_handlers_limit=2` ограничивает длину каждого `top_handlers` | Проверить длину массивов |
| 6 | `list_event_subscriptions(event="Проведение")` возвращает только это событие | Проверить поле `event` у всех строк |
| 7 | `handler_contains` фильтрует без учета регистра | Передать значение в другом регистре |
| 8 | Без `event` и `handler_contains` поведение `list_event_subscriptions` не изменилось | Регрессионный тест |
| 9 | Невалидный `top_handlers_limit` возвращает диагностичную ошибку в стиле текущего MCP | `top_handlers_limit=0`, `top_handlers_limit=100` |

---

## 9. Контрактные тесты

Добавить проверки в контрактный набор `1c-meta`:

1. `count_event_subscriptions_by_event` без параметров:
   - `ok=true`;
   - ответ является массивом;
   - каждая строка содержит `event:string`, `count:number`;
   - счетчики положительные.

2. `count_event_subscriptions_by_event` с `include_top_handlers=true`:
   - каждая строка содержит `top_handlers`;
   - `top_handlers.length <= top_handlers_limit`;
   - каждая строка `top_handlers` содержит `module:string`, `count:number`.

3. `list_event_subscriptions` с `event`:
   - все строки имеют ровно заданное событие;
   - лимит и пагинация работают как раньше.

4. `list_event_subscriptions` с `event` и `handler_contains`:
   - все строки соответствуют обоим фильтрам;
   - поиск по `handler_contains` не зависит от регистра.

5. Регрессия:
   - вызов `list_event_subscriptions` без новых параметров возвращает тот же shape ответа, что и до изменения.

---

## 10. Риски и вопросы

- Нужно подтвердить фактическую схему узла `EventSubscription`: точные имена полей `event`, `handler`, `handler_module`.
- Нужно решить, показывать ли подписки с пустым `event`; текущая рекомендация - исключать их из статистики.
- Если `handler` может быть пустым или нестандартным, top handlers должен пропускать такие строки или возвращать `module="<unknown>"`; решение должен принять владелец индекса.
- После деплоя нового индекса/оператора нужна проверка на реальной БП КОРП, так как ожидаемые числа зависят от версии конфигурации и полноты индексации.

---

## 11. Definition of Done

Готово, когда:

- оператор `count_event_subscriptions_by_event` доступен в `search_metadata` template mode или как отдельный MCP tool в `1c-korp`;
- `list_event_subscriptions` поддерживает `event` и `handler_contains`;
- description `search_metadata` содержит новый оператор и рекомендуемый порядок вызовов;
- контрактные тесты покрывают минимальный и расширенный режимы;
- на БП КОРП подтверждено, что агент может сначала получить статистику, затем сузить запрос до нужного события/обработчика без выгрузки полного списка подписок.
