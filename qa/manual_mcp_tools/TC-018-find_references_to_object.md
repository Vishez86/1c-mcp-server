# TC-018 - find_references_to_object

Tool: `find_references_to_object`

Goal: verify reverse-reference discovery with compact defaults and opt-in samples.

Prerequisites:
- A valid object reference likely to be used by other objects.

Steps:
1. Call:
   ```json
   {
     "target": {"type": "<object_type>", "uuid": "<uuid>"},
     "max_types": 5,
     "limit_per_type": 5
   }
   ```
2. Repeat with:
   ```json
   {
     "target": {"type": "<object_type>", "uuid": "<uuid>"},
     "include_samples": true,
     "include_counts": true,
     "max_types": 5,
     "limit_per_type": 3
   }
   ```
3. If group pagination is truncated, call with `cursor`.

Expected result:
- Default response does not include sample rows.
- Opt-in response includes counts and samples where references exist.
- `max_types`, `limit_per_type`, and cursor are respected.
- Inaccessible metadata is skipped or reported safely.

