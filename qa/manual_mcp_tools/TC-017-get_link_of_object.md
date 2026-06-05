# TC-017 - get_link_of_object

Tool: `get_link_of_object`

Goal: verify link generation for a known object.

Prerequisites:
- A valid object `type` and `uuid` from TC-016.

Steps:
1. Call without link type:
   ```json
   {"type": "<object_type>", "uuid": "<uuid>"}
   ```
2. Call explicit auto:
   ```json
   {"type": "<object_type>", "uuid": "<uuid>", "link_type": "auto"}
   ```
3. Call web link if a base URL is available:
   ```json
   {"type": "<object_type>", "uuid": "<uuid>", "link_type": "web_client", "base_url": "<web_client_base_url>"}
   ```

Expected result:
- Default call returns a single best link.
- `link_type=auto` returns all supported link variants.
- Presentation appears by default and can be disabled with `include_presentation=false`.
- Invalid object identity returns a structured error.

