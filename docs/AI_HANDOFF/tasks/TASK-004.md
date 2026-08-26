# TASK-004 — Keyset paging and safe missing-PK projection

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 item 1, §3.5

## Goal

Replace deep OFFSET paging with cursor/keyset paging when a stable total order exists, while
preserving deterministic paging when PK fields are not visibly projected. Also close two
`ResultsPanel` reviewer minors: reset stale `manualStatementIndex` in `render()` and acknowledge
a committed save even if its refresh fails.

BREAKDOWN RESOLVED (orchestrator, post-plan, grounded in repo reads): Contract **A —
direct-browse only**, implemented as a strict structural gate. `parseFromClause`
(`saveStatements.ts:234`) already proves single-table provenance and skips strings/comments;
the new `keysetPaging.ts` adds `assertBrowseShape(sql)` returning non-null ONLY when the
statement (after stripping one trailing `;`) starts with `SELECT *` or an explicit simple
column list, has NO `distinct`/`group by`/`having`/window/set-operator/`union|intersect|
except` token outside quotes/comments. Under that gate ONLY: (i) full PK already projected →
keyset predicate (OR-of-ANDs over quoted identifiers — portable, no row-value constructor)
replacing OFFSET when a last-row key is supplied, page 0 byte-identical; (ii) explicit
projection missing PK columns → rewrite the projection to append them, mark them hidden,
and `handleRequery` strips hidden columns from the DISPLAYED result (values retained for the
paging key). Any other shape keeps today's behavior unchanged.

## Target Files

- `src/ui/resultsPanel.ts` — consume the chosen keyset/projection contract; reset
  `manualStatementIndex`; replace committed-save refresh rethrow with a success warning.
- `src/ui/keysetPaging.ts` **(new)** — proposed pure SQL/keyset composition module, only after
  the Discussion contract is resolved.
- `src/ui/__tests__/resultsPanelRequery.test.ts` — host requery, cursor-key, and projection
  integration assertions.
- `src/ui/__tests__/manualCommit.test.ts` — stale-index render regression.
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — committed-save refresh-failure regression.
- `src/ui/__tests__/keysetPaging.test.ts` **(new)** — proposed pure module dialect coverage,
  only after the interface is resolved.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Page two uses a stable cursor rather than deep OFFSET | Given a proven total ORDER BY plus last visible row key, second-page SQL contains the dialect-quoted lexicographic predicate and `LIMIT`/equivalent, and contains no `OFFSET 500000`. | Direct browse statement whose result exposes all PK values; exact cursor interface awaits design decision. |
| 2 | edge — dialect | MSSQL emits no row-value constructor | Equivalent composite key uses a parenthesized OR-of-ANDs predicate; postgres/mysql may use the same portable shape; all identifiers are dialect quoted. | Two-column PK and DESC/ASC mixed ordering fixture. |
| 3 | edge — query shape | DISTINCT/aggregate is never widened | `SELECT DISTINCT …` and aggregate fixtures retain their visible columns and receive no injected PK projection; their paging uses the existing safe OFFSET fallback. | SQL shape that cannot prove one source table/key. |
| 4 | regression | New render invalidates old manual statement index | After a manual window records index 0, a fresh `render()` then Commit/Rollback executes no unrelated new statement. | Existing manual-commit fake transaction fixture. |
| 5 | regression — failure | Committed save acknowledges refresh failure | If the automatic post-commit `runSql(r.sql)` throws after transaction success, trailing `saveResult` is `{ok:true,warnings:[<error>]}` and `handleMessage` does not reject. | Existing successful automatic-save fixture with refresh-only failure. |

## Test Files

- `src/ui/__tests__/resultsPanelRequery.test.ts`
- `src/ui/__tests__/manualCommit.test.ts`
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts`
- `src/ui/__tests__/keysetPaging.test.ts` **(new, blocked on interface)**

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/manualCommit.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/keysetPaging.test.ts
npm run typecheck
```

No targeted test currently loads `dist/*.js`, so compile is not required for this task's test
selection. `package.json` has no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [x] **Resolved:** Contract A selected — `assertBrowseShape` structural gate in
      `keysetPaging.ts` using proven `parseFromClause` provenance; no regex rewriting of
      arbitrary SQL; no parser dependency added.
- [ ] Deep page SQL uses a lexicographic keyset predicate only when that proof and a full stable
      key exist; all other query shapes retain safe existing behavior.
- [ ] DISTINCT and aggregate result columns remain unchanged.
- [ ] `render()` clears `manualStatementIndex` alongside its other statement-set state.
- [ ] A refresh failure after an automatic successful commit sends an `ok:true` warning rather
      than rethrowing from the un-awaited message handler.
- [ ] After the Discussion contract is resolved, all listed verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes: `ResultsPanel.handleRequery(msg: RequeryMessage)` (`resultsPanel.ts:1163`);
  `tableByStatement: Map<number, { schema?: string; table: string }>` (`:134`);
  `listPkColumns(schema, table): Promise<string[]>` (`:81`); current
  `buildPagedQueryTerms(sql, where, terms, offset, limit, dialect, tiebreakers)`
  (`queryComposer.ts:464-484`).
- Proposed output (resolved with Contract A): public API sketch for `src/ui/keysetPaging.ts`
  (executor may refine names but must keep the shape — pure functions, no I/O):
  - `assertBrowseShape(sql: string): { columns: string[] | "*"; table: string; schema?: string } | null`
    — non-null only for gated plain `SELECT *|col-list FROM <single table>` statements.
  - `composeKeysetQuery(opts: { baseSql: string; where: string; terms: OrderByTerm[]; tiebreakers: string[]; lastKey?: Array<{ column: string; value: unknown }>; offset: number; limit: number; dialect: Dialect }): { sql: string; hiddenColumns?: string[] }`
    — emits keyset predicate + LIMIT when `lastKey` present and the total order is proven;
    page 0 (`offset === 0 && !lastKey`) byte-identical to today's `buildPagedQueryTerms`
    output; falls back to today's OFFSET composition otherwise.

---

## Discussion

1. **Blocking design fact.** A result row from arbitrary SQL does not contain a missing source
   PK value. It is impossible to add that value to `SELECT DISTINCT`, aggregate, join, CTE, or
   arbitrary wrapped output without either changing cardinality/visible semantics or parsing and
   rewriting the source projection. `tableByStatement` merely has `{schema?, table}`; it does
   not prove SQL shape. The plan's initial "plain browse shaped" rule is not yet represented by
   a parser or a verified interface. Do not guess a regex SQL rewriter.
2. **Required breakdown decision.** Before implementation, select exactly one contract:
   - **A. Direct-browse only:** extend the existing verified table-query producer to mark a
     machine-readable direct-table query; safely add PK fields as hidden columns only there.
     Arbitrary SQL remains OFFSET fallback.
   - **B. AST/parser:** add a maintained SQL parser and only rewrite AST-proven simple SELECTs.
     This adds a dependency and needs an approved parser evaluation.
   - **C. No projection:** implement keyset only when full PK is already projected; leave the
     separate missing-PK finding queued.
   Recommendation: **A**, because it has a bounded source contract and no parser dependency,
   but the planner has not located the producer contract necessary to claim it is implementable.
3. **Why not mark ready with a plausible wrapper.** A wrapper `SELECT * FROM (<inner>)` cannot
   surface a PK that `<inner>` omitted. Adding columns to the inner query breaks DISTINCT and
   aggregates. A fake test would pass while shipping an incorrect query rewrite, violating the
   TDD gate.
4. **Minors must not be implemented independently before the breakdown decision.** They share
   `src/ui/resultsPanel.ts` with this blocked item. A future split may create a ready minors-only
   task if the orchestrator chooses to release the hotspot, but it must then update the ownership
   map and this task's target list first.
5. **RESOLVED (orchestrator).** Contract A chosen as stated at the top of this file.
   `parseFromClause` gives host-side single-table provenance (string/comment-aware); the
   browse-shape gate stays inside the new pure module so both keyset composition AND hidden-PK
   projection share one gate. Hidden columns: projection-rewritten statements return
   `{sql, hiddenColumns}`; displayed results keep visible columns only, while the paging key
   reads values positionally before stripping. Page 0 with no key must compose byte-identical
   to today (guard test). Fallback paths (DISTINCT/aggregates/wraps) are asserted unchanged.
6. **Executor lane-split decision (green phase).** The frozen `resultsPanelOrderBy.test.ts`
   case 13b pins a PARTIAL-PK projection (`tenant_id` visible, `id` missing) to byte-identical
   legacy OFFSET paging with NO tiebreakers. Widening a partial explicit projection would also
   be semantically surprising (the user chose that column list), so the cycle-Y widening lane
   arms ONLY when ZERO PK columns are visible in the result: full PK visible → cycle-W visible
   tiebreaker lane; zero PK visible + gated browse → widen with hiddenColumns; anything else →
   legacy, unchanged. Same discriminator applied in both `composeRequerySql` and the
   `handleRequery` tiebreaker resolution.
7. **Webview lastKey not sent yet (expected).** The task explicitly defers webview changes, so
   `msg.lastKey` is never present in production traffic and every deep page stays on the OFFSET
   composition — byte-identical to cycle W. The keyset predicate path is exercised by the pure
   module tests plus a host-level test dispatching `lastKey` directly at the message boundary
   (the interface the webview will adopt later without host changes).

---

## Executor Report

```yaml
status: PASS
executor_tool: claude-code
executor_model: bao-sonnet
executor_subagent: feature-implementer
worktree: .claude/worktrees/agent-a2348a4ccd290e90a (branch ff to f6d1cb5 before starting)

summary: >
  New pure module src/ui/keysetPaging.ts implements assertBrowseShape (string/comment-aware
  structural gate consistent with parseFromClause provenance) and composeKeysetQuery (portable
  OR-of-ANDs keyset predicate over dialect-quoted identifiers for postgres/mysql/mssql, LIMIT
  or MSSQL TOP replacing OFFSET when a usable last-row key exists and the total order is
  proven, page-0 byte-identical to buildPagedQueryTerms, missing-PK gated-browse widening via
  widenPkWithHidden returning hiddenColumns). src/ui/resultsPanel.ts consumes it: two-lane
  paging split in composeRequerySql (legacy = frozen case-12/13/13b semantics untouched;
  widened = zero-PK-visible gated browse gets hidden PK columns stripped from the DISPLAYED
  result while their values stay positionally available for the paging key), msg.lastKey
  passthrough with host OFFSET fallback, manualStatementIndex=null reset inside render(), and
  the post-commit refresh failure now posts saveResult {ok:true, warnings:[message]} instead of
  rethrowing out of the un-awaited handleMessage.

red_output: |
  All four lanes confirmed RED before implementation:
  1) keysetPaging.test.ts (module did not exist):
     Error: Failed to load ../src/ui/keysetPaging.ts from ../src/ui/__tests__/keysetPaging.test.ts
  2) requery keyset test:
     AssertionError: expected 'SELECT * FROM (SELECT * FROM events) vsdb_page ORDER BY "id" DESC LIMIT 500 OFFSET 100000'
     to contain '("created_at" < \'2026-01-01T00:00:00Z\') OR (…AND "id" > 42)'
  3) widening test:
     expected 'SELECT * FROM (SELECT name FROM users) vsdb_page …' to be 'SELECT * FROM (SELECT name, "id" FROM users) …'
  4) manualCommit stale-index test:
     AssertionError: expected [ 'SELECT secret FROM audit_log' ] to have a length of +0 but got 1
  5) saveEdits refresh-failure test:
     AssertionError: expected 0 to be greater than 0  (+ Unhandled Rejection "Error: connection reset during refresh")

verification_output: |
  # Task's exact Verification Commands (fresh run, final):
  $ npx vitest run src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/manualCommit.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/keysetPaging.test.ts
   ✓ src/ui/__tests__/keysetPaging.test.ts        (32 tests)
   ✓ src/ui/__tests__/manualCommit.test.ts        (12 tests)
   ✓ src/ui/__tests__/resultsPanelRequery.test.ts (15 tests)
   ✓ src/ui/__tests__/resultsPanelSaveEdits.test.ts (28 tests)
   Test Files  4 passed (4)
        Tests  87 passed (87)
  # Frozen contract file (never edited; verified separately):
  $ npx vitest run src/ui/__tests__/resultsPanelOrderBy.test.ts
   ✓ src/ui/__tests__/resultsPanelOrderBy.test.ts (16 tests)
   Test Files  1 passed (1) | Tests 16 passed (16)
  # Combined five-file run during green-phase stabilization: 103 passed (103).
  $ npm run typecheck      → tsc --noEmit exits clean, no output
  $ npm run compile        → esbuild: build complete (extension + webview bundles emitted)

notes:
  - Frozen resultsPanelOrderBy.test.ts was NEVER edited; it passes via the two-lane split.
  - Case 13b forces the widen lane to require ZERO visible PK columns (not merely partial);
    decision recorded in Discussion #6.
  - No git add/commit/push performed; all changes left as working-tree state.
```

---
