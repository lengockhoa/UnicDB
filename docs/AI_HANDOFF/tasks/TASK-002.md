# TASK-002 — Save path resolves ctid lazily (single code path, covers deletes)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (lazy save path), §4 rows 5-9 & 12, §6 item 3

## Goal

In `handleSaveEdits` (resultsPanel.ts:335-591): with TASK-001 gone, no result set carries a host-added ctid column. Collapse the fast-path/fallback fork (lines 409-476) into ONE lazy resolver call — `fetchPostgresCtids` — invoked when `driver === "postgres" && pkColumns.length === 0` AND the edits contain at least one update-cell or delete-row marker (insert-only saves need no ctid). The resulting map feeds `buildSaveStatements` for updates AND deletes (TASK-003 contract).

## Target Files

- `src/ui/resultsPanel.ts` — replace lines 397-476 block with: compute `needsCtid = edits.some(e => !isNewRowMarkerShaped(e.value))` (delete markers + cell edits both qualify; reuse a local predicate consistent with `saveStatements.ts` marker shapes — simplest: `edits.some(e => !(typeof e.value === "object" && e.value !== null && "__vsdb_new_row__" in (e.value as object))))`). If `driver === "postgres" && pkColumns.length === 0 && needsCtid`: call `this.fetchPostgresCtids(tableName, parsed.schema, columns, serverRows)` once; on `!ok` post the existing refusal banner (`ambiguous_only` / `all_failed` variants — keep current copy strings at lines 437-439/461-463); on ok pass `{ ctidByRowId: map }` to `buildSaveStatements`. Non-PG or PK-present: pass `{}` as today. Also: a result-set column literally named `ctid` (user data) must NOT be trusted as row address — with the fast-path deleted this falls out naturally; add the regression test to lock it.
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — rewrite the three TASK-006 describe blocks (lines 645-961) per cases below; keep `fetchPostgresCtids correctness (important #1)` (line 410) and `ctid lookup returns >1 row` (line 502) blocks untouched.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug) | PG no-PK + edit + result set WITHOUT ctid column → lazy resolver used, save SUCCEEDS | recorded SQL has one `SELECT ctid FROM t WHERE name IS NOT DISTINCT FROM 'alice'` then `UPDATE t SET name='alice-2' WHERE ctid='(0,1)'`; success ack `ok:true`; NO "ctid lookup failed" banner | fixture mirrors existing line-819 test but fake returns 1-row ctid result `rows: [["(0,1)"]]` |
| 2 | happy | PG no-PK + DELETE marker → resolver consulted, ctid-DELETE emitted | recorded: ctid lookup SQL, then `DELETE FROM t WHERE ctid='(0,2)'` (TASK-003 path); ack ok | columns `["name"]`, rows `[["alice"],["bob"]]`, fake maps 2nd lookup to `(0,2)`; edits `[{rowId:1, colIndex:0, value:{__vsdb_deleted__:true,__rowId:1}}]` |
| 3 | edge (insert-only) | PG no-PK + ONLY a `__vsdb_new_row__` marker | NO ctid lookup SQL recorded; INSERT issued; ack ok | edits `[{rowId:0,colIndex:0,value:{__vsdb_new_row__:true,__rowId:0,values:["x"]}}]` |
| 4 | edge (user column named ctid) | result set HAS a column literally named `ctid` (user data) → host does NOT trust it | resolver SQL still issued; UPDATE `WHERE ctid='<resolver value>'`; the row-data value `(9,9)` never appears in any statement | columns `["name","ctid"]`, rows `[["alice","(9,9)"]]`, fake resolver returns `(0,1)` |
| 5 | edge (ambiguity) | resolver returns >1 match for a row | refusal ack `ok:false` with ambiguous reason string; NO UPDATE/DELETE issued | existing ambiguity fixture shape (line 502) extended to the collapsed path |
| 6 | happy (existing, kept) | PK-present PG save | no resolver SQL, UPDATE `WHERE id=…` | existing test at line 964, unchanged |

## Test Files

- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — all 6 cases.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/resultsPanelSaveEdits.test.ts
```

## Acceptance Criteria

- [ ] All 6 Test Cases PASS (case 4 is RED against current code — the fast path trusts a user `ctid` column today; cases 1-2 lock the collapsed lazy path).
- [ ] No reference to a result-set `ctid` fast-path remains in `src/ui/resultsPanel.ts`.
- [ ] Refusal banner copy strings unchanged (`ambiguous_only` / `all_failed` variants).
- [ ] `npm run typecheck` clean.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-003 (interface: `ctidByRowId` now consumed for delete rows — build the map before wiring deletes; TASK-001 is NOT a hard dependency since resultsPanel.ts is untouched there, but the collapsed path assumes no producer of ctid columns, so land TASK-001 in the same or earlier wave).

## Interfaces

- Consumes: `fetchPostgresCtids(tableName, schema, columns, serverRows)` (own class method, resultsPanel.ts:759-808 — keep NULL-safe `IS NULL` / `IS NOT DISTINCT FROM` matching untouched); TASK-003's `ctidByRowId` DELETE consumption in `buildSaveStatements`.
- Produces: final save-flow contract — PG no-PK saves (updates + deletes) resolve ctids in one lazy pass at save time; no other task depends on this file afterward.

---

## Discussion

### 2026-08-25 · planner · unic/unic-smart
If executing before TASK-001 lands: case 1 still passes standalone (no ctid column in fixture ⇒ same observable). The only true ordering constraint is vs TASK-003 (map contract for deletes). Wave 2.
---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
