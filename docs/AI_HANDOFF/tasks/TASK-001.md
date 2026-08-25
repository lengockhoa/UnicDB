# TASK-001 -- keepIndices duplicate-column export bug fix

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.1

## Goal

Fix the duplicate-column export bug: when two columns share the same raw name (e.g. `SELECT a.id, b.id`), hiding one currently hides both because `keepIndices()` filters by name. The fix adds a positional `hiddenIndices?: number[]` field to `SerializeOptions`. When present, serializers compute visible-column indices directly from positions, bypassing the name-based `keepIndices()` entirely. The existing `keepIndices` function signature is NOT changed -- all 5 existing call sites remain valid.

## Target Files

- `src/ui/resultsGridModel.ts` (existing, 1134 lines) -- add `hiddenIndices?: number[]` to `SerializeOptions` interface; each serializer (`serializeTsv`, `serializeCsv`, `serializeXml`, `serializeJson`, `serializeSqlInserts`, `serializeSqlUpdates`, `serializeWhereClause`) checks `opts.hiddenIndices` first and computes indices from positions when present, falling back to existing `keepIndices` name-based path when absent
- `src/ui/__tests__/resultsGridModelExport.test.ts` (existing) -- add tests for positional hiddenIndices behavior

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `serializeJson with hiddenIndices hides only specified positions` | `{"columns":["id__2","name"],"rows":[[2,"x"]]}` | columns=`["id","id__2","name"]`, rows=`[[1,2,"x"]]`, hiddenIndices=`[0]` |
| 2 | unit | `serializeJson with hiddenIndices preserves duplicate columns` | `{"columns":["id","name"],"rows":[[1,"x"]]}` | columns=`["id","id","name"]`, rows=`[[1,1,"x"]]`, hiddenIndices=`[1]` |
| 3 | unit | `hiddenIndices takes precedence over hiddenColumns` | Positional filtering applied, names ignored | Both hiddenIndices and hiddenColumns supplied |
| 4 | edge | `hiddenIndices empty array` | No filtering, all columns preserved | hiddenIndices=`[]` |
| 5 | edge | `hiddenIndices out of range` | Invalid indices skipped, valid ones filtered | hiddenIndices=`[0,99]` on 3-col array |
| 6 | regression | `hiddenColumns still works when hiddenIndices absent` | Name-based filtering unchanged (backward compat) | columns=`["id","id"]`, hiddenColumns=`["id"]`, no hiddenIndices |

## Test Files

- `src/ui/__tests__/resultsGridModelExport.test.ts` -- add `"hiddenIndices positional"` describe block

## Verification Commands

```bash
npm test src/ui/__tests__/resultsGridModelExport.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] `SerializeOptions` has optional `hiddenIndices?: number[]` field
- [ ] When `hiddenIndices` is present, serializers use positional filtering (by array index)
- [ ] When `hiddenIndices` is absent, existing `keepIndices` name-based path is unchanged
- [ ] Existing `keepIndices(columns, hiddenColumns)` function signature is NOT modified -- zero call-site breakage
- [ ] All serializers (TSV/CSV/XML/JSON/SQL-inserts/SQL-updates/SQL-where) handle both paths
- [ ] All existing export tests still pass
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: existing `SerializeOptions` interface, existing `keepIndices(columns: string[], hiddenColumns?: string[])` function (unchanged)
- Produces: `SerializeOptions.hiddenIndices?: number[]`; serializers check `opts.hiddenIndices` first, compute visible-column index array directly when present, fall back to `keepIndices` when absent

---

## Discussion

(chua co comment)
