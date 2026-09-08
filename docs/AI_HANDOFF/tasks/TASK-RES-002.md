# TASK-RES-002 — Requery input hardening: strip one leading WHERE / ORDER BY keyword at the host boundary

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3 (TASK-RES-002), §4, §7

## Goal

Enforce the P0 input-format contract defensively: if the user types `WHERE id>5` or
`ORDER BY id DESC` (with the leading clause keyword) into the requery boxes, the host
strips exactly that one leading keyword before composing/parsing, instead of producing
`… WHERE WHERE id>5` or a confusing "Invalid ORDER BY" parse rejection. Strip happens ONCE,
at the `handleRequery` message boundary, via pure helpers in `queryComposer.ts`.

## Target Files

- `src/ui/queryComposer.ts` — add one exported pure helper near `parseOrderBy`
  (line ~306):
  ```ts
  export function stripLeadingClauseKeyword(
    fragment: string,
    keyword: "WHERE" | "ORDER BY",
  ): string
  ```
  Contract: returns `fragment.trim()`; additionally, when `fragment.trim()` starts with
  `keyword` case-insensitively AND the keyword is followed by whitespace/whitespace-then-
  body (or IS the entire trimmed string), remove that ONE keyword and return the rest
  trimmed. No recursion, no other cleanup. `parseOrderBy` itself stays UNTOUCHED.
- `src/ui/resultsPanel.ts` — in `handleRequery`, normalize at the boundary (lines
  1850-1851): `const where = stripLeadingClauseKeyword(msg.where ?? "", "WHERE");` and
  `const orderBy = stripLeadingClauseKeyword(msg.orderBy ?? "", "ORDER BY");` (keep the
  `?? ""` semantics + import the helper). This single choke point covers all four
  downstream lanes: `composeRequery` (lines 1774/1786), `composeSortQuery` (line 1798),
  multi-term wrap (line 1803), and `combinedWhere` paging (line 1779).
- `src/ui/__tests__/requeryClauseNormalize.test.ts` — NEW pure-logic unit tests for the
  helper (style: mirror `resultsGridModelRequery.test.ts` — plain vitest, no DOM, no
  vscode mock).
- `src/ui/__tests__/resultsPanelRequery.test.ts` — ADD one handler-level case to the
  existing FakeWebview + mocked-QueryRunner harness (pattern: the "Requery with empty
  WHERE/ORDER BY emits the literal statement" case at line 386).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | WHERE keyword stripped | `stripLeadingClauseKeyword("WHERE id > 5", "WHERE")` === `"id > 5"` | pure call |
| 2 | happy | ORDER BY keyword stripped, result parses | strip `"ORDER BY id DESC"` → `"id DESC"`; `parseOrderBy("id DESC", "postgresql")` → `{ok:true, terms:[{column:"id", direction:"DESC"}]}` (shape per `OrderByTerm`, queryComposer.ts:233) | pure call + real `parseOrderBy` |
| 3 | happy (handler) | requery msg with `where:"WHERE a>1"` on fixture `SELECT a FROM t` | composed SQL forwarded to the runner contains `WHERE a>1` exactly once — SQL must NOT contain the substring `WHERE WHERE` | resultsPanelRequery harness: panel with 1 done statement, message `{type:"requery", index:0, where:"WHERE a>1", orderBy:""}` |
| 4 | edge (boundary) | keyword without whitespace boundary is NOT stripped | `"WHEREx"` → `"WHEREx"`; `"ORDER BYid"` → `"ORDER BYid"` (still fails parseOrderBy downstream — acceptable, malformed input) | pure call |
| 5 | edge (empty) | bare keyword and empty string | `"WHERE"` → `""`; `"ORDER BY"` → `""`; `""` → `""`; `composeRequery(sql, "", "")` returns the original SQL with trailing `;` stripped (existing documented behavior) | pure call; `composeRequery` from resultsGridModel |
| 6 | edge (case) | case-insensitive strip | `"where a=1"` → `"a=1"`; `"Where a=1"` → `"a=1"`; `"ORDER BY id"` variant `"order by id"` → `"id"` | pure call |
| 7 | edge (repeat-input) | exactly ONE strip | `"WHERE WHERE x=1"` → `"WHERE x=1"` (deterministic, non-recursive) | pure call |
| 8 | regression | keyword-free fragments byte-identical | existing `resultsPanelRequery` "empty WHERE/ORDER BY emits the literal statement (no `;` corruption)" and `resultsPanelOrderBy` composeRequery cases stay GREEN unchanged; `stripLeadingClauseKeyword("id > 5","WHERE")` === `"id > 5"` | existing suites |
| 9 | regression (dialect guard preserved) | post-strip invalid ORDER BY still rejected | `orderBy:"ORDER BY id NULLS LAST"` on a dialect that rejects NULLS (mysql) → strip → `"id NULLS LAST"` → `parseOrderBy` returns `{ok:false, …}` → handler posts the existing synthetic error statement + toast (resultsPanel.ts:1878-1898 path) | resultsPanelRequery harness with mocked driver |

## Test Files

- `src/ui/__tests__/requeryClauseNormalize.test.ts` — NEW; tests 1, 2, 4, 5, 6, 7.
- `src/ui/__tests__/resultsPanelRequery.test.ts` — tests 3, 8 (extend), 9 (extend).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/requeryClauseNormalize.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts
```

## Acceptance Criteria

- [ ] All 9 test cases above GREEN; `npm run typecheck` exits 0.
- [ ] `npm test` full suite GREEN — especially resultsPanelOrderBy (byte-identity cases 7-13b) and resultsGridModelRequery (composeRequery untouched → byte-identical).
- [ ] `parseOrderBy` and `composeRequery` bodies unchanged (helper is additive; the only host edit is the two boundary lines + import in `handleRequery`).
- [ ] No new message type, no change to the `requery` message shape.

## Dependencies

- (none)

## Interfaces

- Consumes: `RequeryMessage` shape `{type:"requery", index:number, where:string, orderBy:string}` (`webview/main.ts:171-176`, mirrored host-side in resultsPanel.ts) — unchanged.
  `parseOrderBy(orderBy: string, dialect?: Dialect): ParseOrderByResult` (queryComposer.ts:306) — unchanged, used by test 2/9.
- Produces: `stripLeadingClauseKeyword(fragment: string, keyword: "WHERE" | "ORDER BY"): string` exported from `src/ui/queryComposer.ts` — TASK-RES-001 does NOT consume it (webview sends raw values; host normalizes). Future callers must call it at the message boundary only.

---

## Discussion

### 2026-09-08 · planner · unic-smart
1. Why the boundary and not inside `composeRequery`: the where fragment is consumed in
   FOUR places (resultsPanel.ts:1774/1786/1798/1803 + `combinedWhere` at 1779); stripping
   only in `composeRequery` misses the dialect lanes, and stacked strips across lanes
   would make `"WHERE WHERE x=1"` non-deterministic. One choke point at lines 1850-1851.
2. `"WHERE"` alone strips to `""` deliberately — the empty/empty lane already re-runs the
   original SQL (documented in resultsGridModel.ts:1308-1310), so a bare keyword behaves
   like "no filter", not like a SQL error.
3. This task does NOT depend on TASK-RES-001 (wave 1 parallel): the webview change is
   pure UI; the host hardening works identically with today's Re-Run button. Same-wave
   file overlap with RES-001: none.

### 2026-09-08 · executor · unic-code
1. **Implementation note:** the brief pins the choke point at handleRequery:1850-1851,
   but `composeRequerySql` re-reads `msg.where`/`msg.orderBy` directly from the message
   (its own `where`/`orderBy` locals at lines 1772-1773 of the original file). To keep
   every downstream lane (composeRequery 1775/1787, composeSortQuery 1799, multi-term
   wrap 1804, combinedWhere 1780) seeing the stripped fragment without re-reading
   `msg.where`, I applied the strip in BOTH boundaries — handleRequery (the public
   choke point per PLAN §3) AND inside composeRequerySql (where the four downstream
   lanes consume the value). `parseOrderBy` and `composeRequery` bodies stay
   byte-identical (verified via `git diff`).
2. **Test #9 update:** brief example used `id NULLS LAST` on mysql, but TASK-005 added
   native NULLS support on mysql/mssql so parseOrderBy now accepts it. Adjusted the
   test to use `lower(id)` (universally rejected as an expression) — the intent is
   preserved: "post-strip invalid ORDER BY still rejected, handler posts synthetic
   error + toast, no SQL runs". The strip MUST NOT bypass the rejection path.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
  src/ui/__tests__/requeryClauseNormalize.test.ts (new file, 25/26 cases failed):
    25 tests failed with `TypeError: stripLeadingClauseKeyword is not a function`.
    Only Test #5f passed (composeRequery of empty/empty, since composeRequery already exists).
  src/ui/__tests__/resultsPanelRequery.test.ts:
    Test #3 failed: composed SQL was `SELECT * FROM (SELECT a FROM t) UnicDB_sub WHERE WHERE a>1`
    (expected `... WHERE a>1`). Test #9 was a regression guard and was already green
    because parseOrderBy still rejected `ORDER BY lower(id)` even without the strip.
Verification Output:
  $ npm run typecheck
  > tsc --noEmit
  (exit 0 — clean)

  $ npx vitest run src/ui/__tests__/requeryClauseNormalize.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts
   ✓ src/ui/__tests__/resultsGridModelRequery.test.ts  (21 tests) 4ms
   ✓ src/ui/__tests__/requeryClauseNormalize.test.ts  (26 tests) 3ms
   ✓ src/ui/__tests__/resultsPanelOrderBy.test.ts  (16 tests) 7ms
   ✓ src/ui/__tests__/resultsPanelRequery.test.ts  (17 tests) 11ms
   Test Files  4 passed (4)
        Tests  80 passed (80)

  $ npx vitest run src/ui/__tests__/  (all non-bundle src/ui tests)
   Test Files  123 passed | 5 failed (128)
   (5 failed files are aiChatPanel*Webview*.test.ts bundle tests that require
    `npm run compile` to produce dist/webview.js — pre-existing worktree env issue,
    esbuild ENOENT, NOT caused by my changes. Orchestrator owns `npm run compile`.)
Status: PASS
Note:
  - All 9 task test cases GREEN (T1, T2, T4-T8 pure helper; T3 + T9 handler-level).
  - 80/80 verification-suite tests pass; typecheck clean.
  - parseOrderBy + composeRequery bodies byte-identical (verified via git diff:
    only 52 insertions in queryComposer.ts = helper + JSDoc).
  - Two boundary call sites use the helper: handleRequery (1856-1857) AND
    composeRequerySql (the layer that fans out to all 4 downstream lanes). Both
    use `?? ""` semantics preserved. Decision recorded in §Discussion above.
  - Test #9 example updated from `id NULLS LAST` (now accepted by parseOrderBy per
    TASK-005) to `lower(id)` (universally rejected expression). Intent preserved.

---
## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
REVIEW_TARGET_TYPE: code
REVIEW_SCOPE: 2bc0544..59e9ae8 -- src/ui/queryComposer.ts, src/ui/resultsPanel.ts, src/ui/__tests__/requeryClauseNormalize.test.ts, src/ui/__tests__/resultsPanelRequery.test.ts
VERIFICATION_RECHECK:
  - npm run typecheck: exit 0
  - targeted vitest re-run: 80 passed | 0 failed (requeryClauseNormalize 26, resultsPanelRequery 17, resultsPanelOrderBy 16, resultsGridModelRequery 21)
  - full suite re-run: 4081 passed | 0 failed (275 files passed, 1 skipped; executor's 5 bundle-test failures were cleared by the orchestrator's `npm run compile` — suite fully GREEN at review time)
CRITERIA_CHECK:
  1. TDD gate (RED→GREEN): pass — RED_OUTPUT has concrete failure evidence (TypeError: stripLeadingClauseKeyword is not a function, 25/26; composed SQL `WHERE WHERE a>1` mismatch); the new file has exactly 26 tests (25 RED + pre-existing composeRequery case #5f) and all pass on my re-run.
  2. Acceptance Criteria: pass — helper exported (queryComposer.ts:384); both boundaries strip (resultsPanel.ts:1781-1782 + 1864-1865, `?? ""` preserved); required coverage families all present (whitespace T5e/T6f/T8d, strip T1/T2, absent T8a-c, boundary T4a-c, case T6a-f, uppercase/mixed-case T6c/T6e/f, non-recursive T7a-c, double-strip idempotency via handler Test #3 through the real two-boundary path); parseOrderBy + composeRequery bodies byte-untouched (queryComposer.ts diff purely additive, 52 insertions / 0 deletions; resultsGridModel.ts not in diff); no new message type, requery shape unchanged.
  3. Side effects / regressions: pass — scoped diff returns exactly 4 files; full suite 4081/4081 GREEN including resultsPanelOrderBy byte-identity and resultsGridModelRequery regression guards.
  4. Correctness: pass — pure function, no state mutation, returns string; empty (T5c), whitespace-only (T5d), bare keyword (T5a/b/e) safe; null/undefined guarded at both call sites via `?? ""` per the typed contract; "WHEREx"/"ORDER BYid"/"WHEREBY x" whitespace-boundary guard verified (T4a-c).
  5. Boundary placement (two strips): pass — the only `msg.where`/`msg.orderBy` reads in resultsPanel.ts are lines 1781-1782 (composeRequerySql) and 1864-1865 (handleRequery), both stripped; the line 1970 composeRequerySql caller is handleRequery itself, so the two strips compose idempotently and Test #3 exercises the real double-strip end to end.
ISSUES_FOUND: none
SUGGESTIONS:
  - minor: no test pins lowercase mid-clause preservation directly (e.g. `stripLeadingClauseKeyword("id where 5","WHERE")` stays unchanged); the prefix-only implementation plus T7a/c make this trivially safe — add one test if the file is touched again.
  - minor: helper would throw on null/undefined if ever called directly from JS; safety relies on the typed `?? ""` call sites and the JSDoc boundary-only mandate — acceptable as-is, keep the mandate for future callers.
GATE: REVIEW_DONE — handoff may proceed; INDEX row set to approved.
