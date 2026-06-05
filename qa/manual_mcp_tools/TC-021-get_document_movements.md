# TC-021 - get_document_movements

Tool: `get_document_movements`

Goal: verify document movement summary defaults and row-level pagination.

Prerequisites:
- A posted document `document_type` and `uuid` with movements.

Steps:
1. Call:
   ```json
   {"document_type": "<document_type>", "uuid": "<uuid>"}
   ```
2. Call detailed rows:
   ```json
   {
     "document_type": "<document_type>",
     "uuid": "<uuid>",
     "summary_only": false,
     "row_limit_per_register": 2
   }
   ```
3. If registers or rows are truncated, repeat with `cursor` and/or `row_cursor`.

Expected result:
- Default response summarizes movement registers without row payloads.
- Detailed call returns movement rows limited per register.
- Register and row cursors page through remaining data.
- Empty movements are omitted unless `include_empty_registers=true`.

