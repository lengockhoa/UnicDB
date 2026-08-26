# TASK-005 — MySQL sort twin and explicit UTC adapter sessions

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.4

## Goal

Add the missing real MySQL adapter sort helper and delegate the composer to it. Establish an explicit UTC contract for MySQL driver parsing/server sessions and MSSQL tedious parsing so UTC-derived timestamp filters do not depend on the extension host timezone.

## Target Files

- `src/adapters/mysql.ts` — export sort helper; set mysql2 `timezone: "Z"`; route the four explicit pool checkouts and `MySqlAdapter.query(sql, values)` through one helper that awaits one UTC session initialization per physical connection and fails closed; replace the latter's direct `pool.query()` with helper checkout, `connection.query()`, and `finally` release.
- `src/adapters/mssql.ts` — explicitly set tedious `options.useUTC: true`.
- `src/ui/queryComposer.ts` — delegate the MySQL sort arm to `mysql.getTableSortQuery` while retaining MSSQL delegation and PostgreSQL output.
- `src/adapters/__tests__/mysql.sortQuery.test.ts` **(new)** — helper contract/parity/security tests.
- `src/adapters/__tests__/timezone.test.ts` **(new)** — faithful mysql2/tedious configuration, ordering, and failure tests.
- `src/ui/__tests__/queryComposer.test.ts` — MySQL delegation/parity and non-UTC timestamp-literal regression tests.

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

## Test Files

- `src/adapters/__tests__/mysql.sortQuery.test.ts` **(new)**
- `src/adapters/__tests__/timezone.test.ts` **(new)**
- `src/ui/__tests__/queryComposer.test.ts`

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/mysql.sortQuery.test.ts src/adapters/__tests__/timezone.test.ts src/ui/__tests__/queryComposer.test.ts
npm run typecheck
```

`package.json` has no lint script. No bundle-loading test is selected, so compile is not required for this task's targeted lane; final cycle verification compiles first.

## Acceptance Criteria

- [ ] MySQL exports the exact four-argument sort signature used by Postgres/MSSQL and quotes through `quoteIdent`.
- [ ] `composeSortQuery("mysql", ...)` delegates to the adapter helper; output parity and injection tests pass.
- [ ] All four explicit `pool.getConnection()` call sites and `MySqlAdapter.query(sql, values)` use one checkout helper; `query()` performs `connection.query()` and releases in `finally`, so parser configuration and every physical server session—including replacements—are UTC before user work, with success cached in a `WeakSet` and in-flight setup deduplicated.
- [ ] Initialization errors fail closed and release the checkout; they are never marked initialized.
- [ ] tedious receives explicit `useUTC: true` without changing existing SSL/timeout options.
- [ ] Tests restore any mocked process/global state and do not require live databases.
- [ ] Targeted tests and typecheck exit 0.
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

---
