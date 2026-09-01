# TASK-ARP02-001 — Runner ownership: idempotent cancel + run-bounded close-origin cancellation

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP02.md` §3, §4 (ARP-02.1)

## Goal

Make `QueryRunner.cancel()` idempotent and bound the persistent `cancelRequested` flag to the run it was
issued for, and make an in-flight `loadMore` re-check cancel after its `fetchBatch` await. Three RED cases
(confirmed by probe on `main @ 367cb80`):

1. **Seam double-fire** — `cancel()` twice on an in-flight NON-batched run calls
   `adapter.cancelActiveQuery()` TWICE (`src/core/queryRunner.ts:392-401` has no delivered-once guard).
2. **Close-origin poison** — `cancel()` on an idle/settled runner sets `cancelRequested=true` (`:377`),
   only reset at the START of the next `run()` (`:127`); a later `loadMore` then throws `Statement 0
   cancelled` at `loadMoreImpl:327` even though the cursor is healthy.
3. **Late settle mutates cancelled** — `loadMore` in flight when `cancel()` fires appends its batch after
   cancel settles (`loadMoreImpl:334-351` never re-checks `cancelRequested` post-await, unlike
   `executeAll:206/:225`).

Deliverable: one idempotent live-work ownership model at the runner — cancellation is exactly-once,
close-origin cancel cannot target later work, and late settlement cannot turn a cancelled state done or
append to it.

## Target Files

- `src/core/queryRunner.ts` — only. Do NOT touch `src/ui/resultsPanel.ts` or `src/core/connectionManager.ts`
  (owned by TASK-ARP02-002 / -003 in the same wave).
- `src/core/__tests__/queryRunner.test.ts` — ADD cases; keep all existing blocks intact (incl. the RLX-001
  seam suite `:616-840`).

## Test Cases (REQUIRED — TDD)

RED-first: write cases 2, 4, 5 FIRST, run them, paste the RED output, then implement. Cases 1, 3, 6 are
expected GREEN on base (regression pins).

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy (regression) | cancel active non-batched run once → seam once, status cancelled | `cancelActiveQuery` called exactly 1x; deferred `runQuery` resolves after → `status === "cancelled"` | RLX-001 seam fixture (`makeAdapter` with `cancelActiveQuery` spy + deferred `runQuery`) |
| 2 | edge: idempotency | double cancel on a non-batched in-flight run fires the seam exactly once | two sequential `await runner.cancel()` while `runQuery` still deferred → `cancelActiveQuery` exactly **1x**; settle → `status === "cancelled"`. **RED on 367cb80** (probe: spy 2x) | deferred `runQuery`, deferred seam not required |
| 3 | edge: idempotency | double cancel on a batched in-flight run → `batched.cancel` 1x, seam never | `currentBatched` in flight (deferred initial `fetchBatch`); two cancels → `batched.cancel` 1x, `cancelActiveQuery` **0x** (GREEN on base — PID window at `:195` and `currentBatched` at `:203` are disjoint; pin) | `makeBatched` with deferred `fetchBatch` |
| 4 | edge: close-origin | cancel on an idle/settled runner must not poison a later `loadMore` | run a batched SELECT to `done` (open cursor); `await runner.cancel()`; then `loadMore(0)` resolves and appends → rows `[[1],[2]]`. **RED on 367cb80** (probe: throws `Statement 0 cancelled`) | batched `fetchBatch` seq: initial `[[1]]`, loadMore `[[2]]` |
| 5 | edge: late settle | `loadMore` in-flight when cancel fires must not append after settle | start `loadMore(0)` (deferred fetch), `await runner.cancel()`, then resolve fetch `[[42]]` → final rows stay `[[1]]`; no unhandled rejection. **RED on 367cb80** (probe: `[[1],[42]]`) | batched seq: initial `[[1]]`, loadMore deferred |
| 6 | edge: late settle | cancel mid-run; deferred settle after → status stays cancelled, never done | regression pin on `executeAll` post-await re-checks (`:206`, `:225`): a deferred `runQuery`/`fetchBatch` settling after cancel yields `cancelled`, never `done` | existing RLX-001 / cancel-batched fixtures |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — ADD cases 2-6 (case 1 is the existing RLX-001 Test#1;
  keep it green unchanged). Reuse `makeAdapter` `:56-72`, `makeBatched` `:39-53`, the seam adapter shape at
  `:617-639`.

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

- [ ] RED-first proof pasted: cases 2, 4, 5 fail on base 367cb80 BEFORE implementation (probe outputs
      were: seam spy 2x; `Statement 0 cancelled`; rows `[[1],[42]]`).
- [ ] After fix: case 2 GREEN (seam exactly 1x); case 4 GREEN (loadMore works after idle cancel); case 5
      GREEN (no post-cancel append; cursor closed idempotently).
- [ ] Case 3 GREEN unchanged (batched double-cancel idempotent; seam never fires on the batched path).
- [ ] All existing `queryRunner.test.ts` blocks still green (RLX-001 seam suite, cancel, append, loadMore,
      batched, stale-cursor release).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] No change to `resultsPanel.ts` / `connectionManager.ts` (same-wave disjointness).
- [ ] Executor Report maps the deferred settlement timelines (cancelled-after-settle, cancel-during-loadMore,
      close-origin-cancel) with no unhandled promise path (concurrency review item).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `none` (wave 1 — runs in parallel with TASK-ARP02-002 and TASK-ARP02-003; no shared files).

## Interfaces

- Consumes:
  - `DbAdapter.cancelActiveQuery?(): Promise<void>` — optional seam, `src/adapters/types.ts` (RLX-01).
  - `BatchedQuery.cancel()/close()/fetchBatch()` — `src/adapters/types.ts`.
  - `QueryRunner.cancel(): Promise<void>` — `src/core/queryRunner.ts:376-402`.
  - `QueryRunner.loadMore(index: number): Promise<StatementResult[]>` — `:291-311` (loadMoreImpl `:313-358`).
- Produces: no new public API. Internal only: a delivered-once guard for the seam branch and a run-bounded
  cancel flag. `isRunning()`/`isCancelled()`/`getResults()` signatures unchanged.

## Discussion

- The exact mechanism for bounding `cancelRequested` is the executor's choice: (a) reset it in `run()`'s
  `finally` (`:157-165`) in addition to entry `:127`, and/or (b) a separate in-flight flag consulted by
  `loadMore`. Cases 4 and 5 are the contract — whatever the predicate, both must stay green together
  (in particular, a close-origin cancel landing during a `loadMore` must still cancel THAT cursor while
  not poisoning a subsequent healthy `loadMore`; assert case 4/5 both ways).
- Do NOT use the adapter's `close()` as cancellation (acceptance item) — the seam stays the only
  non-batched cancellation channel, and only once per run.
- (no comments yet)
- **Executor decision (TASK-ARP02-001, 2026-09-02):** implemented the task Discussion option (b) — a
  separate in-flight-scoped flag — rather than relying on the `run()` `finally` reset alone, exactly as
  the plan-review note bound. Details in the Executor Report below (timelines section).

---

## Executor Report

```
STATUS: PASS
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (cases 2, 4, 5 on base b032b98, BEFORE implementation):
 RUN  v1.6.1 .worktrees/task-arp02-001
 ❯ src/core/__tests__/queryRunner.test.ts  (37 tests | 3 failed) 180ms
   ❯ ...Test #2 — ARP02-001 case 2: double cancel ... seam exactly once
     → expected "spy" to be called 1 times, but got 2 times
   ❯ ...Test #4 — ARP02-001 case 4: cancel on an idle/settled runner ... loadMore
     → Statement 0 cancelled
         ❯ QueryRunner.loadMoreImpl src/core/queryRunner.ts:328:13
   ❯ ...Test #5 — ARP02-001 case 5: loadMore in-flight when cancel fires ...
     → expected [ [ 1 ], [ 42 ] ] to deeply equal [ [ 1 ] ]
 Tests  3 failed | 34 passed (37)
 All three failures match the task's predicted probe outputs (seam spy 2x;
 "Statement 0 cancelled"; rows [[1],[42]]). Cases 3 and 6 were GREEN on base
 as expected (regression pins) — none of the 5 added tests was immediately
 green when it should have been red.

IMPLEMENTATION SUMMARY (src/core/queryRunner.ts only):
 Exactly-once / ownership model, three mechanisms:
 1. Idempotency guards in cancel():
    - Batched branch: new `currentBatchedCancelDelivered` latched before the
      first batched.cancel()/close(); a second cancel() for the same
      in-flight cursor returns immediately (case 3 pin: batched.cancel 1x,
      seam 0x).
    - Non-batched branch: new `seamDelivered` latched before the first
      adapter.cancelActiveQuery(); second cancel() while the PID window is
      open is a no-op (case 2: seam exactly 1x). Both guards reset at run()
      entry AND in run()'s finally, so each run can deliver its seam once.
    - The adapter close() is still never used as a cancellation channel —
      the seam stays the only non-batched channel.
 2. In-flight-scoped cancel ownership (load-bearing, per plan-review note):
    new `cancelPending` flag, set in cancel() ONLY when the cancel targets
    LIVE work (currentBatched or activeAdapter non-null). loadMoreImpl's
    entry guard now rejects on `cancelRequested && cancelPending`
    (previously: bare cancelRequested) — so a close-origin cancel on an
    idle/settled runner (case 4) leaves only the sticky `cancelRequested`,
    which no longer poisons a later healthy loadMore. The run()'s finally
    also closes `cancelPending`, but the guard is NOT relying on that reset
    alone: a post-settle cancel sets only the sticky flag and stays
    harmless by construction.
 3. Post-await re-check in loadMoreImpl (load-bearing): `cancelSeq`
    increments on every cancel(); loadMoreImpl snapshots it before the
    fetchBatch await and discards the late batch when the sequence advanced
    (case 5: no post-cancel append). The run()-finally reset cannot cover
    this because the cancel arrives after the finally — the sequence
    re-check is what closes it.
 Sticky `cancelRequested` / isCancelled() semantics are UNCHANGED for
 consumers (resultsPanel.ts error-toast suppression reads isCancelled()
 after a cancel-during-loadMore; keeping it sticky preserves that). Note:
 resultsPanel.ts / connectionManager.ts were NOT touched.

DEFERRED SETTLEMENT TIMELINES (concurrency review item — no unhandled
promise path):
 A. cancelled-after-settle (case 6 / regression pin):
    cancel() [seam fires once, seamDelivered latched] → cancelRequested=
    true, cancelPending=true → runQuery resolves → executeAll post-await
    re-check (:206) marks cancelled (never done) → run() finally:
    cancelPending=false, PID window closed. Late cancel after that = sticky
    flag only. No pending promise outlives the run.
 B. cancel-during-loadMore (case 5):
    loadMoreImpl sets currentBatched=cursor, snapshots cancelSeq=N →
    fetchBatch parked → cancel(): cancelSeq=N+1, cancelPending=true,
    batched.cancel()+close() delivered ONCE (delivered-guard latched),
    currentBatched=null, cancelPending=false → fetchBatch resolves late →
    cancelSeq mismatch → batch DISCARDED, loadMore resolves with unchanged
    results. The loadMore promise always settles (resolve path; rejection
    path equally handled by existing guards) → no unhandled rejection.
 C. close-origin-cancel (case 4):
    run() fully settled (cancelPending=false from finally; PID window
    closed; currentBatched=null) → idle cancel(): sets sticky
    cancelRequested only; liveCancel=false so cancelPending stays false;
    seam guard sees activeAdapter=null → no-op (RLX-001 Test #3 contract
    preserved) → later loadMoreImpl entry guard
    (cancelRequested && cancelPending) is false → loadMore proceeds
    healthy. If instead an idle-cancel landed DURING an in-flight
    loadMore's fetch (mid-flight variant), the cancelSeq re-check still
    cancels THAT cursor via currentBatched + discards its late batch —
    both directions of the Discussion's "assert case 4/5 both ways" hold.

VERIFICATION OUTPUT (worktree .worktrees/task-arp02-001, branch
handoff/task-arp02-001):
 1. npx vitest run src/core/__tests__/queryRunner.test.ts
    → Test Files  1 passed (1)
      Tests  37 passed (37)     [exit 0]
      (32 pre-existing incl. full RLX-001 seam suite :616-840 + 5 new)
 2. npm run typecheck  → tsc --noEmit, no output   [exit 0]
 3. npm run compile    → "esbuild: build complete" [exit 0]
 git status: only src/core/queryRunner.ts (+106/-1) and
 src/core/__tests__/queryRunner.test.ts (+212) modified. No commits made
 (per instruction).

ISSUES: none.
HANDOFF_TO_REVIEWER: yes — all acceptance criteria met except the reviewer
verdict item itself; task ready for pending_review.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
