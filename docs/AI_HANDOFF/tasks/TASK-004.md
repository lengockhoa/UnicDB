# TASK-004 — Statement splitter: transaction scripts, loop-stack leak, MySQL escapes, MSSQL GO

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (in-scope C1-C4) — §7 Global Constraints applies by reference

## Goal

Fix the splitter so a transactional script is not collapsed into one statement.

- **C1** — `handleKeyword` (`src/core/statementParser.ts:406-408`) pushes `BLOCK` for **every**
  `BEGIN`, and `countBlocks() > 0` suppresses every `;` boundary (`:341-347`), while
  `COMMIT`/`ROLLBACK` never pop. Verified: `BEGIN; INSERT…; COMMIT;` → **1** statement (expected
  3). Distinguish transaction control (`BEGIN;`, `BEGIN TRANSACTION`, `BEGIN WORK`, `BEGIN
  ISOLATION LEVEL …`) from a plpgsql `BEGIN … END` body, and pop on `COMMIT`/`ROLLBACK`/`END
  TRANSACTION`.
- **C2** — `FOR`/`WHILE` (`:421-424`) push `LOOP` unconditionally, so `SELECT … FOR UPDATE` leaks
  a stack entry and a later `END` pops the garbage, desynchronizing depth for the rest of the
  buffer. Only push when the construct is a real loop header.
- **C3** — backslash escapes are unhandled, so MySQL's default `\'` splits a literal:
  `SELECT 'it\'s'; SELECT 2;` → 1 statement. Make escape handling **dialect-conditional**.
- **C4** — no `GO` batch separator for MSSQL: `SELECT 1 GO SELECT 2 GO` → 1 statement.

C5 (leading comments absorbed into the next statement) is explicitly **out of scope** — see
PLAN §2; TASK-005 fixes its only real downstream cost.

## Target Files

- `src/core/statementParser.ts`
- `src/core/__tests__/statementParser.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | plain script | `splitStatements("SELECT 1; SELECT 2;")` → 2 |
| Happy | transaction script | `BEGIN; INSERT INTO t VALUES (1); COMMIT;` → **3**, texts `BEGIN`, `INSERT …`, `COMMIT` |
| Edge (nesting) | plpgsql body | `CREATE FUNCTION f() … AS $$ BEGIN RETURN 1; END $$; SELECT 1;` → 2 (body not split) |
| Edge (nesting) | `BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT 1; ROLLBACK;` | 3 |
| Edge (dialect) | MySQL escape | `splitStatements("SELECT 'it\\'s'; SELECT 2;", "mysql")` → 2 |
| Edge (dialect) | Postgres unchanged | same input with dialect `postgres` keeps today's result (E'' semantics untouched) |
| Edge (batch separator) | MSSQL | `splitStatements("SELECT 1\nGO\nSELECT 2\nGO", "mssql")` → 2, no statement text contains `GO` |
| Edge (false friend) | column named `go` | `SELECT go FROM t` (mssql) → 1 statement, not split |
| R (C1) | `BEGIN; INSERT…; COMMIT;` | today 1 |
| R (C2) | `SELECT * FROM t FOR UPDATE; SELECT 1;` | today the second `;` is suppressed / depth desyncs; after fix → 2 with an empty construct stack |
| R (C3) | MySQL `\'` | today 1 |
| R (C4) | MSSQL `GO` | today 1 |

## Test Files

- `src/core/__tests__/statementParser.test.ts` (extend)

## Verification Commands

```bash
npm run typecheck
npm test -- src/core/__tests__/statementParser.test.ts
npm test -- src/core/__tests__/dangerousStatement.test.ts
npm test -- src/core/__tests__/keywordQualify.test.ts
npm test -- src/ui/__tests__/codeLensProvider.test.ts
npm test -- src/core/__tests__/queryRunner.test.ts
```

## Acceptance Criteria

- [ ] All 12 cases pass; each regression case confirmed failing on `main` first (output pasted
      into the report).
- [ ] `splitStatements(sql)` with no dialect argument behaves **exactly** as today for every
      existing test in `statementParser.test.ts` (no snapshot churn) — the dialect parameter is
      optional and additive.
- [ ] `GO` is only a separator when it is the sole token on its line and the dialect is `mssql`.
- [ ] Backslash escaping is active only for `mysql`.
- [ ] Construct stack is empty after a `SELECT … FOR UPDATE` statement (assert directly, not via
      statement count alone).
- [ ] No new copy of the tokenizer: if shared helpers are extracted, `keywordQualify.ts` and
      `dangerousStatement.ts` are left untouched this cycle (they belong to other tasks/waves) —
      extraction must be additive and non-breaking.
- [ ] `npm run typecheck` clean.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)`
- Produces:

```ts
export type SqlDialect = "postgres" | "mysql" | "mssql";
export interface ParsedStatement { text: string; start: number; end: number; }

/** `dialect` is NEW and optional — omitted ⇒ today's postgres-ish behavior. */
export function splitStatements(sql: string, dialect?: SqlDialect): ParsedStatement[];

export function statementAtCursor(/* unchanged */): ParsedStatement | null;
export function sqlToRun(/* unchanged */): string;
```

`PostgresAdapter.runQuery` (`src/adapters/postgres.ts:156`) calls `splitStatements(sql)` with one
argument — TASK-005 owns that file and may start passing a dialect; keep the 1-arg form valid.

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

Callers of `splitStatements` at HEAD include `postgres.ts:156`, the CodeLens provider and
`keywordQualify`. Those files are owned by other tasks this cycle — this task must not edit them,
which is why the dialect parameter is optional.

`BEGIN` disambiguation rule of thumb, cheapest first: `BEGIN` immediately followed by `;`, or by
`TRANSACTION` / `WORK` / `ISOLATION`, is transaction control. `BEGIN` inside a `$$…$$` /
`AS`-body, or preceded by `DECLARE`, is a plpgsql block. If a case is genuinely ambiguous, prefer
treating it as transaction control **only** when block depth is 0 — a plpgsql `BEGIN` always
appears inside a `CREATE FUNCTION/PROCEDURE/DO` context.

---
