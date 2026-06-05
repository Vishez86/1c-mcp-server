# TC-007 - list_registers

Tool: `list_registers`

Goal: verify register discovery, mode filtering, and pagination.

Prerequisites:
- Target infobase has at least one accessible register.

Steps:
1. Call:
   ```json
   {"limit": 2}
   ```
2. If truncated, call with returned `next_cursor`.
3. Call:
   ```json
   {"mode_support": "balance", "include_fields_summary": true, "limit": 5}
   ```

Expected result:
- Response contains `registers`, `register_count`, `truncated`, `next_cursor`, and `total_estimated`.
- Cursor returns the next page.
- `mode_support` filters registers that support the requested mode.
- `include_fields_summary=true` adds concise dimensions/resources/attributes, not full metadata.

