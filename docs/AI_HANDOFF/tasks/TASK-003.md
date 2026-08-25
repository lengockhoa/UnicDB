# TASK-003 — Postgres no-PK DELETE via lazily-resolved ctid

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (DELETE branch), §4 rows 9-11, §6 item 4

## Goal

In `buildSaveStatements`, the delete-marker branch (saveStatements.ts:344-374) currently `continue`s when `pkColumns.length === 0` — postgres no-PK deletes are silently dropped. Add: when dialect is postgres and `options.ctidByRowId` has the row, emit `DELETE FROM <t> WHERE ctid='<literal>'` (+ concurrency warning), mirroring the UPDATE ctid branch (lines 474-496).

## Target Files

- `src/core/saveStatements.ts` — delete-marker loop: after the existing `if (pkColumns.length === 0) continue;` guard, restructure to `if (pkColumns.length === 0) { if (dialect === "postgres") { …ctid delete… } continue; }`. Missing ctid → `warnings.push("delete row N skipped: postgres no-PK + missing ctid")` and skip. Update the `SaveStatementsOptions` doc comment (line 54-58) to mention DELETE usage.
- `src/adapters/__tests__/saveStatements.test.ts` — new describe block beside the existing markers block (line 195).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | PG no-PK + delete marker + ctid in map → `DELETE FROM t WHERE ctid='(0,2)'` | `r.ok === true`, exactly 1 statement, `stmt` matches `/^DELETE FROM t WHERE ctid='\(0,2\)'/i`, warnings include the concurrency note (`not safe under concurrent writes`) | `buildSaveStatements("postgres","t",[],["id","name"],[marker],serverRows,{ctidByRowId:new Map([[7,"(0,2)"]])})`, marker `rowId 7` `__vsdb_deleted__` (fixture mirrors existing test at line 219) |
| 2 | edge (missing key) | PG no-PK + delete marker + rowId NOT in map | 0 statements, warning `delete row 7 skipped: postgres no-PK + missing ctid`, `r.ok === true` | same but empty `ctidByRowId` map |
| 3 | edge (dialect boundary) | mysql no-PK + delete marker + (irrelevant) map | 0 statements, NO delete emitted, no throw — existing skip semantics preserved | `buildSaveStatements("mysql","t",[],["a"],[marker],[["x"]],{ctidByRowId:new Map([[0,"(0,1)"]])})` |
| 4 | happy | PG no-PK + delete + update mixed in one save | 1 ctid-DELETE + 1 ctid-UPDATE, ordered deletes-then-updates (loop order preserved) | edits: `[deleteMarker(row 1), cellEdit(row 0)]`, `serverRows` for both |

## Test Files

- `src/adapters/__tests__/saveStatements.test.ts` — all 4 cases (follow existing `expectNoPlaceholders` helper usage).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/adapters/__tests__/saveStatements.test.ts
```

## Acceptance Criteria

- [ ] All 4 Test Cases PASS (case 1 RED against current code — run first).
- [ ] PK-present delete path byte-identical to before (existing test at line 219 still green).
- [ ] `npm run typecheck` clean.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: existing `SaveStatementsOptions.ctidByRowId?: ReadonlyMap<number, string>` (saveStatements.ts:54-58) — no signature change.
- Produces: `buildSaveStatements` now consumes `ctidByRowId` for DELETE rows when `dialect === "postgres"`. TASK-002 (resultsPanel.ts) must pass a ctid map covering delete-rowIds too, or those deletes are skipped with warnings — contract is exactly the map TASK-002 builds.

---

## Discussion

### 2026-08-25 · planner · unic/unic-smart
Wave 1 sibling of TASK-001 (disjoint files). TASK-002 depends on this contract, not on its code landing first — but resultsPanel.ts is where both meet, so TASK-002 is sequenced after both to avoid a same-file clash with nothing (TASK-001 does not touch resultsPanel.ts; the dependency on TASK-003 is a true interface dependency).

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 ❯ src/adapters/__tests__/saveStatements.test.ts  (16 tests | 3 failed) 9ms
   ❯ buildSaveStatements — Add Row / Delete Row markers > PG no-PK + delete marker + ctid in map → DELETE FROM t WHERE ctid='(0,2)'
     → expected [] to have a length of 1 but got +0
   ❯ buildSaveStatements — Add Row / Delete Row markers > PG no-PK + delete marker + rowId NOT in ctid map → 0 stmts + warning
     → expected false to be true // Object.is equality
   ❯ buildSaveStatements — Add Row / Delete Row markers > PG no-PK + delete + update mixed in one save → 1 ctid-DELETE + 1 ctid-UPDATE, ordered deletes-then-updates
     → expected [ Array(1) ] to have a length of 2 but got 1

  Test Files  1 failed (1)
       Tests  3 failed | 13 passed (16)
```
Three RED cases (PG happy, PG missing-ctid, PG mixed); the 4th case (mysql boundary)
requires a contract clarification — see Note.

Verification Output (post-impl):
```
$ npx vitest run src/adapters/__tests__/saveStatements.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-003
 ✓ src/adapters/__tests__/saveStatements.test.ts  (16 tests) 5ms
 Test Files  1 passed (1)
      Tests  16 passed (16)

$ npm run typecheck
> vsdb@1.6.2 typecheck
> tsc --noEmit
(clean — exit 0)
```

Status: PASS
Note: Case 3 (mysql no-PK + delete marker) — task spec says "0 statements, NO delete emitted, no throw — existing skip semantics preserved" but the *current* code returns `ok:false, reason:"no_pk"` for any mysql/mssql no-PK call (the cell-edits-loop no_pk guard fires after the delete-marker loop). Test was written against actual existing semantics (`r.ok === false, reason === "no_pk"`, no DELETE emitted, no throw) — the spec's implicit "r.ok === true" was inconsistent with "existing skip semantics". PK-present delete (existing test at line 219) byte-identical to before — still passes. Doc comment on `SaveStatementsOptions` (lines 54-58) updated to mention DELETE branch usage. No changes outside Target Files.
