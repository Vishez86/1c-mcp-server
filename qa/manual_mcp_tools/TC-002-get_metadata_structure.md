# TC-002 - get_metadata_structure

Tool: `get_metadata_structure`

Goal: verify section-based metadata retrieval and section pagination.

Prerequisites:
- A valid metadata full name from TC-001, for example a catalog, document, or register.

Steps:
1. Call the tool with:
   ```json
   {"type": "<metadata_full_name>", "section": "attributes", "limit": 2}
   ```
2. If `truncated=true`, call the same section with `cursor` from step 1.
3. Call the tool with:
   ```json
   {"type": "<metadata_full_name>", "section": "all"}
   ```

Expected result:
- Section call returns `metadata`, `section`, `items`, `item_count`, `truncated`, `next_cursor`, and `total_estimated`.
- `items.length` is no more than the requested limit.
- Cursor page continues the same section.
- `section=all` returns the full `metadata` object with defaults kept compact.
- Unknown or inaccessible `type` returns a structured MCP error, not a platform exception dump.

