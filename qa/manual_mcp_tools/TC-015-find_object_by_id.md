# TC-015 - find_object_by_id

Tool: `find_object_by_id`

Goal: verify object lookup by UUID across filtered metadata types.

Prerequisites:
- A known UUID from TC-016.

Steps:
1. Call:
   ```json
   {"uuid": "<uuid>", "types": ["<object_type>"], "limit": 5}
   ```
2. Call wider search:
   ```json
   {"uuid": "<uuid>", "kinds": ["Справочник", "Документ"], "limit": 2}
   ```
3. If truncated, call with `cursor`.

Expected result:
- Matching candidates include type and reference data.
- Tool respects type/kind filters and pagination.
- Deleted objects are excluded by default.
- `include_deleted=true` changes behavior only if the platform/user can see deleted objects.

