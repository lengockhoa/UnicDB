# TASK-002 — `buildDistinctValuesQuery`: pure DISTINCT-values SQL builder

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.4

## Goal

Add a new pure module `src/ui/distinctValues.ts` that composes the
`SELECT DISTINCT <col> FROM (<original sql>) …` query the host will run to populate the
set-filter dropdown with values from the whole table rather than the loaded window, plus the
truncation helper that decides whether the list is complete. No call sites — TASK-004 wires it.

## Target Files

- `src/ui/distinctValues.ts` **(new)** — `buildDistinctValuesQuery`, `takeDistinctValues`,
  `DISTINCT_VALUES_LIMIT`.
- `src/ui/__tests__/distinctValues.test.ts` **(new)** — all cases below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | postgres composition | `SELECT DISTINCT "name" FROM (SELECT * FROM t) vsdb_distinct ORDER BY 1 LIMIT 1001` | `("SELECT * FROM t", "name", "postgres", "", 1000)` |
| 2 | unit (happy) | mysql quoting | identical shape with `` `name` `` and backticked alias-free body | same, `"mysql"` |
| 3 | edge (dialect capability) | mssql has no LIMIT | `SELECT DISTINCT TOP (1001) [name] FROM (SELECT * FROM t) vsdb_distinct ORDER BY 1` | same, `"mssql"` |
| 4 | edge (injection) | column payload stays one identifier | output contains `"name""; DROP TABLE t--"` (doubled quote) and no bare `DROP TABLE t--` outside the identifier | column `name"; DROP TABLE t--`, postgres |
| 5 | edge (boundary) | trailing semicolon on inner SQL is stripped | no `;` inside the `(...)` wrap; exactly one statement in the output | `"SELECT * FROM t;"` |
| 6 | edge (composition) | an existing WHERE is applied at the OUTER level | `… vsdb_distinct WHERE id > 5 ORDER BY 1 LIMIT 1001`, inner SQL verbatim | `where = "id > 5"` |
| 7 | edge (empty input) | empty/whitespace WHERE adds no clause | output contains no `WHERE` | `where = "   "` |
| 8 | edge (boundary) | `takeDistinctValues` under the limit | `{ values: [1,2,3], truncated: false }` | rows `[[1],[2],[3]]`, limit 1000 |
| 9 | edge (boundary) | `takeDistinctValues` exactly at limit+1 | `values.length === 2` and `truncated === true` | rows of length 3, limit 2 |
| 10 | edge (null handling) | NULL survives as `null`, not `"null"` | `values[0] === null` (strictly), `truncated === false` | rows `[[null],["a"]]` |
| 11 | edge (malformed input) | non-array / short rows are skipped, not crashed | `{ values: ["a"], truncated: false }` | rows `[["a"], [], undefined as unknown as unknown[]]` |

## Test Files

- `src/ui/__tests__/distinctValues.test.ts` — new file. Mirror the plain-unit style of
  `src/ui/__tests__/queryComposer.test.ts` (no `vi.mock("vscode")`, no jsdom).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/distinctValues.test.ts
npx vitest run src/ui/__tests__/queryComposer.test.ts
```

## Acceptance Criteria

- [ ] Every case in §Test Cases passes.
- [ ] `npm run typecheck` clean.
- [ ] `src/ui/distinctValues.ts` imports **only** `quoteIdent` / `Dialect` from
      `../core/saveStatements`. No `vscode`, no `pg`/`mysql2`/`tedious`, no DOM.
- [ ] Every identifier goes through `quoteIdent`; there is no hand-rolled quote/bracket
      escaping in the file.
- [ ] `DISTINCT_VALUES_LIMIT` is exported and defaults to `1000`.
- [ ] `src/ui/queryComposer.ts` is NOT modified by this task (TASK-001 owns it).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `quoteIdent(name: string, dialect: Dialect): string` and `type Dialect` from
  `../core/saveStatements`.
- Produces (TASK-004 consumes these exact signatures — do not rename):

```ts
export const DISTINCT_VALUES_LIMIT = 1000;

export function buildDistinctValuesQuery(
  sql: string,
  column: string,
  dialect: Dialect,
  /** Outer-level WHERE. DECIDED (PLAN.md §3.4/§2): TASK-004 calls this with
   *  `""` — the host retains no per-statement WHERE, so the DISTINCT list is
   *  base-statement scoped, not narrowed by the active filter. The parameter
   *  stays in the signature (cases 6-7 exercise it) so a follow-up cycle can
   *  scope it without a signature change. Keep it required. */
  where: string,
  limit?: number,          // defaults to DISTINCT_VALUES_LIMIT
): string;

export function takeDistinctValues(
  rows: unknown[][],
  limit?: number,          // defaults to DISTINCT_VALUES_LIMIT
): { values: unknown[]; truncated: boolean };
```

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Error: Failed to load url ../distinctValues (resolved id: ../distinctValues) in
  .../src/ui/__tests__/distinctValues.test.ts. Does the file exist?
  Test Files  1 failed (1)
       Tests  no tests
Verification Output: |
  npm run typecheck → clean (tsc --noEmit, exit 0)
  npx vitest run src/ui/__tests__/distinctValues.test.ts → 12 passed / 0 failed
  npx vitest run src/ui/__tests__/queryComposer.test.ts → 21 passed / 0 failed
Status: PASS
Note: Local copy of stripTrailingSemicolon (queryComposer.ts:136 not exported,
TASK-001 owns that file) — hoist into a shared module is a queued follow-up.
Full-suite `npm test` left to the orchestrator's wave boundary; targeted +
typecheck verified in-worktree. queryComposer.ts NOT modified.

---

## Discussion

### 2026-08-26 · planner · bao-opus

→ @executor Notes:

1. **`LIMIT limit + 1` on purpose.** The extra row is the truncation probe: `takeDistinctValues`
   slices back to `limit` and reports `truncated: true` when it saw more. Do not emit
   `LIMIT limit` — you then cannot distinguish "exactly `limit` distinct values" from "more than
   `limit`", and the webview needs that flag to decide whether to keep the loaded-rows fallback
   entries visible.
2. **Reuse the semicolon guard, don't invent one.** `src/ui/queryComposer.ts:136` has
   `stripTrailingSemicolon`, but it is **not exported** and TASK-001 owns that file this wave —
   do not export it from there (that would put two tasks on one file). Write a local copy in
   `distinctValues.ts` with a comment pointing at the original; a four-line pure regex helper
   duplicated once is cheaper than a cross-task file collision. Flag it in your Executor Report
   so a later cycle can hoist both into a shared module.
3. **The subquery alias is `vsdb_distinct`** — deliberately different from `vsdb_page`
   (`buildPagedQuery`) and `vsdb_sort` (`composeSortQuery`) so a nested composition can never
   collide on the alias name.
4. **`ORDER BY 1` (ordinal), not `ORDER BY <col>`.** The outer select projects exactly one
   column; the ordinal is valid on all three dialects and sidesteps re-quoting. MSSQL needs the
   `ORDER BY` anyway for a deterministic `TOP`.
5. **`where` is spec'd but will be called with `""` this cycle.** Round-1 review confirmed the
   host keeps no per-statement WHERE (`src/ui/resultsPanel.ts` has no `lastWhere` /
   `whereByStatement`), so TASK-004 passes `""` and the dropdown is base-statement scoped — an
   accepted limitation recorded in `PLAN.md` §2/§7 with an `INDEX.md` follow-up. Do **not** drop
   the parameter or "simplify" it away: cases 6 and 7 are the contract a later cycle picks up,
   and removing it would force a signature change then. Nothing else in this task changes.
6. Unverified and therefore left to you: whether any adapter returns `rows` as objects rather
   than arrays on this path. Existing `StatementResult.result.rows` is typed `unknown[][]`
   (`src/core/queryRunner.ts`), so `takeDistinctValues` takes `unknown[][]`; case 11 makes it
   defensive against ragged input rather than assuming.

(no other comments)

---

## Executor Report (fix round 1)

EXECUTOR_MODEL: bao-sonnet
RED_OUTPUT: n/a — builder already correct, tests added. Verified `quoteIdent` (src/core/saveStatements.ts:136) doubles every quote char per dialect and the builder passes inner SQL verbatim, so escaped-identifier and schema-qualified inputs were already handled; the new exact-SQL tests went GREEN on first run.
Verification Output: |
  npx vitest run src/ui/__tests__/distinctValues.test.ts → 17 passed / 0 failed
  ✓ src/ui/__tests__/distinctValues.test.ts (17 tests) 3ms — 1 passed (17)
  npx vitest run src/ui/__tests__/queryComposer.test.ts → 42 passed / 0 failed
  npm run typecheck (tsc --noEmit) → clean, exit 0
Status: PASS
Note: Added 5 exact-SQL tests (postgres/mysql/mssql escaped identifiers + postgres/mssql schema-qualified bases); fixed minor doc comment at distinctValues.ts:78-81 to match implemented first-cell behavior.

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck; npx vitest run src/ui/__tests__/distinctValues.test.ts; npx vitest run src/ui/__tests__/queryComposer.test.ts
  result: typecheck clean; 54 pass / 0 fail
TEST_PLAN_COVERAGE: partial — all 11 task cases pass, but the required exact schema-qualified-base-SQL edge case is missing
FINDINGS:
  critical:
    - none
  important:
    - file: /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/src/ui/__tests__/distinctValues.test.ts:41 — the quoted-identifier edge uses partial `toContain` assertions, and lines 13-100 never exercise a schema-qualified inner table. Regressions that alter a qualified base statement or the exact escaped-identifier SQL shape can pass; add exact `toBe` assertions covering both the escaped identifier and a schema-qualified base query.
  minor:
    - file: /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/src/ui/distinctValues.ts:78 — the comment says rows with extra columns are skipped, but line 94 accepts every non-empty row and takes cell 0; make the documentation match the implemented first-cell behavior.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Running model bao-opus; configured reviewer model is unic-smart. Model isolation is satisfied against bao-sonnet, RED evidence is concrete, and all fresh verification commands pass.

## Reviewer Verdict (fix round 1)

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck; npx vitest run src/ui/__tests__/distinctValues.test.ts --reporter=dot
  result: typecheck clean; 17 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed — exact escaped-identifier SQL covers postgres/mysql/mssql; qualified bases cover both LIMIT and TOP branches
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Running bao-opus; configured reviewer is unic-smart. Isolation from bao-sonnet is satisfied; quoteIdent doubles the dialect quote character and the module remains pure.
