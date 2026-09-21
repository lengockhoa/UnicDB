# TASK-ARP07-001 — Schema-impact classifier (pure core, dialect-aware)

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §4, §5, §6

## Goal

Create the pure schema-impact classifier (`src/core/schemaImpact.ts`, NEW) that decides whether a
statement, if it actually completed, changes the schema surface. It reuses the existing
`maskLiteralsAndComments` literal/comment masking (no new parser) and exposes both a per-statement
predicate and a batch helper ("true iff ANY completed statement has impact"). No `vscode` import.

## Target Files

- `src/core/schemaImpact.ts` — NEW. `hasSchemaImpact(sql, dialect?)` + `completedSchemaImpact(completed, dialect?)`.
- `src/core/__tests__/schemaImpact.test.ts` — NEW. The corpus below (TDD).
- Do NOT modify `src/core/dangerousStatement.ts` or `src/core/readOnlyIntent.ts` — import `maskLiteralsAndComments` only.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `hasSchemaImpact("CREATE TABLE users (id int)", "postgres")` | `true` | single depth-0 CREATE |
| 2 | happy | DROP / ALTER / RENAME depth-0 | `true` each | `"DROP TABLE users"`, `"ALTER TABLE users ADD COLUMN email text"`, `"RENAME TABLE a TO b"` (dialect `"mysql"` for RENAME) |
| 3 | happy | SELECT and DML are NOT schema-impact | `false` each | `"SELECT * FROM users"`, `"INSERT INTO users VALUES (1)"`, `"UPDATE users SET x=1"`, `"DELETE FROM users"`, `"MERGE INTO u USING v"`, `"TRUNCATE TABLE users"` |
| 4 | edge (literal masking) | keyword inside a string literal | `false` | `"INSERT INTO t VALUES ('DROP TABLE users')"`, `"SELECT 'CREATE' FROM t"` |
| 5 | edge (comment masking) | keyword inside a comment | `false` | `"/* DROP TABLE users */ SELECT 1"`, `"-- DROP TABLE users\nSELECT 1"` |
| 6 | edge (boundary — CTE / parens) | WITH prelude and parens are not depth-0 | `false` | `"WITH x AS (SELECT 1) SELECT * FROM x"`, `"SELECT count(*) FROM users"` |
| 7 | edge (dialect — mysql) | MySQL backtick identifier and backslash-escaped literal body are masked | `false` | `` "SELECT `create` FROM t" `` and `"INSERT INTO t VALUES ('DROP\\'TABLE x')"` with `dialect="mysql"` |
| 8 | edge (data-only / maintenance) | data/maintenance statements | `false` | `"TRUNCATE TABLE users"`, `"VACUUM ANALYZE users"`, `"ANALYZE users"` |
| 9 | happy (batch) | any-completed semantics | `true` | `completedSchemaImpact(["SELECT 1", "CREATE TABLE t (id int)"], "postgres")` |
| 10 | edge (batch empty / none) | no schema impact in the batch | `false` | `completedSchemaImpact([])`, `completedSchemaImpact(["SELECT 1", "INSERT INTO t VALUES (1)"])`, `completedSchemaImpact(["SELECT 1", "TRUNCATE TABLE users"])` |
| 11 | edge (batch — mysql rename) | batch containing a completed MySQL RENAME | `true` | `completedSchemaImpact(["SELECT 1", "RENAME TABLE a TO b"], "mysql")` |

## Test Files

- `src/core/__tests__/schemaImpact.test.ts` — NEW; contains all corpus tests above. Follow the pure-core style of `src/core/__tests__/readOnlyIntent.test.ts` / `dangerousStatement.test.ts` (vitest, no vscode mock).

## Verification Commands

```bash
npm test src/core/__tests__/schemaImpact.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] `dangerousStatement.ts` and `readOnlyIntent.ts` are unchanged (import only).
- [ ] Module header documents the reconciliation: schema-impact is a strict subset of `readOnlyIntent`'s mutation set on DDL keywords, PLUS `rename`; DML/data-only/maintenance words are false; `drop` overlaps `dangerousStatement`'s red confirm tier.
- [ ] No `vscode` import; pure function.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes:
  - `maskLiteralsAndComments(sql: string, dialect?: SqlDialect): string` — imported from `./dangerousStatement` (real signature, `dangerousStatement.ts:90-223`).
  - `SqlDialect` — imported from `./statementParser` (real type: `"postgres" | "mysql" | "mssql"`, `statementParser.ts:21`).
- Produces (consumed by TASK-ARP07-004):
  - `export function hasSchemaImpact(sql: string, dialect?: SqlDialect): boolean`
  - `export function completedSchemaImpact(completed: readonly string[], dialect?: SqlDialect): boolean` — true iff ANY completed statement has schema impact.

---

## Discussion

(no comments yet)

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: Claude:feature-implementer

RED_OUTPUT (TDD step 1 — `npx vitest run src/core/__tests__/schemaImpact.test.ts` before impl):
```
 FAIL  src/core/__tests__/schemaImpact.test.ts [ src/core/__tests__/schemaImpact.test.ts ]
Error: Failed to load url ../schemaImpact (resolved id: ../schemaImpact) in
/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-arp07-001/src/core/__tests__/schemaImpact.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```
RED confirmed: fails for the expected reason — module `../schemaImpact` does not exist yet.

Verification Output (TDD step 3 — §Verification Commands, fresh in worktree):

Command 1: `npm test src/core/__tests__/schemaImpact.test.ts`
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-arp07-001

 ✓ src/core/__tests__/schemaImpact.test.ts  (11 tests) 2ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  08:18:47
   Duration  173ms (transform 22ms, setup 0ms, collect 23ms, tests 2ms, environment 0ms, prepare 35ms)
```

Command 2: `npm run typecheck`
```
> UnicDB@1.42.0 typecheck
> tsc --noEmit
```
(exit 0, no errors)

Status: PASS

Note:
- Acceptance criteria: 11/11 corpus tests pass; `dangerousStatement.ts` and `readOnlyIntent.ts` untouched (git status shows only the 2 new files); module header documents the reconciliation (strict subset of readOnlyIntent's DDL keywords + `rename`; DML/data-only/maintenance → false; `drop` overlaps dangerousStatement's red tier); no `vscode` import; pure functions.
- Exact exported signatures for TASK-ARP07-004 wiring:
  - `export function hasSchemaImpact(sql: string, dialect?: SqlDialect): boolean`
  - `export function completedSchemaImpact(completed: readonly string[], dialect?: SqlDialect): boolean`
  - `SqlDialect` re-exported type source: `./statementParser` (`"postgres" | "mysql" | "mssql"`).
- Repo eslint is not runnable standalone (legacy `.eslintrc` format, migration-guide error) — pre-existing condition, not introduced by this task; `tsc --noEmit` is the enforced gate and is clean.

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
VERIFICATION_RERUN:
  command: npm test src/core/__tests__/schemaImpact.test.ts && npm run typecheck
  result: 11 pass / 0 fail; typecheck exit 0
TEST_PLAN_COVERAGE: all-followed (11/11 corpus tests; edge cases 4-8 + 10-11 exceed min 2)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/core/schemaImpact.ts:129-137 — completedSchemaImpact does not document that every element must be a single pre-split statement. hasSchemaImpact("SELECT 1; DROP TABLE x") returns false (only the first depth-0 keyword decides; the DROP after `;` is never reached). Safe today because the seam at extension.ts:1788-1791 feeds split per-statement r.sql, but a future feeder that passes raw multi-statement batches would silently stale the cache (the false-NEGATIVE this cycle fears). Add a one-line precondition note in the module header or defensively split like readOnlyIntent.mutationStatements.
    - src/core/schemaImpact.ts:40-45 — `comment` sits in readOnlyIntent's MUTATION_KEYWORDS but is deliberately excluded here; correct for the name-only cache today (COMMENT ON changes metadata, not table/column names), but the reconciliation header should state why COMMENT ON is not schema-impact so a future comment-aware cache does not silently regress.
    - src/core/schemaImpact.ts:115 — JSDoc continuation line missing leading space after `*` (cosmetic only).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Model isolation OK (reviewer unic-smart != executor unic-code). Adversarial probes re-run independently and all pass: /* create */ SELECT and literal/backtick/bracket masking all false; DML (INSERT/UPDATE/DELETE/MERGE/TRUNCATE) all false; CREATE/ALTER/DROP/RENAME true incl. CREATE OR REPLACE and DROP ... IF EXISTS; the known MSSQL [insert] false-positive class does NOT affect this classifier (first-keyword scan; bracket identifiers never open a statement). Pure module: no vscode import, no I/O, inputs unmutated. RED evidence genuine (module-not-found error with stack, non-zero exit).
