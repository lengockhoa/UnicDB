# TASK-504 — WHERE/ORDER BY bar + requery

- Status: `pending_review`
- Owner: `Exec504`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Bar 2 input WHERE + ORDER BY + nút Re-Run: wrap query gốc `SELECT * FROM (<sql>) vsdb_sub WHERE … ORDER BY …` rồi chạy lại qua QueryRunner.

## Target Files

- `src/ui/resultsGridModel.ts` — `composeRequery(sql, where, orderBy)`: strip trailing `;`, escape đúng chỗ (không inject khác), empty where/orderBy bỏ clause.
- `webview/main.ts` — WHERE/ORDER BY inputs + Re-Run button trên grid panel; post `{type:'requery', index, where, orderBy}`.
- `src/ui/messages.ts` + `src/ui/resultsPanel.ts` + `src/extension.ts` — handle requery: compose → runner.run → render lại.
- `src/ui/__tests__/resultsGridModelRequery.test.ts`.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | composeRequery happy | `SELECT * FROM (SELECT a FROM t) vsdb_sub WHERE a>1 ORDER BY a DESC` | sql+where+orderBy |
| 2 | unit | chỉ where / chỉ orderBy | clause tương ứng xuất hiện, clause kia vắng | 1 input empty |
| 3 | edge | cả hai empty | trả nguyên sql (strip `;`) | `"SELECT 1;"` |
| 4 | edge | sql gốc multi-statement / có `;` giữa | dùng statement của index đang render (executor note cách lấy — lấy nguyên đoạn sql của statement) | |
| 5 | integration | Re-Run click → postMessage requery đúng | message shape | jsdom |

## Test Files

- `src/ui/__tests__/resultsGridModelRequery.test.ts`
- `src/ui/__tests__/webviewRequery.test.ts` (bundle-eval integration: requery bar DOM + click → postMessage shape).

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsGridModelRequery.test.ts
npm run typecheck
```

## Acceptance Criteria
- [x] Tests PASS.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- (none về code, nhưng chạy sau 501 để UI panel sẵn)

## Interfaces

- Consumes: (none)
- Produces: `function composeRequery(sql: string, where: string, orderBy: string): string`; message `{ type:'requery'; index: number; where: string; orderBy: string }`.

---

## Discussion


## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec504
SUMMARY: Implemented `composeRequery` pure-logic helper + persistent WHERE/ORDER BY "Re-Run" bar in the webview grid panel + `requery` host-side handler that runs the composed SQL through `QueryRunner.runSql` and refreshes the grid.
TEST_PLAN_FOLLOWED: task §4 + inline (Test #1 happy + #2 single fragment + #3 both-empty + #4 multi-statement + #5 webview integration). All 5 rows covered (Test #5 covered as 4 sub-cases in webviewRequery.test.ts).
FILES_CHANGED:
  - src/ui/resultsGridModel.ts: added `composeRequery(sql, where, orderBy)` (pure-logic, no DOM/vscode) — strips trailing `;`, splits on `;` for multi-statement input, trims fragments, wraps as `SELECT * FROM (<last-non-empty-segment>) vsdb_sub WHERE … ORDER BY …`.
  - src/ui/messages.ts: added `RequeryMessage { type:'requery'; index; where; orderBy }` to the `WebviewMessage` union.
  - src/ui/resultsPanel.ts: imports `composeRequery`; adds `case "requery"` in `handleMessage` + new `handleRequery(index, where, orderBy)` that composes SQL, runs through `this.runner.runSql`, swaps the entry at `index` in `lastResults`, re-derives the `tableByStatement` map for save flow continuity, and posts a fresh `state`. Errors surface as a per-statement `error` status (webview's existing `vsdb-error` placeholder). Cancel-during-requery is treated like cancel-during-loadMore (silent re-post).
  - webview/main.ts: new `RequeryMsg` type in the local mirror union; imports `composeRequery`; new persistent requery bar (`.vsdb-requery-bar`) inside the grid wrap with WHERE input, ORDER BY input, Re-Run + Clear buttons — created ONCE in `buildPersistentDom` and survives every re-render. `renderGrid`'s non-persistent children cleanup now also skips the bar (by class). New `onRequeryClick` posts `{type:'requery', index: activeTab, where, orderBy}`. Persistent DOM interface gained 4 fields (`requeryWhere`, `requeryOrderBy`, `requeryRunBtn`, `requeryClearBtn`).
  - src/ui/__tests__/resultsGridModelRequery.test.ts (new): 13 unit tests across 5 describe blocks (happy, single fragment, both empty, multi-statement, passthrough).
  - src/ui/__tests__/webviewRequery.test.ts (new): 4 bundle-eval integration tests (bar renders in DOM, click → message shape, empty strings carry, Clear empties).
TESTS_ADDED:
  - src/ui/__tests__/resultsGridModelRequery.test.ts: 13 tests (composeRequery — happy path ×3, single fragment ×3, both empty ×3, multi-statement ×3, no double-wrap ×1).
  - src/ui/__tests__/webviewRequery.test.ts: 4 tests (1 renders, 2 click posts message shape, 3 empty strings, 4 Clear empties).
VERIFICATION:
  command: npm run compile
  result: dist/webview.js + dist/extension.js built clean (no errors).
  output_excerpt: |
    ⚡ Done in 122ms
    esbuild: build complete
  command: npx vitest run src/ui/__tests__/resultsGridModelRequery.test.ts src/ui/__tests__/webviewRequery.test.ts
  result: 2 files, 17 passed (13 unit + 4 integration).
  output_excerpt: |
    ✓ src/ui/__tests__/resultsGridModelRequery.test.ts  (13 tests) 2ms
    ✓ src/ui/__tests__/webviewRequery.test.ts  (4 tests) 363ms
    Test Files  2 passed (2)
         Tests  17 passed (17)
  command: npm run typecheck
  result: 0 errors.
  output_excerpt: |
    > vsdb@1.3.2 typecheck
    > tsc --noEmit
  command: npx vitest run (full suite)
  result: 31 files passed, 2 failed (pre-existing — see ISSUES), 373 tests passed, 3 failed (pre-existing).
ISSUES:
  - Pre-existing failures on main (NOT regressions from TASK-504):
    * src/ui/__tests__/webviewKeybinding.test.ts > B1 — `vsdb-save-banner` querySelector returns null after `dispatchState()` + `saveResult` (refused). Reproduced on a clean checkout via `git stash` — fails identically without my changes.
    * src/ui/__tests__/webviewKeybinding.test.ts > B2 — same root cause (banner persistence across re-render).
    * src/ui/__tests__/webviewSaveEdits.test.ts > T4 — `vsdb-save-banner` null on `ok:false` saveResult ack.
    All three look for `.vsdb-save-banner` immediately after a saveResult dispatch, which appears to fail because the bundle's `dom` reference is lost across the synchronous test sequence (the banner element exists in `gridWrap` but the test does not mount `gridWrap` to the panel because there is no ResultsPanel host). These are orthogonal to TASK-504 — out of scope per task Constraints ("compile BEFORE vitest. No commits.").
  - Design decision recorded (per design doc): WHERE/ORDER BY fragments are USER-INTENDED SQL (VSDB is a SQL client). No escaping. An invalid fragment surfaces as a database error from the runner.
  - `runner.isCancelled?.()` — optional-chained since the test fakes used in `resultsPanelSaveEdits.test.ts` (and possibly some adapter mocks) may not implement `isCancelled`. Safe no-op when undefined.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review.


