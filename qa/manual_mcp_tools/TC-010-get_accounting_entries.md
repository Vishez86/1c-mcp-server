# TC-010 - get_accounting_entries

Tool: `get_accounting_entries`

Goal: verify accounting entries retrieval, grouping, and optional query/guidance output.

Prerequisites:
- An accounting register from TC-007.

Steps:
1. Call:
   ```json
   {
     "accounting_register": "<accounting_register_full_name>",
     "period_from": "2025-01-01T00:00:00",
     "period_to": "2025-12-31T23:59:59",
     "limit": 5
   }
   ```
2. Call grouped mode:
   ```json
   {
     "accounting_register": "<accounting_register_full_name>",
     "period_from": "2025-01-01T00:00:00",
     "period_to": "2025-12-31T23:59:59",
     "group_by": ["debit_account", "credit_account"],
     "include_query": true,
     "include_guidance": true,
     "limit": 5
   }
   ```

Expected result:
- Ungrouped call returns `mode=entries`; grouped call returns `mode=entries_grouped`.
- `query_used` and guidance appear only in the opt-in call.
- Rows obey the requested limit and include paging fields.
- Invalid subconto filters return a clear validation error.

