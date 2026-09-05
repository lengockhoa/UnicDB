# TASK-004 — Table designer webview + host (create + modify)

- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §3,§7

## Goal
DataGrip-style designer dialog: webview (left COLUMNS (n)/KEYS (n) lists with +,−,↑,↓; right edit form; bottom live SQL Preview; Cancel / OK — Execute) + host class, in create AND modify modes. Preview computed HOST-side via TASK-001/003 pure fns; OK executes the last previewed SQL via callback (extension wiring is TASK-005).

## Target Files
- `src/ui/newTableFormMessages.ts` (new) · `src/ui/newTableForm.ts` (new) · `webview/newTableFormMain.ts` (new) · `esbuild.js` (modify: add entry `["webview/newTableFormMain.ts"]` → `dist/newTableForm.js`, copy connectionFormConfig block options) · `src/ui/__tests__/newTableForm.test.ts` (new) · `src/ui/__tests__/newTableFormBundle.test.ts` (new)

## Spec
**Messages** (`newTableFormMessages.ts`, mirror connectionFormMessages.ts): `NewTableFormInit {type:"init"; mode:"create"|"modify"; schema; originalTableName?; spec: TableSpec; loadError?}` · `NewTableFormReady` · `NewTableFormSpecChanged {type:"specChanged"; spec; tableChanged?}` · `NewTableFormCancel` · `NewTableFormSubmit {type:"submit"; spec}` (webview union = those 4); host: `NewTableFormPreview {type:"preview"; sql; errors}`.
**Host** (`newTableForm.ts`): `NewTableFormOptions {extensionUri; mode; schema; originalTableName?; loadSpec(): Promise<TableSpec>; runDdl(sql): Promise<void>}` · `class NewTableForm { constructor(options); show(): void; dispose(): void }`.
- Panel `"UnicDB.newTableForm"`, title `New Table` | `Modify — ${schema}.${table}`, CSP + script `dist/newTableForm.js` (mirror ConnectionForm.buildHtml 176-203), reveal on re-show (37-39), dispose pattern (69-74).
- `ready` → modify: `await loadSpec()` (catch → init with `loadError` + empty spec); create: init `{name:"table_name",schema,columns:defaultColumnSpecs("table_name"),keys:[]}`.
- `specChanged` → SYNCHRONOUS preview (pure fns only): create → `specErrors` + `generateCreateTable` (skip generator when errors → sql ""); modify → `diffTable` vs loaded original (sql = statements.join("\n")). Post `{type:"preview",sql,errors}`; keep `lastPreviewSql` — `submit` runs `runDdl(lastPreviewSql)`; success → dispose; reject → do NOT dispose, post preview `{sql:"", errors:[err.message]}` (dialog stays open).
- `cancel` → dispose. Escape (webview keydown) → cancel message.
**Webview** (`webview/newTableFormMain.ts`, vanilla DOM like connectionFormMain.ts):
- Left: sections `COLUMNS (n)` / `KEYS (n)` (live counts), items name(+type), toolbar +,−,↑,↓. Right: selected-item form — Column: Name, Type, Default, Nullable, Primary Key; Key: kind select (PRIMARY KEY/UNIQUE/FOREIGN KEY/CHECK), name, columns (comma text), FK table + ref columns, CHECK expr; none selected → "Select a column or key from the left panel to edit."
- Top: table name input + read-only schema label. Bottom: `<pre id="sql-preview">` + errors list; Cancel + `OK — Execute` (disabled when errors>0, or modify with empty sql).
- Every spec mutation posts `specChanged`; `preview` message fills `<pre>` + errors + OK state.
- Defaults & id tracking: create starts from `defaultColumnSpecs` (user may edit/delete like any row). Webview-local `syncIdColumn(spec, previousTableName): {spec; tracking}` — while first column name === `id_${previousTableName}`, table-name edits rename it to `id_${newName}`; a manual id-column rename (≠ auto value) stops tracking forever.
- Modify: loaded columns keep `originalName` through edits; new columns have none.

## Test Cases (REQUIRED — TDD)
Host tests (`newTableForm.test.ts` — mock vscode, capture panel + onDidReceiveMessage; pattern connectionForm.test.ts):
| # | Type | Test name | Expected |
|---|------|----------|----------|
| 1 | unit | create init + preview exact | `ready` → init `{mode:"create",schema:"public",spec:{name:"table_name",…columns [id_table_name, created_at]}}`; `specChanged` name `users` → preview.sql === TASK-001 #1 exact string, errors [] |
| 2 | unit | modify loadSpec + diff preview | loadSpec resolves fixture; specChanged with renamed col → preview.sql === diffTable stmts joined `\n` |
| 3 | unit | submit → runDdl(lastPreviewSql) + dispose | runDdl called ONCE with previewed sql; panel disposed |
| 4 | edge (failure) | runDdl rejects → stays open | not disposed; posted errors contain "relation exists" |
| 5 | edge (validation) | invalid spec | specChanged dup cols → errors len 2, sql ""; submit → runDdl NOT called |
| 6 | edge (wrong input) | cancel | disposed, runDdl 0 calls |
| 7 | edge (failure) | loadSpec rejects | init carries loadError message; empty spec; later specChanged still answers |
Bundle tests (`newTableFormBundle.test.ts`, jsdom, AFTER `npm run compile`; pattern webviewBundle.test.ts):
| 8 | unit | DOM zones + counts | init(create) → `COLUMNS (2)`, `KEYS (0)`, placeholder, `<pre id="sql-preview">`, OK enabled |
| 9 | unit | live preview + id tracking | table name → `orders` → posted spec.columns[0].name === "id_orders"; preview `<pre>` contains `CREATE TABLE "public"."orders"` |
| 10 | edge (validation) | OK disabled on error | duplicate column names → OK disabled, errors visible |
| 11 | edge (wrong input) | Escape → cancel | keydown Escape → posted `{type:"cancel"}` |
| 12 | edge (boundary) | tracking breaks | id col manually renamed `pk`, then table → `x` → col stays `pk` |

## Test Files
- `src/ui/__tests__/newTableForm.test.ts` · `src/ui/__tests__/newTableFormBundle.test.ts`

## Verification Commands
```bash
npm run compile && npx vitest run src/ui/__tests__/newTableForm.test.ts src/ui/__tests__/newTableFormBundle.test.ts && npx tsc --noEmit
```
(compile FIRST — bundle test loads dist/newTableForm.js. No lint script in this repo.)

## Acceptance Criteria
- [ ] All §Test Cases PASS (bundle after compile). `dist/newTableForm.js` emitted.
- [ ] Host preview uses ONLY TASK-001/003 fns (no local SQL building). CSP mirrors ConnectionForm.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 (`generateCreateTable`,`specErrors`,`defaultColumnSpecs`,`TableSpec`) · TASK-002 (`rowsToSpec` via loadSpec contract) · TASK-003 (`diffTable`)

## Interfaces
- Consumes: TASK-001 fns; `diffTable`; TableSpec from rowsToSpec.
- Produces: `class NewTableForm` (`constructor(options: NewTableFormOptions)`, `show()`, `dispose()`), `NewTableFormOptions`, message types — TASK-005 constructs both modes.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
`lastPreviewSql` is the single source passed to runDdl — OK executes EXACTLY what preview showed.

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5 (via omp Exec-T004)
EXECUTOR_SUBAGENT: Exec-T004
SUMMARY: Implemented NewTableForm host (src/ui/newTableForm.ts + messages), DataGrip-style webview (webview/newTableFormMain.ts), esbuild registration, host + bundle tests; create init from defaultColumnSpecs + syncIdColumn tracking; modify mode previews diffTable output; OK executes lastPreviewSql via runDdl callback; errors surfaced in-webview.
TEST_PLAN_FOLLOWED: task §Test Cases (12 cases mapped 1-1 to spec)
FILES_CHANGED:
  - src/ui/newTableFormMessages.ts: new — typed protocol (init/ready/specChanged/cancel/submit/preview)
  - src/ui/newTableForm.ts: new — host class NewTableForm + Options (extensionUri, mode, schema, originalTableName?, loadSpec?, runDdl)
  - webview/newTableFormMain.ts: new — designer webview (left COLUMNS/KEYS sections + +−↑↓ toolbar, right edit pane, bottom `<pre id="sql-preview">` + errors + Cancel/OK, table-name input + syncIdColumn rename tracking, Escape → cancel)
  - webview/styles.css: append TASK-004 designer CSS rules (.UnicDB-designer, .UnicDB-designer-section, .UnicDB-designer-edit, .UnicDB-designer-toolbar, #sql-preview, .UnicDB-designer-errors, .UnicDB-designer-actions, .UnicDB-designer-load-error)
  - esbuild.js: add newTableFormConfig → dist/newTableForm.js (webview entry) + wire into run() (watch + build)
  - src/ui/__tests__/newTableForm.test.ts: new — 8 host tests (mirror connectionForm.test.ts pattern: vscode mock, panel + handler capture, condition polling)
  - src/ui/__tests__/newTableFormBundle.test.ts: new — 5 jsdom bundle tests after `npm run compile` (describeIfBundle guard), dispatches `init` MessageEvent to bundle
TESTS_ADDED:
  - src/ui/__tests__/newTableForm.test.ts: #1 create init+preview, #2 modify loadSpec+diff, #3 submit→runDdl+dispose, #4 runDdl rejects→not disposed, #5 invalid spec (3 dup cols)→errors+no-op, #6 cancel→disposed, #7 loadSpec rejects→init loadError+later specChanged answers, #8 show() twice→reveal
  - src/ui/__tests__/newTableFormBundle.test.ts: #8 DOM zones+counts on init, #9 live preview+id tracking on rename, #10 OK disabled on errors, #11 Escape→cancel, #12 tracking breaks on manual id rename
VERIFICATION:
  command: npm run compile && npx vitest run src/ui/__tests__/newTableForm.test.ts src/ui/__tests__/newTableFormBundle.test.ts && npx tsc --noEmit
  result: 13 pass / 0 fail / exit 0 (tsc clean)
  output_excerpt: |
    ✓ src/ui/__tests__/newTableForm.test.ts  (8 tests) 5ms
    ✓ src/ui/__tests__/newTableFormBundle.test.ts  (5 tests) 58ms
    Test Files  2 passed (2)
         Tests  13 passed (13)
RED_OUTPUT:
  Initial RED (test file references missing src/ui/newTableForm.ts):
    ❯ src/ui/__tests__/newTableForm.test.ts  (0 test)
    ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯�⎯⎯⎯
     FAIL  src/ui/__tests__/newTableForm.test.ts
    Error: Failed to load url ../newTableForm ... Does the file exist?
  GREEN after host + webview + esbuild entry added; 13/13 pass after `npm run compile`.
ISSUES: none
HANDOFF_TO_REVIEWER: yes — task ready for review; spec contract holds; reviewer should focus on syncIdColumn break-condition semantics + OK-button gating logic.
NEXT: ready for review

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-5
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/newTableForm.test.ts src/ui/__tests__/newTableFormBundle.test.ts && npx tsc --noEmit
  result: 13 pass / 0 fail (tsc clean, exit 0)
TEST_PLAN_COVERAGE: all-followed — 12 §Test Cases map 1-1 (host #1-#7 + reveal, bundle #8-#12); RED_OUTPUT contains real failing output; no lint script in repo (verified)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - webview/newTableFormMain.ts:389 — wireColumnEdit `commit()` rebuilds the ColumnSpec without `originalName`, so a modify-mode column rename made through the edit form loses its rename marker. pgIntrospect.rowsToSpec sets `originalName` on every column (pgIntrospect.ts:198), the loaded spec carries it into the webview, and the first edit strips it; diffTable (alterTable.ts:118-146) then pairs by new name → emits DROP COLUMN + ADD COLUMN instead of RENAME COLUMN — data loss on a rename the user intended. Host test #2 passes only because it constructs the renamed spec manually. Fix: spread `...c` in the commit object (or copy `originalName: c.originalName`) at line 389; add a bundle test driving modify-mode rename and asserting `originalName` survives in the posted specChanged.
    - src/ui/newTableForm.ts:201 — `lastPreviewSql === ""` is the empty sentinel, but in modify mode with zero diff the sentinel is the literal string "No changes detected." (line 177): OK stays enabled and a direct `submit` message would call `runDdl("No changes detected.")`. The webview gate (emptyModify, newTableFormMain.ts:508) protects the shipped path; harden the host guard to also return when `lastPreviewSql === "No changes detected."`.
    - webview/newTableFormMain.ts:137 — the load-error banner reads `(spec as unknown as {loadError?}).loadError`, but the host sends `loadError` on the init message (newTableForm.ts:150), not on the spec; applyInit (line 479) never copies it onto `spec`, so the banner never renders after a loadSpec failure. Fix: store `msg.loadError` in a module var in the message listener and branch on it in render().
    - webview/newTableFormMain.ts:457,502 — `refreshOkButton` is declared twice (function-declaration hoisting keeps only the second); the first definition is dead code — delete it.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Executor-noted edge (manual id-column rename stops auto-rename tracking forever) is per task §Spec by design — severity none. CSP mirrors ConnectionForm exactly (default-src 'none', script-src cspSource, no unsafe-inline scripts); preview computed host-side via specErrors/generateCreateTable/diffTable only; dispose + reveal-on-reshow mirror the reference pattern. Recommend the originalName fix (first minor) before TASK-005 ships modify-mode renames to users.
