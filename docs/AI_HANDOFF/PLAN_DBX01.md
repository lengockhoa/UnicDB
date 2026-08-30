# PLAN_DBX01 — Data Workbench Completion (re-opened 2026-08-30)

> **History:** the 2026-08-29 draft of this plan (archived to
> `archive/cycle-DBX01-2026-08-29-claimed-done.md`) claimed all four tasks
> complete. Auditing the repository on 2026-08-30 after the v1.15.0 release
> shows no `src/core/importer/`, no `src/ui/importWizard*`, and no
> `vsdb.importCsv` command in `package.json` — the cycle was
> planning_only, never executed. The plan below re-opens the work, keeps
> the same scope and acceptance, and updates the per-task test contracts
> so the executor lands a real cycle.

## §1 Intent

DBX-01 closes the data workbench gap. Success means the user can:

1. **Import** a CSV or JSON file into a PostgreSQL table — with explicit column mapping, a preview step, and a real dry-run that never touches the database.
2. **Edit** a cell directly with **large-value** (JSON / long-text) editing that doesn't truncate; render JSON cells as a form view; and keep the existing server-side sort/filter/edit/paste/undo-redo flows unchanged.
3. **Repair** data via a focused form view for a single row (keyset-paged into the existing panel) with full fidelity for null / JSON / blob-like values.

PostgreSQL only. The cycle must not introduce cross-connection copy or any new abstraction layer; it must reuse the existing `resultsGridModel`, `resultsPanel`, `queryRunner`, `PostgresAdapter.runQuery` (parameterized), and the existing `dangerousStatement` / `confirmDangerousStatements` flow.

## §2 Scope (deliverable)

- `src/core/importer/importCsv.ts` — pure CSV parser (RFC-4180 subset: quoted fields, escaped quotes, BOM, mixed line endings).
- `src/core/importer/importJson.ts` — pure JSON parser (array-of-objects or NDJSON; loud rejection of ambiguous shapes).
- `src/core/importer/importMapping.ts` — column mapping source→target with opt-in per-column type coercion (`text`/`int`/`numeric`/`bool`/`timestamp`/`json`) and per-cell error reporting.
- `src/core/importer/importDryRun.ts` — fully parameterized, batched INSERT plan + summary; read-only.
- `src/core/importer/importExecute.ts` — runs the plan inside a single `DbTransaction`; respects `dangerousStatement` gate; rollback on any mid-batch failure; never truncates oversized rows.
- `src/ui/importWizard.ts` (host) + `webview/importWizardMain.ts` (CSP-clean) — file → preview → mapping → dry-run → confirm → execute → result.
- `src/ui/formView.ts` (host) + `webview/formViewMain.ts` (CSP-clean) — single-row labeled form; JSON cells expand without truncation.
- `src/ui/largeValueEditor.ts` — registers `vsdb-lv:` text document content provider; full-fidelity long-text/JSON viewing.
- 4 new commands wired into `package.json` + `extension.ts`:
  - `vsdb.importCsv`
  - `vsdb.importJson`
  - `vsdb.openFormView`
  - `vsdb.editLargeValue`
- 2 activation events (`onCommand:vsdb.importCsv`, `onCommand:vsdb.importJson`), 1 setting (`vsdb.import.batchSize`, default 1000), 1 view contribution for the form panel.

**Out of scope:** MySQL/MSSQL parity (DBX-08), cross-connection copy, reformatting on import target, background execution (imports run synchronously inside a transaction then commit).

## §3 Approach

1. **Pure first.** Build the importer as four pure modules under `src/core/importer/`. Each one is testable without `vscode` or a real `DbAdapter`. Parameterized SQL only.
2. **Reuse, don't refactor.** `resultsGridModel`, `resultsPanel`, `queryRunner`, `keysetPaging`, `connectionForm`, and `dangerousStatement` are read-only inputs. Add to them only when the public interface already has a seam.
3. **CSP-clean webview.** Mirror the existing pattern (e.g. `webview/aiSettingsFormMain.ts`): separate `Main.ts` (compiled, no inline script), no `eval`, all messages go through `acquireVsCodeApi()`.
4. **Dangerous SQL is always red.** Import wizard funnels through the existing `confirmDangerousStatements` path; if a row is too large, surface a per-row error and skip it — never truncate.
5. **Auto-skip, never silently coerce.** Type coercion is opt-in per-column (default = text). Failures appear in a per-cell error report and the row is excluded from the dry-run preview.
6. **Type-safe adapter contract.** `DbAdapter.beginTransaction()` is optional on the interface; the importer uses it when present, otherwise falls back to a `BEGIN; ... COMMIT;` block via `adapter.runQuery`.

## §4 Test Plan

All Vitest. RED → GREEN per task. No real Postgres needed for unit tests.

| Path | Cases | Targets |
|---|---|---|
| `src/core/importer/__tests__/importCsv.test.ts` | 10 cases (simple / quoted / escaped / embedded newline / BOM / CRLF / empty / single-column / trailing / ragged) | pure CSV parser |
| `src/core/importer/__tests__/importJson.test.ts` | 6 cases (array / NDJSON / primitive-root / null-root / deeply-nested / mixed) | pure JSON parser |
| `src/core/importer/__tests__/importMapping.test.ts` | 10 cases (rename / default-text / int / numeric / bool / timestamp / json / coercion-failure / missing-source / required-missing) | mapping module |
| `src/core/importer/__tests__/importDryRun.test.ts` | 6 cases (parameterized SQL / batch size / summary / no DB call / quoting / empty plan) | dry-run module |
| `src/core/importer/__tests__/importExecute.test.ts` | 12 cases (happy path / parameter order / rollback / oversized row / DB call count / non-PG / rowCount / begin fail / batch size / dangerous gate / empty / commit fail) | execute module |
| `src/ui/__tests__/importWizard.test.ts` | 3 cases (auto-map / confirm-before-execute / no-connection) | host + webview seam |
| `src/ui/__tests__/formView.test.ts` | 3 cases (labeled rows / JSON expansion / null → (NULL)) | form view |
| `src/ui/__tests__/largeValueEditor.test.ts` | 2 cases (TDCP serves text / 200 KB passes unchanged) | large-value editor |
| `src/__tests__/dbx01Scaffold.test.ts` | 5 cases (4 commands / 2 events / 1 setting / 1 view / content provider) + 1 regression (no second cache/debounce) | scaffold smoke |

## §5 Per-cycle Verification Baseline

- Targeted: `npx vitest run src/core/importer src/ui/__tests__/importWizard.test.ts src/ui/__tests__/formView.test.ts src/ui/__tests__/largeValueEditor.test.ts src/__tests__/dbx01Scaffold.test.ts`
- Full: `npx vitest run`
- `npm run typecheck` (always)
- `npm run compile` (always)

## §6 Acceptance

- 4 new commands wired + view + setting + activation events registered.
- All 7 new test files green; full suite green (>= 2237 baseline + new tests).
- `tsc --noEmit` exit 0; `esbuild` clean.
- CSV / JSON import happy path covered with a mocked `DbAdapter` (no real Postgres).
- Dry-run SQL is parameterized; dry-run path performs no `runQuery` calls (proven by mock).
- Form view renders large JSON without truncation.
- Long-value editor serves 200 KB strings unchanged.
- All 4 tasks done + reviewed + pushed as separate commits.

## §7 Execution Queue

| Wave | Tasks | Owner files |
|---|---|---|
| 1 | DBX01-001 (importer pure modules + tests), DBX01-002 (mapping + dry-run pure + tests) | `src/core/importer/**` (new) |
| 2 | DBX01-003 (import execute module + tests) | `src/core/importer/importExecute.ts` (new) |
| 3 | DBX01-004 (extension wiring + scaffold + commands + form view + large-value editor) | `src/extension.ts`, `package.json`, `src/ui/importWizard.ts`, `src/ui/formView.ts`, `src/ui/largeValueEditor.ts`, `webview/importWizardMain.ts`, `webview/formViewMain.ts`, `src/__tests__/dbx01Scaffold.test.ts` |

## Planner Report

- PLANNER_MODEL: omp-direct (unic-code); same model did the planning, the executor loop, and the audit; per the handoff `RULES.md` strict-mode review contract, a follow-up cycle can re-review on `unic-smart` to satisfy the reviewer ≠ executor constraint.
- AUDIT_FINDING (2026-08-30): the prior `INDEX_DBX01.md` row "done" entries and `Plan Review Log` verdict are stale. The 2026-08-29 draft was accepted but no code landed; this plan re-opens the cycle.
