# TASK-006 — Scope DISTINCT values and surface dropdown limits/errors

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 item 4, §3.6

## Goal

Fix P2-3 as one dropdown contract: values should be queried inside the active server-side
filter/WHERE (excluding the requested column's own selected values), and the UI must show a
clear footer note when the query is truncated or fails.

BREAKDOWN RESOLVED (orchestrator, post-plan): Discussion option **A** — host stores per-statement
source state `{ barWhere: string; filters: ColumnFilterModel }` written in `composeRequerySql`'s
caller lane (where `combinedWhere` is already computed), cleared in `render()` alongside
`distinctCache`. On `handleRequestDistinctValues`: re-run pure `buildFilterWhere(filtersWithoutColumn, dialect, { columnTypes })`
over a shallow copy with the requested column deleted, then AND with retained `barWhere` —
never string-parse SQL. If that statement has no recorded source state, keep today's `where=""`.
The webview already carries filter state per statement, so no protocol expansion (option B
rejected).

## Target Files

- `src/ui/resultsPanel.ts` — retain per-statement filter/WHERE state and pass it to
  `buildDistinctValuesQuery`; later owner after TASK-004 releases the file.
- `src/ui/messages.ts` — extend the exact distinct-values protocol only if the selected contract
  requires a typed display/error field; later owner after TASK-007 releases the file.
- `webview/main.ts` — render error/truncation status in `.vsdb-setfilter-status`; later owner
  after TASK-007 releases the file.
- `src/ui/__tests__/resultsPanelDistinctValues.test.ts` — host SQL-scoping and protocol tests.
- `src/ui/__tests__/webviewDistinctValues.test.ts` — compiled-bundle footer error/truncation UI
  tests.
- `src/ui/__tests__/webviewSetFilter.test.ts` — selected-column self-filter exclusion behavior.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | DISTINCT for `a` retains WHERE and other filters | Requesting values for `a` after a server requery with bar `WHERE archived = false` and filter `{b:["x"]}` calls `buildDistinctValuesQuery` with `archived = false AND <b predicate>`. | One statement with active bar WHERE and a typed b filter. Exact filter storage contract is blocked below. |
| 2 | edge — boundary | Requested column filters never self-narrow list | Requesting values for `a` omits all predicates derived from filter `a`, while preserving `b` predicates. | Same active model contains selected `a` and `b` values. |
| 3 | edge — failure | Host failure is visible | A `runSql` error produces a distinct-values reply with the exact error string and the mounted set-filter footer displays that string; it does not silently retain only loaded rows. | Existing fake runner rejection and compiled webview bundle. |
| 4 | edge — boundary | Truncation is visible but values remain usable | A reply `{values:[…1000],truncated:true}` displays a bounded “first 1000” note and still renders/selects the returned values. | Existing SetFilterComponent DOM fixture. |
| 5 | regression | No active WHERE preserves current query shape | A statement with no bar/filter state calls `buildDistinctValuesQuery(..., "")` and existing distinct values cache/generation behavior remains unchanged. | Existing tests covering stale replies and cache. |

## Test Files

- `src/ui/__tests__/resultsPanelDistinctValues.test.ts`
- `src/ui/__tests__/webviewDistinctValues.test.ts`
- `src/ui/__tests__/webviewSetFilter.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/webviewDistinctValues.test.ts src/ui/__tests__/webviewSetFilter.test.ts
npm run typecheck
```

Compile must precede webview tests because they evaluate `dist/webview.js`. `package.json` has
no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [x] **Resolved:** option A — store `{barWhere, filters}` source state per statement, rebuild
      via `buildFilterWhere` minus the requested column; no SQL string parsing; statements
      without recorded state keep `where=""` exactly.
- [ ] DISTINCT SQL is scoped to the active bar WHERE plus other-column filters, never to the
      requested column's own filter.
- [ ] A failed DISTINCT request visibly identifies the failure in the set-filter footer.
- [ ] A truncated request visibly says the returned list is capped while keeping values usable.
- [ ] No-filter behavior and stale-reply generation guards stay byte-identical.
- [ ] After Discussion resolution, all listed verification commands exit 0.

## Dependencies

- TASK-004 — releases `src/ui/resultsPanel.ts` and its requery-state changes.
- TASK-007 — releases `src/ui/messages.ts` and `webview/main.ts` protocol/webview ownership.

## Interfaces

- Consumes: `buildDistinctValuesQuery(sql, column, dialect, where, limit?)`
  (`src/ui/distinctValues.ts:38-59`), `DistinctValuesMessage`
  (`src/ui/messages.ts:29-36`), `ResultsPanel.handleRequestDistinctValues()`
  (`resultsPanel.ts:1021`), `RequeryMessage.filters?: ColumnFilterModel`
  (`messages.ts:123-145`), `buildFilterWhere()` (`queryComposer.ts:149`).
- Produces: a scoped DISTINCT query and a visible, typed set-filter footer state.

---

## Discussion

1. **Blocking interface fact.** `handleRequery` receives `msg.where` (free-form SQL) and
   `msg.filters` (structured), but `composeRequerySql` combines bar WHERE and all filter
   predicates internally. It does not expose per-column generated predicates, and free-form
   `where` cannot safely be parsed/subtracted. Storing only final `combinedWhere` would include
   the requested column’s own predicate, contradicting the product behavior and test #2.
2. **Required breakdown decision.** Before implementation choose a non-guessing data model:
   - **A. Store source state:** persist `{barWhere, filters, columnTypes}` per statement and,
     on distinct request, call the existing `buildFilterWhere` after deleting `filters[column]`.
     Recommended — it reuses a real pure composer and never parses SQL.
   - **B. Change webview request:** include current `filters` and `where` in
     `requestDistinctValues`; host still derives SQL and rejects malformed input. This expands
     the semi-trusted protocol and needs security/validation review.
   - **C. Scope all filters:** retain final SQL including own column. Simpler but rejects the
     documented behavior of a usable self-filter dropdown.
   Recommendation: **A**, but the exact `ColumnFilterModel`/`columnTypes` persistence lifecycle
   and update points need verification after TASK-004/TASK-007 land.
3. **Why this is not ready.** Self-filter exclusion cannot be tested concretely until A/B is
   selected. A task that only stores a string and claims it satisfies #2 would ship the wrong UX.
4. **No duplicate error field.** `DistinctValuesMessage` already has `error?: string`
   (`messages.ts:35`). Reuse it; do not add a parallel generic error property.

### 2026-08-27 · executor · claude-code/bao-sonnet

1. **Worktree pinning.** This agent's worktree was spawned from Cycle-X HEAD (`c890072`), which
   still carried the OLD Cycle-X TASK-006. Executed `git merge --ff-only main` (no divergence)
   to pick up `b4bcdbb` with both released dependencies (TASK-004 requery-state +
   TASK-007 webview/messages ownership) before touching anything. No conflicts, no history
   rewrite.
2. **messages.ts untouched.** Verified live: `DistinctValuesMessage` already carries BOTH
   `error?: string` (messages.ts:128) and required `truncated: boolean` (messages.ts:125) —
   per Discussion #4 zero protocol edits were needed. `src/ui/queryComposer.ts` and
   `src/ui/distinctValues.ts` also byte-untouched (pure consumers).
3. **Source-state copy semantics.** The recorded filter model is a SHALLOW spread
   `{ ...msg.filters }`; buildFilterWhere only reads it, and the webview serializes a fresh
   model per post, so no deep clone is warranted. columnTypes rides along because the
   typed `(Blanks)` predicate must rebuild identically minus the requested column.
4. **Scope-string shape.** `[barWhere.trim(), rebuilt].filter(Boolean).join(" AND ")` mirrors
   composeRequerySql's own combination verbatim, so a scoped DISTINCT reads exactly like the
   filtered browse query minus own-column predicates.
5. **Footer render site.** Note APPENDS to the count line as `"N of M — <note>"` via
   textContent only; count semantics stay machine-readable up to the em-dash separator.
   Notes clear when (a) a clean reply arrives for that key or (b) statement identity changes
   (same generation boundary as distinctByColumn).

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Target RED confirmed after writing the 5 new tests, before any production edit.
  `npx vitest run src/ui/__tests__/resultsPanelDistinctValues.test.ts` → Tests 2 failed | 16 passed (18):
  - case 1: `expected 'SELECT DISTINCT "a" FROM (SELECT id, …' to contain 'vsdb_distinct WHERE archived = false AND "b" IN (''x'') ORDER BY 1'`
  - case 2: same composed SQL missing `"b" IN ('x')` (host still passes `where=""`)
  `npx vitest run src/ui/__tests__/webviewDistinctValues.test.ts` (after npm run compile) → Tests 3 failed | 10 passed (13):
  - test 17: `expected '1 of 1' to contain 'permission denied for table t'`
  - test 18: `expected '1000 of 1000' to match /first 1000/i`
  - test 19: `expected '1 of 1' to contain 'boom one'`
  Regression pre-state as required: no-filter shape (`where=""`) test and stale-reply guards already green RED-side; webviewSetFilter suite untouched and green throughout.
Verification Output: |
  `npm run compile` → esbuild: build complete, exit 0 (webview bundle refreshed BEFORE bundle tests).
  `npx vitest run src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/webviewDistinctValues.test.ts src/ui/__tests__/webviewSetFilter.test.ts`
  Test Files 3 passed (3); Tests 42 passed (42); exit 0.
  `npm run typecheck` → `tsc --noEmit`, exit 0.
  Extra regression sweep (not in task list, run for the frozen-file constraint):
  `npx vitest run src/ui/__tests__/keysetPaging.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts`
  Test Files 4 passed (4); Tests 90 passed (90); exit 0. `git diff --check` exit 0.
Status: PASS
Note: src/ui/queryComposer.ts, src/ui/distinctValues.ts, src/ui/messages.ts byte-untouched — DistinctValuesMessage already carried error + truncated so no protocol change was needed. Changed files limited to resultsPanel.ts, webview/main.ts, the three owned test files (two of which received new cases), and the INDEX status row.

---

