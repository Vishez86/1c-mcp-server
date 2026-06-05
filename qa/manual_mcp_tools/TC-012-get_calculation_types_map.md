# TC-012 - get_calculation_types_map

Tool: `get_calculation_types_map`

Goal: verify compact calculation type discovery and raw-row opt-in.

Prerequisites:
- Target infobase has at least one accessible calculation type plan, or QA expects a clean not-found response.

Steps:
1. Call:
   ```json
   {"limit": 5}
   ```
2. If multiple plans are returned, repeat with selected `plan`.
3. Call:
   ```json
   {"plan": "<calculation_plan_full_name>", "limit": 5, "include_raw_rows": true, "include_query": true}
   ```

Expected result:
- Default response returns `calculation_types` without technical `rows` and `columns`.
- Cursor pagination works if truncated.
- Raw rows and query text appear only in the opt-in call.
- Multiple-plan ambiguity is reported explicitly.

