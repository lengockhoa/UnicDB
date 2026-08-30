# INDEX_DBX04 — Relationship Explorer

Base: main @ dfad338 (v1.17.0) · Plan: PLAN_DBX04.md · Reviewer: unic-smart (Dbx04Reviewer)
Executor: unic-code · Package: postgres pack (PostgreSQL-only feature)

## Tasks

| Task | Scope | Status |
|---|---|---|
| TASK-DBX04-001 | src/core/er/fkGraph.ts + fkGraph.test.ts | done |
| TASK-DBX04-002 | src/core/er/layout.ts + svgExport.ts + tests | done |
| TASK-DBX04-003 | erService/erPanel/erPanelHtml/webview/extension/package/esbuild | done |
| TASK-DBX04-004 | dbx04Scaffold.test.ts + extension registration test + full regression | done |

## Contract (shared)

- ErGraph/ErNode/ErEdge types live in fkGraph.ts (001); layout.ts and
  svgExport.ts (002) import them from `./fkGraph` — same-directory import
  (DBX-03 lesson: `../schemaDiff` cost a TS2307 cascade).
- conkey ordinals are 1-based into the detail's columns array.
- All pure modules: no vscode import. Webview: textContent-only.

Status (2026-08-30): all 4 tasks executed. 32/32 targeted (er), scaffold+extension 75/75, full 2380 passed | 2 skipped, typecheck + esbuild clean (dist/erPanel.js via ctx10). Awaiting reviewer verdict.
