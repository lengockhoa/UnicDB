# TASK-DBX03-003 — syncPlan pure module

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX03.md` §3.3, §4 T11–T14

## Goal

Directional (source→target) sync-plan builder over the two diffs: ordered, grouped, parameterized-shaped SQL with human summaries, and hard safety flags (`executable: false` + reason) when the shape is incompatible or data diff was skipped. Preview-only — the module never executes anything.

## Target Files

- `src/core/compare/syncPlan.ts` — new pure module.
- `src/core/compare/__tests__/syncPlan.test.ts` — new tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | safety | incompatible shape → non-executable plan | `plan.executable === false`, `plan.reasons` name the incompatible columns, data group empty | schemaDiff compatible=false |
| 2 | safety | skipped data diff (no key) → data group empty, reason recorded | data statements 0, reason mentions key | dataDiff skipped="no-key" |
| 3 | unit | schema DDL order: ADD COLUMN → ALTER (type/nullable/default) → DROP COLUMN | statement order matches | mixed schemaDiff |
| 4 | unit | full plan: ddl group then data group (INSERTs → UPDATEs → DELETEs), each statement has a one-line summary | `groups.map(g => g.id) === ["ddl", "data"]`; `summary` non-empty | schema + data diffs |
| 5 | edge | only-data diff → ddl group empty | ddl 0, data > 0 | identical shapes |
| 6 | safety | no literal row values in SQL — data statements use $N placeholders with parallel `values` arrays; identifiers quoted (`quoteIdent` discipline) | regex scan finds no literal `VALUES ('…')` and no raw unquoted identifiers | fixture values containing quotes |

## Test Files

- `src/core/compare/__tests__/syncPlan.test.ts`

## Verification Commands

```bash
npm run typecheck
npx vitest run src/core/compare/__tests__/syncPlan.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED evidence in report).
- [ ] Plan is a pure data structure — no execution path, no vscode import.
- [ ] DROP COLUMN statements carry `dangerous: true` so the UI can label them.
- [ ] INSERT VALUES use `$N` placeholders; `values` arrays carried alongside.

## Dependencies

- TASK-DBX03-001 (TableShape/SchemaDiffResult), TASK-DBX03-002 (DataDiffResult) must complete first.

## Interfaces

- Consumes: `SchemaDiffResult`, `TableShape` (TASK-DBX03-001); `DataDiffResult` (TASK-DBX03-002); `quoteIdent` from `src/core/importer/importDryRun.ts` (pure module — direct import OK).
- Produces:
```ts
export interface SyncStatement {
  sql: string;
  summary: string;
  dangerous?: boolean;
  values?: unknown[];   // bound values for INSERT/UPDATE ($N params)
}
export interface SyncGroup { id: "ddl" | "data"; statements: SyncStatement[] }
export interface SyncPlan {
  direction: "source->target";
  executable: boolean;
  reasons: string[];    // human-readable blockers when !executable
  groups: SyncGroup[];  // fixed order: ddl first, then data
  totals: { ddl: number; data: number };
}
export function buildSyncPlan(opts: {
  source: TableShape;
  target: TableShape;
  schemaDiff: SchemaDiffResult;
  dataDiff: DataDiffResult;
  sourceTable: { schema: string; table: string };
  targetTable: { schema: string; table: string };
}): SyncPlan;
```

---

## Discussion

(no comments yet)

---

<!-- Executor appends report below -->
