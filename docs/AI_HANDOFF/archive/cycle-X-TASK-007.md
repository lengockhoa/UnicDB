# TASK-007 — Webview grid hardening: real sort column, warning surfacing, quick-search requery, safe refresh confirm

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (post-audit reconciliation), §3.5

## Goal

Close the four confirmed webview-side defects from the Cycle X grid/UI audit: header-click sort on a duplicated column name posts SQL the server cannot execute, non-fatal save warnings are sent but never rendered, quick-search typing triggers full server requeries, and Refresh silently discards dirty edits because `window.confirm` does not exist in the VS Code webview sandbox.

Audit source: `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md` findings P1-2 (plus its folded-in "Rejected observations" dialect item), P1-3, P2-1, P2-5 (TASK-002, done).

## Target Files

- `webview/main.ts` — four scoped edits:
  1. **P1-2** — `orderByFromColumnState` (`webview/main.ts:2203-2213`) maps `c.colId` straight into the ORDER BY string. `colId` is the **deduped field** produced by `inferColumns` (`src/ui/resultsGridModel.ts:110-119` turns a second `id` into `id__2`), which is not the SQL name of any projected column. Resolve each `colId` back to its source column through `currentSpecs` (`const spec = currentSpecs.find(s => s.field === c.colId); const name = spec ? spec.headerName : c.colId;`) **before** `quoteColIdIfNeeded`.
  2. **P1-2 fold-in (dialect fallback)** — `detectDialectFromHeader` (`:2175`) returns `"unknown"` for Browse headers, so a Browse session on mysql/mssql quotes non-bare column names postgres-style and the host rejects the ORDER BY. Consume the driver token that `src/ui/browseCommands.ts` now appends (below); keep the existing `"unknown" → postgres` fallback intact for legacy/no-connection headers so no current behavior regresses.
  3. **P1-3** — mirror `warnings?: string[]` on the local `SaveResultMsg` (`:88-104`) and render it in `handleSaveResult` (`:3183+`) on the `ok:true` path: when `warnings` is non-empty, show the existing `dom.saveBanner` with the joined warning text (reuse the same show/hide sequence the `rowErrors` branch uses — `textContent`, `classList.remove("UnicDB-hidden")`, `removeAttribute("hidden")`). An empty/absent `warnings` must leave the banner hidden.
  4. **P2-1** — `onFilterChanged` (`:1824-1830`) calls `scheduleFilterRequery()` unconditionally, so each quick-search keystroke batch posts a full server requery with `filters: undefined`. Only schedule when a real column filter is involved: gate on the re-polled `colFilterActive` (`e.api.isColumnFilterPresent()`) or on `e.source` being a column-filter source (`"columnFilter" | "advancedFilter" | "api"` — see the AG Grid `FilterChangedEventSourceType` union). `quickFilter` alone must post nothing. Clearing the last column filter must still post its one unfiltered requery (existing `webviewServerFilter.test.ts` case 9).
  5. **P2-5** — `onRefreshClick` (`:2587-2599`) falls back to `proceed = true` when `window.confirm` is unavailable, which is the production case in the sandboxed webview: dirty edits are discarded with no prompt. Replace the `window.confirm` call **entirely** with an in-DOM confirm rendered in `dom.saveBanner` (same show/hide pattern as the save banner) offering Discard and Cancel. First Refresh click with `dirtyCount > 0` arms the banner and posts nothing; Discard clears `editState`/`undoStack` and posts the requery; Cancel hides the banner and leaves edits intact. `window.confirm` must no longer be referenced.
- `src/ui/messages.ts` — declare `warnings?: string[]` on `SaveResultMessage` (`:191-216`), documenting it as the non-fatal counterpart of `errors` that the host already sends (`src/ui/resultsPanel.ts:812-813`). Additive optional field only — no other message shape changes, and **no** typed `StateMessage.dialect` field (PLAN §2 keeps that queued).
- `src/ui/browseCommands.ts` — append the active connection's driver token to the Browse header so the webview can detect the dialect: `Browse <qualified> at <ISO>` becomes `Browse <qualified> at <ISO> — <driver>@<host>/<database>` when a connection is active (`browseCommands.ts:162`; the `active` config is already in scope at `:144`). Exactly mirrors the Run header built at `src/extension.ts:638`. Keep the `Browse <qualified> at ` prefix byte-identical so `ResultsPanel.render`'s `/^Browse (.+) at /` label extraction is unaffected.

Ownership: `webview/main.ts` is also edited by TASK-004, so this task depends on TASK-004 (see §Dependencies). No other Cycle X task touches `src/ui/messages.ts`, `src/ui/browseCommands.ts`, or any test file listed below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy (regression, P1-2) | Duplicate column sort posts the real column name | Sorting the second `id` column (`colId` `id__2`) posts exactly one `requery` whose `orderBy` is `id ASC` — the string does **not** contain `id__2`. RED today: `orderBy` is `id__2 ASC`. | Bundle + `__UnicDB.debugSetSpecs([{field:"id",headerName:"id",kind:"number"},{field:"id__2",headerName:"id",kind:"number"}])`, then `applyColumnState` on `id__2`; postgres driver header |
| 2 | edge — dialect/escaping (P1-2 fold-in) | Browse header dialect drives quoting | With header `Browse public.users at 2026-01-01T00:00:00.000Z — mysql@h/db`, sorting a column named `First Name` posts `` `First Name` ASC `` (backticks). With the legacy header `Browse public.users at 2026-01-01T00:00:00.000Z` (no driver token) the postgres fallback `"First Name" ASC` is preserved. | Bundle; two dispatched states; `debugSetSpecs` with a spaced column name |
| 3 | happy (regression, P1-3) | `ok:true` + warnings renders the banner | After `{type:"saveResult", index:0, ok:true, warnings:["row 1: ctid fallback is not safe under concurrent writes"]}`, `dom.saveBanner` is visible (no `UnicDB-hidden` class, no `hidden` attribute) and its `textContent` contains `not safe under concurrent writes`. RED today: banner stays hidden. | Bundle + dispatched state with one row |
| 4 | edge — empty/boundary (P1-3) | `ok:true` with no warnings keeps the banner hidden | `{ok:true}` and `{ok:true, warnings:[]}` both leave `saveBanner` carrying `UnicDB-hidden` and the `hidden` attribute, and `editState.dirtyCount` is `0`. | as #3, one dirty cell before the ack |
| 5 | edge — event source / no-op (regression, P2-1) | Search typing posts no requery | Typing `bet` into `.UnicDB-search-input` (three `input` events) and waiting past the 150 ms debounce yields **zero** `requery` messages, while the client-side filter still applies (`getDisplayedRowCount() === 1`). Applying a real column filter afterwards posts exactly one `requery`. RED today: the search typing posts a requery. | Bundle + 3-row state; `flushFilterDebounce` helper pattern from `webviewServerFilter.test.ts` |
| 6 | edge — data loss / missing capability (regression, P2-5) | Refresh without `window.confirm` cannot silently discard | With `window.confirm` deleted from the jsdom window and `editState.dirtyCount === 1`, `__UnicDB.refresh()` posts **zero** messages and `dirtyCount` stays `1`; the in-DOM confirm banner is visible. Clicking its Cancel control leaves `dirtyCount === 1` and posts nothing; clicking Discard sets `dirtyCount === 0` and posts exactly one `requery`. RED today: `dirtyCount` drops to 0 and a requery is posted on the first click. | Bundle + 3-row state + one simulated cell edit; `delete (window as any).confirm` |
| 7 | regression (P2-5) | Clean refresh is unchanged | With `dirtyCount === 0`, `__UnicDB.refresh()` posts exactly one `requery` immediately and the confirm banner never becomes visible. | Bundle + 3-row state, no edits |

## Test Files

- `src/ui/__tests__/webviewServerSort.test.ts` — cases 1, 2 (jsdom; existing `loadBundle`/`dispatchState`/`driverHeader` helpers and the `debugSetSpecs` seam at `webview/main.ts:3357`).
- `src/ui/__tests__/webviewSaveEdits.test.ts` — cases 3, 4 (jsdom; existing bundle + `saveResult` dispatch pattern).
- `src/ui/__tests__/webviewFilters.test.ts` — case 5 (jsdom; `.UnicDB-search-input` is queried the same way in `webviewBundle.test.ts:225`).
- `src/ui/__tests__/webviewCommitRefresh.test.ts` — cases 6, 7. **This file's two existing A13 cases (`:366-419`) stub `window.confirm` and assert it is called; they encode the behavior being removed and must be rewritten to drive the in-DOM confirm controls.** This is the single intentional test-expectation change of this task and must be called out in the Executor Report.
- `src/ui/__tests__/browseCommands.test.ts` — header-shape assertion for the driver token: `renderCalls[0].header` matches `/^Browse public\.users at .+ — mysql@/` with an active mysql connection, and keeps the `Browse public.users at ` prefix when no connection is active.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewServerSort.test.ts src/ui/__tests__/webviewSaveEdits.test.ts src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewCommitRefresh.test.ts src/ui/__tests__/browseCommands.test.ts
npx vitest run src/ui/__tests__/webviewServerFilter.test.ts src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewPerTableTabs.test.ts src/ui/__tests__/webviewExport.test.ts src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
```

`npm run compile` MUST run first — every webview suite loads `dist/webview.js` and skips silently when it is missing. The second command is the regression lane: `webviewServerFilter` case 9 pins the "clearing the last filter still requeries" contract that P2-1 must not break, `webviewPerTableTabs`/`webviewExport` carry legacy Browse-header fixtures, and `resultsPanel.test.ts` pins Browse-label extraction. `package.json` defines no lint script — `typecheck` is the static gate (PLAN §5).

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; cases 1, 3, 5 and 6 were demonstrated RED before the production edit.
- [ ] `orderByFromColumnState` resolves every `colId` through `currentSpecs` before quoting; no posted `orderBy` can contain a `__N` dedup suffix.
- [ ] `SaveResultMessage.warnings?: string[]` exists in `src/ui/messages.ts`, is mirrored in the webview, and renders on `ok:true`; an empty or absent list renders nothing.
- [ ] Quick-search input posts no `requery`; column-filter changes and the clear-last-filter case still post exactly one each.
- [ ] `window.confirm` is not referenced anywhere in `webview/main.ts`, and no code path discards dirty edits without an explicit in-DOM confirmation.
- [ ] The Browse header keeps its `Browse <qualified> at ` prefix; legacy headers without a driver token still fall back to postgres quoting.
- [ ] No typed `dialect` field is added to `StateMessage`, and no other message shape changes.
- [ ] `src/ui/resultsPanel.ts`, `src/core/**`, and `src/adapters/**` are unmodified by this task.
- [ ] The regression verification command exits 0; any assertion change beyond the two A13 cases is justified in §Discussion.
- [ ] `npm run compile` and `npm run typecheck` exit 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — grid/UI audit gate (done); source of all four findings.
- **TASK-004** — file-ownership collision: TASK-004 also edits `webview/main.ts` (whitespace-aware blank classification in the distinct/loaded typed-value lookup). Per PLAN §2 "tasks in the same wave must not modify the same file", this task runs after TASK-004, in Wave 3.

## Interfaces

- Consumes (existing, unchanged — quoted from source):
  - `interface ColumnSpec { field: string; headerName: string; kind: ColumnKind; alignRight?: boolean; hidden?: boolean }` (`src/ui/resultsGridModel.ts:25-35`), reachable webview-side as `currentSpecs: readonly ColumnSpec[]` (`webview/main.ts:347`).
  - `quoteColIdIfNeeded(colId: string, dialect: SqlDialect): string` and `detectDialectFromHeader(header: string): SqlDialect` where `SqlDialect = "postgres" | "mysql" | "mssql" | "unknown"` (`webview/main.ts:2163-2196`).
  - AG Grid `FilterChangedEvent.source?: FilterChangedEventSourceType` = `'api' | 'quickFilter' | 'columnFilter' | 'advancedFilter'`, and `GridApi.isColumnFilterPresent(): boolean`.
  - Host-sent payload `{ type: "saveResult", index, ok: true, warnings?: string[], errors?: string[], rowErrors?: Array<{rowId:number;error:string}> }` (`src/ui/resultsPanel.ts:806-816`).
  - `__UnicDB` test seams: `debugSetSpecs(specs)`, `refresh`, `editState`, `gridApi`, `simulateCellEdit` (`webview/main.ts:3368-3437`).
- Produces:
  - `SaveResultMessage.warnings?: string[]` in `src/ui/messages.ts` — non-fatal per-row messages the webview renders on `ok:true`.
  - Browse header contract `Browse <qualified> at <ISO> — <driver>@<host>/<database>` (driver-token suffix only when a connection is active).

---

## Discussion

### 2026-08-26 · planner · bao-opus
Reconciliation gate decisions and the two judgement calls behind them.

1. **Wave placement (collision found).** The gate provisionally placed this task in Wave 2, but TASK-004's Target Files already include `webview/main.ts`. Rather than merge two unrelated slices into one unreviewable task, this task depends on TASK-004 and moves to Wave 3, where it is file-disjoint from TASK-005 (`src/adapters/mysql.ts`, `src/adapters/mssql.ts`, `src/ui/queryComposer.ts`).
2. **How the Browse dialect is recovered.** The audit's folded-in item says to use a connection/driver-passed dialect "if available". It is not available webview-side: `StateMessage` has no dialect field, and PLAN §2 explicitly keeps `typed StateMessage.dialect` queued for a later cycle. The header string is already the sanctioned dialect channel for Run sessions (`detectDialectFromHeader`'s own doc comment says so), so making the Browse header carry the same token is the smallest fix that actually resolves the defect without a protocol change. A pure-webview "safer fallback" was rejected: with three mutually exclusive quoting styles and no dialect signal, every fallback either fails the same way or silently drops the user's sort.
3. **`window.confirm` removed, not guarded.** Keeping `window.confirm` with a safe `false` fallback would make Refresh a no-op in the real webview while continuing to work in jsdom — the same test/production divergence that hid this bug. The in-DOM banner behaves identically in both environments, which is why the two A13 tests are rewritten rather than patched.
4. **P2-1 gate choice.** Gate on the re-polled `isColumnFilterPresent()` (already assigned to `colFilterActive` on the line above) rather than on `e.source` alone: the existing "clear the last filter" contract (`webviewServerFilter.test.ts` case 9) arrives with the column filter already absent, so a source-only gate must still admit `api`/`columnFilter` sources. Case 5 plus the regression lane pin both directions.

### 2026-08-26 · executor · bao-sonnet (feature-implementer)
Two implementation notes for the reviewer.

1. **P2-1 source gate.** The task's gate list `("columnFilter" | "advancedFilter" | "api" — see the AG Grid FilterChangedEventSourceType union)` is implemented exactly as `e.source === "api" | "columnFilter" | "advancedFilter"`. In the AG Grid v36 shipped here, `api.setFilterModel` fires the event with `source === "api"`, so the existing clear-last-filter contract (serverFilter case 9) still posts its one unfiltered requery. To make the gate airtight I ALSO changed the quick-search input handler (`:856`) to call `gridApi.onFilterChanged("quickFilter")` instead of the bare `onFilterChanged()` — AG Grid v36's bare call defaults the source to `"api"`, which would have kept posting a requery for every keystroke batch even with the gate in place. Case 5 plus case 9 pin both directions.
2. **`src/ui/browseCommands.ts` ownership.** The orchestrator NOTE listed it as not-owned, but the task file's own §Target Files and §Test Files mandate the header token edit and the browseCommands.test.ts header-shape assertion, so I implemented the task-spec edit (driver-token suffix using `mgr.getActive()`, prefix byte-identical). Nothing else in browseCommands.ts was touched. `resultsPanel.ts`, `src/core/**`, `src/adapters/**` are unmodified.

---
## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 Test Files  4 failed | 1 passed (5)
      Tests  4 failed | 54 passed (58)

 FAIL  webviewServerSort.test.ts > TASK-007. duplicate column sort posts the real column name
AssertionError: expected 'id__2 ASC' to be 'id ASC'          // received 'id__2 ASC'
 FAIL  webviewSaveEdits.test.ts > TASK-007. saveResult ok:true warnings → banner shows warning text
AssertionError: expected true to be false                    // banner stayed hidden
 FAIL  webviewFilters.test.ts > TASK-007. quick-search typing applies client filter without server requery
AssertionError: expected [ Array(1) ] to have a length of +0 but got 1   // requery posted
 FAIL  webviewCommitRefresh.test.ts > Edge (permission/confirm) / R(A13). Refresh with dirtyCount > 0
AssertionError: expected +0 to be 1                          // dirtyCount silently discarded
```

Verification Output:
```
$ npm run compile            → esbuild: build complete (dist/webview.js rebuilt)
$ vitest run webviewServerSort webviewSaveEdits webviewFilters webviewCommitRefresh browseCommands
  Test Files  5 passed (5)      Tests  58 passed (58)
$ vitest run webviewServerFilter webviewRequery webviewPerTableTabs webviewExport resultsPanel
  Test Files  5 passed (5)      Tests  47 passed (47)     // incl. serverFilter case 9 (clear-last-filter requery)
$ npm run typecheck           → tsc --noEmit 0 errors
```

Status: PASS

Note:
- Single intentional test-expectation change: the two webviewCommitRefresh A13 cases (previously stubbing window.confirm and asserting it was called) were rewritten to drive the in-DOM refresh-confirm controls (`[data-UnicDB-refresh-discard]` / `[data-UnicDB-refresh-cancel]`); the new clean-refresh case asserts no confirm controls render and exactly one requery posts.
- `window.confirm` no longer referenced in webview/main.ts (grep-confirmed).
- src/ui/browseCommands.ts got the task-spec driver-token header edit (browseCommands.test.ts asserts `^Browse public\.users at .+ — postgres@127\.0\.0\.1/UnicDB$`); browseCommands.ts is listed as a Target File in the task file itself. resultsPanel.ts / src/core/** / src/adapters/** untouched.
- Quick-search handler now calls `gridApi.onFilterChanged("quickFilter")` so AG Grid's default `"api"` source cannot re-arm the requery on keystrokes.
- No typed StateMessage.dialect field added; no other message shape changes.

HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

---
## Reviewer Verdict
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet (isolation OK — reviewer != executor)
Status: APPROVED-WITH-MINOR
Findings:
- MINOR — `webview/main.ts:2219-2221`: the `colId → headerName` resolution is correct for the dedup
  case, but for a genuinely duplicated projection (`SELECT id, id`) both specs share
  `headerName: "id"`, so sorting either column emits `id ASC`, which Postgres rejects as
  `ORDER BY "id" is ambiguous`. Strictly better than today's unexecutable `id__2 ASC` and exactly
  what §Target Files mandates, so not blocking — but the duplicate-name case is still not sortable.
  Worth a follow-up (positional `ORDER BY <n>`) rather than a fix in this task.
- MINOR — `webview/main.ts:1835-1839`: the requery gate is `e.source`-only, while
  `FilterChangedEvent.source` is optional (`source?: FilterChangedEventSourceType`). Any AG Grid
  dispatch that omits `source` would now silently skip the server requery. Verified non-issue on the
  shipped v36 (`onFilterChanged(beans, source = "api")` defaults, column filters dispatch
  `"columnFilter"`; instrumented run observed only `["api","api"]`), and §Target Files permits the
  source-only gate. Adding `|| colFilterActive` would make it fail-safe.
- MINOR — `webview/main.ts:2617` + `:3278`: the refresh confirm reuses `dom.saveBanner`, so an
  incoming `saveResult` calls `hideSaveBanner()` and silently removes an armed Discard/Cancel prompt.
  No data loss (edits are preserved and the banner defaults to Cancel semantics), only a dropped
  refresh intent.
Verified clean (no finding):
- P1-2 dialect: `detectDialectFromHeader` whole-token parse consumes the new Browse driver token;
  legacy tokenless Browse headers still fall back to postgres quoting (webviewServerSort case 2).
- P1-3: `warnings?: string[]` declared on BOTH protocol sides (`src/ui/messages.ts:199` +
  `webview/main.ts:94`), additive-optional only, no `StateMessage.dialect`; matches the payload the
  host already sends (`src/ui/resultsPanel.ts:907`). Renders on `ok:true`, hidden on absent/empty.
- P2-5: `window.confirm` has zero references in `webview/main.ts` (grep-confirmed). The in-DOM
  confirm is CSP-safe — `createElement` + `textContent` + `addEventListener`, no `innerHTML` and no
  inline handlers. Refresh with `dirtyCount > 0` posts nothing until Discard is clicked explicitly.
- Browse header keeps the `Browse <qualified> at ` prefix byte-identical; the driver suffix contains
  no second " at ", so `resultsPanel.ts:202` label extraction is unaffected (47/47 regression lane).
  Re-polling `mgr.getActive()` at `:162` (rather than reusing the `:144` binding) is correct — it
  runs after `setActive`, so it reflects the connection actually queried.
- `src/ui/resultsPanel.ts`, `src/core/**`, `src/adapters/**` unmodified by this task's slice.
- Tests carry real assertions; RED_OUTPUT is genuine failing output, and the two rewritten A13 cases
  are the single declared expectation change (justified in §Discussion 3).
Verification Output: fresh re-run by reviewer, `npm run compile` FIRST (dist/webview.js rebuilt).
- `npm run compile` → esbuild build complete, exit 0
- targeted lane (webviewServerSort, webviewSaveEdits, webviewFilters, webviewCommitRefresh,
  browseCommands) → 5 files / 58 tests passed
- regression lane (webviewServerFilter, webviewRequery, webviewPerTableTabs, webviewExport,
  resultsPanel) → 5 files / 47 tests passed, incl. serverFilter case 9 clear-last-filter requery
- `npm run typecheck` → tsc --noEmit, 0 errors
- full suite `npx vitest run` → 110 passed | 1 skipped (111 files), 1549 passed | 2 skipped, x2 runs
NOTE (not a finding): serverSort case 18 failed intermittently in early lane runs, but only while I
had 6-8 CPU-saturating processes of my own running; under controlled A/B (HEAD vs 41eaa47, matched
load) and in both clean full-suite runs it passed every time. Attributed to reviewer-machine
contention against the suite's 150 ms filter debounce, not to this diff. Flagging so a future CI
failure on that 250 ms timing window is not misread as a new regression.
