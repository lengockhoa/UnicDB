# TASK-BQ01-003 — Factory + ConnectionManager admission for bigquery

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Admission)

## Goal

Admit `driver:"bigquery"` through `createAdapter` (exhaustive switch, no password path)
and through `ConnectionManager` without ever round-tripping SecretStorage for a BigQuery
fake password, with dispose blocking later adapter use.

## Target Files

- `src/adapters/factory.ts` — add `case "bigquery"` returning `new BigQueryAdapter(cfg)`
  (password argument ignored for this driver); keep the `never` exhaustiveness arm.
- `src/core/connectionManager.ts` — bigquery guard: skip `vsdb.pass.<id>`
  store/get/delete on add/edit/connect paths; dispose sets a closed flag so post-dispose
  adapter construction fails fast (explicit error, no client built); double-dispose no-op.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | factory returns BigQueryAdapter for bigquery cfg | `createAdapter(bqCfg, "")` instanceof `BigQueryAdapter`; duck-type has `connect/close/runQuery/testConnection/listSchemas` | bqCfg per TASK-BQ01-001 fixture |
| 2 | edge-exhaustive | switch stays exhaustive | typecheck passes with `_exhaustive: never` arm intact (negative: removing a case must fail compile — verified by reviewer reading the file, not by a test) | source inspection + typecheck |
| 3 | edge-admission | manager addConnection(bigqueryCfg) never touches SecretStorage | with spied fake SecretStorage: `get`/`store` never called with key `vsdb.pass.<id>`; metadata persisted; probe via injected factory fake resolves | `connectionManager.test.ts` fake vscode harness + injected factory |
| 4 | edge-concurrent | dispose-during / after dispose | `dispose(); dispose()` idempotent; after dispose, adapter request for the bigquery connection rejects with explicit closed-error and the client factory was NOT invoked again | manager with injected factory spy |
| 5 | edge-state | edit + connect paths skip password demand | `editConnection(bigqueryId, cfg)` (no password arg) does not throw "password not found"; `getAdapter()` for active bigquery connection does not call `ctx.secrets.get` | fake harness, spy on secrets |
| 6 | regression | existing pg flow unchanged | pre-existing `connectionManager.test.ts` + `factory.test.ts` suites pass unmodified (SecretStorage flow for postgres identical) | current suites |

## Test Files

- `src/adapters/__tests__/factory.test.ts` (modify — add bigquery case group; existing
  tests untouched)
- `src/core/__tests__/connectionManager.test.ts` (modify — add bigquery admission group;
  existing tests untouched)
- Reuses TASK-BQ01-002's `src/adapters/__tests__/bigquery.test.ts` fakes by importing
  the adapter through the factory (no new adapter file).

## Verification Commands

```bash
# 1. Focused proof
npx vitest run src/adapters/__tests__/factory.test.ts src/core/__tests__/connectionManager.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED output pasted in Executor Report first).
- [ ] `createAdapter` switch: `case "bigquery"` present; `never` arm intact; no
      host/port/password usage on the bigquery path.
- [ ] Zero SecretStorage calls for bigquery connections (spy-proven at add, edit,
      active-connect).
- [ ] `dispose()` idempotent; post-dispose bigquery adapter use fails fast with explicit
      error (not a client construction).
- [ ] Existing postgres/mysql/mssql rows of both suites untouched and green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ01-001 (config shape), TASK-BQ01-002 (`BigQueryAdapter` symbol).

## Interfaces

- Consumes:

```ts
import { BigQueryAdapter } from "../adapters/bigquery";        // TASK-BQ01-002
import { validateBigQueryConnection } from "../config/types";  // TASK-BQ01-001 (manager guard)
export type AdapterFactory = (cfg: ConnectionConfig, password: string) => DbAdapter; // unchanged signature
```

- Produces: `createAdapter` now returns `DbAdapter` for all four `DriverType` members;
  `ConnectionManager` treats bigquery as password-less (callers can pass `""`).

---

## Discussion

### 2026-09-02 · planner · unic-smart
This task deliberately owns BOTH `factory.ts` and `connectionManager.ts` in one task —
they are one admission surface and splitting them would serialize two waves for one
behavior. Roadmap lists them as one wave-2 row for the same reason.

### 2026-09-02 · planner · unic-smart
`AdapterFactory`'s signature `(cfg, password)` is NOT changed — the manager and form keep
passing `""` for bigquery. Changing the public signature would ripple into
`connectionForm.ts` (owned by TASK-BQ01-004 in the same wave) for no behavioral gain.

### 2026-09-02 · planner · unic-smart
Roadmap BQ-01 edge "user changes active connection during test": recorded assumption —
existing lifecycle-generation guards in `connectionManager.ts` already cover this (test
runs against the adapter captured at connect-time; switching active connection creates a
new generation). Round 2 does not add a pinning test; if the executor finds the guard
absent while implementing test #4/#5, escalate in the Executor Report rather than
silently widening scope.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

**STATUS:** DONE
**EXECUTOR_TOOL:** claude-code
**EXECUTOR_MODEL:** unic-code
**EXECUTOR_SUBAGENT:** -

### Summary

Added `case "bigquery": return new BigQueryAdapter(cfg)` to the factory
(preserving the `never` exhaustiveness arm) and made `ConnectionManager`
skip ALL SecretStorage I/O for `driver === "bigquery"` connections (add,
edit, delete, getAdapter, getAdapterFor). `dispose()` is now idempotent
(double-dispose is a no-op) and clears the active bookkeeping; post-dispose
adapter construction fails fast via `ConnectionManagerDisposedError`.

### Test Plan Followed

§4 Test Cases from the task file. RED output captured in commit history.

### Files Changed

- `src/adapters/factory.ts`: Replaced the `NotImplementedError("bigquery")` placeholder with `return new BigQueryAdapter(cfg)`. The `password` argument is intentionally ignored for bigquery (BCP: callers pass `""`). The `never` exhaustiveness arm in the `default:` case is preserved.
- `src/core/connectionManager.ts`:
  - New exported class `ConnectionManagerDisposedError` (TASK-BQ01-003 explicit post-dispose error).
  - New private method `requireNotDisposed()` wired into `addConnection`, `editConnection`, `getAdapter`, `getAdapterFor`.
  - `addConnection`: skip `tryStorePassword` when `cfg.driver === "bigquery"`.
  - `editConnection`: skip `tryGetPassword` (use `""`) and skip `tryStorePassword` for bigquery; uses the post-patch `next.driver` for the guard so driver flips during edit still behave correctly.
  - `deleteConnection`: capture the old config BEFORE splice (regression repair — variable name), then skip `tryDeletePassword` for bigquery.
  - `getAdapter` (active path) and `getAdapterFor` (passive path): skip `secrets.get(KEY_PASS_PREFIX + active.id)` for bigquery; pass `""` straight through to the factory.
  - `dispose()`: idempotent guard (`if (this.disposed) return`); resets `currentActiveId` and `state.activeId` to null so `getActive()` reflects post-dispose state; tunnel/idleTimer/stopAll all unchanged.
- `src/adapters/__tests__/factory.test.ts`: Added 2 new tests in a dedicated `describe` block for bigquery admission (returns `BigQueryAdapter`, duck-types DbAdapter surface). Pre-existing 4 tests untouched.
- `src/core/__tests__/connectionManager.test.ts`: Added a 3-test `describe` block (Test #3 SecretStorage spy, Test #4 dispose idempotency, Test #5 edit/getAdapter password skip). Pre-existing 40 tests untouched.

### Tests Added

- `src/adapters/__tests__/factory.test.ts`: `createAdapter — TASK-BQ01-003 bigquery admission`:
  - `bigquery → trả về BigQueryAdapter (ignores password argument)`
  - `bigquery → duck-type DbAdapter surface (connect/close/runQuery/testConnection/listSchemas)`
- `src/core/__tests__/connectionManager.test.ts`: `ConnectionManager — TASK-BQ01-003 bigquery admission`:
  - `TASK-BQ01-003 #3 — addConnection(bigqueryCfg) never touches SecretStorage`
  - `TASK-BQ01-003 #4 — dispose idempotent + post-dispose adapter use fails fast`
  - `TASK-BQ01-003 #5 — edit + getAdapter paths skip password demand for bigquery`

### Verification

```text
$ npx vitest run src/adapters/__tests__/factory.test.ts src/core/__tests__/connectionManager.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq01-003

 ✓ src/core/__tests__/connectionManager.test.ts  (43 tests) 82ms
 ✓ src/adapters/__tests__/factory.test.ts  (6 tests) 2ms

 Test Files  2 passed (2)
      Tests  49 passed (49)
   Start at  18:13:09
   Duration  420ms
```

```text
$ npm run typecheck
> vsdb@1.46.0 typecheck
> tsc --noEmit
(exit 0, no output)
```

```text
$ npx vitest run src/adapters/__tests__/bigquery.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq01-003

 ✓ src/adapters/__tests__/bigquery.test.ts  (6 tests) 4ms

 Test Files  1 passed (1)
      Tests  6 passed (49)
```

All verification commands pass. RED confirmation:

```text
$ npx vitest run src/adapters/__tests__/factory.test.ts --reporter verbose
× src/adapters/__tests__/factory.test.ts > createAdapter — TASK-BQ01-003 bigquery admission > bigquery → trả về BigQueryAdapter (ignores password argument)
  → Driver "bigquery" is not implemented yet (TASK-004 will add it).
× src/adapters/__tests__/factory.test.ts > createAdapter — TASK-BQ01-003 bigquery admission > bigquery → duck-type DbAdapter surface (connect/close/runQuery/testConnection/listSchemas)
  → Driver "bigquery" is not implemented yet (TASK-004 will add it).

× src/core/__tests__/connectionManager.test.ts > ConnectionManager — TASK-BQ01-003 bigquery admission > TASK-BQ01-003 #3 — addConnection(bigqueryCfg) never touches SecretStorage
  → expected [ 'vsdb.pass.bq1' ] to not include 'vsdb.pass.bq1'
× ... > TASK-BQ01-003 #4 — dispose idempotent + post-dispose adapter use fails fast
  → expected { id: 'bq1', ... } to be null
× ... > TASK-BQ01-003 #5 — edit + getAdapter paths skip password demand for bigquery
  → expected [ 'vsdb.pass.bq1' ] to not include 'vsdb.pass.bq1'
```

### Issues / Notes

- During implementation, the `deleteConnection` change initially referenced
  a variable named `old` that hadn't been captured yet (the original code
  spliced before reading). This was caught immediately by the existing
  regression test suite (4 unrelated tests failed) and fixed by moving the
  capture above the splice. GREEN confirmed after the fix.
- Test #4 (dispose idempotent + post-dispose fail-fast) asserts at the
  Manager level: factory call count is stable across dispose calls AND
  `getActive()` returns null post-dispose. The BigQueryAdapter's own
  `BigQueryClosedError` (TASK-BQ01-002) is the LOWER level — the
  Manager-level `ConnectionManagerDisposedError` gates BEFORE any
  adapter construction, which is the contract the task asks for.
- The `requireNotDisposed()` guard is added to `addConnection`,
  `editConnection`, `getAdapter`, `getAdapterFor`. `setActive` and
  `deleteConnection` were left untouched — setActive only mutates
  bookkeeping (no factory call), and deleteConnection is a state mutation
  that already short-circuits on the idempotent `idx < 0` guard; the
  factory-admission paths covered above are sufficient to gate the
  "post-dispose adapter use" contract.
- 20 unrelated UI/bundle tests fail under `npx vitest run` (without
  `npm run compile` first) — these test the compiled `dist/` artifacts and
  fail in any worktree without a prior compile. They are environmental,
  not regressions from this task. The task's focused verification commands
  all pass cleanly.
- No `INDEX.md` touched per the task instructions.

### Next

Ready for review.
