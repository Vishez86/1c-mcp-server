# TC-006 - get_1c_query_guidance

Tool: `get_1c_query_guidance`

Goal: verify compact knowledge guidance retrieval.

Prerequisites:
- None.

Steps:
1. Call:
   ```json
   {
     "topic": "metadata-first",
     "intent": "Build a query for catalog balances",
     "max_sections": 2
   }
   ```
2. Repeat with:
   ```json
   {"topic": "virtual-tables", "include_examples": true, "max_sections": 3}
   ```

Expected result:
- Response returns no more sections than requested.
- Guidance is relevant to the selected topic.
- Examples appear only when `include_examples=true`.
- Tool does not return broad unrelated knowledge blocks.

