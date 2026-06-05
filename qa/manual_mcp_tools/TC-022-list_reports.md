# TC-022 - list_reports

Tool: `list_reports`

Goal: verify compact report discovery and optional variants/guidance.

Prerequisites:
- Target infobase has at least one accessible report.

Steps:
1. Call:
   ```json
   {"limit": 2}
   ```
2. If truncated, call with `cursor`.
3. Repeat with:
   ```json
   {"query": "<report_name_fragment>", "include_variants": true, "include_guidance": true, "limit": 5}
   ```

Expected result:
- Default response returns no more than 2 reports and omits variants/guidance.
- Cursor page continues the list.
- Opt-in call includes variants and guidance.
- Inaccessible reports are excluded unless allowed admin flags are used.

