# PLAN — SQLHANG

Cycle: SQLHANG-2026-09-21 | Date: 2026-09-21 | Base: main
Spec: `docs/AI_HANDOFF/SPEC.md` | Tasks: `docs/AI_HANDOFF/tasks/TASK-SQLHANG-00{1,2,3}.md`

## §1 Intent

User requirement (verbatim, locked — do NOT re-ask):
"khi chạy nhiều query SQL nó hay bị treo; nếu error thì dừng ngay, thoát ra và báo lỗi,
đừng treo connect, phải auto stop luôn" — running multiple SQL queries often hangs; on
error the app must stop immediately, exit/cancel execution, and report the error — never
leave a hung connection requiring manual stop. Auto-stop must be automatic.

Verified state: the stop-on-first-error chain + loud error reporting already shipped
(STOPERR cycle, e8f78ee). What is missing is a *settlement guarantee*: every
statement-execution await (`adapter.runQuery`, `fetchBatch`, cleanup ROLLBACK/CLOSE,
mssql `enqueue`) is unbounded, `runner.cancel()` is best-effort with unbounded internal
awaits, and the checked-out connection is never force-released — so a driver-level hang
freezes the run, the busy UI, and the connection until manual restart.

Success: any statement that fails OR exceeds `UnicDB.queryTimeoutSeconds` (default
300s) ends the run automatically — statement marked `error`, rest `cancelled`, error
reported through the existing STOPERR surface, connection handle released/destroyed,
next run works without manual reconnect. `UnicDB.cancelQuery` always resolves and
escalates to hard abort.

## §2 Scope

**In-scope**
- `src/core/queryRunner.ts` — `statementTimeoutMs` option, `bounded()` helper,
  `QueryTimeoutError`, watchdog on runQuery/pickResult/loadMore/runSql/stale-sweep,
  `cancel()` hardening + abort escalation (SPEC FR-001..005, FR-014).
- `src/adapters/types.ts` — optional `abortActiveQuery?(): Promise<void>` seam (FR-001).
- `src/adapters/postgres.ts` — client/PID tracking, `abortActiveQuery`, bounded
  cleanup, swallow-guarded release (FR-010).
- `src/adapters/mysql.ts` — `abortActiveQuery`, bounded rollback → destroy (FR-011).
- `src/adapters/mssql.ts` — `abortActiveQuery`, `queueGeneration` stale-op rejection,
  lazy reconnect via `ensureConnection` (FR-012).
- `src/extension.ts` — one-line `statementTimeoutMs` wiring (FR-013).
- `package.json` — `UnicDB.queryTimeoutSeconds` property (FR-013).
- 4 NEW test files (SPEC §11).

**Out-of-scope**
- `executeAll` stop-on-error chain, STOPERR toast/mark/badge surfaces — unchanged.
- `beginTransaction`/`DbTransaction` manual-commit path; `BatchedQuery`/`RunResult`
  shapes; `ConnectionManager` caching policy; panel/webview code.
- BigQuery `abortActiveQuery` implementation (runner falls back — SPEC §14 Q4).
- npm deps, version bump, package, publish.
- Legacy sweep (Phase 0): INDEX rỗng (COMMITGUARD archived); `docs/TASKS.md` không
  tồn tại; `git status` chỉ `RUN.md` + `docs/UKIT_INTERNALS.md` (harness-owned) →
  không việc cũ cần fold.

**CONSTRAINT (same-file rule):** all 3 tasks own disjoint files → all wave 1,
`Dependencies: none`. TASK-SQLHANG-001's runner calls `adapter.abortActiveQuery?.()`
— optional-chained, so it typechecks and falls back to `cancelActiveQuery` whether or
not 002/003 have landed; 002/003's methods are extra class members (valid TS without
the interface member) and are also called by their own bounded-cleanup paths, so each
task is independently valuable and independently revertable.

## §3 Approach

Runner owns the timeout; adapters own the abort. `bounded()` races each driver await
against `statementTimeoutMs`; on expiry it fires `abortActiveQuery` (fallback
`cancelActiveQuery`) bounded by `ABORT_GRACE_MS`, then throws `QueryTimeoutError` —
which flows into the EXISTING catch → error status → cancel-rest → STOPERR reporting.
Zero new downstream control flow; the fix is entirely "make every await settle".

Abort semantics per adapter (SPEC FR-010..012): pg = pg_cancel_backend on tracked PIDs
+ `release(true)` on tracked clients (destroy, never re-pool); mysql = fire
`activeCancelClosures` (connection.destroy — same machinery as its cancel seam);
mssql = bump `queueGeneration` + cancel requests + `connection.close()` +
`connected=false`, with `enqueue` rejecting stale-stamped ops and `runQuery` lazily
reconnecting. Cleanup awaits (ROLLBACK/CLOSE/COMMIT/rollback) get `CLEANUP_GRACE_MS`
bounds → destroy + propagate the ORIGINAL error.

**Alternatives rejected:** (a) per-adapter statement timers — triples plumbing, misses
BQ, duplicates the runner's existing cancel ownership; (b) server-side
`statement_timeout` SET — driver-specific, mutates user session state, doesn't cover
socket-level hangs; (c) ConnectionManager health-check/discard — heavier, and
self-healing adapters make it unnecessary; (d) graceful-only cancel without destroy —
exactly today's gap: a dead-socket promise never settles.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| Happy | runQuery settles < timeout | results returned; abort/cancelActiveQuery never called |
| Happy | pg abort on tracked client | dedicated `pg_cancel_backend(pid)` + `release(true)`; pending query rejects |
| Happy | mssql abort then runQuery | `connection.close()` called; `connected=false`; next runQuery lazy-reconnects |
| Edge (timeout) | stmt 2 of 3 never settles, fake timers past 300s | run() resolves; stmt2 `error` QueryTimeoutError; stmt3 `cancelled`; abort once |
| Edge (disabled) | `statementTimeoutMs: 0`, never-settling stmt | no timer armed; abort never called (pass-through) |
| Edge (fallback) | adapter without `abortActiveQuery` times out | `cancelActiveQuery` called instead; QueryTimeoutError still thrown |
| Edge (cancel-hang) | `cancel()` while `batched.cancel()` hangs | cancel() resolves ≤ ABORT_GRACE_MS; abort escalation fires when activeAdapter held |
| Edge (cleanup wedge) | pg stmt errors, then `ROLLBACK` hangs | runQuery rejects with ORIGINAL error; `release(true)` destroy, not plain release |
| Edge (queue) | mssql op queued behind hung op, abort fires | queued op rejects "operation aborted — connection was reset"; never execSql'd |
| Edge (boundary) | mysql `rollback()` hangs after stmt error | `connection.destroy()`; original error propagates; no second release |
| Edge (no-op) | abort with no in-flight work (all 3 adapters) | resolves immediately; no dedicated client / no connection.close |
| Regression (bugfix) | 3-stmt run, stmt 2 driver promise never settles | pre-fix: run() hangs (test times out = RED); post-fix: resolves with stmt2 error |
| Regression (suite) | existing queryRunner/postgres/mysql/mssql unit tests | PASS unchanged (behavior identical under timeout) |

## §5 Verification Commands

Verified against `package.json` scripts: `test` = `vitest run` (excludes
`*.integration.test.ts`), `typecheck` = `tsc --noEmit`, `compile` = `node esbuild.js`.
No `lint` script exists — `npm run typecheck` is the static gate (stated explicitly
per RULES; not omitted).

```bash
npm run typecheck
npx vitest run src/core/__tests__/queryRunnerWatchdog.test.ts          # TASK-001
npx vitest run src/adapters/__tests__/postgresAbort.test.ts src/adapters/__tests__/mysqlAbort.test.ts   # TASK-002
npx vitest run src/adapters/__tests__/mssqlAbort.test.ts               # TASK-003
npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/postgres.test.ts src/adapters/__tests__/mysqlQueueBound.test.ts src/adapters/__tests__/mssql.parameterized.test.ts   # adjacent suites
npm run compile                                                      # wave boundary
npm test                                                             # wave boundary (full)
```

## §6 Acceptance

- [ ] AC-1: `statementTimeoutMs` watchdog on runQuery/pickResult/loadMore/runSql +
      `QueryTimeoutError` + `bounded()` + cancel() bounded & abort-escalating — TASK-001.
- [ ] AC-2: `abortActiveQuery` seam on `DbAdapter` (optional, documented contract) — TASK-001.
- [ ] AC-3: pg abort (PID cancel + destroy-release) + bounded cleanup preserving the
      original error — TASK-002.
- [ ] AC-4: mysql abort (destroy via closures) + bounded rollback → destroy — TASK-002.
- [ ] AC-5: mssql abort (queue generation + connection.close) + lazy reconnect +
      stale-queue rejection — TASK-003.
- [ ] AC-6: `UnicDB.queryTimeoutSeconds` in package.json + wired at runner
      construction — TASK-001.
- [ ] AC-7: regression test fails on pre-fix code (hang) and passes post-fix — TASK-001.
- [ ] AC-8: `npm run typecheck` 0 errors; `npm run compile` OK; full `npm test` PASS
      at wave boundary — all tasks.
- [ ] AC-9: no changes outside the 7 product files + 4 new test files (+ handoff docs).

## §7 Global Constraints

- TypeScript strict; `npm run typecheck` (tsc --noEmit) must stay clean — no `lint`
  script exists in this repo.
- vitest + `vi.useFakeTimers()` for all timeout tests; driver mocks follow existing
  conventions (`vi.mock("pg")`, `vi.mock("mysql2/promise")`, fake tedious Connection
  via instance-level `newRequest` shadow, mock `DbAdapter` for runner tests).
- No new npm dependencies; no `vscode` import in `src/core/` or `src/adapters/`
  (extension.ts is the only vscode-coupled file touched).
- Every new await introduced must be bounded or provably non-blocking — the invariant
  this cycle exists to enforce.
- `abortActiveQuery`/`cancelActiveQuery`/cleanup paths never throw — all failures
  swallowed (best-effort contract, mirrors existing seams).
- Frozen constants: `DEFAULT_STATEMENT_TIMEOUT_MS=300_000`, `ABORT_GRACE_MS=5_000`,
  `CLEANUP_GRACE_MS=3_000` (SPEC §7) — do not restate different values in tasks.

## Planner Self-Audit
Checklist: 14/14 pass
Fixed during audit: (a) added `runSql` + stale-cursor sweep to watchdog scope after
re-reading runLocked (both unbounded); (b) made pg/mysql/mssql aborts also reachable
from their own bounded-cleanup paths so TASK-002/003 stay independently valuable if
TASK-001 is rejected; (c) pinned `ms <= 0` disable semantics + `loadMore` no-status-flip
edge in SPEC §10/§14-Q7; (d) confirmed disjoint target files for a 3-wide wave 1.
Known gaps: (1) real-driver hang (dead socket mid-query) can't be reproduced in unit
tests — pinned via never-settling promise + fake timers, which exercises the same
settle-or-abort contract; (2) tedious's exact settle-on-close behavior is assumed
(request callback fires with error on connection.close) — flagged in TASK-003
Discussion for the executor to verify against the installed tedious version; (3) BQ
timeout orphans the driver promise (no abort seam) — accepted, SPEC §14 Q4.

## Planner Report
PLANNER_MODEL: devin/swe-2 (unic-smart role — strong-tier planner subagent)
Revision: R2 (2026-09-21) — Round-1 review findings applied: fetchBatch timeout →
adapter abort; mssql stale-op string unified; two-file test split; `bounded` helper
+ `CANCEL_GRACE_MS` synced; FR/§ citations renumbered.

## Plan Review Log

### Round 1
VERDICT: Issues Found
REVIEWER_MODEL: devin/swe-2
FINDINGS:
1. important — SPEC FR-003 vs TASK-SQLHANG-001 §Target Files — fetchBatch timeout action diverges: SPEC freezes `batched.cancel()` (bounded) on fetchBatch timeout; TASK-001 wraps `pickResult`/`loadMoreImpl` fetchBatch with `abortAdapter` (whole-adapter abort). Whole-adapter abort destroys the connection where a cursor-scoped cancel suffices, and makes the SPEC §11 "fetchBatch timeout → batched.cancel()" test row unimplementable as written. Required fix: pick one semantics (recommend abortAdapter for the dead-socket case, since a hung fetchBatch implies a hung cursor client that only abort releases) and update the other document so SPEC, PLAN §4, and TASK-001 agree.
2. important — SPEC FR-008 vs PLAN §4/TASK-SQLHANG-003 — frozen mssql stale-op error string conflicts: SPEC §FR-008 freezes `"MsSqlAdapter: operation dropped — connection was aborted"`; TASK-003 and PLAN §4 freeze `"MsSqlAdapter: operation aborted — connection was reset"` (TASK-003 even cites "frozen, SPEC §8.4" — SPEC §8.4 is the package.json setting, wrong anchor). Tests will assert whichever string the executor reads first. Required fix: amend SPEC FR-008 to the TASK-003 string (or vice versa) and correct the §8.4 citation.
3. minor — SPEC §11/§12 vs PLAN §5/TASK-002 — test file names diverge: SPEC names `adapterAbort.test.ts` (single file, pg+mysql); PLAN/TASK-002 name `postgresAbort.test.ts` + `mysqlAbort.test.ts`. SPEC §12 acceptance command references a file that will never exist. Required fix: update SPEC §11/§12 to the two-file split.
4. minor — SPEC §8.2 vs TASK-001 — helper contract drift: SPEC freezes `withTimeout(p, ms, onTimeout)`; TASK-001 specifies `bounded(p, ms, onTimeout, makeError)` (4 args, different name). Also `CANCEL_GRACE_MS` is frozen in SPEC §8.2 exports but absent from TASK-001's export list (TASK-001 uses `ABORT_GRACE_MS` for cancel-bounding — behaviorally equivalent but the frozen export is dropped). Required fix: align SPEC §8.2 to `bounded` + add `CANCEL_GRACE_MS` to TASK-001 exports, or drop it from SPEC.
5. minor — SPEC §8.3 vs TASK-001 — SPEC §8.3 labels the package.json setting "8.3" while TASK-001 cites "SPEC §8.3 frozen shape" correctly but TASK-003 cites "§8.4" for the error string (see #2) — section-number drift between SPEC and tasks. Required fix: renumber citations when fixing #2.
6. minor — PLAN §6 AC-9 — "7 product files + 4 new test files" counts correctly only if the two-file test split (postgresAbort + mysqlAbort) is used; SPEC §11's single adapterAbort.test.ts would make it 3 test files. Resolved by fix #3; no separate action.

Verified-consistent (no action): all cited line numbers in SPEC §1 match current source (queryRunner.ts:443 unbounded runQuery await, :383-390 sweep, :809-852 cancel, postgres.ts:449/501/1181/1254/1297, mysql.ts:153/191/335, mssql.ts:264/574-587); package.json scripts match PLAN §5 (`test`=vitest run, `typecheck`=tsc --noEmit, `compile`=node esbuild.js, no lint); `cancelActiveQuery?` exists at types.ts:134; extension.ts:663 wiring point confirmed; 3 tasks are file-disjoint and TASK-002's CLEANUP_GRACE_MS import has an explicit local-fallback so wave-1 parallelism is safe; regression tests genuinely fail pre-fix (never-settling promise → run() hangs → vitest timeout).

### Round 1 — findings applied
- Finding 1 [important]: adopted adapter-level abort for fetchBatch timeouts (a hung
  fetch implies a hung cursor client that only connection abort releases; a
  cursor-scoped `batched.cancel()` would await the same dead client). SPEC FR-003,
  §10 edge case, and §11 test row updated to `abortAdapter` + `QueryTimeoutError`;
  TASK-001 already specified `abortAdapter` — now consistent.
- Finding 2 [important]: frozen mssql stale-op string unified to
  `"MsSqlAdapter: operation aborted — connection was reset"` (TASK-003/PLAN §4
  variant). SPEC FR-012 + §8.3 updated; TASK-003's wrong `§8.4` citations corrected
  to `§8.3` (§8.4 is the package.json setting).
- Finding 3 [minor]: test file names unified to the two-file split
  `postgresAbort.test.ts` + `mysqlAbort.test.ts`; SPEC §11 matrix and §12 command
  updated (was `adapterAbort.test.ts`).
- Finding 4 [minor]: SPEC §8.2 helper contract aligned to
  `bounded<T>(p, ms, onTimeout, makeError)` (4-arg, module-private, clears timer on
  both branches, `ms <= 0` pass-through); `CANCEL_GRACE_MS` added to TASK-001's
  export list + cancel() usage + test #5 + AC + Produces (was `ABORT_GRACE_MS`).
- Finding 5 [minor]: section citations renumbered — SPEC FRs renumbered so
  pg=FR-010, mysql=FR-011, mssql=FR-012, setting=FR-013, error=FR-014 (matching
  TASK-001/002/003 Parent-plan refs); TASK-001 ref updated to FR-001..005, FR-013,
  FR-014; TASK-003 §8.4→§8.3 per finding 2.
- Finding 6 [minor]: resolved by fix 3 — AC-9's "4 new test files" now matches
  (queryRunnerWatchdog + postgresAbort + mysqlAbort + mssqlAbort).


### Round 2
VERDICT: Issues Found
REVIEWER_MODEL: devin/swe-2
FINDINGS:
1. important — PLAN.md §2 In-scope — stale FR references after the SPEC renumbering: `types.ts` seam cites `(FR-009)` but the seam is FR-001 (FR-009 no longer exists — SPEC jumps FR-005 → FR-010); `package.json` property cites `(FR-014)` but FR-014 is `QueryTimeoutError` — the package.json setting is part of FR-013. Required fix: §2 line for types.ts → `(FR-001)`; package.json line → `(FR-013)`.
2. minor — PLAN.md §2 — `queryRunner.ts` line cites `(SPEC FR-001..008)`; FR-006..009 no longer exist. Harmless range but stale; tighten to `FR-001..005, FR-014` for accuracy.

Verified-fixed (Round 1): (1) fetchBatch timeout unified to `abortAdapter` — SPEC FR-003, §10 edge, §11 test row all updated, matches TASK-001; (2) mssql stale-op string frozen identically `"MsSqlAdapter: operation aborted — connection was reset"` in SPEC §8.3/FR-012, PLAN §4, TASK-003 — §8.4 citations corrected to §8.3; (3) test files unified to postgresAbort+mysqlAbort+mssqlAbort+queryRunnerWatchdog across SPEC §11/§12, PLAN §5, tasks; (4) `bounded<T>(p, ms, onTimeout, makeError)` 4-arg signature matches SPEC §8.2 ↔ TASK-001; `CANCEL_GRACE_MS` now exported/used in TASK-001 (exports, cancel() bound, test #5, AC, Produces). No other new inconsistencies found; task Parent-plan FR refs (001: FR-001..005/013/014, 002: FR-010/011, 003: FR-012) all resolve correctly.
### Round 2 — findings applied without re-review
- PLAN §2 `src/adapters/types.ts` citation (FR-009) → (FR-001) — the seam is FR-001.
- PLAN §2 `package.json` citation (FR-014) → (FR-013) — the setting is FR-013
  (FR-014 is `QueryTimeoutError`).
- PLAN §2 `src/core/queryRunner.ts` citation (SPEC FR-001..008) → (SPEC
  FR-001..005, FR-014) — FR-006..009 no longer exist after the R1 renumber;
  runner scope is FR-001..005 + FR-014.
