# TASK-ARP03-002 — Runner enforcement: retained-row cap + one-shot cursor close + graceful no-op

- Status: `pending_review`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (ARP-03.2)

## Goal

Wire the retained-result budget into `QueryRunner.loadMoreImpl`: own the cap constant, consume the pure
helper `appendBatchBounded` from TASK-ARP03-001, and enforce that at the cap the cursor is closed exactly
once, no further fetch happens, and the statement is marked so the limit is **neither an error nor false
EOF** (a later `loadMore` is a graceful no-op that returns unchanged rows). This MUST compose with the
ARP-02 cancel-ownership fields (`cancelPending`, `cancelSeq`, `currentBatchedCancelDelivered`,
`seamDelivered`, `currentBatched`, `activeAdapter`) — cancel still wins over the budget close.

RED cases (verified on base `main @ f17cc6f`):
1. Oversized next batch → capped prefix, cursor closed exactly 1x, no further fetch, `resultLimited: true`.
2. Second `loadMore` on a limited statement → graceful no-op (no throw), close still exactly 1x.
3. Concurrent cancel during a cap-crossing fetch → batch discarded, `resultLimited` NOT set.
4. Smaller result unchanged (regression pin — must stay green on base).

Deliverable: `RETAINED_ROW_CAP` constant (exported), the budget enforcement inside `loadMoreImpl`, the new
optional `resultLimited` field, and a guarded early-return that prevents a limited statement from surfacing
the "run this statement alone" cursor-closed error.

## Target Files

- `src/core/queryRunner.ts` — only (plus its unit test). Do NOT touch `resultBatcher.ts`
  (owned by TASK-ARP03-001), `resultsPanel.ts` (TASK-ARP03-003) or `webview/main.ts` (TASK-ARP03-004).
  Existing `appendBatch`, `batchStats`, `mergeBatchIntoResult` stay as-is.
- `src/core/__tests__/queryRunner.test.ts` — ADD cases; keep all existing blocks intact (RLX-001 seam
  suite, ARP-02 cancel tests #2-#6 at `:802-1052`).

## Test Cases (REQUIRED — TDD)

RED-first: write cases 1-3 FIRST, run them, paste the RED output (expect: no `RETAINED_ROW_CAP` export /
oversized batches append beyond the cap / `resultLimited` undefined), then implement. Case 4 is expected
GREEN on base (regression pin).

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | edge: oversized | cap-crossing batch → capped prefix, close once, no future fetch | `RETAINED_ROW_CAP - 2` rows retained, next batch of 3 → `result.rows.length === RETAINED_ROW_CAP`, prefix equals prior rows + first batch row (deterministic); `r.resultLimited === true`; `cursorClosed === true`; `batched.close` called exactly **1x**; `batched.fetchBatch` NOT called again. **RED on base** (today: all rows append, no limit, cursor stays open) | `makeBatched` with `fetchBatch` seq: initial `RETAINED_ROW_CAP - 2` rows, then a 3-row batch, then (must not be reached) more; `close` spy |
| 2 | edge: idempotent no-op | second `loadMore` on a limited statement is a graceful no-op | after case-1 limit: `await runner.loadMore(0)` resolves with rows unchanged (length `RETAINED_ROW_CAP`), **no throw**; `batched.close` total still **1x**; `batched.fetchBatch` count frozen. **RED on base** (today: `cursorClosed` → throws "run this statement alone") | same fixture as case 1, second `loadMore` |
| 3 | edge: concurrent cancel wins | cancel during the cap-crossing fetch discards the batch | start `loadMore(0)` (deferred `fetchBatch` returning `RETAINED_ROW_CAP`-overflowing batch); `await runner.cancel()`; then resolve fetch → rows unchanged (no append, length stays pre-fetch), `resultLimited` undefined, cursor closed exactly once (by the cancel path), no unhandled rejection | `makeBatched` with deferred `fetchBatch` resolving an oversized batch AFTER cancel |
| 4 | happy (regression) | smaller result unchanged | batched total « `RETAINED_ROW_CAP` fetched across several `loadMore` → all rows appended; `resultLimited` undefined; `cursorClosed` stays false; EOF at `null` behaves as today; `batched.close` NOT called. **GREEN on base** (pin) | existing `makeBatched` fixtures, EOF `null` tail |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — ADD cases 1-4 after the ARP-02 block (`:802-1052`). Reuse
  `makeAdapter` (`:56-72`) and `makeBatched` (`:39-53`). Use the real `RETAINED_ROW_CAP` constant (import it)
  — do not fabricate a smaller cap in tests unless the test explicitly demonstrates boundary behavior by
  building `RETAINED_ROW_CAP`-sized sequences.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `queryRunner.ts` → `.cache/index/tests-map.json` =
`[queryRunner.test.ts, queryRunner.integration.test.ts]`. `queryRunner.integration.test.ts` is DB-gated
and EXCLUDED from this DB-free focused run — `queryRunner.test.ts` is the pinned target. No lint script;
typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: cases 1-3 fail on base `f17cc6f` BEFORE implementation (probe: oversized
      batch fully appended; no `RETAINED_ROW_CAP`; no `resultLimited`); case 4 GREEN on base (regression pin).
- [ ] Case 1 GREEN: capped prefix, `resultLimited`, `cursorClosed`, `close` exactly 1x, no further fetch.
- [ ] Case 2 GREEN: graceful no-op — the limited-entry guard runs BEFORE the `cursorClosed` throw at
      `src/core/queryRunner.ts:368-370` so no "run this statement alone" error surfaces.
- [ ] Case 3 GREEN: cancel wins over the budget close; the limit close and the cancel close are mutually
      exclusive by ordering (budget check runs after the `cancelSeq` re-check at `:403-405`).
- [ ] Case 4 GREEN unchanged (byte-for-byte prior behavior below the cap).
- [ ] All existing `queryRunner.test.ts` blocks still green (RLX-001 seam suite, ARP-02 cancel tests,
      append, loadMore, batched, stale-cursor release).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] No change to `resultBatcher.ts`, `resultsPanel.ts`, or `webview/main.ts` (disjoint ownership).
- [ ] Executor Report maps the cancel-vs-limit timelines with no unhandled promise path (concurrency review
      item).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `TASK-ARP03-001` (wave 2 — consumes `appendBatchBounded`; must NOT start before 001 is approved).

## Interfaces

- Consumes:
  - `appendBatchBounded(current: any[][], batch: any[][], maxRows: number): { rows: any[][]; limited: boolean }` — from `src/core/resultBatcher.ts` (TASK-ARP03-001).
  - `BatchedQuery.fetchBatch(): Promise<any[][] | null>` / `close()` / `cancel()` — `src/adapters/types.ts`.
  - ARP-02 fields on the runner: `cancelPending`, `cancelSeq`, `currentBatched`,
    `currentBatchedCancelDelivered` (all present in the current `src/core/queryRunner.ts`).
  - `QueryRunnerOptions { batchSize?: number }` — `src/core/queryRunner.ts:57-60` (add the new option field here).
- Produces:
  ```ts
  // src/core/queryRunner.ts
  export const RETAINED_ROW_CAP = 10_000; // conservative, driver-independent primary gate
  // QueryRunnerOptions gains (additive):
  //   maxRetainedRows?: number   // default RETAINED_ROW_CAP — keeps tests/consumers explicit without touching default behavior
  // StatementResult gains (additive, optional):
  //   resultLimited?: boolean    // true iff the retained-row cap was hit and the cursor closed for the budget
  ```
  Existing public API (`loadMore`, `cancel`, `isRunning`, `getResults`, `run`) signatures unchanged.

## Discussion

- **Placement of the budget check.** It runs AFTER the `cancelSeq` re-check (`:403-405`) and replaces the
  bare `appendBatch(currentRows, batch)` at `:414` with `appendBatchBounded(currentRows, batch, cap)`.
  On `limited === true`: close the cursor (best-effort idempotent — reuse the same delivered-once guard the
  ARP-02 cancel path uses, so `close` fires exactly once total), set `cursorClosed = true`,
  `r.resultLimited = true`, and keep `rowCount = rows.length` (the returned prefix length — there is no
  separate `retained` field on the helper). On `limited === false`: exact today's behavior
  (case 4 must be byte-identical).
- **Entry guard order is load-bearing.** The new limited guard `if (r.resultLimited) return this.results.slice()`
  MUST come before the `cursorClosed` throw at `:368-370` — a limited statement has `cursorClosed = true`,
  so without the guard the second `loadMore` (case 2) would throw. The ARP-02 cancel entry guard
  (`cancelRequested && cancelPending`, `:385-387`) is unchanged and checked later.
- **Cancel vs limit mutual exclusion.** The budget close happens only after the `cancelSeq` re-check passes,
  so a cancel landing mid-fetch (a) discards the batch at `:403-405`, (b) closes the cursor via the ARP-02
  cancel path, and (c) never sets `resultLimited`. The executor must prove in the report that no timeline
  yields BOTH a cancel close AND a budget close on the same cursor.
- **Cap default.** `QueryRunnerOptions.maxRetainedRows` defaults to `RETAINED_ROW_CAP`; the option exists so
  tests and future consumers can lower it without editing the constant. Do NOT thread the option into
  `StatementResult` — the marker is the observable contract for 03.3/03.4.
- (no comments yet)

---

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
IMPLEMENTATION SUMMARY:
- src/core/queryRunner.ts: exported RETAINED_ROW_CAP = 10_000; QueryRunnerOptions
  gained maxRetainedRows?: number (default RETAINED_ROW_CAP); StatementResult gained
  optional resultLimited?: boolean; loadMoreImpl got (a) a resultLimited entry guard
  BEFORE the cursorClosed throw (graceful no-op — returns unchanged rows, no error,
  no false EOF) and (b) the budget check after the cancelSeq re-check: bare
  appendBatch replaced by appendBatchBounded(currentRows, batch, this.maxRetainedRows);
  on limited: sets currentBatchedCancelDelivered = true (same delivered-once guard the
  ARP-02 cancel path uses), best-effort closes the cursor exactly once, sets
  cursorClosed = true + resultLimited = true, rowCount = retained prefix length.
  appendBatch / batchStats / mergeBatchIntoResult untouched; resultBatcher.ts NOT
  modified (appendBatchBounded consumed as-is from TASK-ARP03-001).
RED_OUTPUT (npx vitest run src/core/__tests__/queryRunner.test.ts, BEFORE implementation):
  ❯ src/core/__tests__/queryRunner.test.ts  (41 tests | 2 failed) 191ms
    ❯ ... > cap-crossing batch → capped prefix, close once, no future fetch, resultLimited
      → expected [] to have a length of NaN but got +0
      at :1085  expect(rows).toHaveLength(RETAINED_ROW_CAP - 2)
      → RETAINED_ROW_CAP is not exported yet (undefined - 2 = NaN)
    ❯ ... > second loadMore on a limited statement is a graceful no-op
      → expected undefined to be true // Object.is equality
      at :1112  expect(limited[0].resultLimited).toBe(true)
      → resultLimited field does not exist yet; on base the second loadMore
        would instead throw "cursor closed after its run finished — run this
        statement alone" (cursorClosed throw at :368-370)
    (Test Files 1 failed (1) / Tests 2 failed | 39 passed)
    Case 4 (smaller result unchanged) was GREEN on base pre-implementation —
    regression pin confirmed (all 39 pre-existing tests also passed in RED run).
GREEN: same command → "Tests 41 passed (41)".
CANCEL-VS-LIMIT TIMELINE PROOF (no timeline yields BOTH closes on one cursor):
- The budget branch sits strictly AFTER the post-await `cancelSeq` re-check.
- T1 cancel before loadMore entry: entry guard (cancelRequested && cancelPending)
  or the run-path close throws/closes before any fetch — budget never runs.
- T2 cancel DURING fetchBatch: cancel() bumps cancelSeq, calls batched.cancel()
  + close() once, nulls currentBatched; loadMoreImpl resumes, sees
  cancelSeq !== snapshot, returns early — batch discarded, resultLimited never
  set, no second close (case 3 asserts close === 1x, cancel === 1x, rows
  unchanged, resultLimited undefined).
- T3 cancel AFTER fetch resolves but before the re-check microtask: still
  caught — cancelSeq advanced before the re-check line executes (JS single
  thread; cancel() ran to its seq bump synchronously at entry).
- T4 budget close first, THEN cancel: statement is now resultLimited +
  cursorClosed; a later cancel sees currentBatched === null (reset in the
  loadMoreImpl finally) and, being close-origin (runner settled), sets only the
  sticky flag — cancel() has no currentBatched branch to deliver again and
  never re-closes. currentBatchedCancelDelivered is also already true.
- T5 double budget: impossible — after the first limited append, r.resultLimited
  makes every later loadMoreImpl return at the entry guard; fetchBatch is never
  reached again (case 2 asserts fetchBatch frozen at 2 calls, close total 1x).
VERIFICATION OUTPUT:
  1) npx vitest run src/core/__tests__/queryRunner.test.ts
     → Test Files  1 passed (1) / Tests  41 passed (41)
  2) npm test   (fresh worktree; first run had 11 pre-compile dist-missing
     failures — ran `npm run compile`, reran)
     → Test Files  215 passed | 1 skipped (216)
     → Tests  2995 passed | 2 skipped (2997)   [0 failed; the 2 skips are
       src/ai/omp/__tests__/acpLiveSmoke.test.ts, gated on UnicDB_OMP_SMOKE=1 —
       pre-existing env gate, unrelated; baseline floor (2997 collected, no
       failures) met. Worktree HEAD == main c136182.]
  3) npm run typecheck  → exit 0 (tsc --noEmit clean)
  4) npm run compile    → exit 0 (esbuild build complete)
  Note: npm test was run twice (before + after compile) — the mid-run re-run was
  a suite-order fix for the fresh worktree's missing dist/, not a flake.
ISSUES: none.
HANDOFF_TO_REVIEWER: yes — status flipped to pending_review; reviewer model must
  differ from unic-code.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```

## Reviewer Report
REVIEWER_MODEL: unic-smart
ROUND: 1
VERDICT: CHANGES-REQUESTED
Findings:
- important — src/core/queryRunner.ts:466-471 + cancel() :524-527: the budget close sets `this.currentBatchedCancelDelivered = true` and then `await batched.close()` while `currentBatched` still references the cursor. A `cancel()` landing in that window computes `liveCancel = true` (non-null `currentBatched`), sets `cancelPending = true`, then early-returns on the delivered-once guard — leaving `cancelPending` stuck true. A later `loadMore` on a DIFFERENT open statement (non-append multi-statement with multiple open cursors, or an adopted cursor) then throws "Statement cancelled" at the ARP-02 entry guard (:417-419) — a close-origin cancel poisoning a healthy loadMore, which the ARP-02 contract (queryRunner.ts:91-104) explicitly forbids. Fix (minimal): null `this.currentBatched` before `await batched.close()` in the limited branch so a concurrent cancel sees close-origin state (`liveCancel=false`, `cancelPending` stays false); the finally at :478-480 already guards the reset. Same-statement loadMore is unaffected (resultLimited entry guard no-ops first), which is why case 2 does not catch this.
- minor — the task's RED list claims case 3 (concurrent cancel wins) fails on base, but it is a GREEN regression pin: ARP-02's cancelSeq re-check (pre-existing) already discards the late batch, so case 3 passes on base. Executor's RED output honestly shows 2 failed/39 passed (cases 1-2 only). Task-spec inaccuracy, not an executor defect.
- minor — no runner-level exact-boundary test (plan §4 line 66 lists "exact cap reached across batches is not limited"); the boundary is exercised only at the helper level (001 test #2). Runner behavior is correct by delegation (`limited=false` → no close, no resultLimited) but untested at the runner boundary.

## Fix Round 1 Report

```
STATUS: DONE
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (npx vitest run src/core/__tests__/queryRunner.test.ts --testNamePattern "budget close",
BEFORE the fix — reproduces the reviewer's interleaving exactly):
 FAIL ... > cancel() during the budget close does not poison a later loadMore on another statement
 Error: Statement 1 cancelled
 ❯ QueryRunner.loadMoreImpl src/core/queryRunner.ts:418:13
     417|     if (this.cancelRequested && this.cancelPending) {
     418|       throw new Error(`Statement ${index} cancelled`);
 Test Files  1 failed (1) | Tests  1 failed | 42 skipped (43)
→ exactly the ARP-02 isolation violation: cancel() latched in the budget-close
  window (currentBatched still set + delivered-once guard consumed →
  cancelPending stranded true), then a loadMore on a DIFFERENT open statement
  threw "Statement 1 cancelled" at the entry guard. RED at the predicted line.
Boundary pin (plan §4, "exact cap reached across batches is not limited") ran
GREEN pre-fix as a regression pin, as expected.

FIX (src/core/queryRunner.ts, limited branch only): `this.currentBatched = null`
moved BEFORE `await batched.close()`. A cancel() landing during the budget
close now sees close-origin state (currentBatched === null → liveCancel=false
→ cancelPending stays false, sticky flag only) instead of latching against the
consumed delivered-once guard. The finally reset is reference-guarded
(`if (this.currentBatched === batched)`) so the early null is idempotent with
it. No other branch touched.

TIMELINE PROOF for the fixed window (extends the round-0 T1-T5 table with T6):
- T6 cancel DURING budget close: currentBatched already nulled before the
  await → cancel() takes the close-origin path (no currentBatched branch, no
  seam — PID window closed), sets only the sticky flag, cancelPending stays
  false. Budget close completes → statement resultLimited + cursorClosed;
  the OTHER open statement's loadMore proceeds healthy. Test asserts
  batchedA.close === 1x total, batchedA.cancel === 0x, then loadMore(1)
  fetches normally. No timeline yields a stranded cancelPending.

VERIFICATION OUTPUT (all fresh, current turn):
  1) npx vitest run src/core/__tests__/queryRunner.test.ts src/ui/__tests__/webviewResultLimit.test.ts
     → Test Files  2 passed (2) / Tests  49 passed (49)
       (queryRunner 43 passed — 41 prior + 2 new; webviewResultLimit 6 passed)
  2) npm test
     → Test Files  216 passed | 1 skipped (217)
     → Tests  3007 passed | 2 skipped (3009)   [0 failed; floor 3005 + 2 new
       = 3007 exact. The 2 skips are the pre-existing UnicDB_OMP_SMOKE env gate.]
  3) npm run typecheck → exit 0
  4) npm run compile   → exit 0 ("esbuild: build complete")

MINORS APPLIED (same fix round, per instruction):
- webviewResultLimit.test.ts:161 — dropped the unused `itIfBundle` constant
  (describeIfBundle already gates the whole suite; behavior unchanged).
  Comment added so the plain-`it` convention is not "fixed" back by accident.
- webview/main.ts:3275-3294 — hoisted the transactionOpen + durationMs suffix
  into one `suffix` const shared by the truncation branch and the normal path
  (output byte-identical).
- Runner-level exact-boundary test added: "exact cap reached across batches is
  not limited" — batches sum to exactly RETAINED_ROW_CAP → resultLimited
  undefined, close not called, cursor open, following EOF loadMore unchanged
  (plan §4 ARP-03.2 boundary row).

ISSUES: none.
HANDOFF_TO_REVIEWER: pending orchestrator — this is fix round 1 output;
re-review required (reviewer model must differ from unic-code).
```
