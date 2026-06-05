# TC-019 - get_enum_values

Tool: `get_enum_values`

Goal: verify enumeration value retrieval and pagination.

Prerequisites:
- An accessible enum full name from TC-001, for example `Перечисление.<Name>`.

Steps:
1. Call:
   ```json
   {"type": "<enum_full_name>", "limit": 2}
   ```
2. If truncated, call with `cursor`.
3. Repeat with:
   ```json
   {"type": "<enum_full_name>", "limit": 5, "include_order": true, "include_empty": true}
   ```

Expected result:
- Response returns `values` and paging metadata.
- Default response omits order details and empty value unless requested.
- Cursor page continues enumeration values.
- Non-enum type returns a structured validation or metadata error.

