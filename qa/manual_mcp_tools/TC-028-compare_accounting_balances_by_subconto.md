# TC-028 - compare_accounting_balances_by_subconto

Инструмент: `compare_accounting_balances_by_subconto`

Цель: проверить универсальное сравнение двух наборов бухгалтерских остатков по одной аналитике.

## Предусловия

- MCP-сервер 1С развернут и подключен к LLM-чату.
- Пользователь в чате имеет права, достаточные для сценария.
- Значения в угловых скобках нужно заменить реальными данными целевой базы.
- Реальный UUID вида субконто для сравнения получен через `get_accounting_accounts_map`.

## Диалоговый сценарий

### Шаг 1

**Сообщение пользователя:**

> На <as_of> сравни два набора остатков в <accounting_register_full_name>: слева счета <left_prefix>, сторона debit; справа счета <right_prefix>, сторона credit. Соедини по первому субконто и покажи крупные пересечения.

**Ожидаемое действие ассистента / MCP вызов:**

~~~json
{
  "tool": "compare_accounting_balances_by_subconto",
  "arguments": {
    "accounting_register": "<accounting_register_full_name>",
    "as_of": "<as_of>",
    "subconto_kinds": [
      {"kind": "ref", "type": "<subconto_kind_type>", "uuid": "<subconto_kind_uuid>"}
    ],
    "match_subconto_index": 1,
    "left_account_code_prefixes": ["<left_prefix>"],
    "left_balance_side": "debit",
    "right_account_code_prefixes": ["<right_prefix>"],
    "right_balance_side": "credit",
    "min_amount": 10000,
    "limit": 20
  }
}
~~~

**Ожидаемый ответ ассистента:**

Ассистент показывает строки пересечений или корректно сообщает, что пересечений нет. Бизнес-смысл левого и правого набора описывается только из пользовательского контекста.

### Шаг 2

**Сообщение пользователя:**

> Покажи использованный запрос и пояснение универсального маршрута.

**Ожидаемое действие ассистента / MCP вызов:**

~~~json
{
  "tool": "compare_accounting_balances_by_subconto",
  "arguments": {
    "accounting_register": "<accounting_register_full_name>",
    "as_of": "<as_of>",
    "subconto_kinds": [
      {"kind": "ref", "type": "<subconto_kind_type>", "uuid": "<subconto_kind_uuid>"}
    ],
    "match_subconto_index": 1,
    "left_account_code_prefixes": ["<left_prefix>"],
    "left_balance_side": "debit",
    "right_account_code_prefixes": ["<right_prefix>"],
    "right_balance_side": "credit",
    "include_query": true,
    "include_guidance": true,
    "limit": 20
  }
}
~~~

**Ожидаемый ответ ассистента:**

Ассистент включает краткое объяснение, что сравнение идет по UUID `СубконтоN`, а `query_used` возвращается только по явному запросу.

## Дополнительная проверка

Проверить невалидную сторону остатка, например `left_balance_side="amount"`: ассистент должен получить структурированную ошибку и объяснить допустимые значения `debit|credit`.

## Общие критерии приемки

- Ассистент не выдумывает имена объектов, полей, регистров или отчетов; при нехватке данных сначала использует обнаружение tools.
- Ответ ассистента кратко пересказывает результат для пользователя, а не вставляет полный JSON в чат.
- Если tool возвращает `truncated=true`, ассистент предлагает продолжить и использует `next_cursor` в следующем шаге.
- Ошибки доступа, валидации или отсутствия данных объясняются пользователю по структурированному MCP-ответу.
