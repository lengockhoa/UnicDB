# Handoff INDEX

| Task | Title | Status | Owner | Files |
|------|-------|--------|-------|-------|
| TASK-CL-001 | MSSQL bracket masking + read-only guard dialect threading | pending_review | executor=claude-sonnet-4-6 | src/core/dangerousStatement.ts, src/core/connectionManager.ts + 4 core test files |
| TASK-CL-002 | ARP-07 invalidation wiring (form DDL + AI plan-apply) | pending_review | executor=claude-sonnet-4-6 | src/extension.ts, src/ui/tableCommands.ts, src/ui/aiChatPanel.ts + 2 ui test files |
| TASK-CL-003 | Console draft snapshot name cap (ARP-08 minor) | pending_review | executor=claude-sonnet-4-6 | src/ui/consolePanelMessages.ts, src/ui/consolePanel.ts + 2 console test files |
| TASK-CL-004 | BQ-00 + BQ-01 R4.5 carried minors (folded) | pending_review | executor=claude-sonnet-4-6 | src/adapters/bigquery.ts, 2 bigquery test files, ADR 0004 doc |

## Shipped prior cycles (v1.47.0 and earlier)

| Task | Title | Status | Release |
|------|-------|--------|---------|
| TASK-BQ01-001..004 | BigQuery connection foundation (ADC, billing project, location, lifecycle, factory, form) | done | v1.47.0 |
| TASK-BQ00-001..004 | BigQuery feasibility spike (package+bundle proof, pure types, ADC seam, ADR 0004) | done | v1.46.0 |
| ARP-09 | Redacted diagnostics + profile:fast/profile:release | done | v1.45.0 |
| ARP-08 | Console draft recovery | done | v1.44.0 |
| ARP-07 | Successful-DDL cache/context invalidation | done | v1.43.0 |
