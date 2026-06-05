# TC-025 - get_object_history

Tool: `get_object_history`

Goal: verify object history retrieval with compact default limit and pagination.

Prerequisites:
- A valid object reference from TC-016.
- History/versioning/event-log support may vary by configuration.

Steps:
1. Call:
   ```json
   {
     "target": {"type": "<object_type>", "uuid": "<uuid>"},
     "mode": "auto",
     "limit": 5
   }
   ```
2. If truncated, call with `cursor`.
3. Repeat with:
   ```json
   {
     "target": {"type": "<object_type>", "uuid": "<uuid>"},
     "mode": "event_log",
     "include_diff": true,
     "limit": 5
   }
   ```

Expected result:
- Tool returns available history/events or a clear explanation when history is unavailable.
- Default limit is compact.
- Cursor pagination works when enough events exist.
- Diff payload is included only when requested and supported.

