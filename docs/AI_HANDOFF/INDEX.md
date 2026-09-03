# Handoff INDEX

| Task | Title | Status | Owner | Files |
|------|-------|--------|-------|-------|
| TASK-BQ03-001 | BigQuery job state machine + MVP SQL gate | ready | - | src/adapters/bigquery.ts, src/adapters/__tests__/bigqueryJobs.test.ts (new) |
| TASK-BQ03-002 | BigQuery result page bridge (pure helpers) | ready | - | src/adapters/bigqueryPages.ts (new), src/adapters/__tests__/bigqueryPages.test.ts (new) |
| TASK-BQ03-003 | QueryRunner continuation contract for BigQuery pages | ready | TASK-BQ03-001 | src/core/queryRunner.ts, src/core/__tests__/queryRunner.test.ts |
| TASK-BQ03-004 | ResultsPanel BigQuery job states + token-gated Load More | ready | none | src/ui/resultsPanel.ts, src/ui/__tests__/resultsPanel.test.ts |
| TASK-BQ03-005 | Command integration: GoogleSQL selection + copy-safe header | ready | TASK-BQ03-001, TASK-BQ03-004 | src/extension.ts, src/extension.test.ts |

## Shipped prior cycles (v1.49.0 and earlier)

| Task | Title | Status | Release |
|------|-------|--------|---------|
| TASK-BQ02-001..004 | BigQuery resource explorer + table preview (real enumeration, preview builder, schema tree, v1.49.0) | done | v1.49.0 |
| TASK-CL-001..004 | Cleanup cycle: MSSQL bracket, ARP-07 invalidation wiring, snapshot name cap, BQ R4.5 minors | done | v1.48.0 |
| TASK-BQ01-001..004 | BigQuery connection foundation (ADC, billing project, location, lifecycle, factory, form) | done | v1.47.0 |
| TASK-BQ00-001..004 | BigQuery feasibility spike (package+bundle proof, pure types, ADC seam, ADR 0004) | done | v1.46.0 |
| ARP-09 | Redacted diagnostics + profile:fast/profile:release | done | v1.45.0 |
| ARP-08 | Console draft recovery | done | v1.44.0 |
| ARP-07 | Successful-DDL cache/context invalidation | done | v1.43.0 |
