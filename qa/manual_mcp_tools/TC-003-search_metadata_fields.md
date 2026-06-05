# TC-003 - search_metadata_fields

Tool: `search_metadata_fields`

Goal: verify field-level discovery without fetching full metadata structures.

Prerequisites:
- At least one accessible metadata object with attributes, dimensions, resources, or tabular sections.

Steps:
1. Call the tool with:
   ```json
   {"query": "", "limit": 3}
   ```
2. If truncated, call with the returned `next_cursor`.
3. Call with a filter from a discovered object:
   ```json
   {"types": ["<metadata_full_name>"], "field_kinds": ["attributes"], "limit": 5}
   ```

Expected result:
- Response contains `fields`, `field_count`, `truncated`, `next_cursor`, and `total_estimated`.
- Every field includes owner/type context and a field path.
- Permission-denied fields are not returned.
- Pagination works without losing results.
- Response stays compact and does not include full object structures.

