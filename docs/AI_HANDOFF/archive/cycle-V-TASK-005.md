# TASK-005 — Server-side column filter + Load More paging (host + webview wiring)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Server-side filter + paging)

## Goal

Push per-column filters down to the database and keep paging working while a filter is
active. Today `colFilterActive` (`webview/main.ts:220`) hard-blocks `loadMore`
(`webview/main.ts:1936-1941`), so a filter silently searches only the loaded window. Extend
the existing `requery` message with optional `filters` / `offset` / `limit` / `append`,
compose the SQL with TASK-004's builders, and dispatch from the grid's filter events.

## Target Files

- `src/ui/messages.ts` — extend `RequeryMessage` (line 92) with four **optional** fields.
  Optional is load-bearing: three existing call sites (`webview/main.ts:2216`, `:2473`,
  `:2868`) must keep compiling and behaving identically.
- `src/ui/resultsPanel.ts` — `handleRequery` (line 860): when `msg.filters` is present,
  compose via `buildFilterWhere` + `buildPagedQuery` instead of `composeRequery`; when
  `msg.append` is true, concatenate onto the existing `result.rows` rather than replacing.
  Keep every existing guard: `closeStatementCursor` first (line 877), post
  `status:"running"` before the run (lines 890-906), route through `this.transaction` when
  open (line 912), `pickResult` (line 921), `runner.adopt` (line 942).
- `webview/main.ts` — three edits: (a) mirror the message type at line 123; (b) in
  `onFilterChanged` (line 1705) post a debounced server requery carrying
  `gridApi.getFilterModel()`; (c) in `dispatchLoadMore` (line 1936) and `onBodyScroll`
  (line 1956), when a server filter is active, post `requery` with
  `offset = loadedRows, append: true` instead of returning early.
- `src/ui/__tests__/resultsPanelServerFilter.test.ts` **(new)**
- `src/ui/__tests__/webviewServerFilter.test.ts` **(new)**

`webview/styles.css` is NOT edited — reuse existing classes (TASK-003 owns that file).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `requery with filters composes a server-side WHERE` | the SQL handed to `runner.runSql` contains `IN (` and the filtered column's quoted name | fake runner captures the SQL; `filters:{name:{values:["a"]}}` |
| 2 | unit (happy) | `requery with offset+limit pages` | composed SQL contains `LIMIT 500 OFFSET 500` for a postgres driver | `offset:500, limit:500` |
| 3 | unit (happy) | `append:true concatenates rows onto the existing result` | posted `state` message's `results[0].result.rows.length === 1000` | 500 rows already in `lastResults`, run returns 500 more |
| 4 | edge (back-compat) | `requery without the new fields is byte-identical to today` | composed SQL `=== composeRequery(sql, where, orderBy)` | `{type:"requery",index:0,where:"",orderBy:""}` — the exact shape `webview/main.ts:2868` posts after a save |
| 5 | edge (cursor lifecycle) | `previous batched cursor is closed before a filtered requery` | `batched.close()` called exactly once, before `runSql` | Postgres `pool.max=1`; a leaked cursor wedges the next query |
| 6 | edge (concurrency) | `a stale in-flight requery never overwrites a newer one` | after requery A (slow) and B (fast) resolve out of order, `lastResults[0]` holds B's rows | resolve A after B |
| 7 | edge (manual transaction) | `filtered requery routes through the open transaction` | `transaction.runQuery` called; `runner.runSql` NOT called | panel has an open `DbTransaction` |
| 8 | edge (append + error) | `a failed append leaves the existing rows intact` | `runSql` rejects → posted state still has the original 500 rows and a `status:"error"` entry; no row loss | |
| 9 | integration (webview) | `clearing every filter re-requeries unfiltered` | posted message has `filters` `{}` (or absent) and `append` falsy | drive `setFilterModel(null)` on the bundle |
| 10 | integration (webview) | `Load More while a filter is active posts a requery, not a loadMore` | captured host message `type === "requery"` with `append:true` and `offset === 500`; no `{type:"loadMore"}` is posted | `dist/webview.js` in jsdom, 500 rows loaded, filter model set |
| 11 | edge (debounce) | `rapid filter changes collapse into one requery` | 5 `onFilterChanged` events within the debounce window → exactly 1 posted `requery` | fake timers |
| 12 | integration (webview, typed values) | `the posted filter model carries typed values beside display values` | for a filtered numeric column, the posted `filters[col].typed` has the **same length** as `.values` and holds raw `number`s (`typeof === "number"`), not strings | `dist/webview.js` in jsdom; rows loaded with a numeric column; select two values |
| 13 | edge (typed passthrough) | `host emits unquoted numerics end-to-end` | `filters:{id:{values:["42"],typed:[42]}}` → the SQL captured at `runner.runSql` contains `IN (42)` and does **not** contain `IN ('42')` | host-side; pins that `handleRequery` forwards `typed` to `buildFilterWhere` untouched rather than re-`String()`-ing it |
| 14 | edge (typed unavailable) | `a filtered value whose row is no longer loaded degrades to a string literal` | selection includes a display value with no matching loaded row → `typed` is omitted for that column (not padded with `undefined`), and the composed SQL quotes every value | guards TASK-004 case 19: the webview must drop `typed` wholesale rather than emit a length-mismatched array |
| 15 | integration (sort call path) | `a simple ORDER BY from the requery bar is dialect-quoted via composeSortQuery` | driver `mssql`, `orderBy:"name DESC"` → the SQL captured at `runner.runSql` contains `ORDER BY [name] DESC`; driver `postgres`, same input → `ORDER BY "name" DESC` | host-side, `FakeWebview` harness. This is the **liveness** test for `composeSortQuery` and (once TASK-006 lands) for `mssql.getTableSortQuery` — without it those exports are dead code |
| 16 | edge (complex ORDER BY passthrough) | `a non-simple ORDER BY is passed through verbatim, not mangled` | `orderBy:"a, b DESC"`, `orderBy:"lower(name)"`, `orderBy:"1"` → composed SQL is byte-identical to `composeRequery(sql, where, orderBy)`; no bracket/quote injection is attempted | the bar accepts free text; only a **single bare identifier + optional ASC/DESC** may be routed through `composeSortQuery`. Anything else must take today's path or the feature silently corrupts valid SQL |
| 17 | edge (empty ORDER BY) | `an empty or whitespace-only ORDER BY adds no ORDER BY clause` | `orderBy:""` and `orderBy:"   "` → composed SQL contains no `ORDER BY`, byte-identical to today | boundary; the post-save auto-requery at `webview/main.ts:2868` sends `""` on every save |

Kinds: happy (1-3), backward-compat (4), resource-lifecycle (5), concurrency (6),
alternate-execution-path (7), failure-atomicity (8), state-reset (9), integration (10),
timing (11), type-fidelity (12-13), partial-data degradation (14), live-call-path (15),
passthrough-safety (16), empty boundary (17).

## Test Files

- `src/ui/__tests__/resultsPanelServerFilter.test.ts` — cases 1-8, 13, 15-17. Reuse the
  `FakeWebview` / `FakeWebviewPanel` + `vi.mock("vscode", …)` harness already written in
  `src/ui/__tests__/resultsPanelRequery.test.ts:41-110`.
- `src/ui/__tests__/webviewServerFilter.test.ts` — cases 9-12 and 14. Bundle harness copied from
  `src/ui/__tests__/webviewSetFilter.test.ts` (skip-if-`dist/webview.js`-missing guard,
  ResizeObserver + matchMedia stubs).

## Verification Commands

```bash
npm run typecheck
npx tsc -p tsconfig.webview.json --noEmit
npm run compile
npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/webviewServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/webviewSetFilter.test.ts
npm test
```

The two existing requery/set-filter suites are in the list on purpose: this task changes
the code they cover, and they are the regression tripwire.
`npm run compile` must precede the vitest line (cases 9-12, 14 load `dist/webview.js`).

Webview tsc gate — **snapshot diff, not "no new filename"**. `tsconfig.webview.json` has 61
pre-existing errors across six files (mostly `TS2393`/`TS2451` shared-global-scope
redeclarations, plus `TS2339`/`TS2304`/`TS2678` and others), and `webview/main.ts` (14 of them)
is one of the files this task edits, so a filename-based check would pass no matter what
this task breaks. Per PLAN.md §5, capture per-file counts before and after and require an
empty diff:

```bash
npx tsc -p tsconfig.webview.json --noEmit 2>&1 \
  | grep -oE '^[a-zA-Z0-9_/.-]+\.ts' | sort | uniq -c | sort -rn > /tmp/vsdb-webview-tsc-before.txt
# ... make the edits ...
npx tsc -p tsconfig.webview.json --noEmit 2>&1 \
  | grep -oE '^[a-zA-Z0-9_/.-]+\.ts' | sort | uniq -c | sort -rn > /tmp/vsdb-webview-tsc-after.txt
diff /tmp/vsdb-webview-tsc-before.txt /tmp/vsdb-webview-tsc-after.txt && echo "WEBVIEW TSC BASELINE UNCHANGED"
```

Paste the diff result into the Executor Report. Do not fix the baseline errors.

## Acceptance Criteria

- [ ] `RequeryMessage` has `filters?: ColumnFilterModel`, `offset?: number`,
      `limit?: number`, `append?: boolean` — all optional; no existing call site edited to
      satisfy the compiler.
- [ ] `handleRequery` still closes the previous cursor, posts `running` first, honours an
      open `DbTransaction`, and calls `runner.adopt` — verified by cases 5, 7 and by
      `resultsPanelRequery.test.ts` staying green.
- [ ] `colFilterActive` no longer causes a silent dead end: with a filter active, Load More
      issues a paged requery (case 10).
- [ ] The webview populates `filters[col].typed` from the raw loaded cell values whenever
      every selected display value resolves to a loaded row, and **omits** `typed`
      entirely otherwise — never a length-mismatched or `undefined`-padded array.
      `handleRequery` forwards `typed` to `buildFilterWhere` unmodified.
- [ ] `handleRequery` routes a **single bare identifier** `orderBy` (optionally followed by
      `ASC`/`DESC`) through `composeSortQuery(dialect, …)` so it is dialect-quoted, and
      passes anything else through to `composeRequery` byte-identically (cases 15-17).
      This is what makes `composeSortQuery` — and TASK-006's mssql export — live code
      rather than an orphaned API.
- [ ] All 17 Test Cases PASS.
- [ ] `npm run typecheck` clean; webview tsc snapshot diff empty
      ("WEBVIEW TSC BASELINE UNCHANGED"); `npm run compile` clean;
      `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-004 (needs `buildFilterWhere` / `buildPagedQuery` / `composeSortQuery` /
  `ColumnFilterModel`).

Not a dependency on TASK-006: `composeSortQuery` is complete in wave 1 (TASK-004 ships the
mssql arm inline). TASK-006 later swaps that arm's body for a delegation, which case 15
keeps honest from the other side — both tasks run in wave 2 and touch disjoint files.

## Interfaces

- Consumes (from TASK-004, `src/ui/queryComposer.ts` — exact):
  ```ts
  export interface ColumnFilterModel {
    [field: string]: { values: string[]; typed?: unknown[] };
  }
  export function buildFilterWhere(filters: ColumnFilterModel, dialect: Dialect): string;
  export function composeSortQuery(
    dialect: Dialect, originalSql: string, whereFromBar: string,
    column: string, direction: "ASC" | "DESC",
  ): string;
  export function buildPagedQuery(
    sql: string, where: string, orderBy: string,
    offset: number, limit: number, dialect: Dialect,
  ): string;
  ```
  From HEAD: `composeRequery(sql, where, orderBy)` (`src/ui/resultsGridModel.ts:1090`) —
  still the no-filter path; `SaveContext.getDriver(): ConnectionConfig["driver"] | null`
  (`src/ui/resultsPanel.ts:52`) — how the panel learns the dialect;
  `pickResult` and `runner.adopt(index, stmt)` (`src/core/queryRunner.ts`).
- Produces (wire contract; a later cycle's webview work depends on it):
  ```ts
  export interface RequeryMessage {
    type: "requery";
    index: number;
    where: string;
    orderBy: string;
    filters?: ColumnFilterModel;  // AG Grid getFilterModel() payload + typed[] values
    offset?: number;              // 0-based row offset; omitted ⇒ no paging
    limit?: number;               // page size; omitted ⇒ adapter default batch
    append?: boolean;             // true ⇒ concatenate onto existing rows
  }
  ```

---

## Discussion

### 2026-08-25 · planner · bao-opus

The three existing `requery` senders are `onRequeryClick` (`webview/main.ts:2469-2473`),
the Refresh path at `:2214-2216`, and the post-save auto-requery at `:2866-2868`. All three
send only `{index, where, orderBy}`. Case 4 pins that they keep working untouched — if the
new fields are made required, TASK-006's reviewer will see three unrelated call-site edits
and rightly reject the diff.

Dialect on the host comes from `this.saveContext?.getDriver()`. When it returns `null` (no
active connection) fall back to `"postgres"` quoting **only** for composing the string the
run will reject anyway; better, skip the filter push-down entirely and use plain
`composeRequery`. Prefer the latter — never guess a dialect against a live DB.

`webview/main.ts` is also edited by TASK-003 in wave 1 (a one-line swap at `:2760`).
Re-read the file at the start of this task; do not work from a wave-1-era copy.

**Populating `typed` (plan review R1, finding 4).** AG Grid's set-filter model only carries
display strings — VSDB builds those entries with `String(v)` in `buildSetFilterEntries`
(`src/ui/resultsGridModel.ts:1151-1176`). Sending them as-is would make every server-side
predicate a string literal, which costs the index on MySQL and hard-fails an MSSQL `int` or
`datetime2` column. So the webview must attach the raw values too:

- On `onFilterChanged`, for each filtered column, map each selected display value back to a
  loaded row's raw cell value using the same normalization `selectedKeysFromModel` uses
  (`src/ui/resultsGridModel.ts:1204`) — lowercased `String(v)`, `(Blanks)` sentinel
  excluded (it becomes `IS NULL` host-side and must not enter `typed`).
- If **every** selected value resolves, post `typed` alongside `values`, same length, same
  order. If any does not — the row holding it has been scrolled past and evicted, or the
  selection is stale model state — omit `typed` for that column entirely (case 14).
  A partially-filled array is worse than none: TASK-004 case 19 makes a mismatched length
  fall back silently, but an `undefined` slot would reach `sqlLiteral` and emit `NULL`,
  quietly changing the predicate.
- The host forwards `typed` to `buildFilterWhere` untouched. Do not re-`String()` it, and
  do not JSON-round-trip it in a way that turns numbers into strings — case 13 exists to
  catch exactly that.

**Making the sort helpers live code (plan review R1, finding 8).** At HEAD,
`getTableSortQuery` (`src/adapters/postgres.ts:167`) has **zero** production call sites —
it shipped in cycle U as a pure builder. If cycle V only adds an mssql twin, the cycle
ships two dead exports, which is finding 8.

The requery bar already has an ORDER BY input whose value is posted as `orderBy` on every
requery (`webview/main.ts:2215-2216`, `:2472-2473`, `:2867-2868`), and today the host
splices that raw text into the SQL via `composeRequery`. That is the call site. In
`handleRequery`:

- If `orderBy.trim()` matches a **single bare identifier with an optional direction** —
  approximately `/^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(ASC|DESC)?\s*$/i` — route it through
  `composeSortQuery(dialect, sql, where, ident, dir)` so the identifier is quoted for the
  live dialect (`[name]` on MSSQL, `` `name` `` on MySQL, `"name"` on PG).
- Otherwise (`a, b DESC`, `lower(name)`, `1`, empty) keep today's `composeRequery` path
  **byte-identical**. Case 16 pins this. Do not attempt to parse a general ORDER BY list;
  the bar is free text and a half-parser that quotes `lower(name)` as an identifier turns
  working SQL into a syntax error.
- Case 17 covers the empty case because the post-save auto-requery at `:2868` sends
  `orderBy: ""` on every single save — the highest-traffic path through this code.

This closes the dead-export gap without pulling column-header-click wiring into scope
(explicitly out of scope per PLAN.md §2): header clicks still sort client-side.

→ @executor: case 6 is the one most likely to be faked. Assert on *ordering*, e.g. tag each
fake run with a sequence number and check the surviving `lastResults` entry carries the
higher one — not merely that both promises settled.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
SUMMARY: Wired server-side column filtering (AG Grid set-filter model → WHERE via buildFilterWhere) and OFFSET/LIMIT paging (buildPagedQuery) into resultsPanel.handleRequery, with a monotonic requerySeq staleness guard and append-requery concatenation; webview main.ts now debounces filter changes into host requeries and drives Load More via paged append requeries while a filter is active. All optional fields on RequeryMessage preserve the three pre-existing call sites byte-identically.
TEST_PLAN_FOLLOWED: task §4 Test Plan (17 cases) — 1-8, 13, 15-17 in resultsPanelServerFilter.test.ts; 9-12, 14 in webviewServerFilter.test.ts
FILES_CHANGED:
  - src/ui/messages.ts: RequeryMessage + filters?/offset?/limit?/append? (optional)
  - src/ui/resultsPanel.ts: handleRequery filter/paged composition, requerySeq staleness guard, append concatenation, composeSortQuery dispatch
  - webview/main.ts: ServerFilterModel (local structural mirror), buildServerFilterModel, postFilterRequery/scheduleFilterRequery debounce, dispatchLoadMore paged-requery branch
  - src/ui/__tests__/resultsPanelServerFilter.test.ts (new): cases 1-8, 13, 15-17
  - src/ui/__tests__/webviewServerFilter.test.ts (new): cases 9-12, 14
TESTS_ADDED:
  - resultsPanelServerFilter.test.ts: 16 tests (filter IN, paging, append, back-compat, cursor-close order, out-of-order seq, transaction path, append error atomicity, typed literals, mssql/postgres sort ident, non-simple ORDER BY, empty ORDER BY)
  - webviewServerFilter.test.ts: 5 tests (filter-clear re-requery, paged Load More vs loadMore, debounce collapse, typed values same-length, unresolvable display → typed omitted)
VERIFICATION:
  - npm run typecheck: exit 0
  - npx tsc -p tsconfig.webview.json --noEmit: per-file error counts identical to baseline (14/10/10/5/1); verified via diff of sorted counts
  - npm run compile: exit 0
  - vitest (4 target files): 42 passed / 42
  - npm test: 1392 passed, 0 failed, 2 skipped (floor was 1327)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — 17-case matrix covered; review welcome
NEXT: ready for review

RED_OUTPUT (pre-implementation, host tests):
  8 failed | 8 passed (16)
  ✓ resultsPanelServerFilter.test.ts — 8 passed
  FAIL 1. WHERE IN … ✕ filter values → WHERE col IN (…)
  FAIL 2. LIMIT/OFFSET … ✕ paged SQL
  FAIL 3. append … ✕ rows concatenated
  FAIL 5. cursor … ✕ closes before run
  FAIL 6. out-of-order … ✕ staleness guard
  FAIL 7. transaction … ✕ routes through transaction
  FAIL 13. typed 42 … ✕ unquoted numeric literal
  FAIL 16. non-simple … ✕ byte-identical

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  commands:
    - npm run typecheck
    - npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/webviewServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/webviewSetFilter.test.ts
    - npx tsc -p tsconfig.webview.json --noEmit 2>&1 | grep -oE '^[a-zA-Z0-9_./-]+\.ts' | sort | uniq -c | sort -rn
  result: typecheck clean; 42/42 pass; webview tsc per-file counts 14/10/10/5/1 (baseline identical)
TEST_PLAN_COVERAGE: all-followed — 17/17 cases covered (1-8,13,15-17 host; 9-12,14 webview)
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Clean implementation. Optional RequeryMessage fields preserve all 3 existing call sites. requerySeq monotonic guard, cursor-close-first, manual-transaction routing, and append error-atomicity all verified. buildServerFilterModel correctly omits typed when any display value fails resolution (length-mismatch guard). Regression suites (resultsPanelRequery, webviewSetFilter) untouched and green.
