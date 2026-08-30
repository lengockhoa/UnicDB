# TASK-DBX03-002 — dataDiff pure module

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX03.md` §3.2, §4 T7–T10

## Goal

Pure row-level diff keyed by a key tuple (PK or unique NOT NULL columns): rows only-in-source / only-in-target / changed with per-cell diffs, deterministic key ordering, and a hard guard when no usable key exists.

## Target Files

- `src/core/compare/dataDiff.ts` — new pure module.
- `src/core/compare/__tests__/dataDiff.test.ts` — new tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | rows only in source → addedRows | ordered by key tuple ascending | source has 2 extra keys |
| 2 | unit | changed row yields per-cell diffs | `cellDiffs: [{column, from, to}]`, column-named | one column differs |
| 3 | unit | identical datasets → empty groups | `addedRows/removedRows/changedRows.length === 0` | same keys same values |
| 4 | edge | no key → skipped, nothing computed | `result.skipped === "no-key"`, groups empty | `keys: []` |
| 5 | edge | duplicate keys on one side do not crash; first occurrence wins, duplicates counted | no throw, `duplicateKeyCount > 0` | injected dup key |
| 6 | boundary | null cell diffs (null→value, value→null change; null→null identical) | cellDiff only for real changes | null fixtures |

## Test Files

- `src/core/compare/__tests__/dataDiff.test.ts`

## Verification Commands

```bash
npm run typecheck
npx vitest run src/core/compare/__tests__/dataDiff.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED evidence in report).
- [ ] Pure module — rows are INPUTS; no DB calls anywhere.
- [ ] Deterministic: output ordered by key tuple (stable stringify compare), never by Map iteration luck.
- [ ] No vscode import.

## Dependencies

- (none)

## Interfaces

- Consumes: `TableShape` from TASK-DBX03-001 (`src/core/compare/schemaDiff.ts`) for the column list type; rows are `Record<string, unknown>[]` keyed by column name (host builds them from QueryResult rows).
- Produces:
```ts
export interface CellDiff { column: string; from: unknown; to: unknown }
export interface RowChange { key: unknown[]; cellDiffs: CellDiff[] }
export interface DataRowDiff {
  addedRows: Array<{ key: unknown[]; row: Record<string, unknown> }>;
  removedRows: Array<{ key: unknown[]; row: Record<string, unknown> }>;
  changedRows: RowChange[];
  duplicateKeyCount: number;
}
export type DataDiffResult =
  | ({ skipped: "no-key" } & Partial<DataRowDiff>)
  | ({ skipped?: undefined } & DataRowDiff);
export function diffData(
  keys: string[],
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
  columns: string[],
): DataDiffResult;
```

---

## Discussion

(no comments yet)

---

<!-- Executor appends report below -->
