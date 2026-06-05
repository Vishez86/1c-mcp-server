# TC-026 - get_current_user_context

Tool: `get_current_user_context`

Goal: verify user/security context with opt-in detail sections.

Prerequisites:
- MCP client is connected as a real 1C user.

Steps:
1. Call:
   ```json
   {}
   ```
2. Repeat with:
   ```json
   {
     "include_roles": true,
     "include_limits": true,
     "include_allowed_metadata_summary": true,
     "include_server_info": true
   }
   ```

Expected result:
- Default response returns minimal user context and cache policy.
- Expanded response includes requested role, limit, metadata summary, and server sections.
- Sensitive information is masked according to server policy.
- Response is structured and compact in `content[0].text`.

