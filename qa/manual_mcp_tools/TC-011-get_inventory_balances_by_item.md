# TC-011 - get_inventory_balances_by_item

Tool: `get_inventory_balances_by_item`

Goal: verify the inventory fast path by item search or item reference.

Prerequisites:
- Target infobase has item catalog data and accounting setup compatible with inventory subconto.
- A known item name/code or item ref.

Steps:
1. Call by search string:
   ```json
   {
     "item_query": "<item_name_or_code>",
     "as_of": "2025-12-31T23:59:59",
     "limit": 5
   }
   ```
2. Repeat with explicit verbose flags:
   ```json
   {
     "item_query": "<item_name_or_code>",
     "as_of": "2025-12-31T23:59:59",
     "include_query": true,
     "include_guidance": true,
     "limit": 5
   }
   ```

Expected result:
- Response contains selected `item`, `item_search`, register/chart context, and balance rows or a clean empty result.
- Warnings explain ambiguous or fallback behavior.
- `query_used` and guidance appear only when requested.
- Missing item search returns a structured error or no-candidate response, not an unhandled exception.

