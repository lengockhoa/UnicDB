# TASK-BQ03-003 — QueryRunner continuation contract for BigQuery pages

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (BQ-03.3), §3 Approach "Runner continuation", §4 rows 3, 9-12

## Goal

Guarantee the runner's Load More path handles a BigQuery `BatchedQuery` page source correctly: consume ONLY the current statement's page source/token, prevent concurrent duplicate fetches, ignore a late page that settles after cancel or a new run, and release the retained job context once the page source is exhausted (or the runner is disposed). Small, driver-agnostic changes to `src/core/queryRunner.ts` — postgres/mysql/mssql cursor behavior unchanged.

## Target Files

- `src/core/queryRunner.ts` — on EOF from `fetchBatch()` (null/empty), close the batched handle and mark the statement `cursorClosed` (release of the retained job context / cursor); ensure the existing `loadMoreInFlight` serialization and `cancelSeq` post-await discard also cover a job-backed handle (they are generic — pin them with BigQuery-shaped fakes); release retained job context on `run()` start's stale-cursor sweep (existing) so a new run cannot hold a prior job.
- `src/core/__tests__/queryRunner.test.ts` — add a "BQ-03.3 BigQuery page continuation" describe block with in-file fakes (a `BatchedQuery` stub whose `fetchBatch` advances a fake token). Existing tests untouched.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Load More consumes only the current job's token | statement with a token-advancing fake handle: `loadMore(idx)` → `fetchBatch()` called with the NEXT token, appended rows match page 2, another `loadMore` gets page 3; the fetcher received page-2's token, never page-1's again | fake `BatchedQuery` returning page2 then page3 then null; assertion on recorded fetch args |
| 2 | happy | EOF releases the retained job context exactly once | third `loadMore` where `fetchBatch()` returns `null` → handle `close()` called EXACTLY once, statement marked `cursorClosed = true`; a further `loadMore` is a graceful no-op (unchanged rows, no throw, no error toast path) | fake handle with close spy |
| 3 | edge (concurrency) | concurrent duplicate fetch prevented | two `loadMore(idx)` fired without awaiting the first → serialized via the in-flight chain: fetches happen strictly sequentially, no batch lost, no duplicate rows, total rows = page2 + page3 | two deferred fetchBatch resolutions |
| 4 | edge (stale) | late page after cancel is discarded | start `loadMore`, call `runner.cancel()` while `fetchBatch` pending, resolve it late → rows NOT appended; statement stays `cancelled`; `close()` called on the handle | deferred fetch + cancel race |
| 5 | edge (stale) | late page after a NEW run is discarded | start `loadMore`, before it resolves call `runner.run([...new statements])` (allowed after prior run settled — use two runner instances sharing the fake if the single-instance guard interferes; pin whichever composition matches the real API), resolve the first fetch late → first fetch's rows never land in the new run's results | two-run fixture |
| 6 | edge (identity) | loadMore on statement #2 never touches statement #1's handle | two done statements each with own fake handle; `loadMore(1)` (second statement) → only statement #2's `fetchBatch` called; #1's handle call-count unchanged, #1's rows unchanged | two-handle fixture |
| 7 | regression | postgres cursor semantics unchanged | existing queryRunner tests (batched EOF → rowCount update; limited → resultLimited; cancel → "Statement N cancelled") all pass verbatim | current test file |
| 8 | regression | `pickResult` batched initial fetch unchanged | a BigQuery-shaped `{ results: [], batched }` RunResult through `run()` → first page fetched by `pickResult`, `rowCount` null-kept honest (Load More still offered) | minimal fake adapter returning `{ results: [], batched }` |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — new describe block appended; existing describes untouched.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck
npx vitest run src/core/__tests__/resultBatcher.test.ts   # batcher helpers untouched sanity
```

(`npm run typecheck` is the static gate — **no lint script exists** in this repo.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] EOF from `fetchBatch()` closes the handle exactly once and marks `cursorClosed`; a later `loadMore` is a graceful no-op.
- [ ] Concurrent `loadMore` on one index remains serialized (no lost/duplicate batch).
- [ ] A late page after cancel or a new run is discarded, never appended.
- [ ] Per-statement isolation: one statement's loadMore never fetches/closes another's handle.
- [ ] Non-BigQuery (postgres cursor) behavior unchanged — existing tests verbatim green.
- [ ] `npm run typecheck` exits 0.

## Dependencies

- TASK-BQ03-001 (the job-backed `BatchedQuery` shape and its EOF/cancel semantics must exist to fake faithfully; the runner changes themselves are driver-agnostic)

## Interfaces

- Consumes: `BatchedQuery` (`src/adapters/types.ts:62-67` — `columns`, `fetchBatch(): Promise<any[][] | null>`, `cancel()`, `close()`); existing `QueryRunner.loadMore/loadMoreImpl/cancel/run` internals (`loadMoreInFlight` map, `cancelSeq` re-check, `currentBatched`, `resultLimited`/`cursorClosed` markers); TASK-BQ03-001's `BigQueryPagedQuery` contract (`fetchBatch` null = EOF, exactly-once cancel) and its optional `onExhausted?.({ limited: boolean })` hook (set by the runner when constructing the handle view).
- Produces:
  - `BigQueryPagedQuery`'s `onExhausted` callback fires on the next-null-after-limited transition, calling `appendBatchBounded` (mirrors `src/core/queryRunner.ts:462-489`) so the byte-budget `limited` flag surfaces as `resultLimited` in the statement — the channel stays encapsulated in 03.1's handle view, no `BatchedQuery` interface change.
  - **Pending state field (locked by PLAN.md round-1 review)**: add a base-present field to `StatementResult` — `pending?: boolean` — set to `true` by 03.3 immediately when the adapter's `runQuery` returns a BigQuery-shaped `{ results: [], batched }` (job submitted, first page not yet fetched) and cleared on the first successful `pickResult` (i.e. the first page resolves). The marker is a `boolean` (not an enum) because `StatementResult.status` already carries `running/done/error/cancelled` — `pending` is the *pre-running* marker orthogonal to those. TASK-BQ03-004 reads `result.pending` directly to render the pending state without having to re-derive it from a `batched` boolean the panel already discards.
  - No other public API change. Behavioral contract pinned for TASK-BQ03-004: a statement whose handle is exhausted carries `cursorClosed = true` and its Load More is a no-op (panel can rely on that); rows only ever grow via resolved, non-stale fetches.

---

## Discussion

### 2026-09-03 · planner · unic-smart
Grounding notes for the executor:

1. **Most of this task already exists — pin it, then fill the one real gap.** `loadMoreInFlight` serialization (queryRunner.ts:365-385), the `cancelSeq` post-await discard (:435-437), the `resultLimited` graceful no-op (:397-399), and the run()-start stale-cursor sweep (:201-211) are generic over `BatchedQuery`. The genuinely new behavior is the EOF → `close()` + `cursorClosed` transition on a NON-limited statement (today EOF just updates rowCount and leaves the handle open — correct for postgres cursors which the sweep closes later, but a BigQuery job handle should be released as soon as its token is exhausted). Make that transition for EOF-on-fresh-handle; keep postgres behavior byte-identical by reusing the same code path (closing a postgres cursor at EOF is also correct — the sweep was doing it later — but verify the existing tests before asserting that).
2. Test #5 composition note: `runner.run()` throws "already running" only while a run is in flight; `loadMore` is independent of `running`. A single runner instance works: run once (settles), start `loadMore`, then start a second `run` — nothing in `run()` cancels an in-flight loadMore today, which is exactly the leak this test pins (the late page must be discarded by the `cancelSeq`/epoch logic, or by adding an equivalent run-generation re-check if the current one does not cover this path — check `loadMoreImpl`'s guards carefully and pin what is actually true).
3. If you find the late-page-after-new-run case is NOT covered by an existing guard, add the minimal re-check (a run-generation counter captured before the fetch await, compared after) — do NOT refactor the cancel machinery.
4. RED-first: tests #2 and #5 should fail against current code (#2: no close on EOF; #5: late rows appended). Verify, then implement.
5. Do not touch `src/core/resultBatcher.ts` (helpers are already pure and sufficient).

---

## Executor Report

## Reviewer Verdict
