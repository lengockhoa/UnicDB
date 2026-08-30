# INDEX_DBX01

Cycle DBX-01 — **DATA WORKBENCH COMPLETION**: CSV/JSON import + form view + large-value editing. PostgreSQL only. Plan: PLAN_DBX01.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-DBX01-001 | Importer pure modules: CSV + JSON parser | ready | none | independent unic-smart reviewer |
| TASK-DBX01-002 | Mapping + dry-run pure modules | ready | DBX01-001 | independent unic-smart reviewer |
| TASK-DBX01-003 | Import execute module (mocked adapter + transaction) | ready | DBX01-002 | independent unic-smart reviewer |
| TASK-DBX01-004 | Import wizard webview + host wiring + form view + scaffold test | ready | DBX01-003 | independent unic-smart reviewer |

Graph: 001 → 002 → 003 → 004 (linear dependency).

Waves:
- Wave 1: DBX01-001 + DBX01-002 (file-disjoint under `src/core/importer/`)
- Wave 2: DBX01-003 (`importExecute.ts` + tests)
- Wave 3: DBX01-004 (extension wiring + webview + scaffold test)

File locks:
- DBX01-001: `src/core/importer/importCsv.ts` (NEW), `src/core/importer/importJson.ts` (NEW), `src/core/importer/__tests__/importCsv.test.ts` (NEW), `src/core/importer/__tests__/importJson.test.ts` (NEW).
- DBX01-002: `src/core/importer/importMapping.ts` (NEW), `src/core/importer/importDryRun.ts` (NEW), `src/core/importer/__tests__/importMapping.test.ts` (NEW), `src/core/importer/__tests__/importDryRun.test.ts` (NEW).
- DBX01-003: `src/core/importer/importExecute.ts` (NEW), `src/core/importer/__tests__/importExecute.test.ts` (NEW).
- DBX01-004: `src/ui/importWizard.ts` (NEW), `src/ui/__tests__/importWizard.test.ts` (NEW), `src/ui/formView.ts` (NEW), `src/ui/__tests__/formView.test.ts` (NEW), `webview/importWizardMain.ts` (NEW), `webview/formViewMain.ts` (NEW), `src/extension.ts` (additive), `package.json` (additive 4 commands + 2 activation events + 1 view + 1 setting), `src/__tests__/dbx01Scaffold.test.ts` (NEW).
