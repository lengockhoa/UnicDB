# TASK-DBX01-002 — Mapping + dry-run pure modules

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX01.md` §4 (Test Plan), §2 Scope

## Goal

Write RED tests first, then implement two pure, vscode-free modules: `importMapping.ts` (column mapping source→target with opt-in per-column type coercion and per-cell error reporting) and `importDryRun.ts` (build a fully parameterized, batched INSERT plan + summary; read-only — provably no `runQuery` calls). No DB, no `vscode`.

## Target Files

- `src/core/importer/importMapping.ts` **(new)** — `applyMapping(parse, mapping, targets)` pure function.
- `src/core/importer/importDryRun.ts` **(new)** — `buildDryRunPlan(mapped, target)` pure function.
- `src/core/importer/__tests__/importMapping.test.ts` **(new)** — mapping contract.
- `src/core/importer/__tests__/importDryRun.test.ts` **(new)** — dry-run contract.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | renames column via mapping | target column receives source values | CSV headers `a,b` → map `a→id` |
| 2 | unit | default mapping = text coercion | untouched values pass through as text | no mapping entry for column `b` |
| 3 | unit | int coercion | `"42"` → numeric 42 param | mapping `id: "int"` |
| 4 | unit | numeric coercion | `"3.14"` → 3.14 | mapping `price: "numeric"` |
| 5 | unit | bool coercion accepts true/false/1/0 (case-insensitive) | `"TRUE"` → true | mapping `active: "bool"` |
| 6 | unit | timestamp coercion passes ISO string through validated | `"2026-08-30T00:00:00Z"` accepted | mapping `ts: "timestamp"` |
| 7 | unit | json coercion validates JSON.parse on cell | `'{"a":1}'` accepted as parsed value | mapping `payload: "json"` |
| 8 | edge | coercion failure → per-cell error, row excluded from plan | `errors[0].column = "id"`, row dropped | `"abc"` for int column |
| 9 | edge | source column missing from parse result | mapping error names the source column | mapping references `c` but headers are `a,b` |
| 10 | edge | required target column unmapped → error | plan refuses with named column | targets require `id`, mapping omits it |
| 11 | unit | dry-run builds parameterized INSERT | SQL contains `$1..$N` placeholders, zero string-concatenated literals | 3 rows, 2 columns |
| 12 | unit | batch size honored | plan reports `batches = ceil(rows / batch)` | 10 rows, batch 4 → 3 batches |
| 13 | unit | summary counts rows/bytes | `rowCount`, `totalBytes` > 0 | fixture rows |
| 14 | regression | dry-run performs NO database call | mock adapter `runQuery` never invoked | spy adapter injected |
| 15 | unit | identifier quoting uses double-quote escaping | `table` name `"weird""name"` rendered safely | target table with quote |
| 16 | edge | zero mapped rows → empty plan + summary, not throw | `batches: 0, rowCount: 0` | all rows had errors |

## Test Files

- `src/core/importer/__tests__/importMapping.test.ts` — cases 1–10.
- `src/core/importer/__tests__/importDryRun.test.ts` — cases 11–16.

## Verification Commands

```bash
npx vitest run src/core/importer/__tests__/importMapping.test.ts src/core/importer/__tests__/importDryRun.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] RED output recorded before implementation; both files green after.
- [ ] No `vscode` import, no `as any`/`: any`.
- [ ] Dry-run emits only `$N`-parameterized statements — test asserts no cell value appears literally in SQL.
- [ ] Both modules are pure; dry-run takes an optional read-only schema hint (column names/types) but never executes.

## Dependencies

- TASK-DBX01-001 must complete first.

## Interfaces

- Consumes (from DBX01-001): `ImportParseResult`, `ImportRowError`.
- Produces (for DBX01-003/004):
  - `type CoercionType = "text" | "int" | "numeric" | "bool" | "timestamp" | "json"`
  - `interface ColumnMapping { source: string; target: string; type: CoercionType }`
  - `interface MappedRows { values: unknown[][]; errors: ImportRowError[] }`
  - `function applyMapping(parse: ImportParseResult, mapping: readonly ColumnMapping[], requiredTargets?: readonly string[]): MappedRows`
  - `interface DryRunPlan { sqlStatements: string[]; parameterSets: unknown[][]; batches: number; rowCount: number; totalBytes: number }`
  - `function buildDryRunPlan(mapped: MappedRows, target: { schema: string; table: string }, opts?: { batchSize?: number }): DryRunPlan`
  - SQL shape: `INSERT INTO "schema"."table" ("c1","c2",...) VALUES ($1,$2,...)` — one statement per batch.

---
## Discussion

(no comments yet)

---
---
## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
Status: PASS
Note: importMapping.ts — user mapping IS the target column set (unmapped sources dropped); requiredTargets validated pre-coercion; opt-in per-column coercion (text/int/numeric/bool/timestamp/json) with column-named per-row errors; failing rows dropped. importDryRun.ts — batched $N-parameterized INSERTs (zero literal cell values in SQL, asserted), SQL-standard identifier escaping, byte/row summary, provably no DB calls. 10+6=16/16 tests.
