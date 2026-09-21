# TASK-DBX03-001 — schemaDiff pure module

- Status: `done`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX03.md` §3.1, §4 T1–T6

## Goal

Pure (vscode-free) schema diff between two table shapes: classify identical/added/dropped/changed columns and PK changes with deterministic ordering and a `compatible` flag gating the data diff.

## Target Files

- `src/core/compare/schemaDiff.ts` — new pure module.
- `src/core/compare/__tests__/schemaDiff.test.ts` — new tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | identical shapes report identical | `result.identical === true`, `entries.length === 0` | same columns+PKs |
| 2 | unit | column added in source | entry `{kind: "added", column}`; entries ordered by source column order | target missing one column |
| 3 | unit | type change classified | entry `{kind: "changed", change: "type", from: "integer", to: "text"}` | col type differs |
| 4 | unit | nullability/default/pk changes separate entries | one entry per change kind, not conflated | 3 differing attrs on one column + pk set diff |
| 5 | edge | column dropped in target | entry `{kind: "dropped", column}` (target-only column) | source missing one target column |
| 6 | edge | both shapes empty | identical true, no throw | `{columns: [], primaryKeys: []}` |
| 7 | safety | `compatible` false on type change even when column sets match | `result.compatible === false` | type-changed col |

## Test Files

- `src/core/compare/__tests__/schemaDiff.test.ts`

## Verification Commands

```bash
npm run typecheck
npx vitest run src/core/compare/__tests__/schemaDiff.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED pasted in report, then GREEN).
- [ ] No vscode import in the module (grep-clean).
- [ ] Deterministic ordering: source order first, dropped/appended alphabetical.
- [ ] No regression in related suites (wave-boundary full run covers this).

## Dependencies

- (none)

## Interfaces

- Consumes: `TableDetail` output shape from `adapter.listTableDetail` (host passes it in; module stays adapter-free).
- Produces:
```ts
export interface TableShape {
  columns: Array<{ name: string; dataType: string; nullable: boolean; defaultValue: string | null }>;
  primaryKeys: string[];
}
export type SchemaDiffEntry =
  | { kind: "added"; column: string; position: number }
  | { kind: "dropped"; column: string }
  | { kind: "changed"; column: string; change: "type" | "nullable" | "default"; from: string | null; to: string | null }
  | { kind: "pk-changed"; from: string[]; to: string[] };
export interface SchemaDiffResult { identical: boolean; compatible: boolean; entries: SchemaDiffEntry[] }
export function diffSchema(source: TableShape, target: TableShape): SchemaDiffResult;
export function shapeFromTableDetail(detail: TableDetail): TableShape;
```
(`shapeFromTableDetail` maps `listTableDetail` output; PK columns resolved via `conkey` 1-based ordinal indexes against the columns array; `contype === "p"` marks the PK constraint.)

---

## Discussion

(no comments yet)

---

<!-- Executor appends report below -->

## Executor Report

### 2026-08-30 · executor · omp-direct/unic-code

RED: src/core/compare/__tests__/schemaDiff.test.ts written first — module absent, run failed to resolve (pasted in report). GREEN after implementing schemaDiff.ts. 11/11 tests. Deterministic ordering asserted (source order for added, alphabetical for dropped). shapeFromTableDetail resolves PK names from conkey 1-based ordinals (contype=p). No vscode import.
