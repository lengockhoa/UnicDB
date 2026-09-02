# Handoff INDEX

| Task | Title | Status | Owner | Files |
|------|-------|--------|-------|-------|
| TASK-BQ02-001 | BigQuery resource metadata adapter (real enumeration) | approved_minor | reviewer=unic-smart | src/adapters/bigquery.ts, src/adapters/__tests__/bigquery.test.ts |
| TASK-BQ02-002 | BigQuery preview SQL builder + browse command arm | approved_minor | executor=unic-code; reviewer=unic-smart | src/ui/bigQueryPreview.ts (new), src/ui/browseCommands.ts + 2 test files |
| TASK-BQ02-003 | Schema Explorer bigquery wiring (datasets, icons, row-count suppression) | approved_minor | executor=claude-sonnet-4-5; reviewer=unic-smart | src/ui/schemaTree.ts + 2 tree test files |
| TASK-BQ02-004 | Release copy + version gate (CHANGELOG, 1.49.0, boundary suite) | approved_minor | executor=unic-code; reviewer=unic-smart | CHANGELOG.md, package.json |

## Shipped prior cycles (v1.48.0 and earlier)

| Task | Title | Status | Release |
|------|-------|--------|---------|
| TASK-BQ02-001..004 | BigQuery resource explorer + table preview (real enumeration, preview builder, schema tree, v1.49.0) | done | v1.49.0 |
| TASK-CL-001..004 | Cleanup cycle: MSSQL bracket, ARP-07 invalidation wiring, snapshot name cap, BQ R4.5 minors | done | v1.48.0 |
| TASK-BQ01-001..004 | BigQuery connection foundation (ADC, billing project, location, lifecycle, factory, form) | done | v1.47.0 |
| TASK-BQ00-001..004 | BigQuery feasibility spike (package+bundle proof, pure types, ADC seam, ADR 0004) | done | v1.46.0 |
| ARP-09 | Redacted diagnostics + profile:fast/profile:release | done | v1.45.0 |
| ARP-08 | Console draft recovery | done | v1.44.0 |
| ARP-07 | Successful-DDL cache/context invalidation | done | v1.43.0 |
