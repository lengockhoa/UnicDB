# Handoff INDEX

| Task | Title | Status | Owner | Files |
|------|-------|--------|-------|-------|
| TASK-UX1-001 | Console opens from schema tree with no active editor (R6+R7) | pending_review | planner=unic-smart; executor=unic-code (PASS, 6 new tests; 3342 → 3348 baseline; region contract respected — only `commandGenerateSelect` slot in extension.ts; pre-existing esbuild ENOENT is baseline) | src/ui/consolePanel.ts, src/extension.ts, src/ui/__tests__/consolePanel.test.ts, src/extension.test.ts |
| TASK-UX1-002 | SQL Generator on View/Routine nodes — pg_get_viewdef/functiondef → seeded console (R3+R4) | ready | planner=unic-smart | package.json, src/extension.ts, src/extension.test.ts |
| TASK-UX1-003 | Sample Data → console INSERT templates (R1) | ready | planner=unic-smart | package.json, src/ui/tableCommands.ts, src/extension.ts, src/ui/__tests__/tableCommands.test.ts |
| TASK-UX1-004 | User guide icon + docs/VSDB_USER_GUIDE.md (R2) | ready | planner=unic-smart | package.json, src/extension.ts, src/extension.test.ts, docs/VSDB_USER_GUIDE.md (new), src/ui/__tests__/userGuideContent.test.ts (new) |
| TASK-UX1-005 | Filter dropdown Select All alignment (R5) | pending_review | planner=unic-smart; executor=unic-code (PASS, 7/7 setfilter + typecheck + compile clean; 3427|2 green, net +7 vs 3420|2 baseline) | webview/styles.css, webview/main.ts, src/ui/__tests__/webviewSetFilter.test.ts |
| TASK-UX1-008 | Chat pending garble + left padding (R9+R10) | pending_review | planner=unic-smart; executor=unic-code (PASS, 30/30 chatLayoutCss; region contract respected — only `.vsdb-chat-*` touched; pre-existing esbuild spawn ENOENT is baseline, not a regression) | webview/aiChatPanelMain.ts, webview/styles.css, src/ui/__tests__/chatLayoutCss.test.ts |
| TASK-UX1-006 | Results placement `top` + bq04 guard filter extension (R8a) | pending_review | planner=unic-smart; executor=unic-code (PASS, 10 new tests, 3352 pass; guard filter extended via file-side brace-depth scan for `onCommand:` activations + `contributes.configuration` property keys; default stays `below`; frozen surfaces untouched) | package.json, src/ui/resultsPanel.ts, src/ui/__tests__/resultsPanel.test.ts, src/adapters/__tests__/bq04SurfaceGuard.test.ts |
| TASK-UX1-007 | Settings hub gear on schema-tree title bar (R8b) | ready | planner=unic-smart | package.json, src/extension.ts, src/extension.test.ts |
| TASK-UX1-009 | Chat thinking row + streamed code blocks (R11) | ready | planner=unic-smart | webview/aiChatPanelMain.ts, webview/styles.css, src/ui/__tests__/aiChatPanelBundle.test.ts, src/ui/__tests__/chatLayoutCss.test.ts |
| TASK-UX1-010 | DDL/DML status card instead of empty grid (R12) | pending_review | planner=unic-smart; executor=unic-code (PASS, 21 new tests, 3441 pass; pure-helper `src/ui/ddlStatusCard.ts`; `.vsdb-ddl-*` CSS append-only; `commandGenerateSelect` untouched; BQ path keeps `kind===undefined`) | src/core/queryRunner.ts, src/extension.ts, src/ui/resultsGridModel.ts, webview/main.ts, webview/styles.css, src/core/__tests__/queryRunner.test.ts, src/ui/ddlStatusCard.ts (new), src/ui/__tests__/ddlStatusCard.test.ts (new) |
| TASK-UX1-011 | Auto-refresh schema tree after any query, debounced (R13) | ready | planner=unic-smart | src/extension.ts, src/core/schemaImpact.ts, src/core/__tests__/schemaImpact.test.ts, src/extension.test.ts |
| TASK-MENU-001 | Schema-tree table-node context menu: New Table #1, Modify Table #2, rest alphabetical | done | planner=unic-smart; executor=unic-code | package.json, src/extension.test.ts, src/adapters/__tests__/bq04SurfaceGuard.test.ts, CHANGELOG.md |
| TASK-OC4O-001..002 | OC4O: right-click "Open Console for Object" + Help Grid panel (committed a05fa7d, v1.51.1 pending version bump) | done | executor=unic-code; reviewer=unic-smart (2× approved_minor; close-out 0fc7106) | package.json, src/extension.ts, src/ui/consolePanel.ts, src/ui/helpGrid.ts, src/ui/helpGridPanel.ts, webview/helpGridMain.ts, src/extension.test.ts, src/adapters/__tests__/bq04SurfaceGuard.test.ts |
| TASK-BQ04-001 | Additive `dialect?` marker on `StatementResult` + BQ setter in `runStatements` | done | executor=claude-sonnet-4-5; reviewer=unic-smart (R2 changes_requested → R4.5 R1 approved) | src/core/queryRunner.ts, src/ui/resultsGridModel.ts, src/extension.ts, src/core/__tests__/queryRunner.test.ts, src/core/bqDialect.ts (new) |
| TASK-BQ04-002 | Webview cell-renderer switch to `formatBigQueryCell` (`formatDataCellForDialect`) | done | executor=unic-code; reviewer=unic-smart (R2 changes_requested → R4.5 R1 approved_minor) | src/ui/resultsGridModel.ts, webview/main.ts, src/ui/__tests__/resultsGridModel.test.ts |
| TASK-BQ04-003 | Frozen-surface guard test | done | executor=claude-sonnet-4-5; reviewer=unic-smart (R2 changes_requested → R4.5 R1 approved_minor) | src/adapters/__tests__/bq04SurfaceGuard.test.ts (new) |

## Shipped prior cycles (v1.49.0 and earlier)

| Task | Title | Status | Release |
|------|-------|--------|---------|
| TASK-BQ04-001..003 | BQ-04 wire `formatBigQueryCell` into Results grid (3 tasks / 2 waves / R4.5 R1 doc-only fix; +17 tests over v1.50.0; v1.51.0) | done | v1.51.0 |
| TASK-BQ03-001..005 | GoogleSQL query jobs + paged Results grid (job state machine, page bridge, runner continuation, panel distinct states, copy-safe header; v1.50.0) | done | v1.50.0 |
| TASK-BQ02-001..004 | BigQuery resource explorer + table preview (real enumeration, preview builder, schema tree, v1.49.0) | done | v1.49.0 |
| TASK-CL-001..004 | Cleanup cycle: MSSQL bracket, ARP-07 invalidation wiring, snapshot name cap, BQ R4.5 minors | done | v1.48.0 |
| TASK-BQ01-001..004 | BigQuery connection foundation (ADC, billing project, location, lifecycle, factory, form) | done | v1.47.0 |
| TASK-BQ00-001..004 | BigQuery feasibility spike (package+bundle proof, pure types, ADC seam, ADR 0004) | done | v1.46.0 |
| ARP-09 | Redacted diagnostics + profile:fast/profile:release | done | v1.45.0 |
| ARP-08 | Console draft recovery | done | v1.44.0 |
| ARP-07 | Successful-DDL cache/context invalidation | done | v1.43.0 |
