# TASK-006 — ResultsPanel host hardening: cursor ordering, manual-window refresh, wire-safe `batched`

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (post-audit reconciliation), §3.5

## Goal

Close the four confirmed host-side defects that the Cycle X audits located in `src/ui/resultsPanel.ts`: the save flow issues aux/refresh queries while a browse cursor still pins the only pooled client, manual COMMIT/ROLLBACK buttons leave the grid on stale rows, and the state post ships a live cursor handle where the wire type declares a boolean. One task because all four fixes edit the same file (same-file ownership rule, PLAN §2).

Audit source: `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md` findings P1-1, P1-4, P1-5, P3-3 (TASK-002, done).

## Target Files

- `src/ui/resultsPanel.ts` — four scoped edits:
  1. **P1-5** — in `handleSaveEdits`, `await this.closeStatementCursor(r)` immediately before the automatic-mode refresh `await this.runner.runSql(r.sql)` (currently `resultsPanel.ts:769-771`, no close, unlike the manual branch at `:710` and the requery path at `:1085`). Double close is idempotent by design (`postgres.ts:782-785`), so the later `adopt()` closing the displaced cursor stays safe.
  2. **P1-1** — in `handleSaveEdits`, close the active statement cursor **before the first metadata/ctid await** — i.e. before `await this.saveContext.listPkColumns(...)` at `resultsPanel.ts:559`, which precedes both `fetchPostgresCtids` (`:620`) and `listColumnTypes`. This is the audit's own "proposed fix (small)" host-side branch. **Do NOT** add a `noCursor` option or otherwise change the `QueryRunner`/adapter protocol — that alternative was explicitly rejected at the reconciliation gate as out of budget.
  3. **P1-4** — after a manual transaction closes, requery the manual window's statement for **both** commit and rollback. Record the statement index when the manual window opens (`handleSaveEdits`, `:709-711`, where `beginTransaction()` is called) and use it in `handleCommitTransaction` and in the `rollbackTransaction` **message** path only. Reuse the non-manual branch's existing pattern: `runSql(r.sql)` → `pickResult` → new `StatementResult` → `this.lastResults` swap → `this.runner.adopt(...)` → one `state` post. Clear the recorded index after use.
  4. **P3-3** — `sanitizeStatementResult` must emit `batched: !!r.batched` instead of spreading the live cursor object (`:1486-1496`). The early `if (!r.result) return r;` branch must also normalize `batched`, because `extension.ts:642-646` posts `runner.getResults()` — real handles — through this function.
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — save-flow cursor-ordering cases (P1-5, P1-1).
- `src/ui/__tests__/manualCommit.test.ts` — post-commit/post-rollback refresh cases and the teardown guard (P1-4).
- `src/ui/__tests__/resultsPanel.test.ts` — `sanitizeStatementResult` wire-shape cases (P3-3).

Ownership note: no other Cycle X task modifies `src/ui/resultsPanel.ts` or these three test files.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy (regression, P1-5) | Auto-mode save closes the browse cursor before the refresh SELECT | A recorded call log equals `["batched.close", "runSql:SELECT * FROM t"]` — `batched.close()` is called **before** the second `runSql`, and the refresh `runSql` receives exactly `r.sql`. RED today: `close` is absent from the log before the refresh. | `manualCommit` off; statement 0 has `status:"done"`, `sql:"SELECT * FROM t"`, a fake `batched` whose `close` pushes to the shared log; one dirty cell edit |
| 2 | edge — ordering/concurrency (regression, P1-1) | No-PK postgres save closes the cursor before the first metadata/ctid round trip | In the same shared call log, `"batched.close"` appears at an index **lower** than both `"listPkColumns"` and the first `runSql` whose SQL matches `/^SELECT ctid FROM /`. RED today: `listPkColumns` and the ctid probe are logged first. | driver `postgres`; `listPkColumns` resolves `[]`; one dirty cell edit on a rowId with a server row; fake `batched` on statement 0 |
| 3 | edge — state/refresh (regression, P1-4) | Manual ROLLBACK requeries the manual window's statement | After dispatching `{type:"rollbackTransaction"}`, exactly one further `runSql("SELECT * FROM t")` occurs and the last `state` post's `results[0].result.rows` equals the fake adapter's post-rollback rows `[[1,"server-truth"]]` — not the pre-rollback `[[1,"uncommitted"]]`. RED today: zero follow-up `runSql`, only a `transactionStatus` post. | manual-commit mode; a save already opened the transaction on index 0; adapter returns `[[1,"server-truth"]]` for the refresh |
| 4 | edge — state/refresh (regression, P1-4) | Manual COMMIT requeries the same statement | After `{type:"commitTransaction"}`, `transaction.commit()` is called once, exactly one further `runSql("SELECT * FROM t")` occurs, and the trailing `state` post carries the refreshed rows with `results[0].batched` present for the new cursor. | as #3 |
| 5 | edge — teardown/lifecycle | Dispose-time rollback does not requery | Calling `panel.dispose()` with an open manual transaction calls `transaction.rollback()` once and issues **zero** `runSql` calls afterwards, and posts no `state` message after dispose. | open manual window; spy on `runSql` call count across dispose |
| 6 | edge — serialization/type (regression, P3-3) | `state` post carries boolean `batched`, never the handle | For a `StatementResult` whose `batched` is an object with `fetchBatch`/`close`/`cancel` **functions**, the posted payload's `results[0].batched` is strictly `true` and `typeof … === "boolean"`; no function-valued property survives. RED today: the spread ships the object. | fake webview capturing `postMessage`; `render([stmt], "Run at T — postgres@h/db")` |
| 7 | edge — empty/boundary (P3-3) | Result-less statement is still normalized | A `StatementResult` with `result: undefined` and a function-bearing `batched` posts `batched === true` and `result === undefined`; a statement with `batched: undefined` posts `batched === false`. | same fake webview; covers `sanitizeStatementResult`'s early-return branch |

## Test Files

- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — cases 1, 2 (node env; existing `FakeWebview`/`FakeWebviewPanel` + fake-adapter `runSql` recorder pattern already in this file).
- `src/ui/__tests__/manualCommit.test.ts` — cases 3, 4, 5 (node env; existing `FakeWebview.dispatch` message boundary + `DbTransaction` fake).
- `src/ui/__tests__/resultsPanel.test.ts` — cases 6, 7 (node env; existing `postMessage` capture + `vscode` mock).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/manualCommit.test.ts src/ui/__tests__/resultsPanel.test.ts
npx vitest run src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelRetry.test.ts src/ui/__tests__/resultsPanelDistinctValues.test.ts
npm run typecheck
```

The three target suites are node-environment (no `dist/webview.js`), so `npm run compile` is not required for this lane; final cycle verification compiles first. `package.json` defines no lint script — `typecheck` is the static gate (PLAN §5).

## Acceptance Criteria

- [ ] Every test in §Test Cases passes, and cases 1–4 and 6 were demonstrated RED before the production edit.
- [ ] `handleSaveEdits` closes the statement cursor before the first metadata/ctid await **and** before the automatic-mode refresh `runSql`; no `QueryRunner`/adapter/`RunResult` signature changed.
- [ ] Manual COMMIT and manual ROLLBACK both refresh the manual window's statement through `runSql` + `pickResult` + `lastResults` swap + `adopt` + one `state` post; the panel-teardown rollback path does not.
- [ ] `sanitizeStatementResult` never emits a non-boolean `batched`, including when `result` is absent.
- [ ] `src/ui/messages.ts`, `webview/main.ts`, `src/core/**`, and `src/adapters/**` are unmodified by this task.
- [ ] The second (regression) verification command exits 0 with no assertion changes needed; if one is required, the change is limited to the assertion the fixed behavior invalidates and is called out in §Discussion.
- [ ] `npm run typecheck` exits 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — host/adapter audit gate (done); findings S1/M-series routed away from this file.
- TASK-002 — grid/UI audit gate (done); source of P1-1, P1-4, P1-5, P3-3.

Both dependencies are already complete, so this task is schedulable in Wave 2 alongside TASK-003, TASK-004 and TASK-008.

## Interfaces

- Consumes (existing, unchanged signatures — quoted from source):
  - `private async closeStatementCursor(r: StatementResult): Promise<void>` (`src/ui/resultsPanel.ts:902`)
  - `pickResult(runResult: RunResult): Promise<QueryResult>` (`src/core/queryRunner.ts:423`)
  - `QueryRunner.runSql(sql: string)`, `QueryRunner.adopt(index: number, stmt: StatementResult)`, `QueryRunner.beginTransaction(): Promise<DbTransaction>` (`src/core/queryRunner.ts:360`)
  - `DbTransaction { runQuery(sql: string): Promise<RunResult>; commit(): Promise<void>; rollback(): Promise<void> }` (`src/adapters/types.ts:86-90`)
  - `SaveContext.listPkColumns(schema: string, table: string): Promise<string[]>` and optional `listColumnTypes(schema, table): Promise<Record<string,string>>` (`src/ui/resultsPanel.ts:81`, `:85`)
  - `StatementResult { index; sql; status; result?; batched?: BatchedQuery; error?; durationMs; label? }` (`src/core/queryRunner.ts:39-54`)
- Produces: no new exported symbol. Behavioural contracts other tasks may rely on:
  - a `state` message's `results[i].batched` is always `boolean` on the wire (matches `webview/main.ts:120` `batched?: boolean`);
  - `handleSaveEdits` leaves the pre-save browse cursor closed before any aux query.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Reconciliation gate decisions applied verbatim.

1. **P1-1 scope choice.** The audit offered two fixes: a `runSql(sql, { noCursor: true })` protocol option, or closing the active cursor before the first aux await. The protocol option would change `QueryRunner` + all three adapters and cannot be right-sized into this task, so the host-side close is the chosen fix and the protocol variant is not to be attempted here.
2. **Cursor-close side effect.** Closing at the top of `handleSaveEdits` means `loadMore(index)` on the pre-save cursor is no longer possible mid-save. That already holds in manual mode (`:710`) and after the automatic-mode refresh swaps in the new cursor via `adopt()`, so no user-visible capability is lost. Confirm this in review rather than treating it as a regression.
3. **P1-4 "active statement".** The host tracks no active tab, so "the active statement" is defined as the index whose save opened the manual window (`beginTransaction()` at `:709-711`). Recording that index there is the smallest correct grounding; a broadcast refresh of every `lastResults` entry was rejected (N extra queries on a `pool.max=1` connection).
4. **P1-4 teardown guard.** `rollbackOpenTransaction()` has three callers — `:175`/`:240` (dispose paths) and `:425` (webview message). Only the message path may refresh; case 5 locks this in.
5. **Live-DB caveat.** The audit marks the exact deadlock timing for P1-1/P1-5 as *needs live DB verification*. The **ordering** defect is direct code evidence and is fully unit-testable, which is what the test cases assert; no test here requires a live database.

---
