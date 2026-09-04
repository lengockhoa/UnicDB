# TASK-UX1-010 — DDL/DML statements render a status card, not an empty grid (R12)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 1), §3 (UX1-010)

## Goal

Running DDL/DML (e.g. `CREATE OR REPLACE FUNCTION app.fn_create_plan(...) ...`) today
renders an empty results table with no applied/failed detail. Classify each statement's
kind, stamp it additively onto `StatementResult`, suppress the grid tab for non-SELECT
statements, and render a status card instead: success → what was applied + duration;
failure → the original error verbatim plus a pinpointing hint.

## Target Files

- `src/core/queryRunner.ts` — new pure export `classifyStatementKind(sql: string,
  dialect?: SqlDialect): "select" | "ddl" | "dml" | "other"` + additive optional field
  `kind?: "select" | "ddl" | "dml" | "other"` on `StatementResult`. No behaviour change to
  `QueryRunner` itself.
- `src/extension.ts` — ONE stamping site in `runStatements`: after `runner.run()` settles,
  stamp `kind` on `runSlice` entries (same slot as `stampBqDialect`; do not stamp while
  `pending`). Wave-1 region contract: this task owns ONLY the `runStatements` stamping
  slot; UX1-001 concurrently owns ONLY the `commandGenerateSelect` function — disjoint
  functions, no serialisation edge.
- `src/ui/resultsGridModel.ts` — carry `kind` through result reconstruction sites (mirror
  the existing `dialect` field handling, BQ04-001 precedent).
- `webview/main.ts` — in the state/tab logic (`renderActivePanel` :1174 region + statement
  tab creation): statements with `kind` defined and `!== "select"` get NO grid tab; render
  a card via the messages path (`renderMessagesInto` :3396 pattern) — new card branch
  keyed on `kind`.
- `webview/styles.css` — append ONE new `.vsdb-ddl-card` block (success/error variants).
  Do not modify existing selector blocks. Wave-1 region contract (operative rule, P2.5
  round 1): `.vsdb-chat-*` belongs to UX1-008, `.vsdb-setfilter-*` to UX1-005 — disjoint
  selector families make the P3 merge conflict-free.
- Tests: `src/core/__tests__/queryRunner.test.ts` (classifier), new
  `src/ui/__tests__/ddlStatusCard.test.ts` (webview card + tab suppression).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | CREATE FUNCTION success renders card, no grid | statement `CREATE OR REPLACE FUNCTION app.fn(x) ...` with `commandTag: "CREATE FUNCTION"` → webview shows card whose text contains `CREATE FUNCTION` and the duration; zero grid tabs created for that statement | fixture StatementResult `{ sql, status: "done", result: { commandTag, rowCount: null, ... } }` fed through the tab-logic + card builder |
| 2 | happy | SELECT still renders a grid | `SELECT * FROM t` (`kind: "select"`) → grid tab created exactly as today; card path not taken | same pipeline |
| 3 | edge A — empty DML | `UPDATE t SET x=1` matching 0 rows | card with commandTag (e.g. `UPDATE 0`), success styling, no error node | `{ status: "done", result: { commandTag: "UPDATE 0", rowCount: 0 } }` |
| 4 | edge B — failure pinpoint | DDL failure keeps error verbatim + hint | pg error `syntax error at or near "SELEC"\nLINE 3: SELEC ...` → card error text byte-identical to `r.error`; hint string contains `LINE 3` and `statement 1 of 2` for index 0 of a 2-statement run | `{ status: "error", error: "<verbatim>", index: 0 }` + run statement count 2 |
| 5 | edge B — classification boundaries | classifier truth table | `WITH c AS (...) SELECT` → select; `SELECT ... INTO new_t` → ddl; `INSERT/UPDATE/DELETE` → dml; `EXPLAIN SELECT` → other; comment-padded `/* c */ CREATE TABLE` → ddl; `  \n` → other (no throw) | pure calls to `classifyStatementKind` |
| 6 | edge C — BQ pending untouched | pending BQ statement keeps `kind === undefined` | stamping helper skips entries with `pending: true`; `dialect`-stamp coexistence verified | entry `{ pending: true, batched: {...} }` |
| 7 | edge C — multi-statement mixed run | run `[CREATE TABLE a…; SELECT 1;]` | tab list: statement 0 → card, statement 1 → grid; card present for index 0 only | two-entry results array |
| 8 | regression | reconstructions carry `kind` through | resultsGridModel reconstruction site preserves `kind` like `dialect` (assert both fields on the rebuilt object) | model rebuild helper |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — cases 5–6 (classifier + stamping helper).
- `src/ui/__tests__/ddlStatusCard.test.ts` (NEW) — cases 1–4, 7–8 (webview tab logic +
  card content; jsdom; export a pure `buildDdlCardText(result, statementCount)`-style
  helper from webview/main.ts's module surface if direct DOM assert is impractical —
  follow `resultsGridModel.test.ts` precedent for pure-helper extraction).
- `src/ui/__tests__/resultsGridModel.test.ts` — case 8 if reconstruction lives there;
  otherwise keep in ddlStatusCard.test.ts.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts src/ui/__tests__/ddlStatusCard.test.ts src/ui/__tests__/resultsGridModel.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Cases 1–8 pass; classifier case 5 verified against its full truth table.
- [ ] `git diff 75cdb08..HEAD -- src/adapters/types.ts` remains empty (`kind` added to
      `StatementResult` in queryRunner.ts, NOT to adapter types).
- [ ] SELECT path byte-identical (case 2 + existing resultsGridModel/resultsPanel suites
      green).
- [ ] `.vsdb-ddl-card` CSS is a pure append (no existing selector modified).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none (wave-1 region contracts, promoted to the operative rule in P2.5 round 1:
  styles.css changes are a new `.vsdb-ddl-*` append-only block vs UX1-008's `.vsdb-chat-*`
  and UX1-005's `.vsdb-setfilter-*`; the single extension.ts stamping site does not
  collide with UX1-001's commandGenerateSelect branch — different functions; webview/
  main.ts changes stay in the renderActivePanel/state-tab regions, disjoint from
  UX1-005's SetFilterComponent class).

## Interfaces

- Consumes: `StatementResult` (src/core/queryRunner.ts:50 — additive field);
  `stampBqDialect` stamping-slot precedent (extension.ts:2279 region);
  `renderMessagesInto` card pattern (webview/main.ts:3396); pg error text shapes
  (`LINE n:` / `character n`).
- Produces: `classifyStatementKind(sql, dialect?)` + `StatementResult.kind?` — UX1-011
  consumes `kind === "ddl" | "dml"` for refresh classification; webview card contract
  (`.vsdb-ddl-card`) is the final render surface.

---

## Discussion

### 2026-09-04 · planner · unic-smart
Classification is deliberately text-first (first significant keyword after
comment/whitespace stripping) + `commandTag` for the card line — adapter-level DDL
grammars rejected as fragile cross-driver. `WITH ... SELECT` counts as select and
`SELECT ... INTO` as ddl per the plan; if the executor finds a real-world statement class
the truth table mis-handles, extend `classifyStatementKind` and its truth table in the
same task. The `kind` field is additive and `undefined` on BQ-pending shapes so
TASK-BQ03/04 behaviour is untouched (case 6). Hint extraction is a regex over the pg
error text, never a re-parse of SQL.
