# TASK-003 — Grid model: duplicate column names must not collapse onto one field

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (in-scope A17) — §7 Global Constraints applies by reference

## Goal

Fix A17. `inferColumns` (`src/ui/resultsGridModel.ts:74-104`) resolves each column's data index
with `columns.indexOf(name)`, which returns the **first** match. AG Grid then keys rows on
`field`, so `SELECT a.id, b.id` renders both columns from data index 0 and any edit on the second
one addresses the first. Produce unique `field` values while keeping `headerName` as the raw
column name, and use the loop index — never `indexOf` — as the data index.

## Target Files

- `src/ui/resultsGridModel.ts`
- `src/ui/__tests__/resultsGridModel.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | distinct names | `inferColumns(["a","b"], rows)` → fields `["a","b"]`, `headerName` identical |
| Happy | kind inference intact | numeric second column still infers `kind:"number"`, `alignRight:true` |
| Edge (duplicate) | `["id","id"]` | fields `["id","id__2"]`; both `headerName === "id"` |
| Edge (triple + collision bait) | `["id","id","id__2"]` | all three fields unique, no field equals another |
| Edge (empty) | `inferColumns([], [])` | `[]`, no throw |
| R (A17) | `["id","id"]` with rows `[[1,2]]` | second spec must resolve value `2`; today both resolve `1` |

## Test Files

- `src/ui/__tests__/resultsGridModel.test.ts` (extend)

## Verification Commands

```bash
npm run typecheck
npm test -- src/ui/__tests__/resultsGridModel.test.ts
npm test -- src/ui/__tests__/resultsGridModelEdit.test.ts
npm test -- src/ui/__tests__/resultsGridModelExport.test.ts
npm test -- src/ui/__tests__/resultsGridModelRequery.test.ts
npm test -- src/ui/__tests__/agGridSmoke.test.ts
```

## Acceptance Criteria

- [ ] All 6 cases pass; the regression case confirmed failing on `main` first (output in report).
- [ ] `inferColumns` contains no `columns.indexOf(...)`.
- [ ] `field` is unique across the returned specs for any input; `headerName` always equals the
      original column name.
- [ ] De-dup suffix cannot itself collide (a pre-existing `id__2` in the input is handled).
- [ ] Export serializers (`serializeCsv` / `serializeSqlInserts` / `serializeWhereClause`) still
      emit the **original** column names, not suffixed fields — covered by the existing export
      tests staying green.
- [ ] `npm run typecheck` clean; no file outside Target Files touched.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)`
- Produces:

```ts
export interface ColumnSpec {
  field: string;       // now guaranteed unique within one result set
  headerName: string;  // raw column name, may repeat
  kind: ColumnKind;
  alignRight?: boolean;
  hidden?: boolean;
}
export function inferColumns(columns: string[], rows: unknown[][]): ColumnSpec[];
```

`webview/main.ts` (TASK-002) consumes specs positionally —
`specs.forEach((s, j) => obj[s.field] = rows[i][j])` at `webview/main.ts:397` — so a suffixed
field stays correctly aligned with no webview change.

The one place that is **not** positional — `hiddenColumns`, built from `s.field` at
`webview/main.ts:2110-2113` and matched against raw `result.columns` — is fixed by **TASK-002**,
which owns that file in this wave. Do not touch it here.

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

Verified at HEAD: `inferColumns` no longer hides columns named `ctid` (defect A18 was fixed by
cycle S), so this task is A17 only — do not re-add or re-remove any `ctid` special-casing.

**Consumer-side coupling is TASK-002's job, not yours** (clarified in review round 1). Making
`field` unique breaks any consumer that maps a spec back to a *database* column by `field` — the
known one is `hiddenColumns` (`webview/main.ts:2110-2113`) plus the Ctrl+C hidden-column filter,
both of which must switch to `headerName`. That file belongs to TASK-002 in this same wave, so
this task must **not** edit it; TASK-002 carries the acceptance line and the duplicate-name test.
If you find a *further* `field`-as-database-name consumer inside `src/ui/resultsGridModel.ts`
(this task's own file), fix it here and note it in this thread.

---
