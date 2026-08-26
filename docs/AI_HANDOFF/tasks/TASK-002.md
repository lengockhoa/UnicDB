# TASK-002 — Make MySQL multi-statement batches atomic

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 item 2, §3.2

## Goal

Remove M2: MySQL's non-streaming multi-statement `runQuery()` loop currently executes each
statement through separate autocommit operations. Execute the whole batch on one checked-out
UTC-session connection inside one transaction, rolling back and rethrowing on failure. Document
the user-facing all-or-nothing contract and the MySQL DDL limitation.

## Target Files

- `src/adapters/mysql.ts` — replace the `executeText` loop in `runQuery()` with a held
  `PoolConnection` transaction using the existing `getConnectionWithUtcSession()` and
  `runQueryOnConnection()` helpers.
- `src/adapters/__tests__/adapterQueryShape.test.ts` — extend the existing
  `mockMysqlConnection` / `mockMysqlPool` harness at `:600-700` with transaction call-order
  regressions.
- `README.md` — document atomic DML batch policy and MySQL DDL implicit-commit limitation.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Three-statement DML batch commits once | Call log is exactly `getConnection, SET time_zone, beginTransaction, query:INSERT 1, query:UPDATE 2, query:DELETE 3, commit, release`; returned results preserve statement order. | `mysqlAdapterWithPool` existing test helper; fake pool whose direct `query` throws. |
| 2 | edge — failure | Statement two failure rolls back all prior work | Statement 2 rejects `Error("boom")`; `runQuery` rejects the same error; call log ends `query:INSERT 1, query:UPDATE 2, rollback, release`; `commit` is absent. | Held mock connection with query implementation throwing only on UPDATE. |
| 3 | regression — streaming | Single SELECT remains a streaming query | `runQuery("SELECT * FROM t")` returns `{results:[], batched}` and neither `beginTransaction` nor `commit` is called. | Existing single-SELECT streaming mock. |
| 4 | edge — boundary/pool ownership | Multi-statement arm never uses pool.query | The mock `pool.query` throws `pool.query must never be reached`; a two-statement batch still resolves successfully through only the checked-out connection. | Existing M1-style pool harness. |
| 5 | edge — empty | Whitespace/semicolon-only input remains empty | Input split to zero statements returns `{results:[]}` without checking out a connection or beginning a transaction. | Existing `splitStatements` behavior. |

## Test Files

- `src/adapters/__tests__/adapterQueryShape.test.ts`

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
npm run typecheck
```

This task does not load a `dist/*.js` bundle, so compile is not required for its targeted test.
`package.json` has no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [ ] Multi-statement non-streaming MySQL batches acquire exactly one UTC-session connection.
- [ ] Success calls `beginTransaction`, runs every statement on that same connection, commits,
      and releases once.
- [ ] Any statement failure calls rollback before release and rethrows the original failure;
      commit is never called.
- [ ] The single-SELECT `BatchedQuery`/streaming branch remains unchanged.
- [ ] README tells users DML batches are all-or-nothing but MySQL DDL can implicitly commit and
      is therefore not atomic.
- [ ] All listed verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes: `MySqlAdapter.runQuery(sql): Promise<RunResult>` (`mysql.ts:190`);
  `getConnectionWithUtcSession(): Promise<PoolConnection>` (`:504-516`);
  `runQueryOnConnection(connection, sql): Promise<RunResult>` (`:427-447`);
  mysql2 `PoolConnection.beginTransaction()`, `commit()`, `rollback()`, `release()`.
- Produces: unchanged public `RunResult` shape with a new atomicity guarantee for MySQL
  non-streaming batches.

---

## Discussion

1. **Do not concatenate BEGIN/COMMIT into `executeText`.** `multipleStatements:false` at
   `mysql.ts:76` makes that invalid. A held `PoolConnection` is mandatory.
2. **Use existing helpers, do not build a parallel query mapper.** `runQueryOnConnection` is
   already the pinning-safe transaction execution helper used by `beginTransaction()` at `:246`.
3. **DDL caveat is intentional.** MySQL implicitly commits many DDL statements. The implementation
   must roll back on thrown errors, but documentation must not promise that DDL is reversible.
4. **TDD order.** Write the one-connection call-order test and failing rollback test first; today
   they fail because the loop calls `executeText` instead of the held connection.

---
