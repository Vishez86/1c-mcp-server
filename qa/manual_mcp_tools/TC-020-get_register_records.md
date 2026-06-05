# TC-020 - get_register_records

Tool: `get_register_records`

Goal: verify generic register reads with compact defaults and pagination.

Prerequisites:
- A register from TC-007 and supported mode from its `supported_modes`.

Steps:
1. Call:
   ```json
   {
     "register_type": "<register_kind>",
     "register": "<register_name_without_kind>",
     "mode": "records",
     "limit": 5
   }
   ```
2. If truncated, call with `cursor`.
3. Repeat with:
   ```json
   {
     "register_type": "<register_kind>",
     "register": "<register_name_without_kind>",
     "mode": "<supported_virtual_mode>",
     "period": "2025-12-31T23:59:59",
     "include_query": true,
     "include_column_types": true,
     "include_navigation_url": true,
     "limit": 5
   }
   ```

Expected result:
- Rows and paging fields are returned.
- Default response omits `query_used`, column type details, and navigation URLs.
- Opt-in flags add those fields.
- Unsupported mode for the selected register returns a clear error.

