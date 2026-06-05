# TC-004 - run_1c_query

Tool: `run_1c_query`

Goal: verify safe read-only query execution, compact column output, and row pagination.

Prerequisites:
- A queryable metadata object and at least one query field discovered via TC-001 or TC-002.

Steps:
1. Call with a read-only query limited by the tool:
   ```json
   {
     "query": "ВЫБРАТЬ Ссылка, Наименование ИЗ Справочник.<Name>",
     "limit": 2
   }
   ```
2. If `truncated=true`, call with `cursor` from step 1.
3. Repeat with:
   ```json
   {
     "query": "ВЫБРАТЬ Ссылка, Наименование ИЗ Справочник.<Name>",
     "limit": 2,
     "include_column_types": true,
     "include_navigation_url": true,
     "include_guidance": true
   }
   ```

Expected result:
- Read-only query returns `rows`, `columns`, `row_count`, `truncated`, and `next_cursor`.
- Default `columns` are compact names; `include_column_types=true` returns type details.
- Default references do not include navigation URLs; opt-in call includes them where supported.
- Non-read-only query text is rejected with a structured error.

