# TASK-002 — Make MySQL multi-statement batches atomic

- Status: `pending_review`
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

| # | Type | Test name | Expected | Pre-state / Fixture |
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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts (before implementation):
   ❯ src/adapters/__tests__/adapterQueryShape.test.ts  (46 tests | 3 failed) 19ms
   ❯ … > happy: three-statement DML batch commits once on a single held connection …
     → expected [ 'getConnection', …(9) ] to deeply equal [ 'getConnection', …(7) ]
     Received: getConnection, SET time_zone, query:INSERT 1, release, getConnection,
       query:UPDATE 2, release, getConnection, query:DELETE 3, release
       (no beginTransaction, no commit — exactly the autocommit-per-statement defect)
   ❯ … > edge: statement-two failure rolls back prior work …
     → expected [ 'getConnection', …(2) ] to deeply equal [ 'query:UPDATE t SET a=2', …(2) ]
     Received tail: [query:UPDATE t SET a=2, release] — rollback absent
   ❯ … > edge: a two-statement batch resolves through ONLY the checked-out connection …
     → expected [ 'getConnection', 'getConnection' ] to have a length of 1 but got 2
   Test Files  1 failed (1)
        Tests  3 failed | 43 passed (46)
Verification Output: |
  Command 1: npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-002
     ✓ src/adapters/__tests__/adapterQueryShape.test.ts  (46 tests) 13ms
     Test Files  1 passed (1)
          Tests  46 passed (46)
     EXIT: 0
    Targeted sibling regression sweep (factory / mysql.sortQuery / schemas /
    timezone / queryComposer): 5 files, 82 passed, exit 0.
  Command 2: npm run typecheck
    > UnicDB@1.6.7 typecheck
    > tsc --noEmit
    EXIT: 0
Status: PASS
Note: Implementation deviates from plan wording in two safe ways. (1) Statements are executed via runQueryOnConnection per trimmed statement (plan-specified helper); its RunResult is unwrapped to preserve the flat QueryResult-per-statement order executeText previously produced. (2) The now-orphaned private executeText() was deleted rather than left dead (strict codebase, sole caller removed); its doc-comment content merged into query(). Rollback failures are swallowed so the original statement error propagates. Single-SELECT streaming arm untouched. README documents all-or-nothing DML contract + MySQL DDL implicit-commit caveat in "Other ways to run a query".


---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus (config `handoff.reviewer.model` = unic-smart)
EXECUTOR_MODEL: bao-sonnet (claude-code / feature-implementer) — differs, isolation OK
VERIFICATION_RERUN:
  command: `npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts`
  result: 46 pass / 0 fail (exit 0)
  command: `npm run typecheck`
  result: exit 0
  command: `npx vitest run` (full suite — shared adapter path touched)
  result: 1642 pass / 0 fail / 2 skipped (113 files)
TEST_PLAN_COVERAGE: all-followed (cases 1-5 implemented at
  `adapterQueryShape.test.ts:833-1065`; 3 edge cases ≥ minTestsEdgeCase=2). RED_OUTPUT is
  real failing output (call-order diff showing per-statement `getConnection/release`,
  missing `rollback`, 2 checkouts) — genuine TDD evidence, not a bare claim.

FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    1. `README.md:59-62` — doc/behavior drift on the headline user promise. The bullet says
       multi-statement runs via "Cmd/Ctrl+Enter on a selected region, or the whole file via the ▶ button" are
       all-or-nothing, but that UI path does NOT reach the new transaction arm.
       `extension.ts:563` (`sqlToRun`) splits the selection first and `queryRunner.ts:167`
       calls `adapter.runQuery(statements[i].text)` once per statement — verified empirically:
       a 3-statement selection produced 3 parsed statements, 2 separate `runQuery` calls
       (`done,error,cancelled`), i.e. statement 1 commits in its own transaction and is NOT
       rolled back when statement 2 fails. The atomicity is real but only for callers that
       pass a multi-statement STRING (`resultsPanel.ts:966` save bundle, `sampleDataAi.ts:240`,
       `tableCommands.ts:105/477`). Scope the README bullet to those flows, or say the
       editor Run path is per-statement. Same wording overstates Postgres too
       (`postgres.ts:320` has the identical one-client-per-call boundary).
    2. `src/ui/sampleDataAi.ts:233-236` — comment is now stale: it states run-time mid-batch
       failure "is NOT atomic ... per-statement auto-commit". That call joins statements into
       one `runQuery` string, so on MySQL it now DOES roll back. The user-visible error text at
       `:242-245` ("partial rows MAY have committed — DbAdapter exposes no transaction API")
       is likewise no longer accurate for MySQL/Postgres. Out of this task's declared Target
       Files; log as follow-up rather than fix here.
    3. `src/adapters/mysql.ts:233` — `runQueryOnConnection` re-runs `splitStatements` on text
       already split by the caller. Verified idempotent for the cases that matter (embedded
       `;` in literals, backslash escapes, leading line/block comments all re-split to exactly
       1 statement), so this is correctness-neutral duplicated work, not a defect. The
       unwrap-inner-results loop keeps flat statement order correct.

ADVERSARIAL CHECKS (all pass):
  - `release()` guaranteed on every path — it is in `finally` at `mysql.ts:246-248`, outside the
    catch, so it runs after a mid-batch throw, after a rollback that itself throws (rollback is
    wrapped in its own try/catch at :240-244), and on the `beginTransaction()` failure path.
    Exactly one release: `getConnectionWithUtcSession` only self-releases when UTC-session init
    fails, and in that case it throws before `connection` is bound — no double release.
  - Rollback failure does NOT swallow the original error: the inner catch at :242 is empty and
    `throw error` at :245 rethrows the ORIGINAL statement error. Test case 2 asserts
    `expect(caught).toBe(boom)` by identity.
  - No path commits after a partial error — `commit()` at :238 is the last statement inside the
    try, unreachable once any `runQueryOnConnection` rejects; test asserts `not.toContain("commit")`.
  - Streaming arm byte-identical: `git diff d0cd195^ d0cd195 -- src/adapters/mysql.ts` shows zero
    changed lines in the `singleSelect`/`openStreamingQuery` block; the diff is confined to the
    post-`singleSelect` loop plus the `executeText` deletion.
  - Pool pinned only for batch duration; the streaming arm returns BEFORE the checkout at :224,
    so a cursor is never wrapped in a transaction. connectionLimit:1 deadlock risk is unchanged
    from the previous code — the old loop also held the single connection per statement via
    `query()`; the batch now holds it slightly longer but never re-enters the pool while held
    (`runQueryOnConnection` uses the passed connection, never `pool.query`; test 4 makes
    `pool.query` throw and asserts exactly 1 checkout). Callers already close cursors before
    save/transaction work (`resultsPanel.ts:934-936, 1003`).
  - `executeText` deletion is safe: no remaining references anywhere in `src/`; typecheck clean.

NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Implementation is correct and well-tested; the transaction, rollback, error-identity and
release semantics all hold under adversarial reading. The only real issue is minor #1 — the
README promises atomicity for the editor Run path, which still executes one statement per
`runQuery` call and therefore is not all-or-nothing. Recommend a doc-scope fix (and follow-up
task for the stale `sampleDataAi.ts` comment/error text) rather than blocking this handoff.
