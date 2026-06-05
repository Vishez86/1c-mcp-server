# TC-009 - get_accounting_balances

Tool: `get_accounting_balances`

Goal: verify configuration-agnostic accounting balance retrieval through register virtual tables.

Prerequisites:
- An accounting register from TC-007, for example `РегистрБухгалтерии.<Name>`.

Steps:
1. Call:
   ```json
   {
     "accounting_register": "<accounting_register_full_name>",
     "mode": "balance",
     "period": "2025-12-31T23:59:59",
     "limit": 5
   }
   ```
2. If truncated, call with `cursor` from step 1.
3. Repeat with:
   ```json
   {
     "accounting_register": "<accounting_register_full_name>",
     "mode": "turnovers",
     "period_from": "2025-01-01T00:00:00",
     "period_to": "2025-12-31T23:59:59",
     "include_query": true,
     "include_column_types": true,
     "limit": 5
   }
   ```

Expected result:
- Response returns rows for the selected virtual table mode or an empty result with no error.
- Pagination fields are present.
- `include_query` and `include_column_types` are opt-in.
- Result includes the selected accounting register and `configuration_agnostic=true`.

