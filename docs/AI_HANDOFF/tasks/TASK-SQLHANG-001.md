# TASK-SQLHANG-001 — Runner watchdog + abort seam + timeout setting

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 | Spec: `docs/AI_HANDOFF/SPEC.md` FR-001..005, FR-013, FR-014

## Goal

Give `QueryRunner` a settlement guarantee: every statement-execution await is bounded
by `statementTimeoutMs`; on expiry the runner fires the adapter's `abortActiveQuery`
(fallback `cancelActiveQuery`) and throws `QueryTimeoutError`, which flows through the
existing error path (statement `error` → rest `cancelled` → STOPERR reporting).
`cancel()` is bounded and escalates to abort. Wire the `UnicDB.queryTimeoutSeconds`
setting (default 300, 0 = disabled) and declare the `abortActiveQuery` seam on
`DbAdapter`.

## Target Files

- `src/core/queryRunner.ts` —
  - `QueryRunnerOptions` += `statementTimeoutMs?: number`; field default
    `DEFAULT_STATEMENT_TIMEOUT_MS = 300_000`; `<= 0` disables (pass-through, no timer).
  - New module-private `bounded<T>(p, ms, onTimeout, makeError)` per SPEC FR-002.
  - New exported `QueryTimeoutError` (SPEC §8.2) + exported constants
    `DEFAULT_STATEMENT_TIMEOUT_MS`, `ABORT_GRACE_MS = 5_000`,
    `CANCEL_GRACE_MS = 5_000`, `CLEANUP_GRACE_MS = 3_000`.
  - `executeAll`: wrap `adapter.runQuery(...)` and `pickResult(runResult)` in
    `bounded(..., statementTimeoutMs, () => this.abortAdapter(adapter), () => new QueryTimeoutError(ms))`.
  - `loadMoreImpl`: wrap `batched.fetchBatch()` identically; `onTimeout` resolves the
    adapter lazily via `this.adapterProvider()` (cost only on timeout).
  - `runSql`: wrap `adapter.runQuery(sql)` identically.
  - `runLocked` stale-cursor sweep: wrap each `entry.batched.close()` in
    `bounded(..., CLEANUP_GRACE_MS, abort-via-provider, …)`; timeout → still mark
    `cursorClosed = true`, continue sweep.
  - `cancel()`: wrap `currentBatched.cancel()`, `currentBatched.close()`,
    `adapter.cancelActiveQuery()` in `bounded(..., CANCEL_GRACE_MS, …)`; after graceful
    channels, if `this.activeAdapter !== null` fire `adapter.abortActiveQuery?.()`
    (bounded by `ABORT_GRACE_MS`, best-effort).
  - New private `abortAdapter(adapter)`: `adapter.abortActiveQuery?.() ?? adapter.cancelActiveQuery?.()`,
    bounded by `ABORT_GRACE_MS`, all errors swallowed.
- `src/adapters/types.ts` — add optional `abortActiveQuery?(): Promise<void>` to
  `DbAdapter` with the SPEC §8.1 doc contract (placed next to `cancelActiveQuery?`).
- `src/extension.ts` — `new QueryRunner(...)` (~line 663): add
  `statementTimeoutMs: (vscode.workspace.getConfiguration("UnicDB").get<number>("queryTimeoutSeconds") ?? 300) * 1000`.
- `package.json` — `contributes.configuration.properties` += `UnicDB.queryTimeoutSeconds`
  (SPEC §8.3 frozen shape).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | runQuery settles before timeout | results returned; `abortActiveQuery`/`cancelActiveQuery` never called | mock adapter, `statementTimeoutMs: 1000`, fast resolve |
| 2 | edge (timeout) | stmt 2 of 3 never settles; `vi.advanceTimersByTime` past timeout | `run()` resolves; `results[1].status === "error"` with QueryTimeoutError message; `results[2].status === "cancelled"`; `abortActiveQuery` called exactly once | mock adapter: stmt1 resolves, stmt2 `new Promise(() => {})`, `statementTimeoutMs: 50` |
| 3 | edge (disabled) | `statementTimeoutMs: 0`, never-settling stmt | no timer armed; abort never called; run stays pending (pass-through = today's behavior) | same mock, `statementTimeoutMs: 0` |
| 4 | edge (fallback) | adapter without `abortActiveQuery` times out | `cancelActiveQuery` called; QueryTimeoutError thrown | mock adapter exposing only `cancelActiveQuery` |
| 5 | edge (cancel-hang) | `cancel()` while `batched.cancel()` never resolves | `cancel()` resolves ≤ CANCEL_GRACE_MS; with `activeAdapter` held, `abortActiveQuery` fires | batched mock with hanging cancel; adapter with `abortActiveQuery` spy |
| 6 | edge (loadMore) | `loadMore` `fetchBatch` never settles | `loadMore` rejects with QueryTimeoutError; statement keeps `done` status (no flip) | done statement with hanging `fetchBatch` |
| 7 | regression (bugfix) | 3-stmt run, stmt 2 driver promise never settles | pre-fix: `run()` never resolves (test times out = RED); post-fix: resolves with stmt2 `error` | same fixture as #2 — this IS the reported hang |
| 8 | edge (sweep) | stale cursor `close()` hangs at next run start | `runLocked` proceeds; entry marked `cursorClosed`; new run executes | prior done result with hanging `batched.close` |

## Test Files

- `src/core/__tests__/queryRunnerWatchdog.test.ts` (NEW) — all 8 cases; mock
  `DbAdapter` per `queryRunner.test.ts` conventions; `vi.useFakeTimers()`.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunnerWatchdog.test.ts
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck
npm run compile
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; #7 fails on pre-fix code (hang → timeout).
- [ ] `QueryTimeoutError`, `DEFAULT_STATEMENT_TIMEOUT_MS`, `ABORT_GRACE_MS`,
      `CANCEL_GRACE_MS`, `CLEANUP_GRACE_MS` exported from `src/core/queryRunner.ts`.
- [ ] `abortActiveQuery?` present on `DbAdapter` with SPEC §8.1 doc contract.
- [ ] `UnicDB.queryTimeoutSeconds` in package.json + read at runner construction.
- [ ] `npm run typecheck` 0 errors; existing `queryRunner.test.ts` still PASS.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `DbAdapter.abortActiveQuery?(): Promise<void>` (optional-chained — works
  whether or not TASK-002/003 have landed); `DbAdapter.cancelActiveQuery?()` (existing).
- Produces: `QueryTimeoutError`, `DEFAULT_STATEMENT_TIMEOUT_MS`, `ABORT_GRACE_MS`,
  `CANCEL_GRACE_MS`, `CLEANUP_GRACE_MS` (exported from `src/core/queryRunner.ts` — TASK-002 imports
  `CLEANUP_GRACE_MS` for bounded cleanup); `DbAdapter.abortActiveQuery?` seam
  (implemented by TASK-002/003); `QueryRunnerOptions.statementTimeoutMs`.


---

## Discussion

### 2026-09-21 · planner · devin/swe-2 (unic-smart role)
`bounded()` must clear its timer on BOTH branches (settle and timeout) — a leaked
timer keeps the extension host alive and re-fires `onTimeout` later. Keep the helper
module-private; tests exercise it through the public run/cancel/loadMore paths, not
by importing it. `abortAdapter` prefers `abortActiveQuery` over `cancelActiveQuery`
because abort additionally releases the connection handle (SPEC §14 Q2).

### 2026-09-21 · planner · devin/swe-2 (unic-smart role) — validator dismissal
`task-budget-validator` verdict `needs_breakdown` (target-file-count: 4 > 3) —
DISMISSED: only `queryRunner.ts` + `types.ts` carry logic; `extension.ts` is a
one-line option pass and `package.json` a declarative property — neither has an
independent test surface, so splitting them into a fourth task would produce a
task with no testable deliverable of its own (its only check would be "the
property exists", which typecheck + the watchdog tests already cover).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report
EXECUTOR_TOOL: omp vibe worker
EXECUTOR_MODEL: devin/swe-2
EXECUTOR_SUBAGENT: -
RED_OUTPUT:
```
❯ src/core/__tests__/queryRunnerWatchdog.test.ts  (9 tests | 7 failed) 30020ms
 ❯ exports the frozen constants and QueryTimeoutError
   → expected undefined to be 300000 // Object.is equality
 ❯ #2 — stmt 2 of 3 never settles: timeout → error + rest cancelled + abort once
   → Test timed out in 5000ms.
 ❯ #4 — adapter without abortActiveQuery falls back to cancelActiveQuery
   → Test timed out in 5000ms.
 ❯ #5 — cancel() resolves within grace when batched.cancel() hangs; abort fires
   → Test timed out in 5000ms.
 ❯ #6 — loadMore fetchBatch never settles: rejects with QueryTimeoutError, status stays done
   → Test timed out in 5000ms.
 ❯ #7 — regression: 3-stmt run with never-settling stmt 2 resolves (was: hang)
   → Test timed out in 5000ms.
 ❯ #8 — stale cursor close() hangs at next run start: sweep bounded, run proceeds
   → Test timed out in 5000ms.
 Test Files  1 failed (1)
      Tests  7 failed | 2 passed (9)
```
Verification Output:
```
$ npx vitest run src/core/__tests__/queryRunnerWatchdog.test.ts
✓ src/core/__tests__/queryRunnerWatchdog.test.ts  (9 tests) 7ms
 Test Files 1 passed (1) — Tests 9 passed (9)

$ npx vitest run src/core/__tests__/queryRunner.test.ts
✓ src/core/__tests__/queryRunner.test.ts  (83 tests) 260ms
 Test Files 1 passed (1) — Tests 83 passed (83)

$ npm run typecheck
> UnicDB@1.54.1 typecheck
> tsc --noEmit
(exit 0)

$ npm run compile
(exit 0) — dist/webview.js.map 4.1mb, dist/webview.css.map 85.2kb

$ npm test
 Test Files 315 passed | 2 skipped (317)
      Tests 4727 passed | 5 skipped (4732)
(exit 0)
```
Status: PASS
Note: cancel() escalation fires abortActiveQuery ONLY (fire-and-forget) — the
cancelActiveQuery fallback would have re-fired the already-delivered graceful
seam (caught by existing RLX-001 tests asserting seam exactly-once). Worktree
node_modules was empty; symlinked to main repo install so esbuild/vsce-driven
suites run. bq04SurfaceGuard extended to drop the intentional additive
abortActiveQuery hunk (same precedent as the BQF runQuery widening).
