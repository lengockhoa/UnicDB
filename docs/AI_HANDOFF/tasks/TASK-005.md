# TASK-005 — MySQL sort twin and explicit UTC adapter sessions

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.4

## Goal

Add the missing real MySQL adapter sort helper and delegate the composer to it. Establish an explicit UTC contract for MySQL driver parsing/server sessions and MSSQL tedious parsing so UTC-derived timestamp filters do not depend on the extension host timezone.

## Target Files

- `src/adapters/mysql.ts` — export sort helper; set mysql2 `timezone: "Z"`; route the four explicit pool checkouts and `MySqlAdapter.query(sql, values)` through one helper that awaits one UTC session initialization per physical connection and fails closed; **(M1)** replace `query()`'s direct `this.pool.query(sql, values)` at `:398-408` with helper checkout, `connection.query(sql, values)`, and `finally` release, so it becomes the single choke point through which all nine `information_schema` metadata call sites and `executeText`'s non-streaming DML flow; **(M3)** in `openStreamingQuery`, also settle the `firstFields` promise on the stream's `"end"` event (`:439-445`, awaited at `:591-598`) so a stream that ends without ever emitting `fields` or `error` resolves as an empty success (`columns = []`) instead of hanging forever and leaking the pooled connection.
- `src/adapters/mssql.ts` — explicitly set tedious `options.useUTC: true`.
- `src/ui/queryComposer.ts` — delegate the MySQL sort arm to `mysql.getTableSortQuery` while retaining MSSQL delegation and PostgreSQL output.
- `src/adapters/__tests__/mysql.sortQuery.test.ts` **(new)** — helper contract/parity/security tests.
- `src/adapters/__tests__/timezone.test.ts` **(new)** — faithful mysql2/tedious configuration, ordering, and failure tests.
- `src/ui/__tests__/queryComposer.test.ts` — MySQL delegation/parity and non-UTC timestamp-literal regression tests.
- `src/adapters/__tests__/adapterQueryShape.test.ts` — **(M1)** `query()` checkout/release shape; **(M3)** fake-stream `end`-without-`fields` case. Existing file, already mocks mysql2-shaped adapter internals.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | MySQL sort helper and composer parity | Both return `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY `name` ASC`; source dispatch contains a MySQL delegation, not an inline duplicate. | Four-argument helper/composer calls |
| 2 | edge — injection | Backtick payload is one identifier | Column ``n`; DROP TABLE x--`` is emitted within one backtick-quoted identifier with embedded backtick doubled; no free `DROP` token appears outside it. | ASC sort payload |
| 3 | edge — empty/boundary | WHERE and direction boundaries | Whitespace WHERE is omitted, non-empty WHERE is outer, DESC is preserved, and empty original SQL follows existing Postgres/MSSQL helper shape. | Empty SQL/WHERE and DESC fixtures |
| 4 | happy | UTC checkout and tedious options | mysql2 receives `timezone: "Z"`; checkout awaits `SET time_zone = '+00:00'` before returning the connection; tedious receives `useUTC: true`. | Mocked promise pool/core connection shapes |
| 5 | edge — failure | UTC session setup fails closed | Initialization rejection releases that checkout and rejects the adapter operation; no user query executes on the uninitialized connection. | mysql2 connection query rejects |
| 6 | edge — concurrency | Every physical connection initializes once | Two physical pool connections each initialize exactly once; repeated checkouts of one identity skip only after successful initialization and never overtake an in-flight initialization. | Faithful promise connection identity fixture |
| 7 | edge — replacement/state | Direct-query replacement initializes before SQL | After a pool connection loss, `MySqlAdapter.query(sql, values)` acquires the replacement through the helper, runs `SET time_zone = '+00:00'` before its metadata/non-streaming query, and releases it; no direct `pool.query()` is called. | Sequential mocked physical connections; invoke `listSchemas()` or `runQuery()` non-streaming path after replacement |
| 8 | regression — environment | Host TZ cannot shift canonical filter literal | Under a non-UTC `TZ`, `buildFilterWhere` emits the same MySQL/MSSQL UTC-naive literal `2024-03-01 10:30:00.000`; process timezone is restored after the test. | Canonical Date/ISO typed filter |
| 9 | regression — M1 | `query()` checks out and always releases | With a mock pool, calling `listSchemas()` invokes `pool.getConnection()` exactly once, runs the SQL through `connection.query`, and calls `connection.release()` exactly once; `pool.query` is never called. | Mock promise pool whose `query` would throw if reached |
| 10 | edge — failure/cleanup (M1) | A rejecting query still releases the connection | When `connection.query` rejects, `listSchemas()` rejects with that error **and** `connection.release()` was still called exactly once — no leaked checkout on the error path. | Mock connection whose `query` rejects |
| 11 | edge — pathological stream (M3) | Stream `end` without `fields` resolves empty, not hung | A fake stream emitting only `"end"` makes `openStreamingQuery` resolve within the test (no timeout) with `columns` `[]`; the first `fetchBatch()` returns `null` and the pooled connection is released exactly once. RED before fix: the promise never settles and the test times out. | Fake mysql2 stream stub emitting `end` only |
| 12 | edge — ordering (M3) | `fields` still wins when it arrives | A fake stream emitting `"fields"` then rows then `"end"` yields those column names (not `[]`), proving the new `end` listener does not pre-empt the normal path; a stream emitting `"error"` first still rejects and destroys the connection. | Fake stream stubs for both orderings |

## Test Files

- `src/adapters/__tests__/mysql.sortQuery.test.ts` **(new)**
- `src/adapters/__tests__/timezone.test.ts` **(new)**
- `src/ui/__tests__/queryComposer.test.ts`
- `src/adapters/__tests__/adapterQueryShape.test.ts` — cases 9–12 (M1, M3)

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/mysql.sortQuery.test.ts src/adapters/__tests__/timezone.test.ts src/ui/__tests__/queryComposer.test.ts src/adapters/__tests__/adapterQueryShape.test.ts
npx vitest run src/adapters/__tests__/schemas.test.ts src/adapters/__tests__/factory.test.ts src/core/__tests__/queryRunner.test.ts
npm run typecheck
```

The second command is the regression lane for the M1 checkout change (metadata callers of `query()` plus the runner contract). `package.json` has no lint script. No bundle-loading test is selected, so compile is not required for this task's targeted lane; final cycle verification compiles first.

## Acceptance Criteria

- [ ] MySQL exports the exact four-argument sort signature used by Postgres/MSSQL and quotes through `quoteIdent`.
- [ ] `composeSortQuery("mysql", ...)` delegates to the adapter helper; output parity and injection tests pass.
- [ ] All four explicit `pool.getConnection()` call sites and `MySqlAdapter.query(sql, values)` use one checkout helper; `query()` performs `connection.query()` and releases in `finally`, so parser configuration and every physical server session—including replacements—are UTC before user work, with success cached in a `WeakSet` and in-flight setup deduplicated.
- [ ] Initialization errors fail closed and release the checkout; they are never marked initialized.
- [ ] tedious receives explicit `useUTC: true` without changing existing SSL/timeout options.
- [ ] **(M1)** `this.pool.query(` no longer appears anywhere in `src/adapters/mysql.ts`; `query()` releases its checkout in `finally` on both the success and the rejection path.
- [ ] **(M3)** `openStreamingQuery` cannot hang when the stream ends without `fields`: that case resolves as an empty success with `columns: []`, releases the connection exactly once, and the normal `fields`-first and `error`-first orderings are unchanged.
- [ ] Tests restore any mocked process/global state and do not require live databases; the M3 case proves resolution without relying on a test timeout.
- [ ] Targeted tests, the regression lane, and typecheck exit 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — host/adapter audit gate.
- TASK-004 — owns the preceding `src/ui/queryComposer.ts` edit and shared helper.

## Interfaces

- Consumes: shared `stripTrailingSemicolon(sql: string): string` from TASK-004 if wrapping terminator normalization is needed; `quoteIdent(name: string, dialect: Dialect): string`; mysql2 `createPool(...)`, `PromisePool.getConnection(): Promise<PromisePoolConnection>`, wrapper `.connection` identity, connection `.query(...)`/`.release()`, and current `MySqlAdapter.query(sql: string, values: any[] = [])`; tedious `new Connection(config)`; existing `composeSortQuery(...)`.
- Produces: `getTableSortQuery(originalSql: string, whereFromBar: string, column: string, direction: "ASC" | "DESC"): string` from `src/adapters/mysql.ts`; UTC adapter connection invariant.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Verified defaults and ordering: mysql2 currently falls back to host `local` timezone, and its core pool emits `connection` then `acquire` without awaiting async listeners. Therefore use the adapter checkout helper, not an async event hook. Tedious already defaults to UTC but the task makes it explicit. The helper must establish server session UTC, not merely configure client parsing.

### 2026-08-26 · planner · bao-opus (reconciliation gate)
Two host-audit findings folded in from `docs/AI_HANDOFF/notes/cycle-x-audit-host.md`; both live in `src/adapters/mysql.ts`, which this task already owns exclusively, so same-file ownership is intact and no new task is warranted.

- **M1 (P1, latent)** — `query()` at `:398-408` is the sole gatekeeper for all nine `information_schema` call sites and `executeText`, and it uses `pool.query()`, which checks out implicitly (verified in `mysql2/lib/base/pool.js:243-273`). With `connectionLimit: 1` there is no observable defect today, but it is exactly the hole through which a replacement physical connection would bypass the UTC session init this task introduces. This was already required by the plan (§3.4, acceptance item 5) and by plan-review Round 1; it is restated here as an explicit test-backed item rather than an implicit one. Cases 9–10 pin checkout and release, including the error path.
- **M3 (P2)** — `firstFields` (`:439-445`) resolves on `"fields"` and rejects on `"error"` but never settles on `"end"`, so a stream that ends without either hangs `openStreamingQuery` forever while holding the pooled connection; the caller never receives the handle, so `fetchBatch`/`close` are unreachable and the pool is exhausted. The audit marks the triggering server behavior as *needs live DB verification*, but the missing listener is direct code evidence and is fully testable with a fake stream. Case 12 guards against the new listener pre-empting the normal path.

M2 (multi-statement partial commit) is explicitly **not** in this task — it is pre-existing behavior, medium-sized, and queued in `INDEX.md`.

---

## Executor Report (fix round 1)

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
SUMMARY: Resumed the existing handoff/task-005 worktree (prior executor timed out). The wave-2/3 implementation was already complete and green; verified it fresh in this turn with zero code changes needed. MySqlAdapter.query() is now the single choke point via getConnectionWithUtcSession() (M1, no live `this.pool.query(` left), openStreamingQuery settles firstFields on `end` (M3), mysql2 gets `timezone: "Z"` + per-session `SET time_zone = '+00:00'` cached per physical core in a WeakSet with in-flight dedup, tedious gets explicit `useUTC: true`, and composeSortQuery's mysql arm delegates to getTableSortQuery (src/adapters/mysql.ts).
TEST_PLAN_FOLLOWED: task section — all 12 cases (1-3 sort/parity/injection/boundary, 4 UTC+tedious, 5 fail-closed, 6 per-connection-once, 7 replacement init, 8 host-TZ regression, 9-10 M1 checkout/release+error, 11-12 M3 stream end/orderings) covered and passing.
FILES_CHANGED:
  - src/adapters/mysql.ts: export getTableSortQuery (backtick-quoteIdent, ASC/DESC whitelist, outer WHERE); pool `timezone: "Z"`; getConnectionWithUtcSession/ensureUtcSession helpers with WeakSet cache + WeakMap in-flight dedup; query() (M1) uses checkout + connection.query + finally release; openStreamingQuery (M3) settles firstFields on `end`.
  - src/adapters/mssql.ts: explicit `useUTC: true` in tedious options.
  - src/ui/queryComposer.ts: mysql arm delegates to mysqlGetTableSortQuery; no inline backtick duplication.
  - src/adapters/__tests__/mysql.sortQuery.test.ts (new): 7 helper contract/parity/injection/boundary tests.
  - src/adapters/__tests__/timezone.test.ts (new): 6 tests — cases 4-8 (UTC checkout ordering, tedious useUTC, fail-closed, per-physical-init-once, replacement init, host-TZ literal stability).
  - src/ui/__tests__/queryComposer.test.ts: TASK-005 mysql delegation/parity + injection + boundary + dispatch-source tests.
  - src/adapters/__tests__/adapterQueryShape.test.ts: cases 9-12 (M1 checkout/release incl. error path; M3 end-without-fields empty success, fields-first wins, error-first rejects/destroys).
  - docs/AI_HANDOFF/INDEX.md: TASK-005 status ready -> pending_review.
  - docs/AI_HANDOFF/tasks/TASK-005.md: status + this report.
TESTS_ADDED:
  - src/adapters/__tests__/mysql.sortQuery.test.ts: basic wrap, outer WHERE, DESC, backtick-injection, direction whitelist, empty SQL, whitespace WHERE
  - src/adapters/__tests__/timezone.test.ts: mysql timezone+SET ordering, tedious useUTC, init fails closed, per-physical init once, replacement init before SQL, host-TZ literal stability
  - src/ui/__tests__/queryComposer.test.ts: mysql helper/composer parity, injection payload, WHERE/DESC/empty boundaries, dispatch-source (delegation not inline)
  - src/adapters/__tests__/adapterQueryShape.test.ts: case 9 checkout once+release, case 10 reject still releases, case 11 end-without-fields empty, case 12a fields-first wins, case 12b error-first rejects
VERIFICATION:
  command: npx vitest run src/adapters/__tests__/mysql.sortQuery.test.ts src/adapters/__tests__/timezone.test.ts src/ui/__tests__/queryComposer.test.ts src/adapters/__tests__/adapterQueryShape.test.ts
  result: 4 files, 109 tests, all pass (exit 0)
  output_excerpt: |
    ✓ src/adapters/__tests__/mysql.sortQuery.test.ts  (7 tests) 2ms
    ✓ src/adapters/__tests__/timezone.test.ts  (6 tests) 5ms
    ✓ src/adapters/__tests__/adapterQueryShape.test.ts  (41 tests) 11ms
    ✓ src/ui/__tests__/queryComposer.test.ts  (55 tests) 7ms
    Test Files  4 passed (4)      Tests  109 passed (109)
  command: npx vitest run src/adapters/__tests__/schemas.test.ts src/adapters/__tests__/factory.test.ts src/core/__tests__/queryRunner.test.ts
  result: 3 files, 31 tests, all pass (exit 0)
  output_excerpt: |
    ✓ src/core/__tests__/queryRunner.test.ts  (18 tests) 111ms
    ✓ src/adapters/__tests__/factory.test.ts  (4 tests) 1ms
    ✓ src/adapters/__tests__/schemas.test.ts  (9 tests) 4ms
    Test Files  3 passed (3)      Tests  31 passed (31)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit, no output)
  command: npx vitest run   (wave-boundary regression net)
  result: 110 files, 1544 passed, 2 skipped, 0 failed (exit 0)
  output_excerpt: |
    Test Files  110 passed | 1 skipped (111)
    Tests       1544 passed | 2 skipped (1546)
ISSUES: none. M3 note: the `firstFields` listener references `columns` declared later in the same scope (temporal-dead-zone safe — listeners only run on async events); M1 grep confirms no live `this.pool.query(` remains in src/adapters/mysql.ts.
HANDOFF_TO_REVIEWER: yes — status set to pending_review; all verification commands re-run fresh in this turn and green.
NEXT: ready for review (reviewer model must differ from executor bao-sonnet).
```
