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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (step 1 - tests written first, run BEFORE implementation):

Command: npm test src/ui/__tests__/resultsGridModelExport.test.ts

    Test Files  1 failed (1)
          Tests  5 failed | 41 passed (46)
       Start at  18:38:36
       Duration  549ms

Failing tests (all 5 are the new hiddenIndices cases):

    FAIL ... hiddenIndices positional > 1. serializeJson with hiddenIndices hides only specified positions
    FAIL ... hiddenIndices positional > 2. serializeJson with hiddenIndices preserves duplicate columns
    FAIL ... hiddenIndices positional > 3. hiddenIndices takes precedence over hiddenColumns
      AssertionError: expected '{"columns":["id","id__2"],"rows":[[1,2]]}' to be
                       '{"columns":["id__2","name"],"rows":[[2,"x"]]}'
      at src/ui/__tests__/resultsGridModelExport.test.ts:685:17
    FAIL ... hiddenIndices positional > 5. hiddenIndices out of range -> invalid indices skipped, valid filtered
      AssertionError: expected '{"columns":["id","name","active"],"rows":[[1,"x",true]]}' to be
                       '{"columns":["name","active"],"rows":[["x",true]]}'
      at src/ui/__tests__/resultsGridModelExport.test.ts:701:17
    FAIL ... hiddenIndices positional > 7. every serializer applies positional hiddenIndices (TSV/CSV/XML/SQL)
      AssertionError: expected 'id\tid\tname\n9\t1\tx' to be 'id\tname\n1\tx'
      at src/ui/__tests__/resultsGridModelExport.test.ts:724:44

Tests 4 (empty array -> no filtering) and 6 (regression: hiddenColumns name
path unchanged) passed pre-implementation by design: they assert pre-existing
behavior, which is correct for an additive optional field. The run as a whole
is RED for the new behavior: 5 failed.

Verification Output:

Command 1: npm test src/ui/__tests__/resultsGridModelExport.test.ts  (after implementation)

     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-001
     OK   src/ui/__tests__/resultsGridModelExport.test.ts  (46 tests) 270ms

    Test Files  1 passed (1)
          Tests  46 passed (46)
       Start at  18:41:09
       Duration  1.30s (transform 93ms, setup 0ms, collect 698ms, environment 0ms, prepare 89ms)

Command 2: npm test  (full suite; first attempt failed on 2 pre-existing
missing-dist/ artifact tests - dist/schemaForm.js and dist/webview.css - so
per instructions `npm run compile` was run once, then the suite retried)

    npm run compile:
      dist/webview.js.map    3.9mb
      dist/webview.css.map  36.7kb
      Done in 134ms
      esbuild: build complete

    npm test (after compile):
      Test Files  85 passed | 1 skipped (86)
           Tests  1266 passed | 2 skipped (1268)
        Start at  18:40:44
        Duration  10.59s (transform 3.27s, setup 5ms, collect 9.00s, tests 43.80s, environment 14.05s, prepare 5.21s)

Command 3: npm run typecheck

    > UnicDB@1.6.3 typecheck
    > tsc --noEmit
    (no output, exit code 0)

Status: PASS

Note: Implementation adds `hiddenIndices?: number[]` to SerializeOptions plus
two module-local helpers (hiddenIndexSet normalizer, resolveKeepIndices which
checks hiddenIndices first and falls back to the unchanged keepIndices name
path). All 7 serializers handle both paths; serializeSqlUpdates and
serializeWhereClause additionally rebuild their column->index Map over
visible positions only when hiddenIndices is present, so SET/WHERE read the
VISIBLE duplicate's value, never the hidden one. keepIndices() signature and
behavior unchanged. Files changed: src/ui/resultsGridModel.ts,
src/ui/__tests__/resultsGridModelExport.test.ts (7 new tests, incl. the 6
required table cases + 1 all-serializer coverage case). No git commands run;
no files outside Target Files + Test Files modified.

## Reviewer Verdict (R1 — adapters/export group)
VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
FINDINGS: no Critical/Important defects; minor notes only, non-blocking. Verification re-run green.
SOURCE: R1 review round outcome recorded in RUN.md cursor (adapters/export group).
