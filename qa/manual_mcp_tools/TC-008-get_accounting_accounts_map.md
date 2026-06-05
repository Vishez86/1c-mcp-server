# TC-008 - get_accounting_accounts_map

Tool: `get_accounting_accounts_map`

Goal: verify compact account map retrieval and opt-in raw rows/guidance.

Prerequisites:
- Target infobase has an accessible chart of accounts.

Steps:
1. Call:
   ```json
   {"limit": 5}
   ```
2. If needed, call with a known chart:
   ```json
   {"chart": "<chart_full_name>", "limit": 5}
   ```
3. Call with optional verbose flags:
   ```json
   {"chart": "<chart_full_name>", "limit": 5, "include_raw_rows": true, "include_guidance": true, "include_query": true}
   ```

Expected result:
- Default response contains `accounts` and paging fields.
- Default response does not include technical `rows`, `columns`, or guidance.
- Verbose call includes `rows`, `columns`, `guidance`, and `query_used`.
- If multiple charts exist and none is specified, tool asks for a chart instead of guessing.

