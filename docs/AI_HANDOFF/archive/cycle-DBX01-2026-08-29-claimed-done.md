# PLAN_DBX01 — Data Workbench Completion

## §1 Intent

DBX-01 closes the data workbench gap. Success means the user can:
1. **Import** a CSV or JSON file into a PostgreSQL table — with explicit column mapping, a preview step, and a real dry-run that never touches the database.
2. **Edit** a cell directly with **large-value** (JSON / long-text) editing that doesn't truncate; render JSON cells as a form view; and keep the existing server-side sort/filter/edit/paste/undo-redo flows unchanged.
3. **Repair** data via a focused form view for a single row (keyset-paged into the existing panel) with full fidelity for null / JSON / blob-like values.

PostgreSQL only. The cycle must not introduce cross-connection copy or any new abstraction layer; it must reuse the existing `resultsGridModel`, `resultsPanel`, `queryRunner`, `PostgresAdapter.runQuery` (parameterized), and the existing `dangerousStatement` / `confirmDangerousStatements` flow.

## §2 Scope

**In scope** (deliverable):
- A new pure `src/core/importer/importCsv.ts` module: CSV parse → header detection → row-buffer → return preview (first N rows) + type inference + error report. No DB.
- A new pure `src/core/importer/importJson.ts` module: JSON parse (array-of-objects or NDJSON) → type inference → preview. No DB.
- A new pure `src/core/importer/importMapping.ts` module: column-mapping (CSV header → target column, JSON key → target column), with type coercion (string/int/numeric/bool/timestamp/json/text) and per-cell error reporting. No DB.
- A new pure `src/core/importer/importDryRun.ts` module: given a mapping + rows, build parameterized `INSERT INTO ... VALUES ($N, $M) ...` statements *or* a `COPY` plan, validate quoting, surface what would happen (N inserts, M batches, total bytes). No DB.
- A new `src/core/importer/importExecute.ts` module: given the dry-run plan + a `DbAdapter`, execute within a single transaction (`adapter.beginTransaction()`), respecting `dangerousStatement` (always red — confirmed via existing `confirmDangerousStatements` extension).
- A new webview `webview/importWizardMain.ts` (CSP-clean, no inline script) that drives the wizard: file → preview → mapping → dry-run → confirm → execute → result.
- A new `src/ui/importWizard.ts` host wrapper that opens the webview, wires the existing `ConnectionManager` adapter, and reports progress into the existing results panel.
- A new `src/ui/formView.ts` and corresponding webview (extending the existing `resultsPanel` webview with a "Form" toggle) that renders a single row as a labeled form; large JSON values render in a `vscode.TextDocumentContentProvider` (full-fidelity read-only) with a side "Edit" affordance.
- Wire 4 new commands into `package.json` + `extension.ts`:
  - `vsdb.importCsv` (idempotent: opens the import wizard)
  - `vsdb.importJson`
  - `vsdb.openFormView` (toggles form view on the active results tab)
  - `vsdb.editLargeValue` (opens the in-document editor for a long-text / JSON cell)
- Tests covering: CSV parser, JSON parser, mapping + coercion, dry-run SQL build (no real DB needed), execute happy path (integration with a mocked `DbAdapter`), form view (CSS class + label rendering), large-value editor (TextDocumentContentProvider content).

**Out of scope for this cycle:**
- MySQL / MariaDB / SQL Server parity for the import wizard (these will follow DBX-08).
- Cross-connection / cross-database copy.
- Reformatting / type-promotion on the import target.
- Background / async execution of large imports (synchronous within a transaction, then commit).

## §3 Approach

1. **Pure first.** Build the importer as four pure modules under `src/core/importer/`. Each one is testable without `vscode` or a real `DbAdapter`. Use parameterized SQL via `pg.Pool.query(sql, values)` — never string-concatenated literals.
2. **Reuse, don't refactor.** `resultsGridModel`, `resultsPanel`, `queryRunner`, `keysetPaging`, `connectionForm`, and `dangerousStatement` are read-only inputs. Add to them only when the public interface already has a seam (e.g. a new view toggle in `resultsPanel.ts`).
3. **CSP-clean webview.** Mirror the existing pattern (e.g. `webview/aiSettingsFormMain.ts`): separate `Main.ts` (compiled, no inline script), no `eval`, all messages go through `acquireVsCodeApi()`.
4. **Dangerous SQL is always red.** Import wizard funnels through the existing `confirmDangerousStatements` extension path; if a row is too large, surface a row-level error and skip it — never truncate.
5. **Auto-skip, never silently coerce.** Type coercion must be opt-in per-column (default = text). Failures appear in a per-cell error report and the row is excluded from the dry-run preview.
6. **Type-safe adapter contract.** `DbAdapter.beginTransaction()` already exists; if not, the import execute path uses `adapter.runQuery` with a `BEGIN; ... COMMIT;` block — the existing path used by `queryRunner` integration tests.

## §4 Test Plan

All Vitest. RED→GREEN per task. No real Postgres needed for unit tests; the existing `queryRunner.integration.test.ts` pattern is the model for any test that wants a real Postgres (none for DBX-01; all pure + mocked).

| Path | Cases | Targets |
|---|---|---|
| `src/core/importer/__tests__/importCsv.test.ts` | quoted/escaped quotes, header detection, empty file, single-column, BOM, mixed line endings (`\r\n` / `\n`), trailing newline | pure CSV parser |
| `src/core/importer/__tests__/importJson.test.ts` | array-of-objects, NDJSON, deeply-nested values rejected, primitive root rejected, top-level null/empty | pure JSON parser |
| `src/core/importer/__tests__/importMapping.test.ts` | column rename, type coercion (int / numeric / bool / timestamp / json / text), per-cell error report, no target column → error, missing source column → error | mapping module |
| `src/core/importer/__tests__/importDryRun.test.ts` | parameterized INSERT SQL build (no string concat), batch count, total row count, dry-run is read-only, identifier quoting, primary-key collision detection, no real `runQuery` call | dry-run module |
| `src/core/importer/__tests__/importExecute.test.ts` | mocked DbAdapter, happy path: BEGIN + batched INSERTs + COMMIT, error mid-batch → ROLLBACK, oversized row skipped with report, uses dangerousStatement gate | execute module |
| `src/ui/__tests__/importWizard.test.ts` | wizard opens, mapping pre-fills when source headers match target columns, form view toggle, large-value editor uses TextDocumentContentProvider | host + webview seam |
| `src/ui/__tests__/formView.test.ts` | renders a single row as a labeled form, JSON cell expands without truncation, null cell renders as "(NULL)" | form view |
| `src/__tests__/dbx01Scaffold.test.ts` | 4 new command ids, view / setting / activation event shape matches manifest | scaffold smoke test |

## §5 Per-cycle Verification Baseline

- `npm run typecheck` (always)
- Targeted: `npx vitest run src/core/importer src/ui/__tests__/importWizard.test.ts src/ui/__tests__/formView.test.ts src/__tests__/dbx01Scaffold.test.ts`
- Full boundary: `npm test` at the end of each wave

## §6 Acceptance

- [ ] 4 new commands wired + view + setting + activation events registered.
- [ ] `npx vitest run src/core/importer` → all green; full suite green.
- [ ] `npm run typecheck` exit 0; `npm run compile` clean.
- [ ] CSV / JSON import happy path covered with a mocked DbAdapter (no real Postgres).
- [ ] Dry-run SQL is parameterized; dry-run path performs no `runQuery` calls (proven by mock).
- [ ] Form view renders large JSON without truncation.
- [ ] All 4 tasks done + reviewed + pushed.

## §7 Execution Queue

| Wave | Tasks | Owner files |
|---|---|---|
| 1 | DBX-01-001 (importer pure modules + tests), DBX-01-002 (mapping + dry-run pure + tests) | `src/core/importer/**` (new) |
| 2 | DBX-01-003 (import execute module + tests) | `src/core/importer/importExecute.ts` (new) |
| 3 | DBX-01-004 (extension wiring + scaffold + commands + form view + large-value editor) | `src/extension.ts`, `package.json`, `src/ui/importWizard.ts`, `src/ui/formView.ts`, `webview/importWizardMain.ts`, `src/__tests__/dbx01Scaffold.test.ts` |

## Planner Report

PLANNER_MODEL: unic-code (in-session, this is a tight scope, no need for opus)
PLAN_REVIEW: self-accepted; user-side review on first review pass

## Plan Review Log

### Round 1 — accepted (reviewer: in-session self, model unic-code)
- Verified: resultsGridModel already has markDirty / undo / clear; keysetPaging already exists; queryRunner already exposes fetchBatch + cancel; resultsPanel already has per-tab state. No need to rebuild edit infrastructure.
- Applied: scoping cuts (no MySQL/MSSQL, no cross-connection copy, no reformat) keep cycle ≤ 4 tasks.
- Constraint: confirmDangerousStatements extension already covers admin-red, so importing rows is naturally "red" (writes) — no new gate needed; the importer funnels through the existing path.
- Risk: NDJSON vs JSON-array ambiguity is a real input-shape decision; the importer must reject ambiguous files loudly. Mitigation: importJson rejects primitive root + deeply-nested + ambiguous NDJSON-mixed-with-array.
