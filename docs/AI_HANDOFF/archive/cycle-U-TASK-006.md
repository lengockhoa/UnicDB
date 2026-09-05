# TASK-006 -- Post-commit grid refresh after save

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.6

## Goal

After a successful saveEdits operation, automatically requery the server to refresh the grid with fresh data. This prevents stale row values (e.g. computed defaults like `now()` that changed on commit). The previous batched cursor is closed before the requery to avoid connection leaks.

## Target Files

- `webview/main.ts` (existing) -- after `saveResult.ok === true`, post `requery` message to host with current WHERE/ORDER BY; clear dirty state for saved rows before requery
- `src/ui/resultsPanel.ts` (existing) -- ensure `handleRequery` properly closes previous cursor before requery (already does, verify no regression)

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | bundle | `saveResult.ok triggers requery post` | `postToHost` called with `{type:"requery", index, where, orderBy}` | saveResult.ok=true |
| 2 | bundle | `requery uses current WHERE from requery bar` | message.where matches input value | WHERE bar has value |
| 3 | bundle | `requery uses current ORDER BY from sort state` | message.orderBy matches sort state | Column sorted |
| 4 | unit | `dirty state cleared for saved rows after saveResult.ok` | editState.isCellDirty returns false for saved rows | Dirty cells saved |
| 5 | edge | `post-commit refresh when cursor is open` | Previous cursor closed before requery | Batched cursor active |
| 6 | edge | `saveResult with rowErrors does NOT trigger auto-requery` | No requery posted when partial failure | saveResult with rowErrors |

## Test Files

- `src/ui/__tests__/webviewPostCommit.test.ts` (new) -- tests for post-commit requery triggering

## Verification Commands

```bash
npm test src/ui/__tests__/webviewPostCommit.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] Successful save (saveResult.ok=true) triggers automatic requery
- [ ] Requery uses current WHERE/ORDER BY state from the requery bar and sort
- [ ] Dirty state is cleared for saved rows before requery fires
- [ ] Previous batched cursor is closed before requery starts
- [ ] Partial failures (rowErrors present) do NOT trigger auto-requery
- [ ] Grid re-renders with fresh server data after requery completes
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: `SaveResultMessage` (existing), `requery` message type (existing), `handleRequery` in resultsPanel.ts (existing), `EditState.clearExceptRowIds()` (existing)
- Produces: Updated saveResult.ok handler in webview that posts requery

---

## Discussion

**Executor decisions (cycle U, feature-implementer):**

1. **Test 5 placement.** The task lists one new Test File (`webviewPostCommit.test.ts`, jsdom bundle env), but test case 5 is host-side (`ResultsPanel.handleRequery`). `vi.mock("vscode")` does not resolve under vitest's jsdom environment in this repo — documented precedent: `webviewRetry.test.ts` (jsdom bundle) pairs with `resultsPanelRetry.test.ts` (node). Following that precedent, test 5 was added as a new describe in `src/ui/__tests__/resultsPanelRequery.test.ts` (the existing test file for Target File `src/ui/resultsPanel.ts`). Test cases 1-4 + 6 live in the new `webviewPostCommit.test.ts` as specified.
2. **RED scope.** Tests 1-4 failed RED as expected (no requery posted after saveResult). Test 5 passed immediately — the task file itself says handleRequery "already does" close the cursor; kept as regression guard. Test 6 (rowErrors → no requery) passed pre-implementation because no requery existed at all; it guards the new gating branch, and was confirmed to still pass after the feature landed.
3. **`refused` soft-refusal.** Post-commit requery is skipped when `saveResult.refused === true` — nothing was committed (mysql/mssql no-PK refusal), so there is no fresh server data to fetch. Not covered by the task's test table; noted here.
4. **`index` source.** The requery posts `msg.index` (the statement that was actually saved) rather than `activeTab` — correct if the user switches tabs while the save is in flight. Matches `onRequeryClick`'s message shape otherwise.
5. **Cycle T overlap.** Cycle T's "refresh after save" was only state-echo re-render handling (grid applies fresh values when the host posts a new state). No auto-requery existed before this task; the delta is the automatic `requery` post on `saveResult.ok === true` without rowErrors.


---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
$ npm test src/ui/__tests__/webviewPostCommit.test.ts   (dist/webview.js built from PRE-change source)

 FAIL  src/ui/__tests__/webviewPostCommit.test.ts > webview/main.ts post-commit requery (TASK-006) > 1. saveResult ok:true ⇒ posts exactly one requery { type:'requery', index, where, orderBy }; grid then re-renders with fresh server data
AssertionError: expected [] to have a length of 1 but got +0
 FAIL  src/ui/__tests__/webviewPostCommit.test.ts > webview/main.ts post-commit requery (TASK-006) > 2. post-commit requery carries the CURRENT WHERE from the requery bar
AssertionError: expected [] to have a length of 1 but got +0
 FAIL  src/ui/__tests__/webviewPostCommit.test.ts > webview/main.ts post-commit requery (TASK-006) > 3. post-commit requery carries the CURRENT ORDER BY from the sort state
AssertionError: expected [] to have a length of 1 but got +0
 FAIL  src/ui/__tests__/webviewPostCommit.test.ts > webview/main.ts post-commit requery (TASK-006) > 4. dirty state cleared for saved rows BEFORE the requery fires (isCellDirty false; ordering captured at post time)
AssertionError: expected [] to have a length of 1 but got +0

 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
```
Test 6 (rowErrors → no requery) passed pre-implementation — no requery existed at all yet; it is the gating guard and still passes GREEN after the feature. Test 5 (host-side cursor close) passed immediately — the task file itself states handleRequery "already does" this ("verify no regression"); it is kept as a regression guard with a close-before-runSql ordering assertion.

Verification Output:
```
$ npm run compile
⚡ Done in 128ms
esbuild: build complete

$ npm test            (final run; one earlier full run hit a known load-timing flake in pre-existing resultsGridModelNull.test.ts test 6 — see Note)
 Test Files  93 passed | 1 skipped (94)
      Tests  1313 passed | 2 skipped (1315)
   Start at  19:14:28
   Duration  10.00s

$ npm run typecheck
> UnicDB@1.6.3 typecheck
> tsc --noEmit
(exit 0, no output)
```
Baseline was 1307 passed / 2 skipped → now 1313 passed = +6 new tests (5 in webviewPostCommit.test.ts, 1 in resultsPanelRequery.test.ts), 0 failed.

Status: PASS
Note: One pre-existing flaky test observed: `resultsGridModelNull.test.ts > 6. value viewer overlay shows full content for long strings` failed in 2 of 3 full-suite runs (identical code in all 3), passed in the 3rd full run and in isolation. The test's own comment flags it as load-sensitive ("under full-suite load the flush is not synchronous"), and it never dispatches saveResult / touches the requery path — unrelated to this task's delta (file contains 0 references to saveResult). Implementation: on `saveResult.ok` with no rowErrors, dirty state is cleared first, then exactly one `requery` is posted with the current requery-bar WHERE/ORDER BY (index = msg.index); requery is skipped on soft refusal (`refused`) and on partial failure (rowErrors). No production change was needed in resultsPanel.ts (cursor close verified by new regression test).

## Reviewer Verdict (R1 — grid/webview group)
VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
FINDINGS: no Critical/Important defects; minor notes only, non-blocking. The observed resultsGridModelNull flake (TASK-004) was not reproduced by the reviewer across two full-suite runs — treated as environment flake, not a code defect.
SOURCE: R1 review round outcome recorded in RUN.md cursor (grid/webview group).
