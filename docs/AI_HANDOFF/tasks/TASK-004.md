# TASK-004 — Host wiring: distinct-values round trip + ORDER BY parser + paging tiebreaker

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 / §3.2 / §3.4

## Goal

Wire the wave-1 pure builders into the extension host: answer the webview's
`requestDistinctValues` with a cached `distinctValues` reply, replace `SIMPLE_ORDER_BY_RE` with
TASK-001's `parseOrderBy` (surfacing a rejection to the user instead of passing SQL through
raw), and page through `buildPagedQueryTerms` with the statement's full projected PK as the
ordered tiebreaker (or no tiebreaker when any PK component is not projected).

## Target Files

- `src/ui/messages.ts` — add `RequestDistinctValuesMessage` + `DistinctValuesMessage`, extend
  the `WebviewMessage` and `HostMessage` unions.
- `src/ui/resultsPanel.ts` — new `case "requestDistinctValues"` in `handleMessage` (`:328`);
  `handleRequestDistinctValues` + a per-`(index, column)` cache invalidated in `render()` and a
  captured statement identity/generation guard that drops late responses for replaced statements;
  every reply echoes the request's `index` and `column`; `composeRequerySql` (`:898`) switched
  from `SIMPLE_ORDER_BY_RE` to `parseOrderBy` / `buildOrderByClause` /
  `buildPagedQueryTerms`; resolve all PK columns through `listPkColumns` and pass them only when
  every name appears in `r.result.columns`; remove the now-dead `SIMPLE_ORDER_BY_RE` (`:61`) if
  nothing else references it; extend `SaveContext` (`:72`) with optional `listColumnTypes`.
- `src/extension.ts` — **implement** the new optional `SaveContext.listColumnTypes` next to the
  existing `listPkColumns` (`:95-107`), which already calls
  `adapter.listColumns(table, schema || undefined)` and returns `ColumnInfo[]`. Map to
  `Record<name, dataType>`; `catch → {}`. ~8 lines, no other change to this file. No other task
  touches `src/extension.ts`.

### Composition dispatch — PINNED by `PLAN.md` §3.1, do not improvise

`composeRequerySql` must dispatch exactly like this. Anything not listed keeps cycle-V behaviour.

| `msg` shape (after `parseOrderBy(orderBy, dialect)` succeeds) | Compose with | Alias |
|---|---|---|
| `dialect === null` | `composeRequery(sql, where, orderBy)` — **unchanged** | `vsdb_sub` |
| no `filters`, no `offset`, **0 terms** | `composeRequery(sql, where, "")` — **unchanged** | `vsdb_sub` |
| no `filters`, no `offset`, **1 term, no `nulls`** | `composeSortQuery(dialect, sql, where, col, dir)` — **unchanged cycle-V path, keeps its quoting** | `vsdb_sort` |
| no `filters`, no `offset`, **≥2 terms, or 1 term with `nulls`** | new multi-term wrap (below) | `vsdb_sub` |
| `filters` or `offset` present | `buildPagedQueryTerms(...)` | `vsdb_page` |

Multi-term wrap, exact shape (alias matches `composeRequery`'s existing `vsdb_sub`):

```
SELECT * FROM (<sql, trailing ; stripped>) AS vsdb_sub[ WHERE <where.trim()>] ORDER BY <buildOrderByClause(terms, dialect)>
```

No LIMIT/OFFSET on this path — `msg.offset` is absent by construction. An ORDER BY already
present in the original SQL is **replaced** by the outer one (pre-existing wrapper behaviour
shared by `composeRequery` / `composeSortQuery` / `buildPagedQuery`); do not add inner-ORDER-BY
detection.
- `src/ui/__tests__/resultsPanelDistinctValues.test.ts` **(new)** — cases 1-6, 6b, 14, 15.
- `src/ui/__tests__/resultsPanelOrderBy.test.ts` **(new)** — cases 7-13b.
- `src/ui/__tests__/resultsPanelServerFilter.test.ts` — **update case 16 only** (see §Discussion).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | integration (happy) | `requestDistinctValues` runs the DISTINCT SQL | `runSql` called once with a string containing `SELECT DISTINCT "name"` and `vsdb_distinct` | postgres panel, statement 0 |
| 2 | integration (happy) | the reply reaches the webview | a posted message `{type:"distinctValues", index:0, column:"name", values:["a","b"], truncated:false}` | runner returns rows `[["a"],["b"]]` |
| 3 | edge (cache) | a second request for the same column runs no SQL | `runSql` call count still 1; a second `distinctValues` message IS still posted | same request twice |
| 4 | edge (invalidation) | a new `render()` for that index clears the cache | after re-render, the same request runs `runSql` again | statement replaced |
| 5 | edge (permission/driver error) | a failing DISTINCT query degrades, never throws | posted message has `error` non-empty and `values: []`; no unhandled rejection; panel still responsive | `runSql` rejects with `permission denied` |
| 6 | edge (no connection) | no dialect ⇒ no SQL, explicit error reply | `runSql` not called; posted `distinctValues` carries the request's `index` / `column` and an `error` | `saveContext.getDriver()` returns `null` |
| 6b | edge (concurrency) | late DISTINCT response for a replaced statement is dropped | request `{index:0,column:"name"}`, call `render()`/replacement requery for statement 0 before the deferred old `runSql` resolves, then resolve it: **no** `distinctValues` `postMessage` occurs for the old response and the replacement cache stays empty (a next request runs SQL); the captured response identity remains old `index:0,column:"name"` and is rejected against current statement generation | deferred runner promise for statement 0, then replacement at same index |
| 7 | integration (happy) | multi-term ORDER BY uses the PINNED `AS vsdb_sub` wrapper | composed SQL `=== 'SELECT * FROM (SELECT id FROM t) AS vsdb_sub ORDER BY "a" ASC, "b" DESC'` — exact string via `toBe`, alias `AS vsdb_sub`, no LIMIT/OFFSET | `requery` with `orderBy: "a, b DESC"`, no filters, no offset, postgres, sql `SELECT id FROM t` |
| 8 | integration (happy) | same wrapper on mssql + with a bar WHERE | `=== 'SELECT * FROM (SELECT id FROM t) AS vsdb_sub ORDER BY [a] ASC, [b] DESC'`; and with `where: "id > 0"` → `… AS vsdb_sub WHERE id > 0 ORDER BY [a] ASC, [b] DESC` | same, mssql |
| 8b | edge (identifier charset) | active-dialect quoted colId round-trips; mismatched style rejects | postgres `orderBy: '"First Name" ASC'` composes `ORDER BY "First Name" ASC` and runs SQL; postgres with `` `First Name` ASC `` runs no SQL and surfaces the standard parse error | quoted input from TASK-003 + mismatched quote input |
| 8c | edge (dialect capability) | `NULLS` native vs rejected | postgres `orderBy: "a NULLS LAST"` → SQL contains `ORDER BY "a" ASC NULLS LAST`; mysql and mssql → `runSql` NOT called, `showErrorMessage` called with a message matching `/NULLS/i` | one case per dialect |
| 9 | regression (behaviour change) | an expression is REJECTED, not passed through | `runSql` NOT called; an error is surfaced (`showErrorMessage` called) — RED against today's pass-through | `orderBy: "lower(name)"` |
| 10 | regression (back-compat) | a single identifier still composes as in cycle V | `ORDER BY "name" DESC` (postgres) and `[name] DESC` (mssql) | `orderBy: "name DESC"` |
| 11 | regression (back-compat) | empty ORDER BY is byte-identical to `composeRequery` | `toBe(composeRequery(sql, "", ""))`, no `ORDER BY` substring | `orderBy: ""` |
| 12 | integration (happy) | paging appends the full composite PK in declared order | SQL ends `ORDER BY "name" ASC, "tenant_id" ASC, "id" ASC LIMIT 500 OFFSET 500`; both PK columns appear once and in `listPkColumns` order | `offset:500`, `r.result.columns:["name","tenant_id","id"]`, PK `["tenant_id","id"]` |
| 13 | edge (boundary) | no PK ⇒ paging unchanged | SQL is byte-identical to the live cycle-V `buildPagedQuery` output for the same message | `listPkColumns` resolves `[]` |
| 13b | edge (projection safety) | any non-projected PK component disables the whole tiebreaker | SQL is byte-identical to `buildPagedQuery`; contains neither appended `"tenant_id"` nor `"id"`; no gap-free UI promise/message is posted | projection `["name","tenant_id"]`, PK `["tenant_id","id"]` — `id` missing |
| 14 | integration (type-derived `(Blanks)`) | `columnTypes` comes from declared type, not row values | a `(Blanks)` selection on a `varchar` column whose **every loaded row value is `null`** composes `("n" IS NULL OR "n" = '' …)`; the same selection on an `int4` column composes bare `"num" IS NULL` | `listColumnTypes` returns `{ n: "varchar", num: "int4" }`; loaded rows all-NULL for `n` |
| 15 | edge (metadata unavailable) | no type metadata ⇒ cycle-V behaviour, never a type error | `tableByStatement` miss **and** `listColumnTypes` rejecting both compose bare `"n" IS NULL` with no `= ''`; `runSql` still called once (the requery is not aborted) | two sub-cases |

## Test Files

- `src/ui/__tests__/resultsPanelDistinctValues.test.ts` **(new)** — cases 1-6, 14, 15.
- `src/ui/__tests__/resultsPanelOrderBy.test.ts` **(new)** — cases 7-13 (incl. 8b, 8c).
- `src/ui/__tests__/resultsPanelServerFilter.test.ts` — case 16 updated (see §Discussion).

Reuse the `FakeWebview` / `FakeWebviewPanel` + `vi.mock("vscode")` harness at the top of
`src/ui/__tests__/resultsPanelServerFilter.test.ts` (lines 25-181, including the `requeryMsg`
factory and `waitForTerminal`).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts
npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelRetry.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts
npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/distinctValues.test.ts
npx vitest run src/extension.test.ts src/scaffold.test.ts
npm test
```

`npm test` is the cycle's boundary run: this is the last task, and its baseline is
1400 passed / 2 skipped / 0 failed. `src/ui/__tests__/resultsGridModelNull.test.ts` test 6 is a
known pre-existing flake under the full suite (passes in isolation) — not a cycle-W regression.

## Acceptance Criteria

- [ ] Every case in §Test Cases passes.
- [ ] `npm run typecheck` clean.
- [ ] `npm test` ≥ 1400 passed with no failure other than the documented flake.
- [ ] Cases 11, 13 and 13b prove the no-filter / unusable-full-PK paths are byte-identical to
      cycle V — asserted with `toBe` against a live `composeRequery` / `buildPagedQuery` call,
      not a pasted string. These are the only byte-identity claims in this cycle; do not add a
      `toBe(composeRequery(...))` assertion to the single-term sort path: that path composes via
      `composeSortQuery` (`vsdb_sort`, quoted) and `composeRequery` emits `vsdb_sub` unquoted, so
      such an assertion would revert cycle V's dialect quoting and break
      `resultsPanelServerFilter.test.ts:556-571` (case 15). See `PLAN.md` §7.
- [ ] `composeRequerySql` dispatches exactly per the table in §Target Files: the single-bare-term
      path still goes through `composeSortQuery` unchanged, and the multi-term path emits the
      pinned `AS vsdb_sub` wrapper with no LIMIT/OFFSET. (cases 7, 8, 10)
- [ ] DISTINCT replies echo the captured request `index` and `column`; a completion whose
      statement identity/generation no longer matches current statement index is dropped before
      both cache write and `postMessage`. (case 6b)
- [ ] `buildDistinctValuesQuery` is called with `where = ""`; `grep` shows no new
      `lastWhere`/`whereByStatement`-style field added to `resultsPanel.ts`.
- [ ] `columnTypes` is sourced from `SaveContext.listColumnTypes`, never from
      `result.rows`; `grep -n "typeof .* === \"string\"" ` shows no row-value type sniffing in
      the `(Blanks)` path. (cases 14, 15)
- [ ] `src/ui/__tests__/resultsPanelServerFilter.test.ts` case 15 (`:556-571`) is still green and
      **unmodified**; only the case-16 block changes.
- [ ] `SIMPLE_ORDER_BY_RE` is gone from `src/ui/resultsPanel.ts` (or a `grep` shows a remaining
      caller, documented in the Executor Report).
- [ ] A rejected ORDER BY produces BOTH a `vscode.window.showErrorMessage` and no `runSql` call.
- [ ] Paging tiebreakers are the full host-derived PK (`saveContext.listPkColumns` /
      `tableByStatement`) in declared order, never webview input; they are passed only when every
      PK name is present in `r.result.columns`, otherwise `[]` preserves cycle-V SQL and no
      gap-free promise is emitted. (cases 12, 13, 13b)
- [ ] `webview/main.ts` is NOT modified by this task (TASK-003 owns it).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001, TASK-002

## Interfaces

- Consumes from TASK-001 (`src/ui/queryComposer.ts`):

```ts
// pass the LIVE dialect — that is what rejects NULLS on mysql/mssql
export function parseOrderBy(orderBy: string, dialect?: Dialect): { ok: true; terms: OrderByTerm[] } | { ok: false; error: string };
export function buildOrderByClause(terms: OrderByTerm[], dialect: Dialect): string;
export function buildPagedQueryTerms(sql: string, where: string, terms: OrderByTerm[], offset: number, limit: number, dialect: Dialect, tiebreakers: string[]): string;
export function buildFilterWhere(filters: ColumnFilterModel, dialect: Dialect, options?: { columnTypes?: Record<string, string> }): string;
```

- Consumes from TASK-002 (`src/ui/distinctValues.ts`):

```ts
export const DISTINCT_VALUES_LIMIT = 1000;
export function buildDistinctValuesQuery(sql: string, column: string, dialect: Dialect, where: string, limit?: number): string;
export function takeDistinctValues(rows: unknown[][], limit?: number): { values: unknown[]; truncated: boolean };
```

- Consumes from TASK-003 (webview → host), and produces the reply:

```ts
export interface RequestDistinctValuesMessage { type: "requestDistinctValues"; index: number; column: string; }
export interface DistinctValuesMessage {
  type: "distinctValues";
  index: number;
  column: string;
  values: unknown[];
  truncated: boolean;
  error?: string;
}
```

- Existing host API used unchanged: `SaveContext.getDriver(): Dialect | null`,
  `SaveContext.listPkColumns(schema: string, table: string): Promise<string[]>`,
  `this.tableByStatement: Map<number, { schema?: string; table: string }>`.

- **New, added by this task** — `SaveContext` gains one OPTIONAL method so the panel can learn
  declared column types without importing `ConnectionManager` (same pattern and same adapter call
  as the existing `listPkColumns`; `extension.ts:98-106` already has `ColumnInfo[]` in hand):

```ts
export interface SaveContext {
  getDriver(): ConnectionConfig["driver"] | null;
  getManualCommit?(): boolean;
  listPkColumns(schema: string, table: string): Promise<string[]>;
  /** NEW (optional — an older/ test SaveContext without it still works).
   *  column name → declared DB type, from ColumnInfo.dataType
   *  (src/adapters/types.ts:47-52). Resolves to {} on any failure. */
  listColumnTypes?(schema: string, table: string): Promise<Record<string, string>>;
}
```

  Optional, so every existing `SaveContext` literal in the test suite keeps compiling untouched;
  absent ⇒ no `columnTypes` ⇒ cycle-V `IS NULL` (case 15).

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (actual, before implementation — 3 files):
```
Test Files  2 failed (2)  Tests  8 failed | 3 passed (11)   [distinct+orderBy new]
Test Files  1 failed (1)  Tests  3 failed | 13 passed (16)  [serverFilter case 16]
```
RED covered: distinct cases 1-6, 6b, 14(varchar); orderBy cases 7, 8 (both),
8b(backtick), 8c (all three), 9, 10(quoted), 12; serverFilter case 16
(a,b DESC / lower(name) / 1).

Verification Output:
```
npm run typecheck                      → clean (no output)
vitest distinctValues+orderBy          → 27 passed / 0 failed
vitest serverFilter+requery+panel+retry+saveEdits → 71 passed / 0 failed
vitest queryComposer+distinctValues    → 54 passed / 0 failed
vitest extension+scaffold              → 67 passed / 0 failed
npm test                               → 1477 passed | 2 skipped | 0 failed (109 files)
```
(`npm run compile` run before extension.test.ts per instructions; the
schemaForm-bundle test needs dist/ present.)

Status: PASS
Note:
- Deliberate test change (Discussion note 1): resultsPanelServerFilter.test.ts
  case 16 rewritten in place — "a, b DESC" now asserts the parsed `AS vsdb_sub`
  wrapper; "lower(name)" and "1" now assert rejection (no runSql +
  showErrorMessage). Case 15 (:556-571 area) untouched and green.
- Accepted limitation restated (Discussion note 6 / PLAN §2 out-of-scope,
  §7): the DISTINCT list is BASE-STATEMENT scoped (`where = ""`); a filtered
  view may offer values it cannot contain. Queued follow-up in INDEX.md.
- waitForTerminal in resultsPanelServerFilter.test.ts and the new orderBy test
  file gained a `minStates=2` floor: TASK-004 made handleRequery await PK /
  column-type metadata before composing, so the old helper returned on the
  initial render state before the requery's first runSql. No assertion logic
  changed.
- SIMPLE_ORDER_BY_RE removed from resultsPanel.ts; the only remaining mention
  is a historical doc comment in queryComposer.ts:232 (TASK-001's file, not a
  caller).
- DISTINCT runs route through this.transaction.runQuery when a manual
  transaction is open (same pinned-session rule as requery).
- Late-response guard (6b) keys on a statementGeneration counter bumped by
  render() and by a successful requery replacement; distinctCache cleared in
  both places too.


### 2026-08-26 · planner · bao-opus

→ @executor Read this before touching `composeRequerySql`.

1. **You are deliberately breaking one existing test, and only one.**
   `src/ui/__tests__/resultsPanelServerFilter.test.ts:578-591` ("case 16 — non-simple ORDER BY
   is passed through verbatim") asserts `"lower(name)"`, `"a, b DESC"` and `"1"` compose
   byte-identically to `composeRequery`. After this task: `"a, b DESC"` is *parsed and quoted*,
   and `"lower(name)"` / `"1"` are *rejected*. Update that `describe` in place — rename it, keep
   the three inputs, and assert the new behaviour per input. Do **not** delete the block and do
   **not** touch any other test in that file. Record the change in your Executor Report; the
   reviewer will check that the behaviour change was intentional and matches `PLAN.md` §3.1.
2. **Rejection must be visible and must run nothing.** Follow the existing error style in
   `handleRequery`: `vscode.window.showErrorMessage` plus the synthetic error `StatementResult`
   so the webview shows it in the `vsdb-error` placeholder. Silently falling back to
   `composeRequery` reintroduces exactly the bug this cycle is closing.
3. **Full-PK tiebreaker source, in order:** `tableByStatement.get(index)` →
   `listPkColumns(schema, table)` → compare **every** PK name against `r.result?.columns`. Preserve
   the array's declared order and pass all columns only when each is projected; if the PK is empty,
   result metadata is absent, or one component is missing, pass `[]` and preserve the case-13/13b
   byte-identical path. Never use only the first PK and never append all projected columns — neither
   is guaranteed unique. The result header is already available as `StatementResult.result.columns`
   (`src/adapters/types.ts:12`), so no new metadata/message is needed. `listPkColumns` is async;
   resolve it in `handleRequery` before the sync composer rather than reordering the `requerySeq`
   guard at `:956`. The UI currently has no gap-free copy; do not add one for the fallback.
4. **`columnTypes` (TASK-001) is derived from DECLARED TYPES — never from row values.** Round-1
   review killed the row-sniffing version: "at least one loaded value is a `string`" is
   page-dependent (the same selection composes `IS NULL` on one page and `IS NULL OR = ''` on
   the next) and is inert for an all-NULL `varchar` window, which is the case users actually
   notice. Resolve it statically instead:
   `tableByStatement.get(index)` → `saveContext.listColumnTypes?.(schema ?? "", table)` →
   `Record<name, dataType>` → pass as `buildFilterWhere(filters, dialect, { columnTypes })`.
   Note `StatementResult.result.columns` is `string[]` (`src/adapters/types.ts:12`) — **names
   only, no types** — so the result header cannot supply this; that is why the `SaveContext`
   method exists. Any miss (no table, method absent, promise rejects) ⇒ pass **no**
   `columnTypes` ⇒ every `(Blanks)` stays `IS NULL`, i.e. cycle V. Unknown must never widen the
   predicate: `col = ''` against an `int` is a hard error on postgres and mssql. Cases 14/15.
   `listColumnTypes` is `async`, like `listPkColumns` — resolve it in `handleRequery` **before**
   calling the sync `composeRequerySql` and pass it in (same reason as note 3: an async composer
   reorders the `requerySeq` guard at `:956`). One `await` for both lookups.
5. **The distinct cache must key on `(index, column)` and be cleared in `render()`**, but cache
   clearing alone is insufficient. Capture the request's `index`, `column`, and current statement
   identity/generation before awaiting `runSql`; after it resolves, verify that index still points
   to that same statement before caching or posting. The reply object must echo the captured
   request index/column, never values read from mutable current state. If `render()` or a replacement
   requery changed statement 0 while its DISTINCT request was in flight, drop the old completion:
   no cache write and no `postMessage` (case 6b). This mirrors the existing stale requery guard.
6. **The DISTINCT query is BASE-STATEMENT scoped — call `buildDistinctValuesQuery` with `""`.**
   This was "unverified" in round 0; round-1 review resolved it: `src/ui/resultsPanel.ts` retains
   no per-statement WHERE (no `lastWhere`, no `whereByStatement`; the requery bar's text only
   ever arrives inside a single `RequeryMessage`), and `RequestDistinctValuesMsg` carries only
   `{index, column}`. So compose DISTINCT over the statement's own `r.sql` — the base table,
   whose `(schema, table)` you already have from `tableByStatement` — bounded by its own
   `LIMIT n+1`. **Do not invent host state to retain a WHERE**, and do not change the message
   contract (TASK-003 is written against `{index, column}` in parallel). The consequence — the
   dropdown may offer a value the current filtered view cannot contain, so selecting it yields
   zero rows — is an **accepted limitation** recorded in `PLAN.md` §2 out-of-scope and §7, with
   a queued follow-up in `INDEX.md`. Restate it in your Executor Report so the reviewer sees it
   as planned.
7. **`parseOrderBy` takes the live dialect.** Call `parseOrderBy(orderBy, dialect)`, not
   `parseOrderBy(orderBy)` — the two-arg form is what rejects `NULLS FIRST|LAST` on mysql/mssql
   (case 8c). Route that rejection through the *same* `showErrorMessage` + synthetic error
   `StatementResult` channel as note 2; there is exactly one rejection path in this task.
8. **A quoted colId arriving from TASK-003 is normal input, not an attack.** TASK-003 quotes any
   non-bare `colId` before sending (`orderBy: '"First Name" ASC'`), and `parseOrderBy` strips the
   quotes, un-doubles the escapes and hands you `column: "First Name"`, which
   `buildOrderByClause` re-quotes via `quoteIdent`. Do not add a second validation layer that
   rejects quoted input — case 8b fails if you do, and header-click sort on a spaced column name
   regresses versus today.

(no other comments)

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck
  result: PASS (clean)
  command: npx vitest run src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts
  result: 54 pass / 0 fail
TEST_PLAN_COVERAGE: partial — case 15's required tableByStatement-miss subcase is not implemented
FINDINGS:
  critical:
    - none
  important:
    - file: docs/AI_HANDOFF/tasks/TASK-004.md:213-220 — RED_OUTPUT contains only aggregate failure counts and prose, with no assertion failure, stack trace, or explicit non-zero exit; paste real pre-implementation failing-test output to establish the required RED cycle.
    - file: src/ui/resultsPanel.ts:963-973 — postgres/mysql single-SELECT execution returns a batched cursor, but pickResult reads only one 500-row batch while this query probes 1001 values and the cursor is never closed; dropdowns are incomplete and a PostgreSQL cursor can retain the sole pooled client. Consume batches through the probe limit and close any batched handle in finally, with a batched-path test.
    - file: src/ui/resultsPanel.ts:945-948 — the cache stores only values and hard-codes truncated:false on hits, so a first truncated:true response becomes falsely exhaustive on the second request. Cache and replay both values and truncated.
    - file: src/ui/__tests__/resultsPanelDistinctValues.test.ts:393-410 — the first case-15 fixture uses SELECT n FROM t, so tableByStatement is populated; the required metadata-unavailable tableByStatement-miss edge case is absent. Add a no-FROM fixture and assert requery still runs with bare IS NULL.
  minor:
    - none
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Running bao-opus on the configured unic-smart reviewer tier; model isolation is satisfied. Full npm test was intentionally left to the orchestrator.

---

## Executor Report (fix round 1)

EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer (fix round)

RED_OUTPUT (actual, pre-fix source via `git stash` of resultsPanel.ts — regression
tests for findings 2-3; finding 4's new test passed against pre-fix code because the
handler already degrades gracefully on a table-map miss, so it is a pure coverage
addition, not a behaviour fix; the original cycle's first-run RED output is
unavailable — this round's RED is the reproduced evidence going forward):
```
❯ fix round 1 — a truncated:true first response replays truncated (not false)
  → expected false to be true // Object.is equality
❯ fix round 1 — batched DISTINCT response drains all pages and closes the cursor
  → expected [ Array(500) ] to have a length of 900 but got 500
Test Files  1 failed (1)   Tests  2 failed | 12 skipped (14)
```

Fixes:
- Important #2 (distinct cache truncated): `distinctCache` now stores
  `{ values, truncated }`; cache hits replay the captured `truncated` instead of
  hard-coding `false`. (resultsPanel.ts cache decl + hit path)
- Important #3 (batched cursor leak): the DISTINCT run drains `fetchBatch()` pages
  through the probe limit (or EOF), then `batched.close()` in `finally` —
  best-effort/idempotent, mirroring `closeStatementCursor`. Non-batched runs
  unchanged.
- Important #4 (table-map-miss case): test added (`SELECT now()` fixture — no FROM,
  tableByStatement miss) asserting the requery still runs once with bare
  `"n" IS NULL` and no `= ''`. Handler needed no change: the metadata resolution
  at `handleRequery` already treats a miss as "no columnTypes" (cycle V).
- Important #1 (RED evidence): real assertion-failure RED output above, captured
  by stashing the fix and running the new regression tests against pre-fix source.

Verification Output:
```
npm run typecheck                       → clean (no output)
npx vitest run resultsPanelDistinctValues.test.ts        → 14 passed / 0 failed
npx vitest run distinctValues+orderBy+serverFilter+requery → 57 passed / 0 failed
npm run compile                         → esbuild: build complete
```

Status: PASS
Note: All four reviewer findings addressed (three code/test, one evidence); full
`npm test` boundary run left to the orchestrator per round-1 convention.
