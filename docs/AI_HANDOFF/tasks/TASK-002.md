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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: feature-implementer

### Summary

Collapsed the no-PK save-time ctid resolver in `handleSaveEdits` (resultsPanel.ts lines 397–476) into ONE lazy resolver call. The fast-path that trusted a result-set `ctid` column is gone — the host no longer appends one (TASK-001) and a user-named column called `ctid` is data, not a row address. The resolver runs only when driver is `postgres`, PK is empty, and at least one edit is NOT a pure `__vsdb_new_row__` marker; pure INSERT saves skip it entirely. Refusal banner copy (`ambiguous_only` / `all_failed`) is preserved verbatim. The three TASK-006 describes that asserted the old fast-path behaviour were rewritten as TASK-002 cases 1–4; cases 5 (ambiguity) and 6 (PK-present) are kept at their existing locations.

### RED_OUTPUT (against pre-fix `resultsPanel.ts` on wave-1 base)

```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002

❯ src/ui/__tests__/resultsPanelSaveEdits.test.ts  (14 tests | 2 failed) 10ms
  ❯ ... > ResultsPanel — insert-only PG no-PK skips resolver (TASK-002 case 3)
      > PG no-PK + ONLY a __vsdb_new_row__ marker → NO ctid lookup SQL; INSERT issued; ack ok
      → expected undefined not to be undefined
  ❯ ... > ResultsPanel — user column named `ctid` is NOT trusted (TASK-002 case 4)
      > result set HAS a column literally named `ctid` (user data) → host does NOT trust it
      → expected 'UPDATE t SET name=\'alice-2\' WHERE c…' to match /ctid='\(0,1\)'/

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

FAIL ... > insert-only PG no-PK skips resolver (TASK-002 case 3) > ...
AssertionError: expected undefined not to be undefined
 ❯ src/ui/__tests__/resultsPanelSaveEdits.test.ts:913:17
    911|     // INSERT was issued.
    912|     const ins = recorded.find((c) => /INSERT\s+INTO/i.test(c.sql));
    913|     expect(ins).toBeDefined();

FAIL ... > user column named `ctid` is NOT trusted (TASK-002 case 4) > ...
AssertionError: expected 'UPDATE t SET name=\'alice-2\' WHERE c…' to match /ctid='\(0,1\)'/
- Expected: /ctid='\(0,1\)'/
+ Received: "UPDATE t SET name='alice-2' WHERE ctid='(9,9)'"
 ❯ src/ui/__tests__/resultsPanelSaveEdits.test.ts:996:25
    994|     const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    995|     expect(update).toBeDefined();
    996|     expect(update!.sql).toMatch(/ctid='\(0,1\)'/);

Test Files  1 failed (1)
     Tests  2 failed | 12 passed (14)
```

Cases 1 and 2 were already GREEN against the pre-fix code (consistent with the planner's note "case 1 still passes standalone"); cases 3 and 4 are the genuine RED that drove the collapsed-path implementation.

### Verification Output (after implementation)

`npx vitest run src/ui/__tests__/resultsPanelSaveEdits.test.ts`:

```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002

✓ src/ui/__tests__/resultsPanelSaveEdits.test.ts  (14 tests) 7ms

Test Files  1 passed (1)
     Tests  14 passed (14)
  Start at  08:30:00
  Duration  263ms (transform 88ms, setup 0ms, collect 95ms, tests 7ms, environment 0ms, prepare 31ms)
```

`npm run typecheck`:

```
> vsdb@1.6.2 typecheck
> tsc --noEmit

(no diagnostics, exit code 0)
```

### Files Changed (worktree .worktrees/task-002)

- `src/ui/resultsPanel.ts` — replaced the fast-path / fallback fork (lines 397–476) with a single lazy resolver call gated by `needsCtid = driver === "postgres" && pkColumns.length === 0 && edits.some(e => !(marker-shaped))`. Refusal banner copy (`ambiguous_only` / `all_failed`) preserved verbatim. No remaining reference to the result-set `ctid` fast-path or `ctidColIdx`.
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — replaced the three TASK-006 describe blocks (`— no-PK hidden ctid column (TASK-006 #1)`, `— no-PK regression (TASK-006 #2)`, `— no-PK fallback to fetchPostgresCtids (TASK-006 #3)`, `— partial ctid in row data (TASK-006 #4)`) at lines 645–961 with the four new TASK-002 case describes (case 1 PG-no-PK lazy resolver + edit, case 2 DELETE-marker resolver, case 3 insert-only skips resolver, case 4 user column named `ctid` not trusted). `fetchPostgresCtids correctness (important #1)` (case 5 ambiguity), `ctid lookup returns >1 row`, and `— PK table does NOT use ctid (TASK-006 #6)` (case 6) are untouched.

### Acceptance Criteria

- [x] All 6 Test Cases PASS (cases 1, 2, 5, 6 were already green; cases 3, 4 became GREEN only after the lazy-ctid collapse).
- [x] No reference to a result-set `ctid` fast-path remains in `src/ui/resultsPanel.ts` (grep `ctidColIdx` → 0 hits in the file).
- [x] Refusal banner copy strings unchanged (`ambiguous_only` / `all_failed` variants at the new single-bail-out site).
- [x] `npm run typecheck` clean.
- [ ] Reviewer verdict (pending).

Status: PASS
Note: none
