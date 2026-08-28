# TASK-AH-001 — Runner append mode + global indices + multi-statement cursor discipline

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AH.md` §7 (Approach §3)

## Goal

Make `QueryRunner.run()` support DataGrip-style accumulation: with `opts.append === true`, new StatementResults are appended to `this.results` with global indices (previous tabs untouched) instead of the array being replaced. Within an append multi-statement run, release each statement's batched cursor as soon as the next statement is pending (fixing the pool max=1 hang), marking released entries `cursorClosed: true`; single-statement runs keep full cursor paging. Stamp append entries with `runNo`/`runStmtNo` for later webview labeling.

## Target Files

- `src/core/queryRunner.ts` — `run(statements, onUpdate, opts?: { append?: boolean })` (signature extends :106-109); append branch computes `base = this.results.length` and maps new entries to indices `base..base+N-1` instead of the replace at :130-135; stamp `runNo`/`runStmtNo` (1-based) on append entries only; in `executeAll` after `pickResult`, if `opts.append && statements.length > 1 && i < statements.length - 1 && runResult.batched` → close the cursor, keep first-batch rows, set `cursorClosed: true`; `loadMoreImpl` gains an early reject for `cursorClosed` entries BEFORE `batched.fetchBatch()`; extend `StatementResult` (:39-54) with optional `cursorClosed?: boolean; runNo?: number; runStmtNo?: number` — these fields go HERE, not in `src/adapters/types.ts` (AF-locked).
- `src/core/__tests__/queryRunner.test.ts` — EXTEND (reuse existing `makeBatched` close-spy + `makeAdapter` helpers at :36-60).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | append run accumulates results and keeps old entries | run `[{SELECT a}]` then run2 `[{SELECT b},{SELECT c}]` with `{append:true}` → `getResults()` length 3; indices 0,1,2; entries 0-1 referentially identical objects (same `sql`, same `result`); run2 entries `runNo===2`, `runStmtNo` 1,2 | adapter mock returning non-batched results |
| 2 | unit | default run (no opts) still replaces | run1 2 statements then run2 1 statement without opts → `getResults()` length 1; old entries gone | existing Test #1 fixture |
| 3 | edge (boundary/empty) | append run with empty statements array | `run([], onUpdate, {append:true})` → results unchanged (same length/content as before), exactly one onUpdate call, no throw | seeded results from run1 |
| 4 | edge (lifecycle/concurrency) | cancel mid-append-run leaves old tabs intact | seed run1 results; start append run2 of 3; `cancel()` during statement 2 → entries 0..base-1 untouched; new entries status `cancelled`; `cursorClosed` absent on old entries | batched mock with delayed fetchBatch + cancel spy |
| 5 | unit (happy, cursor) | single-statement append run keeps cursor open + Load More works | 1 batched statement, `{append:true}` → entry has `batched`, NO `cursorClosed`; `loadMore(0)` fetches batch 2 and appends rows | `makeBatched` with 2-fetch sequence |
| 6 | unit (multi-stmt state) | 2 batched statements in one append run → stmt 1 cursor closed after initial fetch, stmt 2 runs | after run: entry 0 `cursorClosed===true`, first-batch rows kept, `batched.close` spy called exactly once BEFORE adapter runQuery for stmt 2 (assert call order); entry 1 done with its own rows, no `cursorClosed` | 2 batched mocks; adapter whose runQuery for stmt 2 resolves only after a tick (proves no queue-hang) |
| 7 | edge (error-message kind) | loadMore on a cursorClosed entry rejects with the clear message | `loadMore(0)` on entry 0 of test 6 → rejects with message matching `/run this statement alone/`; `batched.fetchBatch` spy NOT called (dead cursor never touched) | test 6 post-state |
| 8 | edge (boundary) | last statement of a multi-statement append run keeps its cursor | 2 batched statements, `{append:true}` → entry 1 has `batched`, no `cursorClosed`; `loadMore(1)` works | 2 batched mocks |
| 9 | regression | cross-run stale-cursor close preserved + degrade message | existing suites `"run() mới đóng batched cursor còn mở từ lần chạy trước"` (:416) and `"cursor cũ được đóng TRƯỚC khi statement mới chạy"` (:438) stay green; PLUS new pin: run1 single batched statement (cursor left open) → run2 (any mode) → `loadMore(0)` on run1's entry now rejects with `/run this statement alone/` (stale cursor was closed by run2's sweep) | run1 batched mock w/ open cursor; run2 replaces |
| 10 | regression | default-path suite green | all pre-existing tests in this file (Test #1–#7b, Fix #3, batched/cancel/pickResult suites) pass unchanged | current suite at HEAD |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — all 10 tests above (EXTEND existing file; helpers reused, new `describe("Cycle AH — append runs")` blocks).

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck
npm test
npm run compile
```

(No lint script exists in this repo — `npm run typecheck` is the static gate. Full `npm test` here doubles as the wave-boundary net: this task is wave 1.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for new cases, GREEN after; RED output pasted in Executor Report).
- [ ] `run()` signature is `run(statements, onUpdate, opts?: { append?: boolean }): Promise<StatementResult[]>`; default behavior byte-identical to today (regressions 9-10 green).
- [ ] Multi-statement append run never leaves a cursor open across statements (close-before-next-statement order asserted).
- [ ] No diff outside `src/core/queryRunner.ts` + its test file (in particular: no `src/adapters/types.ts`, no styles.css, no `src/ai/**`/`src/core/ddl/**`/`src/core/sqlFormat.ts`).
- [ ] `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.

## Dependencies

- none

## Interfaces

- Consumes: (none new — existing `adapter.runQuery(sql: string): Promise<RunResult>`, `BatchedQuery.close(): Promise<void>`, `pickResult(runResult: RunResult): Promise<QueryResult>` from this same file)
- Produces:
  - `run(statements: ParsedStatement[], onUpdate: (results: StatementResult[]) => void, opts?: { append?: boolean }): Promise<StatementResult[]>` — AH-002's call site and AH-003's label derivation depend on this exact signature.
  - `interface StatementResult { ...; cursorClosed?: boolean; runNo?: number; runStmtNo?: number }` — `cursorClosed` gates AH-001's own loadMore guard and AH-003's degraded Load More notice; `runNo`/`runStmtNo` feed AH-003's `Run N · Statement M` tab labels (both optional → replace-mode entries carry neither, so webview falls back to today's labels).
  - `loadMore(index: number): Promise<StatementResult[]>` — unchanged signature; on a `cursorClosed` entry rejects with `Error` whose message contains `run this statement alone` (AH-002 surfaces it via the existing loadMore catch path).

---

## Discussion

### 2026-08-28 · planner · unic-smart
Root-cause note for the executor: the hang is pool max=1 — a held keyset cursor keeps the client; statement i+1's runQuery queues and fails `connectionTimeoutMillis`. Closing the cursor immediately after `pickResult`'s initial fetch is the deliberate trade (paging depth on non-last statements) per user decision; OFFSET-stateless paging is deferred to ROADMAP. Keep the close BEFORE the next statement's `adapter.runQuery` — test 6 pins the order.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
