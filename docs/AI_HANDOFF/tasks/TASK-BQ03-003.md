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

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  ✓ src/core/__tests__/queryRunner.test.ts  (52 tests | 4 failed) — captured after
  initial implementation run. Failing tests (RED state before GREEN):
    - Test #2 — EOF releases the retained job context exactly once; further
      loadMore is a graceful no-op
      → expected undefined to be true (cursorClosed not set at EOF)
    - Test #4 — late page after cancel is discarded; close() called on the
      handle
      → Test timed out (mockImplementationOnce consumed by initial fetch,
        not loadMore; fixed in test by reordering the override to AFTER
        runner.run())
    - Test #5 — late page after a NEW run is discarded; first fetch's rows
      never land in new run
      → Same mock-ordering issue; fixed in test by reordering
    - Test #9 — BQ onExhausted({ limited: true }) surfaces as resultLimited
      on the statement
      → expected undefined to be true (resultLimited not set by onExhausted)
Verification Output: |
  ## npx vitest run src/core/__tests__/queryRunner.test.ts
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-bq03-003
   ✓ src/core/__tests__/queryRunner.test.ts  (52 tests) 238ms
   Test Files  1 passed (1)
        Tests  52 passed (52)

  ## npm run typecheck
  > UnicDB@1.49.0 typecheck
  > tsc --noEmit
  (no output, exit 0)

  ## npx vitest run src/core/__tests__/resultBatcher.test.ts
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-bq03-003
   ✓ src/core/__tests__/resultBatcher.test.ts  (14 tests) 3ms
   Test Files  1 passed (1)
        Tests  14 passed (14)
Status: PASS
Note: Implementation matches spec — EOF close + cursorClosed + cursorExhausted
  for BQ-shaped handles (duck-typed via 'onExhausted' in batched), onExhausted
  callback wired to set resultLimited, runGeneration counter closes the
  late-page-after-new-run leak, pending field set/cleared on BQ-shaped
  runResult. Non-BQ (postgres cursor) paths stay byte-identical — all existing
  ARP03-002 boundary tests, sweep tests, and the cursorClosed throw tests
  pass verbatim. The 'cursorExhausted' field is the new minimum to distinguish
  BQ-EOF close (graceful no-op) from sweep close (existing throw); documented
  in StatementResult JSDoc.

## Reviewer Verdict
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
MODEL_ISOLATION: PASS — executor unic-code ≠ reviewer unic-smart (config handoff.reviewer.model)
VERIFICATION_RERUN:
  - npx vitest run src/core/__tests__/queryRunner.test.ts → 52/52 PASS (fresh)
  - npm run typecheck → exit 0 (fresh)
  - npx vitest run src/core/__tests__/resultBatcher.test.ts → 14/14 PASS (fresh)
  - (extra) npx vitest run src/ui/__tests__/resultsPanel.test.ts → 52/52 PASS (sibling 03.4, same wave commit dafc032)
TEST_PLAN_COVERAGE: all-followed — all 9 spec test cases implemented with real assertions; RED_OUTPUT contains genuine pre-GREEN failures (4 failing tests with messages). Scope check: commit dafc032 touched only queryRunner.ts, its test, resultsPanel.ts + test — bigquery.ts and resultBatcher.ts untouched by THIS task (the 5de036d..HEAD stat includes BQ03-001/002 waves).
Verdict: Changes-requested

FINDINGS:
  CRITICAL:
    - src/core/queryRunner.ts:502 + :326 vs src/adapters/bigquery.ts:557/:586 — the runner duck-types BQ handles via
      `"onExhausted" in batched` and installs the hook with `bq.onExhausted = ...`, but the real `BigQueryPagedQuery` that
      TASK-BQ03-001 shipped stores the hook in `private onExhaustedCb` behind `setOnExhausted(cb)` and has NO own
      `onExhausted` property. In production the `in` check is false → `isBqShaped` false → (a) EOF never closes the BQ
      job handle nor sets cursorClosed/cursorExhausted (spec acceptance "EOF closes handle exactly once" silently never
      fires), (b) `pending` is never set for real BigQuery statements (03.4's pending state is dead on arrival), and
      (c) onExhausted({limited:true}) is never received so a byte-budget EOF never surfaces as resultLimited. All 52
      runner tests stay green only because the in-file fakes pre-declare `onExhausted: null` (makeBqBatched) — the fakes
      test the fake, not the adapter contract. Fix: detect via `typeof (batched as {setOnExhausted?:unknown}).setOnExhausted === "function"`
      (BQ03-001's documented installer, TASK-BQ03-001.md:148) and install through it; keep the fakes as-is or align
      them. Add one integration-shaped test where the fake exposes `setOnExhausted` instead of the property so this
      can't regress.
  IMPORTANT:
    - src/core/queryRunner.ts:566-576 — EOF-close path passes `isBqShaped` captured before the await, but nothing re-checks
      the handle wasn't already closed by a racing cancel close; the `try { await batched.close() } catch {}` covers it,
      acceptable — but note `currentBatchedCancelDelivered = true` here (line 568) marks the cancel channel delivered for
      a close that is NOT cancel-origin. A subsequent cancel() on this index returns early as "already delivered" even
      though no cancel was involved. Mitigated by `!r.cursorClosed` exactly-once guard and currentBatched=null before it,
      so window is narrow; flag for the fix round to null the flag question explicitly or reuse the budget-close
      ordering verbatim (ARP03-002 does NOT set the delivered flag on budget close — verify intended symmetry).
  MINOR:
    - src/core/__tests__/queryRunner.test.ts (Test #4) — the settled-error branch (`if (settled instanceof Error)`) is
      allowed to pass either way; tighten to assert the discard invariant directly on rows (already asserted) and drop
      the error-shape tolerance or pin the exact expected shape once behavior is settled.
    - queryRunner.ts:473-475 comment says budget-limited statement "also has cursorExhausted unset" — that coupling is
      load-bearing for the guard order at :466/:476; add a test pinning budget-close does NOT set cursorExhausted
      (currently only implied by Test #2's resultLimited undefined).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Runner-internal contract (EOF close, cursorExhausted vs sweep-close throw, runGeneration late-page guard,
  per-index isolation, serialization) is sound and well-tested against the fakes — but the duck-typed hook channel
  diverges from the real adapter's setOnExhausted surface, so the entire BQ behavior is inert in production. This is
  exactly the 03.1↔03.3 seam both tasks pinned; wire it through the pinned installer before 03.5's real-query cutover.

## R4.5 Round 1 Fix Report
EXECUTOR_MODEL: unic-code

RED_OUTPUT:
  Pre-fix, the new regression test (Test #10 — REGRESSION R4.5) was added with
  the fake shaped like the real `BigQueryPagedQuery`: a `setOnExhausted(cb)`
  installer method, NO own `onExhausted` property. The pre-fix runner only
  checked `"onExhausted" in batched` and assigned `bq.onExhausted = ...`, so
  against this real-shaped fake the wiring was inert — `setOnExhausted` was
  never called. The test failed at:

    FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — BQ-03.3 BigQuery page continuation > Test #10 — REGRESSION R4.5: runner detects the REAL BigQueryPagedQuery shape (setOnExhausted method, no own onExhausted property)
    AssertionError: expected 'object' to be 'function' // Object.is equality

    - Expected: function
    + Received: object

    ❯ src/core/__tests__/queryRunner.test.ts:1661:29
        1659|     // be a function — the runner must use `setOnExhausted`, not the
        1660|     // non-existent `onExhausted` property.
        1661|     expect(typeof storedCb).toBe("function");
           |                             ^

Verification Output:
  ## npx vitest run src/core/__tests__/queryRunner.test.ts
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/r45-bq03-003
   ✓ src/core/__tests__/queryRunner.test.ts  (53 tests) 238ms
   Test Files  1 passed (1)
        Tests  53 passed (53)

  ## npm run typecheck
  > UnicDB@1.49.0 typecheck
  > tsc --noEmit
  (no output, exit 0)

  ## npx vitest run src/core/__tests__/resultBatcher.test.ts
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/r45-bq03-003
   ✓ src/core/__tests__/resultBatcher.test.ts  (14 tests) 2ms
   Test Files  1 passed (1)
        Tests  14 passed (14)

  ## npx vitest run src/core/__tests__/   (sanity sweep, all core tests)
   ✓ 19 test files passed, 423 tests passed (4.33s)

Status: PASS
Note: Fix replaces the inert duck-type (`"onExhausted" in batched` + `bq.onExhausted = ...`) with detection
  via `typeof bqLike.setOnExhausted === "function"` and installation through `bqLike.setOnExhausted(cb)`.
  Both call sites updated:
    - queryRunner.ts:326 (the `pending` marker in run())
    - queryRunner.ts:502 (the loadMoreImpl hook installer + EOF-close branch)
  Existing BQ-03.3 fakes in queryRunner.test.ts were aligned to the REAL `BigQueryPagedQuery` shape
  (setOnExhausted installer, no own onExhausted property) — the previous pre-declared `onExhausted: null`
  is what made the in-file fakes test the fake instead of the adapter contract. New Test #10 pins the
  real shape so this seam cannot regress. No changes to src/adapters/bigquery.ts (03.1's file), no
  changes to src/ui/resultsPanel.ts (03.4's file), no changes to src/core/resultBatcher.ts.

## R4.5 R2 Re-judgement
REVIEWER_MODEL: unic-smart
Verdict: Approved-with-minor
The R2 CRITICAL is fully fixed in commit 647523f. Both duck-type call sites (src/core/queryRunner.ts:335 for the `pending` marker, :517-534 for the hook installer + EOF-close) now detect BQ handles via `typeof bqLike.setOnExhausted === "function"` and install through `bqLike.setOnExhausted(cb)` (:525) — which matches the real `BigQueryPagedQuery` shape (installer at src/adapters/bigquery.ts:590, hook in private `onExhaustedCb` at :557, no own `onExhausted` property). The in-file fakes were aligned to the real shape (closure-stored cb, `setOnExhausted`, no pre-declared property), so they now test the adapter contract instead of the fake, and new Test #10 pins the exact real shape (no own `onExhausted`, installer required) asserting storedCb becomes a function, `resultLimited` surfaces, `cursorClosed` set, close exactly once — RED output shows the genuine pre-fix failure against the real-shaped fake. The R2 IMPORTANT (delivered-flag symmetry on EOF close) resolves as accepted: the EOF branch (:577-587) now uses the budget-close ordering verbatim (set flag → null currentBatched → best-effort close), guarded by `!r.cursorClosed` exactly-once. Verified fresh: 53/53 runner tests (postgres regression included), 14/14 batcher, 423/423 core sweep, typecheck exit 0, no edits outside this task's files. Remaining non-blocking (acknowledged R2 minors, unchanged): Test #4's settled-error branch tolerance and the missing budget-close-does-not-set-cursorExhausted pin — tighten opportunistically, no handoff block.
