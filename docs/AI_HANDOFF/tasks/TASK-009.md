# TASK-009 — Results host: ctid lookup returns rows, atomic save batch, real header, refresh after commit

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.4 / §3.5 (A3, A4, A12-host, A14, A15) — §7 Global Constraints applies by reference

## Goal

Fix the host side of save. Today a postgres no-PK save *always* refuses, a successful save leaves
the grid unrefreshed on batched drivers, the panel header is always blank, and a mid-batch
failure leaves the table half-written.

- **A3** — `fetchPostgresCtids` (`resultsPanel.ts:770-771`) reads `res.results[0]?.rows`, but
  `runSql("SELECT ctid FROM …")` has no `;`, so `PostgresAdapter.runQuery` routes it to
  `DECLARE CURSOR` and returns `{results: [], batched}` (`postgres.ts:161-168`). Every row
  "fails" ⇒ `all_failed` ⇒ the user-visible "ctid lookup failed for every dirty row" — **and one
  cursor is leaked per row** against a `max: 1` pool, so later queries hang until
  `connectionTimeoutMillis`. Use `pickResult()`, which drains and closes.
- **A4** — the post-save refresh (`:524-526`) reads `refreshed.results[0]`, `undefined` on
  batched drivers ⇒ no `state` post and `runResult.batched` never closed (another cursor leak).
  `handleRequery:641` already solves this with `pickResult` — reuse it.
- **A12-host** — read `serverIndexByRowId` off the `saveEdits` message, convert
  `Record<string, number>` → `ReadonlyMap<number, number>`, pass it to `buildSaveStatements`, and
  **use it to key the ctid map by `rowId`** (today `fetchPostgresCtids` keys by server row index,
  which is no longer interchangeable with `rowId`).
- **A14** — `render()` (`:127-149`) never assigns `this.header`, so every later post
  (`:228,245,274,569,660,704`) sends an empty header and the query duration/title is always blank.
- **A15** — save statements run one-by-one with no transaction (`:533-540`); a partial failure
  leaves the table half-written and unrollbackable. Wrap the batch in `BEGIN … COMMIT` with
  `ROLLBACK` on first failure.

- **A19-skip (§3.4a)** — when `buildSaveStatements` returns `ok:true` **with** `skippedRows`, the
  host must map every entry into `SaveResultMsg.rowErrors` (`{rowId, error: reason}`,
  `messages.ts:121`). Today those rows are reported nowhere machine-readable, so
  `handleSaveResult`'s else-branch (`webview/main.ts:2321-2330`) runs `editState.clear()` +
  `undoStack.clear()` and the user's edit is destroyed with no banner and no undo. The consumer
  already exists (`clearExceptRowIds`, `webview/main.ts:2304`) — this is pure host wiring, no
  webview change.

Also pass `{ schema: parsed.schema }` into `buildSaveStatements` so TASK-001's qualification
actually takes effect.

## Target Files

- `src/ui/resultsPanel.ts`
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts`
- `src/ui/__tests__/resultsPanel.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | ctid resolve | fake adapter returns the **batched** shape for a single `SELECT` without `;` ⇒ map has one entry per matched row, keyed by `rowId` |
| Happy | atomic batch | 2 statements ⇒ exactly one `BEGIN`, both statements, one `COMMIT`; `saveResult {ok:true}` |
| Happy | header | after `render(results, "Browse x at T")`, the next post carries `header === "Browse x at T"` |
| Edge (resource) | 3 dirty rows | every opened cursor is closed — assert the fake's open/close counts are equal (today: 3 opens, 0 closes) |
| Edge (failure/rollback) | statement 2 throws | `ROLLBACK` issued, no `COMMIT`, `saveResult {ok:false}` with the error, rows stay dirty |
| Edge (ambiguity) | two identical rows | `{ok:false, reason:"ambiguous_only"}` banner copy unchanged |
| Edge (remap) | message carries `serverIndexByRowId: {"4":3}` | `buildSaveStatements` receives a `Map([[4,3]])` **and** `ctidByRowId` keyed by rowId `4` |
| Edge (absent field) | message without `serverIndexByRowId` | identical behavior to today (back-compat with an older webview) |
| Edge (partial success) | builder returns `ok:true`, 1 statement, `skippedRows:[{rowId:7,reason:"no server row for UPDATE"}]` | posted `saveResult` has `ok:true` **and** `rowErrors === [{rowId:7, error:"no server row for UPDATE"}]`, so the webview keeps row 7 dirty |
| Edge (nothing skipped) | builder returns `ok:true`, `skippedRows` absent | `rowErrors` is absent/empty — a full success must not produce a phantom dirty row |
| R (A19-skip) | 2 dirty rows, row 7 skipped by the builder | today `saveResult` carries no `rowErrors`, the webview hits `editState.clear()` and row 7's edit is silently lost; after fix it stays dirty and the banner names it |
| R (A3) | corrected batched fake | today `all_failed` + N leaked cursors |
| R (A4) | post-save refresh on a batched driver | today no `state` posted at all |
| R (A14) | any post after `render()` | today `header === ""` |
| R (A15) | mid-batch failure | today statement 1 is committed and unrecoverable |

## Test Files

- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` (**fix the fake first** — it currently returns
  `{results:[{…}]}` unconditionally, which is why A3 was invisible; it must mirror
  `PostgresAdapter.runQuery`: a single `SELECT` with no `;` ⇒ `{results: [], batched}`)
- `src/ui/__tests__/resultsPanel.test.ts` (extend — header, transaction framing)

## Verification Commands

```bash
npm run typecheck
npm test -- src/ui/__tests__/resultsPanelSaveEdits.test.ts
npm test -- src/ui/__tests__/resultsPanel.test.ts
npm test -- src/ui/__tests__/resultsPanelRequery.test.ts
npm test -- src/adapters/__tests__/saveStatements.test.ts
npm test -- src/ui/__tests__/browseCommands.test.ts
```

## Acceptance Criteria

- [ ] All 15 cases pass; each regression case confirmed failing on `main` first (output in report).
- [ ] **No silently-skipped row (§3.4a):** every `skippedRows` entry from `buildSaveStatements` is
      forwarded as a `rowErrors` entry on the posted `saveResult`. Concretely — a save where the
      builder returns `ok:true` with a non-empty `skippedRows` MUST NOT reach the webview without
      `rowErrors`, because that path clears the user's edit as if it had been saved.
- [ ] **Fake correction is explicit:** the report states that the `runSql` fake in
      `resultsPanelSaveEdits.test.ts` now mirrors the real adapter contract (batched shape for a
      single `SELECT` without `;`) and that the A3 regression was observed failing against the
      corrected fake. Without this the regression test is worthless.
- [ ] No `\.results\[0\]` remains in `src/ui/resultsPanel.ts` — every run-result read goes through
      `pickResult`.
- [ ] Save statements execute as one transaction; `ROLLBACK` on the first failure; no `COMMIT`
      after a failure.
- [ ] `this.header` is assigned in `render()` and every subsequent post carries it.
- [ ] `buildSaveStatements` is called with `{ schema: parsed.schema, serverIndexByRowId, ctidByRowId }`.
- [ ] The host still ignores webview-supplied `tableName` / `pkColumns` (§7) — `serverIndexByRowId`
      is an index remap only and never widens what the host will address.
- [ ] `npm run typecheck` clean.

## Dependencies

- TASK-001 (`SaveStatementsOptions.schema` / `.serverIndexByRowId` and `SaveStatementsOk.skippedRows`
  must exist to compile)
- TASK-002 (`SaveEditsMessage.serverIndexByRowId` must exist on the message type)

## Interfaces

- Consumes:

```ts
// TASK-001 — src/core/saveStatements.ts
export interface SaveStatementsOptions {
  ctidByRowId?: ReadonlyMap<number, string>;      // KEYED BY rowId
  serverIndexByRowId?: ReadonlyMap<number, number>;
  schema?: string;
}
export interface SaveStatementsOk {
  ok: true; statements: string[]; warnings: string[];
  skippedRows?: ReadonlyArray<{ rowId: number; reason: string }>;   // NEW — forward to rowErrors
}
export function buildSaveStatements(
  dialect: Dialect, tableName: string, pkColumns: string[], columns: string[],
  edits: EditEntry[], serverRows: unknown[][], options?: SaveStatementsOptions,
): SaveStatementsResult;

// TASK-002 — src/ui/messages.ts
export interface SaveEditsMessage {
  type: "saveEdits"; index: number;
  edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
  tableName: string | null; pkColumns: string[];
  serverIndexByRowId?: Record<string, number>;
}

// existing — src/core/queryRunner.ts:402
export async function pickResult(runResult: RunResult): Promise<QueryResult>;

// existing, UNCHANGED — src/ui/messages.ts:121 (already consumed by the webview's
// clearExceptRowIds at webview/main.ts:2304; no webview edit needed for A19-skip)
rowErrors?: Array<{ rowId: number; error: string }>;
```

- Produces: `(none)` — no new exported API; behavior only.

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

**Stale-inventory note:** A1/A2 (the `__vsdb_browse__` ctid subquery wrap) and A18 no longer exist
at HEAD — cycle S (`8b58f24`) removed them. `parseFromClause` now receives plain
`SELECT * FROM "s"."t"` and resolves, so "statement #0 has no addressable table" is already gone.
Do not re-introduce a browse-time ctid wrap; the lazy save-time resolver is the shipped design.

**ctid key change is the subtle part.** `fetchPostgresCtids` currently does `map.set(i, …)` where
`i` is the index into `serverRows`, and `buildSaveStatements` looks up by `rowId`. Those were
accidentally equal before A12; they are not equal after it. Translate inside the panel
(`rowId → serverIndex` forward, `serverIndex → rowId` when populating the map) and assert it —
getting this backwards produces a *silent wrong-row update*, the worst failure mode in this file.

**Transaction shape:** send `BEGIN`, the statements, and `COMMIT` through the existing
`runner.runSql` path in a single call so the `max: 1` pool keeps one session. Issuing them as
separate `runSql` calls does not guarantee the same connection and would make the rollback a lie.

---

## Executor Report

### 2026-08-25 · executor · claude-sonnet-5

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: claude-sonnet-5
- EXECUTOR_SUBAGENT: -
- STATUS: DONE

**SUMMARY:** Fixed A3 (batched-cursor leak in `fetchPostgresCtids`), A4 (post-save refresh
never posted state on a batched driver), A12-host (ctid map + `serverIndexByRowId` now keyed
by `rowId`, not server-row-loop-index), A14 (`this.header` was never assigned in `render()`),
A15 (save statements now run as one atomic `BEGIN…COMMIT` combined `runSql` call, with
`ROLLBACK` on first failure), and A19-skip (`buildSaveStatements`' `skippedRows` is now
forwarded as `SaveResultMessage.rowErrors`). Also wired `schema` + `serverIndexByRowId` +
`ctidByRowId` into every `buildSaveStatements` call, and switched the post-commit refresh /
ctid-lookup reads to `pickResult()` (mirroring `handleRequery`'s existing pattern) so no
`.results[0]` remains in `resultsPanel.ts`.

**Fake correction (explicit, per acceptance criteria):** `makeRecordingRunner` in
`resultsPanelSaveEdits.test.ts` previously returned `{results:[{...}]}` unconditionally for
every `runSql` call, regardless of SQL shape — this is why A3 (`res.results[0]?.rows` against a
batched `{results:[], batched}` response) was invisible in the suite. It now mirrors
`PostgresAdapter.runQuery` / `shouldUseCursor`: a single `SELECT`/`WITH` statement with no `;`
boundary returns the batched cursor shape (`{results:[], batched:{fetchBatch,close,...}}`);
anything else (multi-statement text, e.g. the new `BEGIN;...;COMMIT;` transaction envelope, or
a non-SELECT) returns `{results:[...]}`. A new `makeBatchAwareRunner` helper (built on the same
`isSingleSelectNoSemicolon` routing rule) drives the new batched-fake tests and tracks
open/close counts. The A3 regression was observed FAILING against this corrected fake on the
pre-fix baseline (see RED output below — "ctid resolve via CORRECTED batched fake" test).

**TEST_PLAN_FOLLOWED:** task §"Test Cases (REQUIRED — TDD)" — all 15 rows implemented as
listed; several rows share one test where the underlying mechanism is identical (documented
below).

**FILES_CHANGED:**
- `src/ui/resultsPanel.ts`: `render()` now assigns `this.header`; `handleMessage`'s `saveEdits`
  case forwards `msg.serverIndexByRowId`; `handleSaveEdits` gained a 5th param
  (`serverIndexByRowId?`), builds a `Map<number,number>` from it, narrows ctid-resolution to
  only the rowIds that actually need one (excluding pure `__vsdb_new_row__` inserts), always
  passes `{ schema, serverIndexByRowId, ctidByRowId }` to `buildSaveStatements`, runs the whole
  statement batch as one combined `runner.runSql(BEGIN;...;COMMIT;)` call (dialect-aware
  keywords via new `transactionKeywords()` — plain `BEGIN/COMMIT/ROLLBACK` for
  postgres/mysql, `BEGIN/COMMIT/ROLLBACK TRANSACTION` for mssql), issues a best-effort separate
  `ROLLBACK` call on failure, refreshes via `pickResult()` + `runner.adopt()` (mirroring
  `handleRequery`), and forwards `built.skippedRows` as `rowErrors` on the `ok:true` ack.
  `fetchPostgresCtids` was redesigned to accept `rowIds: number[]` +
  `resolveServerIndex(rowId): number` instead of looping every `serverRows` index, uses
  `pickResult()` to read the (possibly batched) SELECT, and closes `res.batched` in a `finally`
  best-effort block; the result map is keyed by `rowId`.
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts`: fixed `makeRecordingRunner`'s fake to
  correctly route single-SELECT-no-semicolon SQL through the batched shape (`isSingleSelectNoSemicolon`
  helper); rewrote the old per-statement "partial failure" describe block into
  "partial failure / atomic batch (A15)" asserting single-combined-call transaction semantics;
  extended `saveResultAcks()`/added `stateMessages()` helpers; added a `makeBatchAwareRunner`
  helper and 8 new describe blocks (ctid-resolve-via-batched-fake, resource open/close-count,
  atomic-batch happy path, A12 remap, absent-`serverIndexByRowId` back-compat, skippedRows→
  rowErrors, full-success-has-no-phantom-rowErrors, post-save refresh on a batched driver).
- `src/ui/__tests__/resultsPanel.test.ts`: added a "header (A14)" describe block asserting the
  `render()` post AND a later `"ready"`-handshake post both carry the real header, not `""`.

**TESTS_ADDED:**
- `resultsPanelSaveEdits.test.ts`:
  - "ResultsPanel — partial failure / atomic batch (A15)" — atomic rollback on 2nd-statement failure (Edge failure/rollback; R-A15)
  - "ResultsPanel — ctid resolve via CORRECTED batched fake (Happy + R-A3)" — batched shape, keyed by rowId, cursor closed
  - "ResultsPanel — resource cleanup, 3 dirty rows (Edge — resource)" — open/close counts
  - "ResultsPanel — atomic batch happy path (Happy — atomic batch)" — exactly one BEGIN…COMMIT call, 2 statements, ok:true
  - "ResultsPanel — A12 remap via serverIndexByRowId (Edge — remap)" — `{"4":3}` resolves serverRows[3] not serverRows[4]
  - "ResultsPanel — no serverIndexByRowId field (Edge — absent field, back-compat)"
  - "ResultsPanel — skippedRows → rowErrors (Edge partial success / R A19-skip)"
  - "ResultsPanel — full success has no phantom rowErrors (Edge — nothing skipped)"
  - "ResultsPanel — post-save refresh on a batched driver (R-A4)"
- `resultsPanel.test.ts`:
  - "ResultsPanel — header (A14)" — render() post + later "ready" post both carry the real header (Happy — header; R-A14)
- Ambiguity case (`{ok:false, reason:"ambiguous_only"}`) and A3-original-invisible/A3-leak-count
  were already exercised by the pre-existing "fetchPostgresCtids correctness (important #1)"
  describe block once the fake was corrected — no separate new test needed; verified still
  green above.

**RED_OUTPUT (captured against the pre-fix baseline, restored via `git show HEAD:src/ui/resultsPanel.ts`
then swapped back after capture — no `git stash`/`checkout`/`commit` used):**

```
 ❯ src/ui/__tests__/resultsPanelSaveEdits.test.ts  (22 tests | 7 failed) 16ms
   ❯ ResultsPanel — partial failure / atomic batch (A15) > first UPDATE ok, second throws → ...
     → expected true to be false // Object.is equality
   ❯ ResultsPanel — ctid resolve via CORRECTED batched fake (Happy + R-A3) > ctid SELECT returns the batched shape ...
     → expected [ …(2) ] to have a length of 1 but got 2
   ❯ ResultsPanel — resource cleanup, 3 dirty rows (Edge — resource) > 3 dirty rows needing ctid ...
     → expected 3 to be 4 // Object.is equality
   ❯ ResultsPanel — atomic batch happy path (Happy — atomic batch) > 2 statements ⇒ exactly ONE BEGIN…COMMIT call ...
     → expected [] to have a length of 1 but got +0
   ❯ ResultsPanel — A12 remap via serverIndexByRowId (Edge — remap) > message carries serverIndexByRowId: {"4":3} ...
     → expected 'SELECT ctid FROM "t" WHERE "name" IS …' to match /'target'/
   ❯ ResultsPanel — skippedRows → rowErrors (Edge partial success / R A19-skip) > 1 row updates, 1 row (rowId 7) ...
     → expected undefined not to be undefined
   ❯ ResultsPanel — post-save refresh on a batched driver (R-A4) > refresh SQL is a single SELECT (batched) ...
     → expected [ [ 1, 'alice' ] ] to deeply equal [ [ 1, 'alice-2' ] ]
 ❯ src/ui/__tests__/resultsPanel.test.ts  (16 tests | 1 failed) 19ms
   ❯ ResultsPanel — header (A14) > render(results, "Browse x at T") → ... carry that header, not blank
     → expected '' to be 'Browse x at T' // Object.is equality

 Test Files  2 failed (2)
      Tests  8 failed | 30 passed (38)
```

Each failure matches the task's stated regression exactly: A15 (`ok` was `true` — statement 1
silently committed), A3 (2 ctid-lookup calls instead of the batched fake's 1 — meaning the
resolver never even reached the "closed" bookkeeping the corrected fake models), resource
open/close mismatch, atomic-batch call never combined (`[]` — zero `BEGIN` calls recorded), A12
remap read the wrong row (`'a'` instead of `'target'`), A19-skip `rowErrors` was `undefined`,
A4 refresh rows stayed stale (`'alice'` not `'alice-2'`), A14 header was `''`.

**VERIFICATION (all 6 commands, run fresh after restoring the fix):**

```
$ npm run typecheck
> tsc --noEmit
(clean, exit 0)

$ npm test -- src/ui/__tests__/resultsPanelSaveEdits.test.ts
 ✓ src/ui/__tests__/resultsPanelSaveEdits.test.ts  (22 tests) 10ms
 Test Files  1 passed (1)
      Tests  22 passed (22)

$ npm test -- src/ui/__tests__/resultsPanel.test.ts
 ✓ src/ui/__tests__/resultsPanel.test.ts  (16 tests) 15ms
 Test Files  1 passed (1)
      Tests  16 passed (16)

$ npm test -- src/ui/__tests__/resultsPanelRequery.test.ts
 ✓ src/ui/__tests__/resultsPanelRequery.test.ts  (10 tests) 5ms
 Test Files  1 passed (1)
      Tests  10 passed (10)

$ npm test -- src/adapters/__tests__/saveStatements.test.ts
 ✓ src/adapters/__tests__/saveStatements.test.ts  (23 tests) 7ms
 Test Files  1 passed (1)
      Tests  23 passed (23)

$ npm test -- src/ui/__tests__/browseCommands.test.ts
 ✓ src/ui/__tests__/browseCommands.test.ts  (16 tests) 5ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

**Full-suite regression check (`npm run compile` once, then `npm test`):**

```
 Test Files  84 passed | 1 skipped (85)
      Tests  1167 passed | 2 skipped (1169)
```

vs. wave-1 baseline (1158 passed / 2 skipped / 84 files) — net +9 new tests (8 in
`resultsPanelSaveEdits.test.ts`, 1 in `resultsPanel.test.ts`), zero regressions, zero new
skips.

**ISSUES:** none. One design decision made without a human to ask (per Handoff-mode autonomy
rule): dialect-aware transaction keywords — postgres/mysql use plain `BEGIN`/`COMMIT`/`ROLLBACK`;
mssql uses `BEGIN TRANSACTION`/`COMMIT TRANSACTION`/`ROLLBACK TRANSACTION` because plain `BEGIN`
in T-SQL is block syntax, not transaction syntax. No test case in the task's required 15
specifically exercises the mssql keyword branch (none of the 15 rows call for it), so this
branch is defensive/untested-by-name here — it reuses the same `runner.runSql` combined-call
path already covered for postgres, and `src/adapters/__tests__/saveStatements.test.ts` (owned
by TASK-001, unmodified) already covers mssql identifier quoting independently.

**HANDOFF_TO_REVIEWER:** yes — `handoff.reviewer.enabled` per `.ukit/storage/config.json`;
task status will be set to `pending_review` in `docs/AI_HANDOFF/INDEX.md` by the orchestrator
per the standard wave pipeline (this executor does not edit `INDEX.md` per task instructions).

**NEXT:** ready for review.

---
