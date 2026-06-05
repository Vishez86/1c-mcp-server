# TC-016 - search_objects

Tool: `search_objects`

Goal: verify object search with compact defaults, opt-in matched fields, and cursor pagination.

Prerequisites:
- At least one searchable metadata type from TC-001.

Steps:
1. Call:
   ```json
   {"query": "<known_name_fragment>", "types": ["<object_type>"], "limit": 2}
   ```
2. If truncated, call with `cursor`.
3. Repeat with:
   ```json
   {
     "query": "<known_name_fragment>",
     "types": ["<object_type>"],
     "include_matched_fields": true,
     "include_navigation_url": true,
     "limit": 2
   }
   ```

Expected result:
- Default matches do not include verbose matched-field diagnostics or navigation URLs.
- Opt-in call includes matched fields and navigation links where supported.
- Cursor page does not duplicate first-page results.
- Search respects allowed metadata and field-level security.

