# Handoff INDEX

| Task | Title | Status | Owner | Files |
|------|-------|--------|-------|-------|
| TASK-BQ04-001 | Additive `dialect?` marker on `StatementResult` + BQ setter in `runStatements` | ready | - | src/core/queryRunner.ts, src/ui/resultsGridModel.ts, src/extension.ts, src/core/__tests__/queryRunner.test.ts |
| TASK-BQ04-002 | Webview cell-renderer switch to `formatBigQueryCell` (`formatDataCellForDialect`) | ready | - | src/ui/resultsGridModel.ts, webview/main.ts, src/ui/__tests__/resultsGridModel.test.ts |
| TASK-BQ04-003 | Frozen-surface guard test + non-BQ render regression | ready | - | src/adapters/__tests__/bq04SurfaceGuard.test.ts (new) |

## Shipped prior cycles (v1.49.0 and earlier)

| Task | Title | Status | Release |
|------|-------|--------|---------|
| TASK-BQ03-001..005 | GoogleSQL query jobs + paged Results grid (job state machine, page bridge, runner continuation, panel distinct states, copy-safe header; v1.50.0) | done | v1.50.0 |
| TASK-BQ02-001..004 | BigQuery resource explorer + table preview (real enumeration, preview builder, schema tree, v1.49.0) | done | v1.49.0 |
| TASK-CL-001..004 | Cleanup cycle: MSSQL bracket, ARP-07 invalidation wiring, snapshot name cap, BQ R4.5 minors | done | v1.48.0 |
| TASK-BQ01-001..004 | BigQuery connection foundation (ADC, billing project, location, lifecycle, factory, form) | done | v1.47.0 |
| TASK-BQ00-001..004 | BigQuery feasibility spike (package+bundle proof, pure types, ADC seam, ADR 0004) | done | v1.46.0 |
| ARP-09 | Redacted diagnostics + profile:fast/profile:release | done | v1.45.0 |
| ARP-08 | Console draft recovery | done | v1.44.0 |
| ARP-07 | Successful-DDL cache/context invalidation | done | v1.43.0 |
