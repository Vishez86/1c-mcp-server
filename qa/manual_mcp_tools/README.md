# Manual QA Coverage - MCP Tools

Use these cases with an MCP client connected to a deployed 1C MCP server. Each file covers one tool and includes checks for compact responses, pagination where applicable, and permission-safe behavior.

Before running object-specific cases, use the discovery cases to collect real values from the target infobase:

- Metadata type: `list_metadata_objects`
- Field names: `get_metadata_structure` or `search_metadata_fields`
- Register names: `list_registers`
- Report names: `list_reports`
- Object UUIDs: `search_objects`

| ID | Tool | Case |
| --- | --- | --- |
| TC-001 | `list_metadata_objects` | [TC-001-list_metadata_objects.md](TC-001-list_metadata_objects.md) |
| TC-002 | `get_metadata_structure` | [TC-002-get_metadata_structure.md](TC-002-get_metadata_structure.md) |
| TC-003 | `search_metadata_fields` | [TC-003-search_metadata_fields.md](TC-003-search_metadata_fields.md) |
| TC-004 | `run_1c_query` | [TC-004-run_1c_query.md](TC-004-run_1c_query.md) |
| TC-005 | `validate_1c_query` | [TC-005-validate_1c_query.md](TC-005-validate_1c_query.md) |
| TC-006 | `get_1c_query_guidance` | [TC-006-get_1c_query_guidance.md](TC-006-get_1c_query_guidance.md) |
| TC-007 | `list_registers` | [TC-007-list_registers.md](TC-007-list_registers.md) |
| TC-008 | `get_accounting_accounts_map` | [TC-008-get_accounting_accounts_map.md](TC-008-get_accounting_accounts_map.md) |
| TC-009 | `get_accounting_balances` | [TC-009-get_accounting_balances.md](TC-009-get_accounting_balances.md) |
| TC-010 | `get_accounting_entries` | [TC-010-get_accounting_entries.md](TC-010-get_accounting_entries.md) |
| TC-011 | `get_inventory_balances_by_item` | [TC-011-get_inventory_balances_by_item.md](TC-011-get_inventory_balances_by_item.md) |
| TC-012 | `get_calculation_types_map` | [TC-012-get_calculation_types_map.md](TC-012-get_calculation_types_map.md) |
| TC-013 | `get_database_passport` | [TC-013-get_database_passport.md](TC-013-get_database_passport.md) |
| TC-014 | `get_object_by_ref` | [TC-014-get_object_by_ref.md](TC-014-get_object_by_ref.md) |
| TC-015 | `find_object_by_id` | [TC-015-find_object_by_id.md](TC-015-find_object_by_id.md) |
| TC-016 | `search_objects` | [TC-016-search_objects.md](TC-016-search_objects.md) |
| TC-017 | `get_link_of_object` | [TC-017-get_link_of_object.md](TC-017-get_link_of_object.md) |
| TC-018 | `find_references_to_object` | [TC-018-find_references_to_object.md](TC-018-find_references_to_object.md) |
| TC-019 | `get_enum_values` | [TC-019-get_enum_values.md](TC-019-get_enum_values.md) |
| TC-020 | `get_register_records` | [TC-020-get_register_records.md](TC-020-get_register_records.md) |
| TC-021 | `get_document_movements` | [TC-021-get_document_movements.md](TC-021-get_document_movements.md) |
| TC-022 | `list_reports` | [TC-022-list_reports.md](TC-022-list_reports.md) |
| TC-023 | `get_report_info` | [TC-023-get_report_info.md](TC-023-get_report_info.md) |
| TC-024 | `run_1c_report` | [TC-024-run_1c_report.md](TC-024-run_1c_report.md) |
| TC-025 | `get_object_history` | [TC-025-get_object_history.md](TC-025-get_object_history.md) |
| TC-026 | `get_current_user_context` | [TC-026-get_current_user_context.md](TC-026-get_current_user_context.md) |

