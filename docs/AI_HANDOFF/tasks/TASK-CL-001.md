# TASK-CL-001 — MSSQL bracket-identifier masking + read-only guard dialect threading

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 TASK-CL-001

## Goal

Close the MSSQL bracket-quoted-identifier false-positive class: `SELECT * FROM [insert]`
on a read-only MSSQL connection is currently blocked as a mutation because
`maskLiteralsAndComments` has no `[…]` branch. Add a dialect-gated mssql bracket branch to
the masker, and thread the connection's dialect through `ConnectionManager.guardAdapter`
so the guard actually uses it (today it calls `isMutationSql(sql)` with NO dialect, which
also leaves the existing mysql backtick masking inert on this path).

## Target Files

- `src/core/dangerousStatement.ts` — add mssql `[…]` identifier branch to `maskLiteralsAndComments` (gated `dialect === "mssql"`, `]`-doubling escape), mirroring the mysql backtick branch at :178-204.
- `src/core/connectionManager.ts` — `guardAdapter` (:803-839): narrow `cfg.driver` → `SqlDialect | undefined` (`"bigquery" → undefined`) and pass it to BOTH `isMutationSql(sql, dialect)` calls (:813, :832). Local helper; do NOT import from extension.ts.
- `src/core/__tests__/dangerousStatement.test.ts` — masker branch pins.
- `src/core/__tests__/readOnlyIntent.test.ts` — false-positive regression pins.
- `src/core/__tests__/schemaImpact.test.ts` — classifier-inherit pins.
- `src/core/__tests__/connectionManager.test.ts` — end-to-end read-only mssql pin.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | `maskLiteralsAndComments("SELECT * FROM [insert]", "mssql")` returns length-preserving blanked text | `'SELECT * FROM          '` — same length as input, bracket region blanked | RED at `611df12` (bracket body returned verbatim) |
| 2 | regression | `mutationStatements("SELECT * FROM [insert]", "mssql")` is empty | returns `[]` — benign SELECT on read-only mssql no longer blocked | RED at `611df12` (returns 1 entry) |
| 3 | happy | `isMutationSql("DROP TABLE [insert]", "mssql")` | `true` — real DDL with bracket-quoted table still caught | input string only |
| 4 | happy | `mutationStatements("INSERT INTO [order] VALUES (1)", "mssql")` non-empty | returns 1 entry — genuine INSERT still a mutation | input string only |
| 5 | edge (escape) | `]`-doubling escape | `mutationStatements("SELECT * FROM [we]]ird]", "mssql")` → `[]` (masker consumes the doubled `]]` and closes at the final `]`) | input string only |
| 6 | edge (malformed) | unterminated bracket | `mutationStatements("SELECT * FROM [insert", "mssql")` → `[]`, no throw — masker blanks to EOF, mirroring unterminated-string behavior | input string only |
| 7 | edge (dialect gate) | omitted/postgres dialect unchanged | `mutationStatements("SELECT * FROM [insert]")` (no dialect) → 1 entry; `mutationStatements("SELECT * FROM [insert]", "postgres")` → 1 entry — proves the fix is dialect-gated, not unconditional | input string only |
| 8 | edge (classifier inherit) | schemaImpact unaffected both ways | `hasSchemaImpact("CREATE TABLE [foo] (x int)", "mssql")` → `true`; `hasSchemaImpact("SELECT * FROM [create]", "mssql")` → `false` | input strings only |
| 9 | unit | backtick regression intact | `mutationStatements("SELECT `insert` FROM t", "mysql")` → `[]` (existing behavior pinned at :178-204 unchanged) | input string only |
| 10 | regression (e2e) | read-only mssql connection runs bracket-quoted SELECT | ConnectionManager built with `{ readOnly: true, driver: "mssql", … }` + fake adapter: `SELECT * FROM [insert]` reaches `adapter.runQuery` (no `ReadOnlyViolation`) — extends the existing read-only describe block | RED at `611df12`; requires the :813/:832 dialect threading, not just the masker |
| 11 | regression (e2e inverse) | read-only mssql connection still blocks real mutation | same fixture: `DELETE FROM [t]` → throws `ReadOnlyViolation` | fixture as #10 |

## Test Files

- `src/core/__tests__/dangerousStatement.test.ts` — tests #1, #5, #6, #9
- `src/core/__tests__/readOnlyIntent.test.ts` — tests #2, #3, #4, #7
- `src/core/__tests__/schemaImpact.test.ts` — test #8
- `src/core/__tests__/connectionManager.test.ts` — tests #10, #11

## Verification Commands

```bash
npx vitest run src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/dangerousStatement.test.ts src/core/__tests__/schemaImpact.test.ts src/core/__tests__/connectionManager.test.ts
npm run typecheck
```

(No `lint` script exists in this repo — `npm run typecheck` is the static gate; bundle gate `npm run compile` runs at cycle close, not per task.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; #1, #2, #10 confirmed RED at `611df12` before the fix (paste RED output in Executor Report).
- [ ] Masker branch is gated on `dialect === "mssql"`; omitted dialect behavior byte-identical to before (test #7).
- [ ] Both `isMutationSql` call sites in `guardAdapter` receive the connection dialect; bigquery narrows to `undefined`.
- [ ] `npm run typecheck` exits 0.
- [ ] No file outside §Target Files modified; read-only postgres/mysql paths unchanged (test #9 + full suite at wave boundary).

## Dependencies

- (none)

## Interfaces

- Consumes: `maskLiteralsAndComments(sql: string, dialect?: SqlDialect): string` (dangerousStatement.ts:90, existing); `isMutationSql(sql: string, dialect?: SqlDialect): boolean` / `mutationStatements(sql, dialect?): string[]` (readOnlyIntent.ts:109/:114, existing); `SqlDialect = "postgres" | "mysql" | "mssql"` (statementParser.ts:21, existing); `ConnectionConfig["driver"]` (existing DriverType union incl. `"bigquery"`).
- Produces: no new exports. Changed behavior contract — `mutationStatements(sql, "mssql")` no longer flags MSSQL bracket-quoted identifiers as mutations; `guardAdapter`'s injected runQuery closure now passes `(sql, dialect)` where dialect derives from `cfg.driver`.

---

## Discussion

### 2026-09-02 · planner · unic-smart
STATUS.md item 2 said "fix belongs in dangerousStatement.ts and schemaImpact.ts if it has the same gap". Verified: schemaImpact/analyzeStatement pick the FIRST depth-0 keyword, so a bracket identifier cannot flip them — but they consume the same masker, so tests #8 pins both directions. The real second surface is `connectionManager.guardAdapter` calling `isMutationSql(sql)` with NO dialect (so the mysql backtick masking is ALSO inert there) — that threading is in scope here because it is the same false-positive class on the same guard. Masking MORE than the mssql tokenizer sees is the safe direction (today `[o'brien]` opens a bogus string literal in the tokenizer; the masker hiding the region hides a superset). `statementParser` bracket tokenization is deliberately out of scope (PLAN §2).

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-sonnet-4-6
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  5 tests failed at the masking/threading gap:
  - dangerousStatement.test.ts > TASK-CL-001 > #1 maskLiteralsAndComments blanks the bracket region length-preservingly
    → expected 'SELECT * FROM [insert]' to be 'SELECT * FROM          ' (no bracket branch in masker)
  - dangerousStatement.test.ts > TASK-CL-001 > #5 `]]` doubling escape
    → expected true to be false (masker keeps `[we]]ird]` verbatim → "we]]ird" leaks)
  - dangerousStatement.test.ts > TASK-CL-001 > #6 unterminated bracket
    → expected 'SELECT * FROM [insert' not to contain 'insert' (no masking at all)
  - readOnlyIntent.test.ts > TASK-CL-001 > #2 SELECT * FROM [insert] (mssql) is not a mutation
    → expected true to be false (depth-scan sees fake `insert` keyword)
  - connectionManager.test.ts > DBX-05 read-only + tunnel > readOnly + mssql: SELECT * FROM [insert] passes through
    → ReadOnlyViolation: Connection is marked read-only — mutation blocked: SELECT * FROM [insert]
      (object.value at connectionManager.ts:814 — `isMutationSql(sql)` called with no dialect)

Verification Output: |
  > npx vitest run src/core/__tests__/dangerousStatement.test.ts src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/schemaImpact.test.ts src/core/__tests__/connectionManager.test.ts
  ✓ src/core/__tests__/dangerousStatement.test.ts  (34 tests)
  ✓ src/core/__tests__/schemaImpact.test.ts  (13 tests)
  ✓ src/core/__tests__/readOnlyIntent.test.ts  (24 tests)
  ✓ src/core/__tests__/connectionManager.test.ts  (45 tests)
  Test Files  4 passed (4)
       Tests  116 passed (116)
  > npm run typecheck
  > tsc --noEmit
  EXIT: 0

Status: PASS
Note: All 11 test cases (#1-#11) pass; 116 total core tests green; typecheck exits 0. Implementation: (a) `dangerousStatement.ts` adds a `dialect === "mssql"`-gated bracket branch mirroring the mysql backtick branch (doubling escape, unterminated → EOF blanking); (b) `connectionManager.ts:guardAdapter` narrows `cfg.driver` to `SqlDialect | undefined` (bigquery → undefined) via a local ternary helper (no import from extension.ts), and threads the dialect through BOTH `isMutationSql`/`mutationStatements` call sites (:813/:814 and :831/:832). Per-task scope respected; BQ-00 frozen surface untouched. Test expectations adjusted for byte-exact length preservation: `[insert]` is 8 chars → 8 spaces (test #1 was off-by-one on character count, not a masking bug). Full suite has 20 unrelated `dist/*.js missing` failures (bundle gate, runs at cycle close, not per task).
