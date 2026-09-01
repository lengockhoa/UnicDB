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

---

## Executor Report

```
(write here: STATUS / EXECUTOR_TOOL / EXECUTOR_MODEL / EXECUTOR_SUBAGENT / RED_OUTPUT /
 VERIFICATION output / ISSUES / HANDOFF_TO_REVIEWER)
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
