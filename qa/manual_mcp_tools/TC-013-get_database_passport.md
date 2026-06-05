# TC-013 - get_database_passport

Tool: `get_database_passport`

Goal: verify that the database passport is compact by default and expands only by flags.

Prerequisites:
- MCP user has access to at least one accounting register or other metadata.

Steps:
1. Call:
   ```json
   {}
   ```
2. Call expanded:
   ```json
   {
     "include_organizations": true,
     "include_period": true,
     "include_accumulation_registers": true,
     "include_information_registers": true,
     "include_calculation_registers": true,
     "include_empty_registers": false
   }
   ```

Expected result:
- Default response is concise and does not enumerate every register class.
- Expanded response includes only requested sections.
- Register limits are respected.
- Repeated call without `force_refresh` may use cache semantics but still returns correct structured content.

