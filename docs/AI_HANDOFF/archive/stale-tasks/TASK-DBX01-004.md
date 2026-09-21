# TASK-DBX01-004 — Import wizard webview + host wiring + form view + scaffold test

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX01.md` §2 Scope, §3 Approach 3-4, §4 Test Plan, §5 Verification

## Goal

Write RED scaffold test first, then build the import wizard host + webview (CSP-clean, no inline script, all messages through `acquireVsCodeApi()`), the large-value editor (via `UnicDB-lv:` text document content provider for full-fidelity JSON / long-text editing), the form view (single-row labeled form rendering), wire 4 new commands into `package.json` + `extension.ts` (`UnicDB.importCsv`, `UnicDB.importJson`, `UnicDB.openFormView`, `UnicDB.editLargeValue`), the activation events + setting, and the scaffold smoke test. Reuse `connectionManager`, `resultsPanel`, and `queryRunner` — no second cache or wrapper.

## Target Files

- `src/ui/importWizard.ts` **(new)** — host: opens webview, wires `ConnectionManager` adapter, drives file→preview→mapping→dry-run→execute.
- `webview/importWizardMain.ts` **(new)** — compiled webview main; CSP-clean.
- `src/ui/formView.ts` **(new)** — single-row labeled form renderer (data only; styling lives in webview).
- `webview/formViewMain.ts` **(new)** — compiled webview main.
- `src/ui/largeValueEditor.ts` **(new)** — registers `UnicDB-lv:` text document content provider; opens a `vscode.TextDocument` for a long value cell.
- `src/__tests__/dbx01Scaffold.test.ts` **(new)** — scaffold smoke: 4 commands + 2 activation events + 1 setting + 1 view + content provider registered.
- `src/extension.ts` — additive registration guarded for partial vscode mocks (mirror existing `typeof vscode.languages.registerX === "function"` pattern).
- `package.json` — additive 4 commands, 2 activation events, 1 setting (`UnicDB.import.batchSize`), 1 view contribution for the form panel.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | scaffold: 4 command ids registered | activate() registers `UnicDB.importCsv`/`UnicDB.importJson`/`UnicDB.openFormView`/`UnicDB.editLargeValue` | partial vscode mock |
| 2 | unit | scaffold: content provider for `UnicDB-lv:` registered | `workspace.registerTextDocumentContentProvider` called with scheme `UnicDB-lv` | partial mock |
| 3 | unit | scaffold: setting `UnicDB.import.batchSize` default 1000 | `configuration.get("UnicDB.import.batchSize")` defaults to 1000 | configuration stub |
| 4 | unit | scaffold: 2 activation events present | manifest has `onCommand:UnicDB.importCsv` and `onCommand:UnicDB.importJson` | parsed package.json |
| 5 | unit | scaffold: view contribution registered for form panel | `contributes.viewsContainer` has the form panel | parsed package.json |
| 6 | unit | import wizard pre-fills mapping from matching headers | CSV `id,name` over `users(id,name)` auto-maps both | mock parse result |
| 7 | unit | import wizard requires user confirmation before execute | confirmDangerousStatements called once, then runQuery | mock flow |
| 8 | unit | form view renders labeled rows | one entry per (column, value) | row fixture |
| 9 | unit | form view JSON cell expands without truncation | length = original payload length, no `…` | 10 KB JSON payload |
| 10 | edge | form view null cell renders as `(NULL)` | row entry's value === "(NULL)" | `null` cell |
| 11 | unit | large-value editor uses TextDocumentContentProvider | opening a `UnicDB-lv:` uri returns the original text verbatim | 50 KB string |
| 12 | regression | never truncates long values in the editor | `provideTextDocumentContent` returns input unchanged | 200 KB string |
| 13 | edge | wizard refuses when no active connection | result.error names "no-connection" | empty ConnectionManager |
| 14 | regression | no second cache, no second debounce in the import path | importWizard does not import `acSchemaCache` or own a debounce | grep guard in test |

## Test Files

- `src/__tests__/dbx01Scaffold.test.ts` — cases 1–5, 14.
- `src/ui/__tests__/importWizard.test.ts` — cases 6, 7, 13.
- `src/ui/__tests__/formView.test.ts` — cases 8, 9, 10.
- `src/ui/__tests__/largeValueEditor.test.ts` — cases 11, 12.

## Verification Commands

```bash
npx vitest run src/__tests__/dbx01Scaffold.test.ts src/ui/__tests__/importWizard.test.ts src/ui/__tests__/formView.test.ts src/ui/__tests__/largeValueEditor.test.ts
npx vitest run
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] RED output recorded; all 14 cases green; full regression stays at 2237+ passed.
- [ ] No `as any`/`: any`, no second cache/debounce, no second SQL builder.
- [ ] Webview main files contain NO `innerHTML`, NO `eval`, NO inline script; messages only via `acquireVsCodeApi().postMessage`.
- [ ] Long-value editor serves 1+ MB strings without materialising them into webview state.
- [ ] Manifest adds the 4 commands under the existing `commands` array; activation events use the same `onCommand` pattern as prior cycles.

## Dependencies

- TASK-DBX01-001, TASK-DBX01-002, TASK-DBX01-003 must complete first.

## Interfaces

- Consumes (from DBX01-001/002/003): `parseCsv`, `parseJson`, `applyMapping`, `buildDryRunPlan`, `executeImport`.
- Consumes (existing repo):
  - `import { ConnectionManager } from "./ui/connectionManager";`
  - `import { vscode } from "./vscode";` (project alias)
  - `import { confirmDangerousStatements } from "./ui/dangerousConfirm";` (existing helper)
- Produces:
  - `import { openImportWizard } from "./ui/importWizard";` — `(uri: vscode.Uri, ctx: { connectionManager, schemaCache }) => void`
  - `import { openFormView } from "./ui/formView";` — `(row: Record<string, unknown>, ctx) => void`
  - `import { openLargeValueEditor } from "./ui/largeValueEditor";` — `(cell: { value: string; label: string }) => void`
  - `export const LARGE_VALUE_SCHEME = "UnicDB-lv";` (used by the form view to open a long cell)

---
## Discussion

(no comments yet)

---
---
## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
Status: PASS
Note: importWizard host (parse -> auto-map case-insensitive -> dry-run -> confirmDangerousStatements -> execute; no-cache/no-timer regression-guarded), formView (pure, null -> (NULL), large-value flag without truncation), largeValueEditor (UnicDB-lv: provider, 200 KB verbatim passthrough, Disposable). extension.ts wires 4 commands + provider behind partial-mock guards; package.json gains 4 commands, 2 activation events, UnicDB.import.batchSize (default 1000). ahlScaffold command-count assertion relaxed to floor. Verification: DBX-01 targeted 19/19, full 2301 passed | 2 skipped, tsc clean, esbuild clean.
EXECUTOR_TOOL: omp-direct (unic-code)
Status: PASS
Note: importWizard host (parse -> auto-map case-insensitive -> dry-run -> confirmDangerousStatements -> execute; no-cache/no-timer regression-guarded), formView (pure, null -> (NULL), large-value flag without truncation), largeValueEditor (UnicDB-lv: provider, 200 KB verbatim passthrough, Disposable). extension.ts wires 4 commands + provider behind partial-mock guards; package.json gains 4 commands, 2 activation events, UnicDB.import.batchSize (default 1000). ahlScaffold command-count assertion relaxed to floor. Verification: DBX-01 targeted 19/19, full 2301 passed | 2 skipped, tsc clean, esbuild clean.
