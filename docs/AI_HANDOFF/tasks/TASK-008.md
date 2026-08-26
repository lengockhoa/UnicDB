# TASK-008 — Save/core hardening: NULL-PK rows skipped, batched first-fetch errors surfaced

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (post-audit reconciliation), §3.5

## Goal

Close the two confirmed core-layer defects the Cycle X audits located: `buildSaveStatements` emits `WHERE pk = NULL` (matching zero rows, acknowledged as a successful save — the edit is silently lost), and `pickResult`'s batched branch swallows the cursor's first `fetchBatch` error into an empty grid, so a failed query is indistinguishable from an empty table.

Audit sources: `docs/AI_HANDOFF/notes/cycle-x-audit-host.md` finding S1 (TASK-001, done) and `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md` finding P2-2 (TASK-002, done; cross-listed to the core owner so the fix has a single owner).

## Target Files

- `src/core/saveStatements.ts` — **S1**: both PK `WHERE` builders interpolate `sqlLiteral(serverRow[i])` unconditionally, so a NULL PK value yields `WHERE "id"=NULL`.
  - UPDATE builder at `:645-665` (the `for (const pk of pkColumns)` loop that pushes into `whereParts` and then emits `UPDATE ${qTable} SET … WHERE …`).
  - DELETE builder at `:511-530` (same loop shape, emitting `DELETE FROM ${qTable} WHERE …`).
  - In each loop, when the resolved `serverRow[i]` is `null` or `undefined`, take the existing skip path instead of pushing a `WHERE` part: set `whereOk = false`, push the reason onto `warnings`, and push `{ rowId, reason }` onto `skippedRows` with reason text containing `pk column NULL in server row` plus the column name. **No statement may be emitted for that row.** Reuse the surrounding `whereOk`/`breakReason` mechanism already in both loops — do not invent a second skip channel.
- `src/core/queryRunner.ts` — **P2-2**: `pickResult`'s batched branch (`:426-440`) wraps the initial `await runResult.batched.fetchBatch()` in `try { … } catch { /* ignore */ }` and returns `rows: []`. Rethrow from that catch so the error reaches the existing error handling: `QueryRunner.executeAll`'s `catch` (`:218-224`, sets `status:"error"` + `error`) and `ResultsPanel.handleRequery`'s error branch (`resultsPanel.ts:1267-1303`). Do not change `pickResult`'s signature or its `rowCount: null` contract for batched results.
- `src/adapters/__tests__/saveStatements.test.ts` — S1 cases (this is the existing home of `buildSaveStatements` unit tests despite living under `adapters/__tests__`).
- `src/core/__tests__/queryRunner.test.ts` — P2-2 cases.

Ownership: no other Cycle X task modifies `src/core/saveStatements.ts`, `src/core/queryRunner.ts`, or these two test files.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy (regression, S1) | NULL PK on UPDATE skips the row and emits nothing | `result.statements` has length `0`; `result.skippedRows` contains one entry for that `rowId` whose `reason` matches `/pk column NULL in server row/` and names `id`; `result.warnings` carries the same reason. RED today: one `UPDATE "t" SET "v"='x' WHERE "id"=NULL` is emitted and `skippedRows` is empty. | `buildSaveStatements("postgres","t",["id"],["id","v"],[{rowId:0,colIndex:1,value:"x"}],[[null,"old"]])` |
| 2 | edge — partial batch / ordering (S1) | Only the NULL-PK row is skipped | Exactly one statement is emitted, and it is the UPDATE for the row whose `id` is `1`; `skippedRows` has exactly one entry, for the NULL-PK `rowId`; the emitted SQL contains no `=NULL`. | Two server rows `[[1,"a"],[null,"b"]]`, one dirty cell in each |
| 3 | edge — composite key / boundary (S1) | Composite PK with one NULL component is skipped whole | No statement is emitted; the single `skippedRows` reason names the NULL component (`b`), not the non-NULL one (`a`); a control row with both components non-NULL still emits its UPDATE. | `pkColumns:["a","b"]`, server rows `[[1,null,"x"],[1,2,"y"]]` |
| 4 | edge — different statement kind (S1) | NULL PK on DELETE is skipped too | A delete-marked row whose PK is NULL emits **no** `DELETE`, and `skippedRows` carries the same NULL-PK reason — proving the fix is in both builders, not only the UPDATE path. | delete-marker edit on a server row with NULL `id` |
| 5 | regression (S1) | Falsy-but-present PK values still address rows | PK values `0`, `""` and `false` each emit a normal `WHERE` term (`"id"=0`, `"id"=''`, `"id"=false` per `sqlLiteral`) and are **not** skipped — the guard tests `null`/`undefined` only. | three single-row cases | 
| 6 | happy (regression, P2-2) | Initial `fetchBatch` rejection propagates from `pickResult` | `await expect(pickResult({ results: [], batched })).rejects.toThrow(/cursor exploded/)`. RED today: it resolves to `{ rows: [], rowCount: null }`. | `batched.fetchBatch` = `vi.fn().mockRejectedValue(new Error("cursor exploded"))` |
| 7 | edge — end-to-end status (P2-2) | A failing first fetch marks the statement `error`, not `done` | After `runner.run([stmt("SELECT * FROM t",0,16)], () => {})`, `results[0].status === "error"` and `results[0].error` contains `cursor exploded`; `results[0].result` carries no rows presented as success. RED today: `status:"done"` with `rows: []`. | adapter returning `{ results: [], batched }` whose first `fetchBatch` rejects |
| 8 | edge — empty vs failed boundary (P2-2) | A genuinely empty cursor is still a success | `fetchBatch` resolving `null` (EOF, no rows) still yields `status:"done"`, `result.rows` `[]` and `result.rowCount === null` — the fix must not turn empty results into errors. | adapter returning a batched cursor whose first `fetchBatch` resolves `null` |

## Test Files

- `src/adapters/__tests__/saveStatements.test.ts` — cases 1–5 (plain node vitest; pure-function style already established in this file).
- `src/core/__tests__/queryRunner.test.ts` — cases 6–8 (plain node vitest; existing `makeAdapter`/`makeBatched`/`stmt` helpers at `:20-40`).

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/saveStatements.test.ts src/core/__tests__/queryRunner.test.ts
npx vitest run src/adapters/__tests__/saveStatementsInline.test.ts src/adapters/__tests__/saveStatementsParser.test.ts src/adapters/__tests__/saveStatementsQualify.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsPanelDistinctValues.test.ts
npm run typecheck
```

Both suites are plain node tests with no bundle dependency, so `npm run compile` is not required for this lane. The second command is the regression lane: the three sibling `saveStatements*` suites pin the builder's other contracts, and the three `resultsPanel*` suites are `pickResult`'s live consumers — `resultsPanelDistinctValues` matters because `handleRequestDistinctValues` (`resultsPanel.ts:977`, `:993`) also calls `pickResult` and now sees a throw instead of empty rows (its `catch` at `:998-1003` already replies with `error`). `package.json` defines no lint script — `typecheck` is the static gate (PLAN §5).

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; cases 1, 4, 6 and 7 were demonstrated RED before the production edit.
- [ ] Neither PK `WHERE` builder can emit `=NULL`; a NULL/undefined PK value always produces a `skippedRows` entry with a reason containing `pk column NULL in server row` and the offending column name, plus a matching `warnings` entry.
- [ ] Falsy-but-present PK values (`0`, `""`, `false`) are unaffected.
- [ ] `pickResult` rethrows the initial `fetchBatch` error; an EOF-`null` first fetch still yields an empty successful result with `rowCount === null`.
- [ ] `pickResult`'s signature and the batched `rowCount: null` contract are unchanged.
- [ ] `src/ui/**`, `webview/**`, and `src/adapters/*.ts` (production adapters) are unmodified by this task.
- [ ] The regression verification command exits 0; any assertion change is limited to expectations the fixed behavior invalidates and is listed in the Executor Report. `src/core/__tests__/queryRunner.test.ts:228-231` ("pickResult swallows the initial fetch error…") is a known comment/assertion that documents the OLD behavior and may need updating — the surrounding cancel-path assertion `expect(["cancelled","done"]).toContain(...)` must be re-examined, not silently loosened.
- [ ] `npm run typecheck` exits 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — host/adapter audit gate (done); source of S1.
- TASK-002 — grid/UI audit gate (done); source of P2-2, cross-listed to this core owner.

Both dependencies are already complete, so this task is schedulable in Wave 2 alongside TASK-003, TASK-004 and TASK-006.

## Interfaces

- Consumes (existing, unchanged — quoted from source):
  - `buildSaveStatements(dialect: Dialect, tableName: string, pkColumns: string[], columns: string[], edits: EditEntry[], serverRows: unknown[][], options?: SaveStatementsOptions): SaveStatementsResult` (`src/core/saveStatements.ts:309-317`), whose result carries `skippedRows?: ReadonlyArray<{ rowId: number; reason: string }>` (`:105`) and `warnings`.
  - `quoteIdent(name: string, dialect: Dialect): string` (`src/core/saveStatements.ts:136`) and `sqlLiteral`.
  - `pickResult(runResult: RunResult): Promise<QueryResult>` (`src/core/queryRunner.ts:423`); `RunResult.batched?: BatchedQuery` (`src/adapters/types.ts:78`).
- Produces: no new exported symbol. Behavioural contracts other tasks rely on:
  - a NULL PK value never reaches SQL; the affected row surfaces through `skippedRows`, which `ResultsPanel.handleSaveEdits` already forwards to the webview as `rowErrors` (`resultsPanel.ts:826-832`), so those rows stay dirty and retryable;
  - a failed initial cursor fetch surfaces as a rejected `pickResult`, so `QueryRunner.executeAll` marks the statement `error` and `ResultsPanel.handleRequery` renders the error panel instead of a false empty grid.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Reconciliation gate notes.

1. **Single owner for P2-2.** The grid/UI audit filed P2-2 but marked it "TASK-001 coordination — do not double-fix" because `queryRunner.ts` is core territory. It is assigned here, to the task that owns `src/core/queryRunner.ts`; TASK-006 and TASK-007 must not touch it.
2. **Blast radius of the rethrow.** `pickResult` has five production call sites: `queryRunner.ts:193` (`executeAll`, already inside a `catch` that sets `status:"error"`), `resultsPanel.ts:771` (auto-save refresh — the surrounding `catch` at `:835-851` rethrows in non-manual mode, which is the pre-existing behavior TASK-006's cursor-close fix makes far less likely to trigger), `:977`/`:993` (distinct values — its own `catch` replies with `error`, exactly what P2-3 wants surfaced), `:1208` (`handleRequery` — dedicated error branch), and `:1393` (ctid probe — per-row `try/catch`). Every one already has an error path, so the rethrow lands in existing handling rather than creating unhandled rejections. Case 7 plus the regression lane verify this.
3. **S1 reachability.** A NULL PK is impossible under a real PRIMARY KEY constraint; the audit reached it via a JOIN whose PK metadata resolved to a different table (`parseFromClause` picks the first FROM candidate) or a view that NULLs the PK column. The fix is a guard in the pure builder — no metadata-resolution change is in scope here.
4. **Non-goals.** M1/M3 (mysql adapter) belong to TASK-005; M2, the pg-metadata-vs-manual-window item, and C1 are queued in `INDEX.md`. Do not widen this task to them.

---
