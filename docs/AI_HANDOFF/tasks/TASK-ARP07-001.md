# TASK-ARP07-001 — Schema-impact classifier (pure core, dialect-aware)

- Status: `ready`
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

<!-- Phase 3 executor appends below. -->

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->
