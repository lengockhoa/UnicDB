# TASK-003 — Eliminate NULL/viewer aggregate flake at bundle lifecycle root

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.2

## Goal

Make `resultsGridModelNull.test.ts` deterministic by evaluating the webview bundle once, reusing/resetting one grid lifecycle, and waiting for observable AG Grid state rather than elapsed time. Do not add retries, production test hooks, or longer arbitrary sleeps.

## Target Files

- `src/ui/__tests__/resultsGridModelNull.test.ts` — one suite bundle lifecycle, per-test state reset, AG Grid animation flush, and bounded observable waits.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | Long read-only value opens one viewer | After replacing column `s` with `editable: false`, a double-click creates exactly one `.vsdb-value-viewer` whose text is exactly 500 `x` characters. | One evaluated bundle; `GridApi.flushAllAnimationFrames()` then `vi.waitFor` |
| 2 | edge — ordering/load | Shuffled suite remains deterministic | Five single-thread shuffled seeds pass all NULL/viewer cases with no retry and no fixed 50 ms waits. | Seeds 1–5 after `npm run compile` |
| 3 | edge — cleanup/state | Prior editor/viewer cannot leak | Before each case there is no active editor and no viewer; after editable-null double-click editing count is `> 0` and viewer count is `0`. | Previous case may have opened viewer/editor |
| 4 | regression | Bundle installs one message lifecycle | Bundle evaluation occurs once for the describe block rather than once per `it`; case 6 no longer races five stale message handlers/timer closures. | Existing six cases currently call `loadBundle()` independently |
| 5 | edge — interaction | Viewer close path remains usable | Escape closes the open viewer and the following case starts with zero overlays. | Read-only long-string viewer open |

## Test Files

- `src/ui/__tests__/resultsGridModelNull.test.ts` — contains all cases; no new test-only production API.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts
for seed in 1 2 3 4 5; do npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts --poolOptions.threads.singleThread --sequence.shuffle.tests --sequence.seed=$seed || exit 1; done
npm run typecheck
```

`compile` must precede Vitest because the test loads `dist/webview.js`. `package.json` has no lint script.

## Acceptance Criteria

- [ ] Bundle evaluation and `window.message` listener installation happen once per suite.
- [ ] Tests use `GridApi.flushAllAnimationFrames()` and bounded `vi.waitFor` for observable transitions; no retry and no increased fixed sleep.
- [ ] Editor and overlay state is reset through existing APIs/interactions, not a production test-only method.
- [ ] Long content remains full, plain text, exactly 500 characters.
- [ ] Isolated run and all five shuffled single-thread seeds exit 0.
- [ ] `npm run typecheck` exits 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — the UI audit gate must complete before any Cycle X UI fix wave starts.

## Interfaces

- Consumes: existing `GridApi` methods `getEditingCells(): CellPosition[]`, `stopEditing(...)`, `setGridOption(...)`, and `flushAllAnimationFrames(): void`; bundle debug getter `window.__vsdb.gridApi`.
- Produces: deterministic test harness only; no production interface.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Confirmed source evidence: each current `loadBundle()` executes the whole bundle, whose anonymous `window.addEventListener("message", ...)` cannot be removed by the test. Case 6 is the sixth evaluation. Preserve behavior while fixing this lifecycle leak.

### 2026-08-26 · executor · claude-code/bao-sonnet
Implemented the single-evaluation/shared-grid approach. The reset uses the existing host message lifecycle plus `stopEditing`, Escape, row cleanup, and `flushAllAnimationFrames`; observable DOM/API boundaries are awaited with bounded `vi.waitFor`. No retry or fixed 50 ms waits remain. The initial RED exposed stale DOM/state after per-test bundle evaluation: test 2 saw one unexpected `.vsdb-null`, and test 3 saw two spans instead of one; this confirmed the lifecycle problem before the reset harness was completed.

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Targeted RED after the first failing-state harness change (single bundle evaluation plus shared reset still incomplete):

  FAIL src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — NULL cell display + value viewer > 2. non-null value renders normally (no .vsdb-null)
  AssertionError: expected 1 to be +0 // Object.is equality
  ❯ src/ui/__tests__/resultsGridModelNull.test.ts:296:58
      294|     getGridApi()?.flushAllAnimationFrames();
      295|     await waitForGrid(() =>
      296|       expect(root.querySelectorAll(".vsdb-null").length).toBe(0),
      297|     );

  FAIL src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — NULL cell display + value viewer > 3. undefined value renders "(NULL)" same as null
  AssertionError: expected 2 to be 1 // Object.is equality
  ❯ src/ui/__tests__/resultsGridModelNull.test.ts:328:30
      326|     const nullSpans = root.querySelectorAll(".vsdb-null");
      327|     expect(nullSpans.length).toBe(1);

  This was the deterministic RED from stale shared bundle/grid state; after completing the observable reset boundary, the targeted suite passed.

Verification Output:
  1. `npm run compile`
     PASS — esbuild completed; dist/webview.js 2.2mb, dist/webview.css 22.2kb.
  2. `npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts`
     PASS — 8 tests passed, 1 file passed.
     Tail:
       ✓ src/ui/__tests__/resultsGridModelNull.test.ts  (8 tests) 342ms
       Test Files  1 passed (1)
       Tests  8 passed (8)
       Start at 13:18:11
       Duration 747ms (transform 20ms, setup 0ms, collect 23ms, tests 342ms, environment 237ms, prepare 27ms)
  3. `for seed in 1 2 3 4 5; do npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts --poolOptions.threads.singleThread --sequence.shuffle.tests --sequence.seed=$seed || exit 1; done`
     PASS — all five seeds passed, 8 tests each.
     Tails:
       seed 1: Tests 8 passed (8), Duration 643ms
       seed 2: Tests 8 passed (8), Duration 707ms
       seed 3: Tests 8 passed (8), Duration 678ms
       seed 4: Tests 8 passed (8), Duration 685ms
       seed 5: Tests 8 passed (8), Duration 640ms
  4. `npm run typecheck`
     PASS — `tsc --noEmit` exited 0.
  5. `npm test`
     PASS — 108 test files passed, 1 skipped; 1494 tests passed, 2 skipped, 0 failed.
     Tail:
       ✓ src/ui/__tests__/webviewPerTableTabs.test.ts  (6 tests) 967ms
       ✓ src/ui/__tests__/webviewServerFilter.test.ts  (5 tests) 2236ms
       Test Files 108 passed | 1 skipped (109)
       Tests 1494 passed | 2 skipped (1496)
       Start at 13:16:47
       Duration 11.26s (transform 2.92s, setup 4ms, collect 9.02s, tests 51.60s, environment 13.55s, prepare 5.20s)

Status: PASS
Note: none

---
