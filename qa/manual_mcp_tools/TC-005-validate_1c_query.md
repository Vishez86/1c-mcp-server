# TC-005 - validate_1c_query

Tool: `validate_1c_query`

Goal: verify query validation without execution.

Prerequisites:
- A valid queryable metadata object from TC-001.

Steps:
1. Call with a safe read-only query:
   ```json
   {"query": "ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ Справочник.<Name>"}
   ```
2. Call with the same query and:
   ```json
   {"explain": true}
   ```
3. Call with a prohibited write or unsafe query text.

Expected result:
- Safe query returns validation success and does not execute data retrieval.
- `explain=true` adds diagnostic explanation.
- Unsafe query is rejected with `isError=true` and a clear validation error.
- Error response includes `correlation_id` in compact text.

