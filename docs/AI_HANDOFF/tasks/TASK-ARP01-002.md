# TASK-ARP01-002 — Transaction guard: wrap `beginTransaction` in `guardAdapter`

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP01.md` §3, §4 (ARP-01.2)

## Goal

Close the secondary execution boundary of the read-only promise: a mutation sent through a
`DbTransaction` obtained on a read-only adapter must be blocked BEFORE the underlying driver
is invoked. Wrap `adapter.beginTransaction?()` inside `guardAdapter()` so the returned
transaction's `runQuery()` runs through the same `isMutationSql` gate as `adapter.runQuery`.
No signature changes; `src/adapters/types.ts` untouched; `commit()`/`rollback()` pass
through unchanged; adapters without `beginTransaction` gain nothing.

## Target Files

- `src/core/connectionManager.ts` — extend `guardAdapter` (`:652-669`). Keep the existing
  `runQuery` wrap byte-identical; ADD a `beginTransaction` wrap as described in PLAN §3.
- `src/core/__tests__/connectionManager.test.ts` — ADD a new describe block for the
  transaction guard. Reuse the `STUB_CTX` + factory pattern (existing `DBX-05 read-only +
  tunnel` describe at `:411-437`); extend the fake adapter with `beginTransaction` returning
  `{ runQuery, commit, rollback }` over a tracked driver `runs[]` array so the "driver never
  called" assertion is observable.

## Test Cases (REQUIRED — TDD)

RED-first: write the "readOnly tx DELETE is blocked and the driver is never called" test
FIRST, run it, paste the RED output, then implement the wrap.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | readOnly tx `SELECT` passes to driver once | `tx.runQuery("SELECT 1")` → underlying driver tx-`runQuery` called exactly once; result returned | fake adapter with `beginTransaction` (readOnly cfg) |
| 2 | edge: block-before-driver | readOnly tx `DELETE` throws before driver | `tx.runQuery("DELETE FROM t")` throws `ReadOnlyViolation`; driver tx-`runQuery` NEVER called (`runs[]` empty). **RED on a948b3f** (unwrapped tx would call driver) → flips GREEN after wrap | same |
| 3 | edge: optional API preserved | adapter without `beginTransaction` | guarded `adapter.beginTransaction` stays `undefined`; `adapter.runQuery` still throws `ReadOnlyViolation` on `DELETE` | fake adapter WITHOUT `beginTransaction` (readOnly cfg) |
| 4 | edge: per-call freshness | two `beginTransaction()` calls each guard their own tx | mutation on tx2 throws `ReadOnlyViolation`; `commit()` on tx1 still resolves and calls driver once; tx1 and tx2 are distinct objects | fake adapter, two sequential `beginTransaction()` calls |
| 5 | edge: non-readOnly regression | `readOnly: false` tx mutation passes through | no `ReadOnlyViolation`; driver tx-`runQuery` called with the DELETE text | fake adapter, `readOnly: false` |
| 6 | edge: values passthrough | `tx.runQuery(sql, values)` forwards args unchanged | driver tx-`runQuery` receives exactly `(sql, values)` | `tx.runQuery("UPDATE t SET a=$1", [1])` on readOnly — note: blocked (mutation), so use `"SELECT $1"` to exercise passthrough |
| 7 | regression | commit/rollback pass through | `tx.commit()` / `tx.rollback()` call the driver once each, no interception | same fixture |

## Test Files

- `src/core/__tests__/connectionManager.test.ts` — ADD the 7 cases above as a new
  `describe("ConnectionManager ARP-01 transaction guard", ...)`. Do not modify the existing
  DBX-05/RLX-03 describes.

## Verification Commands

```bash
npx vitest run src/core/__tests__/connectionManager.test.ts
npm run typecheck
npm run compile
git diff a948b3f -- src/adapters/types.ts      # MUST be empty
```

(Selection per RULES: `connectionManager.ts` resolves via `.cache/index/tests-map.json` to
`connectionManager.test.ts` — verified. No lint script exists; typecheck + compile are the
static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: "readOnly tx DELETE throws before driver" fails on base
      a948b3f BEFORE the wrap (test run output captured in the Executor Report).
- [ ] Case 2 GREEN after wrap — driver `runQuery` never invoked for a tx mutation on a
      read-only adapter.
- [ ] Cases 1, 3–7 GREEN (SELECT once; optional API preserved; per-call freshness; non-RO
      passthrough; values forwarded; commit/rollback passthrough).
- [ ] `git diff a948b3f -- src/adapters/types.ts` is EMPTY — no signature change.
- [ ] Existing DBX-05 and RLX-03 describes in `connectionManager.test.ts` still green —
      the `runQuery` guard behavior is unchanged.
- [ ] `npx vitest run src/core/__tests__/connectionManager.test.ts`, `npm run typecheck`,
      `npm run compile` all exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `none` (wave 1, runs in parallel with TASK-ARP01-001). It consumes ARP-01.1's classifier
  API surface but does NOT require 001 to be merged first — `isMutationSql`/`mutationStatements`/
  `ReadOnlyViolation` already exist on base.

## Interfaces

- Consumes:
  - `isMutationSql(sql: string, dialect?: SqlDialect): boolean` —
    `src/core/readOnlyIntent.ts:91`.
  - `mutationStatements(sql: string, dialect?: SqlDialect): string[]` —
    `src/core/readOnlyIntent.ts:96`.
  - `ReadOnlyViolation` — `src/core/readOnlyIntent.ts:12`.
  - `DbAdapter.beginTransaction?(): Promise<DbTransaction>` — `src/adapters/types.ts:123`.
  - `DbTransaction { runQuery(sql: string, values?: unknown[]): Promise<RunResult>; commit(): Promise<void>; rollback(): Promise<void> }` — `src/adapters/types.ts:86-95`.
- Produces: on a guarded read-only adapter, `beginTransaction()` returns a
  `DbTransaction` whose `runQuery` is wrapped (mutation → `ReadOnlyViolation` before the
  driver; `commit`/`rollback` untouched). This covers every real caller (QueryRunner
  `:419-424`, ResultsPanel `:1057`, importExecute `:127-137`) because they all obtain the
  adapter through ConnectionManager (`getAdapter` `:543` / `getAdapterFor` `:343`), both of
  which route through `guardAdapter`.

## Discussion

- Optional synergy (NOT required): if `ConnectionConfig.driver` is the same
  `"postgres"|"mysql"|"mssql"` union as `SqlDialect`, you MAY thread `cfg.driver` into
  `isMutationSql(sql, cfg.driver)` so the guard inherits ARP-01.1's dialect masking. The
  default (postgres) path is fully acceptable and covered by the tests. Record the choice.
- Do not change commit/rollback semantics; do not force `beginTransaction` to exist; do not
  touch `src/adapters/types.ts`.

---

## Executor Report

```
STATUS:
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY:
TEST_PLAN_FOLLOWED:
RED_FIRST:
  command: npx vitest run src/core/__tests__/connectionManager.test.ts (new tx-block case)
  result: <paste RED here — must be present before implementation>
FILES_CHANGED:
TESTS_ADDED:
VERIFICATION:
  command: npx vitest run src/core/__tests__/connectionManager.test.ts
  result:
  command: npm run typecheck
  result:
  command: npm run compile
  result:
  command: git diff a948b3f -- src/adapters/types.ts
  result:
ISSUES:
HANDOFF_TO_REVIEWER:
NEXT:
```

## Reviewer Verdict

REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERDICT:
VERIFICATION_RERUN:
TEST_PLAN_COVERAGE:
FINDINGS:
NOTES:
