# TC-023 - get_report_info

Tool: `get_report_info`

Goal: verify report metadata retrieval and parameter pagination.

Prerequisites:
- An accessible report full name from TC-022.

Steps:
1. Call:
   ```json
   {"report": "<report_full_name>", "limit": 5}
   ```
2. If `parameters_paging.truncated=true`, call with `cursor`.
3. Repeat with:
   ```json
   {
     "report": "<report_full_name>",
     "include_schema": true,
     "include_variants": true,
     "include_default_settings": true,
     "include_guidance": true,
     "limit": 5
   }
   ```

Expected result:
- Default response is compact and does not include schema, variants, defaults, or guidance.
- Parameters are paginated with `parameters_paging`.
- Opt-in call includes requested details.
- Invalid report name returns a structured error.

