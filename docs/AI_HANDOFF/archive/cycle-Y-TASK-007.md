# TASK-007 — Typed state dialect, declared-type wiring, and webview minors

- Status: `pending_review`
- Owner: `claude-code/bao-sonnet`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 items 5, 7, 8, §3.7

## Goal

Replace header-string dialect inference with a typed `StateMessage.dialect`, then use the same
message path to wire TASK-003's declared types into the webview `inferColumns` call. Also fix the
duplicate-name server sort ordinal, declare `hiddenColumns` in `readExportInput`, and remove two
dead test expressions.

BREAKDOWN RESOLVED (orchestrator, post-plan): Discussion option **C+** — typed `dialect` +
minors are unconditional; declared-type plumbing rides on TASK-004's browse-shape provenance.
`ResultsPanel` records per-statement columnTypes ONLY when both `tableByStatement` (parse
provenance) and the TASK-004 browse-gate hold, via the existing optional
`SaveContext.listColumnTypes` (same resolution path as `handleRequery`'s filter lane). That map
is keyed by POSITIONAL index → declared type string to avoid duplicate-name ambiguity, sent as
optional `StateMessage.columnTypes?: Record<string, string>` (keyed by numeric-string ordinal).
The webview converts positional→name once for `inferColumns(columns, rows, types)` (safe:
output columns at that point ARE the table columns under the same gate). Every `state` post in
`resultsPanel.ts` fills `dialect` from `this.saveContext?.getDriver() ?? undefined` through one
private helper; when null/omitted, webview falls back to the legacy header parse unchanged.

## Target Files

- `src/ui/messages.ts` — add typed optional state fields after verifying their exact shared types.
- `src/ui/resultsPanel.ts` — later owner after TASK-004; centralize state posts or update every
  real site to include live dialect and declared-type map.
- `webview/main.ts` — consume typed dialect preferentially, retain legacy header fallback, feed
  declared types to `inferColumns`, fix duplicate-name sort ordinal, and correct
  `readExportInput` return type.
- `src/ui/__tests__/resultsPanel.test.ts` — state protocol output coverage.
- `src/ui/__tests__/resultsGridModelRequery.test.ts` — declared-type state-to-grid behavior.
- `src/ui/__tests__/webviewServerSort.test.ts` — duplicate-name positional sort bundle coverage.
- `src/ui/__tests__/webviewExport.test.ts` — `hiddenColumns` type cleanup and unchanged export
  regression.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Typed dialect controls quoting | A state message `{dialect:"mysql"}` with a non-bare column id posts a requery ORDER BY containing backticks even when `header` is malformed/non-driver text. | Compiled webview bundle; existing server-sort fixture. |
| 2 | edge — empty | Legacy state falls back safely | A state lacking `dialect` continues to infer postgres/mysql/mssql from existing valid headers; a malformed header falls back to current postgres behavior. | Existing `driverHeader` fixture plus malformed header. |
| 3 | happy | Declared varchar reaches inference | State `{columnTypes:{code:"varchar"}}` plus rows `[["123"]]` renders `code` left-aligned/string; a declared integer all-null column is right-aligned/number. | TASK-003's optional third parameter must exist. |
| 4 | edge — ordering | Duplicate headers use positional ORDER BY | State columns `["id","id"]`; sorting second grid field posts a positional ordinal term that identifies column 2, never a second ambiguous quoted `id`. | Compiled webview bundle, current duplicated-field naming fixture. |
| 5 | regression — export | `readExportInput` declares hidden columns | The return annotation includes `hiddenColumns:string[]`; existing sql-where export still posts exactly `WHERE (id=1 AND \`order\`='x')`. | Existing webviewExport mysql fixture. |
| 6 | edge — no active driver | State output omits dialect without connection | `saveContext.getDriver()` returning null produces a state compatible with header fallback rather than an invented dialect. | ResultsPanel host harness. |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts`
- `src/ui/__tests__/resultsGridModelRequery.test.ts`
- `src/ui/__tests__/webviewServerSort.test.ts`
- `src/ui/__tests__/webviewExport.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts src/ui/__tests__/webviewServerSort.test.ts src/ui/__tests__/webviewExport.test.ts
npm run typecheck
```

Compile must precede the webview tests because they evaluate `dist/webview.js`. `package.json`
has no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [x] **Resolved:** option C+ — unconditional typed `dialect` + minors; declared types attached
      positionally ONLY under TASK-004's browse-shape gate via `listColumnTypes`; header parse
      remains the fallback for legacy/missing values. No name-keyed map is ever sent for
      arbitrary output.
- [x] A typed state dialect is preferred for SQL quoting; header parsing is retained only for
      backwards-compatible messages without it.
- [x] Declared types reach `inferColumns` without sampled values overriding them.
- [x] Duplicate output column names are sorted by an unambiguous positional expression.
- [x] `readExportInput` return type declares its already-returned `hiddenColumns`; dead test
      no-ops are removed without changing expected export text.
- [x] After Discussion resolution, all listed verification commands exit 0.

## Dependencies

- TASK-003 — produces optional declared-type parameter for `inferColumns`.
- TASK-004 — releases `src/ui/resultsPanel.ts` as later owner.

## Interfaces

- Consumes: `StateMessage { type:"state"; header:string; results:StatementResult[]; busy:boolean }`
  (`src/ui/messages.ts:20-27`), `SaveContext.getDriver(): ConnectionConfig["driver"] | null`
  (`resultsPanel.ts:77`), `inferColumns(columns, rows)` (`resultsGridModel.ts:76`),
  `orderByFromColumnState(api)` (`webview/main.ts:2213`).
- Proposed output (NOT YET APPROVED): `StateMessage.dialect?: "postgres" | "mysql" | "mssql"`
  and a declared-types map keyed by result column name. Exact name/type/source is blocked below.

---

## Discussion

1. **Blocking metadata fact.** `QueryResult` is only
   `{columns:string[]; rows:any[][]; rowCount; commandTag?; durationMs}` (`adapters/types.ts:11-17`).
   It has no declared types. `SaveContext.listColumnTypes(schema, table)` exists only for a
   `tableByStatement` direct table and currently supports `(Blanks)` filtering in
   `handleRequery` (`resultsPanel.ts:1241-1249`). It cannot correctly label arbitrary query
   output, duplicate aliases, joins, or expressions. Sending it as `StateMessage.columnTypes`
   would falsely claim server types for output columns.
2. **Required breakdown decision.** Pick one grounded scope before implementation:
   - **A. Direct-table-only metadata:** only attach a map for parser-proven direct-table browse
     statements, keyed by exact output columns; all other result sets keep sample inference.
     Recommended if TASK-004 resolves direct-browse provenance.
   - **B. Extend adapter QueryResult:** add ordered declared type metadata (`columnTypes` by
     position, not name) to PostgreSQL/MySQL/MSSQL query/cursor results. This is a broad
     three-adapter protocol task and must be separately planned.
   - **C. Defer P2-4 webview plumbing:** deliver typed `dialect` and minors now in a ready task,
     leaving P2-4 queued after TASK-003. This avoids a false type promise.
   Recommendation: **C** unless a direct-browse provenance contract is materialized by
   TASK-004. The current Cycle Y combined task must not ship a name-keyed map that mislabels
   duplicate or computed columns.
3. **State post inventory required.** `resultsPanel.ts` has state posts at least at
   `:223,385,436,453,505,923,1205,1283,1356,1384`. Before refactoring, catalog whether each
   has `saveContext`, whether `getDriver()` can throw, and whether a helper would alter message
   ordering. No unverified global replacement.
4. **Duplicate names need a SQL dialect decision.** SQL ordinal syntax is generally `ORDER BY 2`,
   but its interaction with existing `parseOrderBy` (currently only identifiers) must be added
   and tested on all dialects before claiming this ready. Do not send synthetic `id__2` to the
   host: it is AG Grid-only and not a database column.
5. **Dead expression cleanup.** `void received;` and `void root;` in `webviewExport.test.ts`
   are after their variables were already used. Remove only those two statements; preserve the
   test assertion and fixture lifecycle.
6. **Executor decision (unattended run):** the handoff TEST PLAN table says `{columnTypes:{code:"varchar"}}`;
   the implemented wire format is POSITIONAL per BREAKDOWN RESOLVED (option C+), so tests use
   ordinal keys (`{"0":"varchar"}`) and convert positional→name in the webview exactly once.
   This is the plan-pinned contract, not a deviation from it.
7. **Executor decision:** host-side declared-type resolution is async (`listColumnTypes` await)
   while render is sync. Resolution runs as a generation-guarded background fill keyed by
   `statementGeneration`; when a fresh positional map lands, ONE extra state re-post upgrades the
   live grid. Tests poll bounded across posts for the upgrade message. Maps are dropped if the
   live projection length at post time mismatches (guards TASK-004 widening-lane hidden-PK strip).
8. **Executor decision — intentional expectation changes (two):** (a) `queryComposer.test.ts`
   case 5 no longer lists `"1"` among rejected inputs — parseOrderBy now accepts bare ordinals
   on all three dialects (mirrors cycle-W case-16 precedent). (b) The duplicate-sort bundle case
   tightened from `"id ASC"` to `"2 ASC"`, and `resultsPanelServerFilter.test.ts` case-16's
   "'1' is rejected" was rewritten to pin that an ordinal composes BARE (never quote-wrapped):
   the cycle-V single-term lane routed through `composeSortQuery`/adapter helpers, which would
   have emitted the inert identifier `"1"` — ordinals now bypass that lane to buildOrderByClause,
   which emits them unquoted.

---

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: bao-sonnet
- EXECUTOR_SUBAGENT: feature-implementer
- Status: PASS

### RED_OUTPUT

RED phase captured pre-GREEN across 4 files + queryComposer lane:

```
FAIL webviewServerSort.test.ts > TASK-007 typed state dialect beats header parsing
  AssertionError: expected '"First Name" ASC' to be '`First Name` ASC'  // header parse, not typed field
FAIL webviewServerSort.test.ts > duplicate-name sort uses positional ORDER BY
  AssertionError: expected 'id ASC' to be '2 ASC'                        // ambiguous quoted name, not ordinal
FAIL resultsPanel.test.ts > T7.1 dialect carried on state posts
  AssertionError: expected undefined to be 'mysql'                       // `"dialect" in m` === false both paths
FAIL resultsGridModelRequery.test.ts > positional columnTypes → inferColumns
  AssertionError: expected false to be true                              // parseOrderBy('2 ASC') ok:false all dialects
FAIL webviewExport.test.ts > readExportInput return annotation declares hiddenColumns
  AssertionError: expected -1 (indexOf) >= 0                             // annotation absent
```

All RED failures stemmed from missing behavior (typed fields never sent / grammar rejected
ordinals), not fixture or wiring accidents; GREEN converted each without weakening assertions.

### Implementation Notes

- `src/ui/messages.ts`: `StateMessage` gains optional documented `dialect?: "postgres" | "mysql" | "mssql"`
  and positional `columnTypes?: Record<string, string>` (numeric-string ordinals, 0-based into
  result columns).
- `src/ui/resultsPanel.ts`: ALL 11 state posts route through one private `postMessage`, so a
  single tail call fills them via `decorateStateMessage(payload)` — dialect from
  `saveContext?.getDriver() ?? undefined`; `columnTypes` attached only when the cached map exists,
  its key count equals the LIVE projection length, and the statement has exactly one result.
  Maps are produced by generation-guarded `refreshColumnTypes()` (browse-shape gate
  `assertBrowseShape` + `tableByStatement` provenance + `listColumnTypes`) with one upgrade
  re-post on completion; any metadata failure ⇒ no map sent. Ordinal single-term terms bypass
  the `composeSortQuery` lane so they are never quote-wrapped.
- `src/ui/queryComposer.ts`: `parseOrderBy` accepts unsigned integer tokens; `buildOrderByClause`
  emits ordinal terms bare (no quoting) on postgres/mysql/mssql.
- `webview/main.ts`: StateMsg mirror gains the two optional fields; handler converts
  positional→name once using this statement's columns and stores `typedDialect`;
  `resolveSqlDialect()` prefers the typed field with `detectDialectFromHeader(headerText)` kept
  as byte-identical fallback; `orderByFromColumnState` emits `specIdx+1` positional terms when
  ≥2 specs share a headerName (deduped AG-grid-only `id__2` never reaches the host);
  `renderGrid` passes `declaredColumnTypes` into `inferColumns(columns, rows, types)`;
  `readExportInput(): {...}` return type now declares `hiddenColumns: string[]`.
- Removed dead `void received;` + trailing `void root;` from `webviewExport.test.ts` case 6b only.

### Files Changed

- src/ui/messages.ts — typed optional state fields
- src/ui/resultsPanel.ts — decorateStateMessage + refreshColumnTypes + import StateMessage + ordinal sort-lane bypass
- src/ui/queryComposer.ts — ordinal grammar + bare emission
- webview/main.ts — typed dialect preference w/ header fallback, positional→name conversion, inferColumns wiring, duplicate-name ordinal sort, hiddenColumns return annotation
- src/ui/__tests__/resultsPanel.test.ts — protocol output coverage (dialect both null-driver & no-saveContext paths; columnTypes happy/edge incl. aggregate + missing saveContext)
- src/ui/__tests__/resultsGridModelRequery.test.ts — positional map → inferColumns kinds/alignment, duplicates identical-declaration edge; ordinal parse/compose cases
- src/ui/__tests__/webviewServerSort.test.ts — duplicate-sort pinned to "2 ASC"; typed-dialect beats malformed header (mysql backticks) + legacy fallback (postgres quotes); declared types override sampling (all-null int right-aligned)
- src/ui/__tests__/webviewExport.test.ts — dead no-ops removed; source-level hiddenColumns annotation test
- src/ui/__tests__/queryComposer.test.ts — intentional: case 5 accepts ordinal (see Discussion #8a)
- src/ui/__tests__/resultsPanelServerFilter.test.ts — intentional: "'1' rejected" → ordinal composes BARE (see Discussion #8b)

### Verification Output

Order honored (compile first). Full fresh outputs from this turn:

```
$ npm run compile            → esbuild: build complete (extension/webview/aiChatPanel ok)
$ npx vitest run <task files>:
 ✓ src/ui/__tests__/resultsPanel.test.ts           (22 tests)
 ✓ src/ui/__tests__/resultsGridModelRequery.test.ts (21 tests)
 ✓ src/ui/__tests__/webviewExport.test.ts          (10 tests)
 ✓ src/ui/__tests__/webviewServerSort.test.ts      (14 tests)
 Test Files  4 passed (4)
      Tests  67 passed (67)

$ npm run typecheck          → tsc --noEmit clean, exit 0

Adjacent regression lane (touched shared modules):
 queryComposer 65 ✓ · resultsPanelOrderBy+Requery+ServerFilter 112 ✓
 resultsGridModel/Requery batch 63 ✓ · webviewRequery 10 ✓ · PerTableTabs ✓
 SaveEdits 7 ✓ · CommitRefresh 14 ✓ · Filters 8 ✓
```

Status line: PASS — every task Verification Command exited 0 in this turn.

---


## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: bao-opus (config handoff.reviewer.model = unic-smart → opus tier)
EXECUTOR_MODEL: bao-sonnet (claude-code / feature-implementer) — differs from reviewer, isolation OK
VERIFICATION_RERUN:
  command: npm run compile → npx vitest run <4 task files> → npm run typecheck
  result: compile PASS · 67 pass / 0 fail · typecheck clean (exit 0)
  spot-run: queryComposer.test.ts + resultsPanelServerFilter.test.ts → 81 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed (6/6 cases; ≥2 edge cases satisfied; RED_OUTPUT has real assertion diffs)
FINDINGS:
  critical:
    - none
  important:
    - src/ui/queryComposer.ts:458 — `buildOrderByClause` decides "is ordinal" from the term's
      column TEXT (`/^[0-9]+$/`), but by that point `parseOrderBy` has already STRIPPED the
      quotes of a legitimately quoted all-digit identifier. A real column named `2024`
      (`ORDER BY "2024" DESC`) parses to `{column:"2024"}` and re-emits BARE `ORDER BY 2024 DESC`
      on all 3 dialects — silently converting a column sort into a positional-ordinal sort
      (out-of-range ordinal ⇒ query error, or in-range ⇒ sorts the WRONG column). Verified by
      probe: pg `"2024" DESC`, mysql `` `2024` DESC ``, mssql `[2024] DESC` all → `2024 DESC`.
      Pre-change behavior quoted them correctly. Fix: carry ordinal-ness as data, not text —
      e.g. add `ordinal?: true` to `OrderByTerm`, set it only in the bare-token branch at
      queryComposer.ts:325, and have buildOrderByClause (and resultsPanel.ts:1334) test that
      flag instead of re-regexing `column`. Add a case pinning `"2024"`/`` `2024` ``/`[2024]`
      stays quoted while bare `2024` stays bare.
  minor:
    - src/ui/queryComposer.ts:294 — the `parseOrderBy` docblock still says "ordinals … are all
      rejected"; now stale, contradicts the new grammar. Update alongside the fix.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Scope as claimed is otherwise sound — header fallback is byte-identical (detectDialectFromHeader
untouched, still used at main.ts:3138 export lane), positional map is length-guarded + single-result
gated, no host-trust expansion (identifiers/values still quote-wrapped). Both documented expectation
changes (#8a/#8b) are justified and safe. Separately: during this review an out-of-band mutation
("MUTANT") appeared in webviewServerSort.test.ts:296; it was NOT in commit abde88b, my fresh re-run
caught it as a real FAIL, and I restored the file — no action needed from the executor.

## Fix Response (R4.5 round 1)

RESPONDER_MODEL: bao-sonnet
FIX_SUMMARY: Added `ordinal?: true` to `OrderByTerm`, set it only for bare unsigned integer
ORDER BY tokens, and switched both `buildOrderByClause` and the ResultsPanel single-term lane to
use the typed flag instead of re-detecting ordinal-ness from text. Updated the stale parser docblock
and added quoted-digit, bare-ordinal, and mixed-clause coverage. Trace conclusion: `resolveColumnToken`
unquotes a dialect-quoted digit identifier to logical `2024`; `isSafeLogicalIdent("2024")` accepts it
because it is non-empty and contains no control characters, so quoted digit columns already flow
through the grammar and must remain distinguished from ordinals by data.
RED_OUTPUT: |
  $ npx vitest run src/ui/__tests__/queryComposer.test.ts -t "digit"
  FAIL src/ui/__tests__/queryComposer.test.ts > buildOrderByClause (TASK-001) > keeps quoted digit identifiers quoted across all dialects
    AssertionError: expected '2024 DESC' to be '"2024" DESC' // Object.is equality
  FAIL src/ui/__tests__/queryComposer.test.ts > buildOrderByClause (TASK-001) > mixes a bare ordinal and quoted digit identifier in one postgres clause
    AssertionError: expected '2 DESC, 2024 ASC' to be '2 DESC, "2024" ASC' // Object.is equality
  Test Files  1 failed (1)
       Tests  2 failed | 1 passed | 65 skipped (68)
Verification Output: |
  $ npm run compile
  esbuild: build complete

  $ npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/webviewServerSort.test.ts src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts
   Test Files  6 passed (6)
        Tests  157 passed (157)
  webviewServerSort.test.ts completed in the compile-first run; exit 0.

  $ npm run typecheck
  tsc --noEmit clean, exit 0
Status: PASS

## Discussion

### 2026-08-27 · executor: bao-sonnet
The reviewer finding was fixed without touching `keysetPaging.ts`. Bare numeric terms now carry explicit
ordinal state, while quoted digit identifiers remain ordinary logical identifiers and are re-quoted by
the active dialect builder.

## Re-Review (R4.5 round 1)

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus (configured reviewer role: unic-smart)
EXECUTOR_MODEL: bao-sonnet (claude-code / feature-implementer)
MODEL_ISOLATION: PASS — reviewer and executor models differ.
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts && npm run typecheck
  result: PASS — 3 files, 100 tests passed; typecheck passed.
PROBE: PASS — parse → compose: postgres `"2024" DESC` / mysql `` `2024` DESC `` / mssql `[2024] DESC` remain quoted with `ordinal=false`; bare `2024 DESC` remains bare with `ordinal=true` on all three dialects.
EVIDENCE:
  - src/ui/queryComposer.ts:233-237 — `OrderByTerm.ordinal?: true` explicitly preserves ordinal provenance.
  - src/ui/queryComposer.ts:329-330 — only the bare unsigned-integer branch sets `ordinal: true`; quoted digit identifiers resolve normally without it.
  - src/ui/queryComposer.ts:462-464 — composition reads the typed flag, with no text regex re-detection.
  - src/ui/resultsPanel.ts:1334 — single-term composeSortQuery bypass tests `first.ordinal === true`.
  - src/ui/queryComposer.ts:293-299 — parser docblock now documents accepted bare ordinals and quoted all-digit identifiers.
  - af6196b TASK-007 paths: only queryComposer.ts, resultsPanel.ts, queryComposer.test.ts, and this task document changed.
FINDINGS: none.

