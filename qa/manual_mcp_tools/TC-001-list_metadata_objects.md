# TC-001 - list_metadata_objects

Tool: `list_metadata_objects`

Goal: verify compact metadata discovery and cursor pagination.

Prerequisites:
- MCP client is connected as a user with access to at least one metadata object.

Steps:
1. Call the tool with:
   ```json
   {"limit": 2}
   ```
2. If `structuredContent.truncated=true`, call it again with:
   ```json
   {"limit": 2, "cursor": "<next_cursor_from_step_1>"}
   ```
3. Call it with:
   ```json
   {"limit": 2, "response_profile": "standard"}
   ```

Expected result:
- `isError=false` and `structuredContent.ok=true`.
- Step 1 returns `objects` with no more than 2 items.
- When truncated, `next_cursor` is present and step 2 returns the next page, not the same objects.
- Compact profile omits verbose fields such as `resource_uri`; standard profile includes additional metadata.
- `content[0].text` is a short summary, while full data is in `structuredContent`.

