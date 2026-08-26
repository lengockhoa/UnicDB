# TASK-005 — Emulate NULLS FIRST/LAST on MySQL and MSSQL

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 items 6 and 8, §3.4

## Goal

Accept valid `NULLS FIRST` / `NULLS LAST` order terms on all three dialects. PostgreSQL keeps
native syntax; MySQL and MSSQL receive a safe leading null-rank sort expression followed by the
regular quoted column sort. Remove the dead `unquoteIdent` guard and correct stale test names
as bundled P3 cleanup.

## Target Files

- `src/ui/queryComposer.ts` — stop rejecting NULLS for mysql/mssql; render native or emulated
  clauses; remove the dead guard in `unquoteIdent`.
- `src/ui/__tests__/queryComposer.test.ts` — replace today’s mysql/mssql rejection assertions
  with exact emulation SQL and retitle the stale whitespace predicate cases at `:685,698`.
- `src/ui/__tests__/resultsPanelOrderBy.test.ts` — replace case 8c’s rejected-requery assertion
  with host execution assertion for emulated NULLS clauses.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | MySQL NULLS LAST is emulated | `parseOrderBy("a ASC NULLS LAST", "mysql")` is `{ok:true}` and `buildOrderByClause` is exactly `` `a` IS NULL ASC, `a` ASC ``. | One valid bare identifier. |
| 2 | edge — dialect | MSSQL NULLS LAST is emulated without boolean ORDER BY | Exact output is `CASE WHEN [a] IS NULL THEN 1 ELSE 0 END ASC, [a] ASC`; it contains no `NULLS LAST`. | Same term under `mssql`. |
| 3 | edge — boundary | NULLS FIRST reverses only rank direction | MySQL and MSSQL rank key ends `DESC` while the data term stays caller direction; postgres remains exactly `"a" ASC NULLS FIRST`. | ASC and DESC term fixtures. |
| 4 | regression | Valid mysql/mssql NULLS no longer becomes synthetic error state | `ResultsPanel` receives `a NULLS LAST`, calls runner with emulated SQL once, and does not post `status:"error"` / error text matching `Invalid ORDER BY`. | Existing case-8c host harness, parameterized mysql/mssql. |
| 5 | edge — malformed input | Expressions remain rejected | `parseOrderBy("CASE WHEN a IS NULL THEN 0 END", "mysql")` is `{ok:false}` and runner is never called. | Existing expression-rejection fixture. |
| 6 | regression — cleanup | Unquote and whitespace behavior stays unchanged | Existing quoted identifier escaping tests still pass after deleting the no-op guard; renamed whitespace tests retain their exact regex/NOT LIKE assertions. | Existing suite cases. |

## Test Files

- `src/ui/__tests__/queryComposer.test.ts`
- `src/ui/__tests__/resultsPanelOrderBy.test.ts`

## Verification Commands

```bash
npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts
npm run typecheck
```

No selected test loads a `dist/*.js` bundle. `package.json` has no lint script. Global
constraints: PLAN.md §7.

## Acceptance Criteria

- [ ] PostgreSQL output remains native and byte-identical.
- [ ] MySQL output uses `quotedColumn IS NULL ASC|DESC, quotedColumn direction`.
- [ ] MSSQL output uses `CASE WHEN quotedColumn IS NULL THEN 1 ELSE 0 END ASC|DESC` followed
      by its normal bracket-quoted data term.
- [ ] Plain-identifier validation and expression rejection remain intact.
- [ ] The old rejection tests are intentionally rewritten to pin the new public behavior.
- [ ] The unreachable `unquoteIdent` guard and stale TRIM-based test titles are removed/updated
      without changing their assertions.
- [ ] All listed verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes: `parseOrderBy(orderBy: string, dialect?: Dialect): ParseOrderByResult`
  (`queryComposer.ts:304`), `OrderByTerm { column, direction, nulls? }` (`:231-235`), and
  `buildOrderByClause(terms, dialect)` (`:443-451`).
- Produces: an accepted `nulls` term for all three dialects and safe, dialect-specific SQL used
  by `ResultsPanel.composeRequerySql()` (`resultsPanel.ts:1117`).

---

## Discussion

1. **Rank direction is load-bearing.** `IS NULL` / CASE returns 1 for nulls. Ascending puts nulls
   last; descending puts them first. Keep the actual data sort direction unchanged after the
   rank term.
2. **No raw user token reaches SQL.** Keep `parseOrderBy` → logical identifier → `quoteIdent`
   flow. Do not append raw `NULLS` input or expressions.
3. **No `resultsPanel.ts` ownership.** The host test may be edited, but production composition
   stays in `queryComposer.ts`; this task must not touch `resultsPanel.ts`, which TASK-004 owns.
4. **TDD order.** Convert the existing expected-rejection assertions into failing exact SQL
   assertions before changing parser/rendering code.
5. **Executor decision — host requery lane for emulated NULLS (case 4 / 8c).** With the parser
   change, `resultsPanel.composeRequerySql` needs zero edits: a single term with `nulls` already
   routes through the multi-term wrap (`terms.length === 1 && !first.nulls` is false) into
   `buildOrderByClause(terms, dialect)` on the pinned `AS vsdb_sub` wrapper. The rewritten 8c
   therefore asserts exact execution on that existing lane:
   mysql → `` SELECT * FROM (SELECT id FROM t) AS vsdb_sub ORDER BY `a` IS NULL ASC, `a` ASC ``;
   mssql → `SELECT * FROM (SELECT id FROM t) AS vsdb_sub ORDER BY CASE WHEN [a] IS NULL THEN 1
   ELSE 0 END ASC, [a] ASC`; plus `runSql` called exactly once, no `status:"error"`, no
   `Invalid ORDER BY` text, and `showErrorMessage` never called.
6. **Executor observation — pre-existing full-suite failure (not this task's).** On clean HEAD
   (verified by stash + rebuild + rerun), `webviewServerSort.test.ts` case 18 fails only under
   full-suite load and passes when its file runs alone; `webview/main.ts` keeps a local copy of
   the ORDER BY grammar and never imports `queryComposer.ts`, so it cannot regress from this
   diff. Also environmental: this worktree has no `node_modules` (gitignored); a
   `node_modules/.bin` symlink to the main repo's bin dir was added so bundle tests can spawn
   esbuild. PLAN §7 baseline otherwise holds (1560 passed with my changes vs 1552 baseline —
   the delta is my +8 net new cases minus removed/reworked rejection cases).

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts
  FAIL src/ui/__tests__/queryComposer.test.ts > parseOrderBy (TASK-001) > parses NULLS on mysql and mssql instead of rejecting
  FAIL src/ui/__tests__/queryComposer.test.ts > parseOrderBy + buildOrderByClause — NULLS emulation (TASK-005) > mysql 'a ASC NULLS LAST' parses ok and composes the exact emulated clause
  FAIL src/ui/__tests__/queryComposer.test.ts > parseOrderBy + buildOrderByClause — NULLS emulation (TASK-005) > mssql 'a ASC NULLS LAST' composes the CASE rank key without any NULLS token
  FAIL src/ui/__tests__/queryComposer.test.ts > parseOrderBy + buildOrderByClause — NULLS emulation (TASK-005) > NULLS FIRST reverses only the rank key direction on mysql/mssql
  FAIL src/ui/__tests__/queryComposer.test.ts > parseOrderBy + buildOrderByClause — NULLS emulation (TASK-005) > mixed ASC/DESC composite terms with nulls compose per dialect
  FAIL src/ui/__tests__/queryComposer.test.ts > parseOrderBy + buildOrderByClause — NULLS emulation (TASK-005) > round trip: 'a NULLS LAST' under mysql parses ok then renders through the composer path
  FAIL src/ui/__tests__/queryComposer.test.ts > buildPagedQueryTerms — NULLS + tiebreaker path (TASK-005) > emulated null-rank keys lead and PK tiebreakers trail (mysql paging)
  FAIL src/ui/__tests__/queryComposer.test.ts > buildPagedQueryTerms — NULLS + tiebreaker path (TASK-005) > emulated null-rank keys lead and PK tiebreakers trail (mssql paging)
  FAIL src/ui/__tests__/resultsPanelOrderBy.test.ts > TASK-004 case 8c (TASK-005) — NULLS native on postgres, emulated on mysql/mssql > mysql: 'a NULLS LAST' runs the emulated ORDER BY once with no error
  FAIL src/ui/__tests__/resultsPanelOrderBy.test.ts > TASK-004 case 8c (TASK-005) — NULLS native on postgres, emulated on mysql/mssql > mssql: 'a NULLS LAST' runs the emulated ORDER BY once with no error
  AssertionError: expected "spy" to be called 1 times, but got 0 times
    ❯ src/ui/__tests__/resultsPanelOrderBy.test.ts:259:20
      259|     expect(runSql).toHaveBeenCalledTimes(1);
         |                    ^
  Example diff for case 1 (mysql emulation RED):
  - Expected: `SELECT * FROM (SELECT * FROM t) vsdb_page ORDER BY `a` IS NULL ASC, `a` ASC, `id` ASC LIMIT 500 OFFSET 0`
  - Received: `SELECT * FROM (SELECT * FROM t) vsdb_page ORDER BY `a` ASC NULLS LAST, `id` ASC LIMIT 500 OFFSET 0`
  Tests 10 failed | 71 passed (81) — all 10 failures are the new/rewritten assertions failing because parseOrderBy still rejects NULLS on mysql/mssql and buildOrderByClause still emits raw `NULLS …`.
Verification Output: |
  Command 1 (fresh in final turn): npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts
   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-005
   ✓ src/ui/__tests__/resultsPanelOrderBy.test.ts  (16 tests) 7ms
   ✓ src/ui/__tests__/queryComposer.test.ts  (65 tests) 10ms
   Test Files  2 passed (2)
        Tests  81 passed (81)
   Start at 23:51:17 · Duration ~0.48s — exit 0

  Command 2 (fresh in final turn): npm run typecheck
   > vsdb@1.6.7 typecheck
   > tsc --noEmit
   TYPECHECK_EXIT=0

  Supplementary (context, not part of the task's command list):
  Full suite after npm run compile: 1560 passed | 2 skipped | 1 failed
  The single failure (webviewServerSort.test.ts case 18, debounce-timing under
  full-suite load) reproduces identically on clean HEAD via git stash + rebuild +
  rerun, and the file passes alone; webview/main.ts does not import queryComposer.ts
  (it keeps a local grammar copy at :131-132/:2162). Pre-existing, out of scope.
Status: PASS
Note: Pre-existing flake in webviewServerSort.test.ts case 18 fails only in full-suite runs and also fails on clean HEAD (proven by stash+rerun); unrelated to queryComposer.ts since webview/main.ts never imports it. Worktree lacks node_modules (gitignored); symlinked node_modules/.bin to the parent repo so bundle tests can spawn esbuild — environmental setup, no repo file changed. Reviewer should focus on the intentional expectation rewrite of queryComposer.test.ts case 10 and resultsPanelOrderBy.test.ts case 8c per task §Goal/cycle-W precedent.

---
