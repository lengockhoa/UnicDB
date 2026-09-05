# TASK-005 -- A19 failed-row retry affordance

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.5

## Goal

Add a "Retry failed rows" button in the save banner when a partial save failure occurs (some rows succeed, some fail). Clicking it resends only the failed rows' edits through the existing save pipeline.

## Target Files

- `src/ui/messages.ts` (existing, 127 lines) -- add `retryFailedRows` message type to WebviewMessage union
- `src/ui/resultsPanel.ts` (existing, 1054 lines) -- add `handleRetryFailedRows` method that receives row IDs + edits and runs them through the save pipeline
- `webview/main.ts` (existing) -- add retry button rendering in save banner, collect errored rows' edits on click, post `retryFailedRows` message

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | bundle | `retry button appears when saveResult has rowErrors` | Button element exists in banner DOM | saveResult with rowErrors |
| 2 | bundle | `retry button hidden when saveResult has no rowErrors` | Button not present | saveResult.ok=true, no rowErrors |
| 3 | bundle | `clicking retry posts retryFailedRows message` | postToHost called with correct payload | Button clicked |
| 4 | unit | `retry message contains only failed row IDs` | message.rowIds length matches rowErrors length | 3 successes, 2 failures |
| 5 | edge | `retry with 0 failed rows` | No message posted (no-op) | rowErrors empty array |
| 6 | edge | `retry edits come from editState for failed rows only` | Snapshot contains entries only for errored rowIds | editState with mixed clean/dirty |

## Test Files

- `src/ui/__tests__/webviewRetry.test.ts` (new) -- tests for retry message construction and button rendering

## Verification Commands

```bash
npm test src/ui/__tests__/webviewRetry.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] "Retry failed rows" button appears in save banner when `rowErrors` is present
- [ ] Button is hidden when there are no row errors
- [ ] Clicking retry collects only the failed rows' dirty edits from editState
- [ ] `retryFailedRows` message is posted with correct `rowIds` and `edits`
- [ ] Host `handleRetryFailedRows` runs edits through the same save pipeline
- [ ] After retry, successful rows clear dirty state; failed rows stay dirty
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: `SaveResultMessage.rowErrors` (existing), `EditState.snapshot()` (existing), `EditState.isCellDirty()` (existing)
- Produces: `retryFailedRows` message type in messages.ts; `handleRetryFailedRows` method in resultsPanel.ts; retry button in webview banner

---

## Discussion

**Executor (cycle U) — decisions recorded:**
1. Retry payload field is named `edits` (not `failedEdits` as the cycle prompt phrased it) — the task file's Acceptance Criteria ("`retryFailedRows` message is posted with correct `rowIds` and `edits`") is authoritative and matches `SaveEditsMessage.edits`; the payload also carries `serverIndexByRowId` (same A12 addressing contract as `saveEdits`) so the host resolves failed rows' server indexes correctly on streamed/added results.
2. Host coverage lives in a SECOND new test file `src/ui/__tests__/resultsPanelRetry.test.ts` (node env) because `vi.mock("vscode")` does not resolve under jsdom — no existing test combines jsdom + the vscode mock, and `vitest.config.ts` (not a Target File) would have needed an alias otherwise. The task's listed Test File `webviewRetry.test.ts` holds all 6 required webview-side cases.
3. RED nuance: R2 (button absent on no-rowErrors ack) and H3 (empty retry no-op) pass in RED by design — they pin ABSENCE/no-op behavior that trivially holds pre-implementation and guard the GREEN implementation from over-showing/over-acking. The other 7 tests failed for the expected reasons (missing button, missing `retry` seam, missing host `retryFailedRows` handling).

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Tests written first into the task's Test Files, run against the pre-feature
  bundle (dist/webview.js compiled from unmodified source). 7 failed | 2 passed:

  Test Files  2 failed (2)
        Tests  7 failed | 2 passed (9)

  [1/7] FAIL resultsPanelRetry.test.ts > H1. retryFailedRows → same save pipeline:
        combined transaction with exactly ONE UPDATE for the failed row + ok:true ack
        AssertionError: expected undefined not to be undefined
        ❯ const combined = recorded.find((c) => /^BEGIN/i.test(c.sql.trim()));
          (host ignored retryFailedRows — no BEGIN/UPDATE was ever emitted)
  [2/7] FAIL resultsPanelRetry.test.ts > H2. edits whose rowId is NOT in rowIds are dropped
        AssertionError: expected undefined not to be undefined (same root cause)
  [3/7] FAIL webviewRetry.test.ts > R1. retry button appears when saveResult has rowErrors
        AssertionError: expected null to be truthy  (findRetryButton() → null)
  [4/7] FAIL webviewRetry.test.ts > R3. clicking retry posts retryFailedRows message
        AssertionError: expected null to be truthy  (no retry button in banner)
  [5/7] FAIL webviewRetry.test.ts > R4. retry message contains only failed row IDs
        AssertionError: expected null to be truthy  (no retry button in banner)
  [6/7] FAIL webviewRetry.test.ts > R5. retry with 0 failed rows → no message posted
        AssertionError: expected 'undefined' to be 'function'
        ❯ expect(typeof UnicDBApi()?.retry).toBe("function")  (retry seam absent)
  [7/7] FAIL webviewRetry.test.ts > R6. retry edits come from editState for failed rows only
        AssertionError: expected null to be truthy  (no retry button in banner)

  R2 + H3 passed in RED by design (absence/no-op pinning — see Discussion #3).
Verification Output: |
  $ npm run compile
  (esbuild output)
    dist/webview.js  2.3mb
    dist/extension.js  4.8mb
    dist/extension.js.map  8.0mb
  ⚡ Done in 209ms
  esbuild: build complete

  $ npm test src/ui/__tests__/webviewRetry.test.ts   (task §Verification cmd 1)
   ✓ src/ui/__tests__/webviewRetry.test.ts  (6 tests) 828ms
   Test Files  1 passed (1)
        Tests  6 passed (6)

  $ npm test   (full suite — baseline 1298 passed / 2 skipped; +9 new tests)
   Test Files  92 passed | 1 skipped (93)
        Tests  1307 passed | 2 skipped (1309)
   (0 failed)

  $ npm run typecheck
  > tsc --noEmit
  (no output — clean, exit code 0)
Status: PASS
Note: none

## Reviewer Verdict (R1 — grid/webview group)
VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
FINDINGS: no Critical/Important defects; minor notes only, non-blocking. The observed resultsGridModelNull flake (TASK-004) was not reproduced by the reviewer across two full-suite runs — treated as environment flake, not a code defect.
SOURCE: R1 review round outcome recorded in RUN.md cursor (grid/webview group).
