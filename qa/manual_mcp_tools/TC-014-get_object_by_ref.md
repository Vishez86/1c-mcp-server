# TC-014 - get_object_by_ref

Tool: `get_object_by_ref`

Goal: verify object retrieval by type and UUID with compact references and tabular-section pagination.

Prerequisites:
- A valid object `type` and `uuid` from TC-016.

Steps:
1. Call:
   ```json
   {"type": "<object_type>", "uuid": "<uuid>", "fields": ["<field_name>"]}
   ```
2. If the object has tabular sections, call:
   ```json
   {
     "type": "<object_type>",
     "uuid": "<uuid>",
     "include_tabular_sections": true,
     "tabular_section_row_limit": 2
   }
   ```
3. Repeat step 1 with `include_navigation_url=true`.

Expected result:
- Response returns object ref and requested fields only.
- Default ref does not include navigation URLs.
- Tabular section rows obey `tabular_section_row_limit` and expose cursor data when truncated.
- Invalid UUID returns a structured not-found or validation error.

