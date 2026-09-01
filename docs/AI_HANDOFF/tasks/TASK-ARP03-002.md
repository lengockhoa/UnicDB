# TASK-ARP03-002 — Runner enforcement: retained-row cap + one-shot cursor close + graceful no-op

- Status: `ready`
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
(write here: STATUS / EXECUTOR_TOOL / EXECUTOR_MODEL / EXECUTOR_SUBAGENT / RED_OUTPUT /
 IMPLEMENTATION SUMMARY / VERIFICATION OUTPUT / ISSUES / HANDOFF_TO_REVIEWER)
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
