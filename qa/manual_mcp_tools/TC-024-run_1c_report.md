# TC-024 - run_1c_report

Tool: `run_1c_report`

Goal: verify report execution with compact defaults, row pagination, and column selection.

Prerequisites:
- An accessible report from TC-022 and valid parameters from TC-023.

Steps:
1. Call:
   ```json
   {
     "report": "<report_full_name>",
     "parameters": {},
     "output_format": "table",
     "limit": 5
   }
   ```
2. If truncated, call with `cursor`.
3. Repeat with:
   ```json
   {
     "report": "<report_full_name>",
     "parameters": {},
     "output_format": "table",
     "columns": ["<column_name>"],
     "include_parameters_used": true,
     "include_navigation_url": true,
     "include_guidance": true,
     "limit": 5
   }
   ```

Expected result:
- Default execution returns table rows and paging fields without echoing parameters or guidance.
- Cursor returns next report rows.
- Column selector limits returned columns.
- Opt-in fields appear only when requested.

