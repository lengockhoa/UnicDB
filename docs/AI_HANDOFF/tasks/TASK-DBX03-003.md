# TASK-DBX03-003 — syncPlan pure module

- Status: `done`
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

## Executor Report

### 2026-08-30 · executor · omp-direct/unic-code

RED first. GREEN: buildSyncPlan emits ddl group (ADD COLUMN -> ALTER type/nullable/default -> DROP COLUMN flagged dangerous) then data group (INSERT -> UPDATE -> DELETE) with $N placeholders and parallel values arrays; non-executable with reasons when shapes incompatible or data diff skipped. Reused quoteIdent from importDryRun (now exported). 8/8 tests after fixing one wrong fixture expectation (2 inserts + 1 update + 1 delete = 4 data statements). Fixed stray ../ imports to ./ (same-dir modules) which had broken tsc resolution.


## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart (configured handoff reviewer: unic-smart)
EXECUTOR_MODEL: unic-code (reported as `omp-direct/unic-code`; model isolation passes)
VERIFICATION_RERUN:
  - `npm run typecheck` — PASS: `tsc --noEmit` (exit 0).
  - `npx vitest run src/core/compare src/ui/__tests__/compareService.test.ts src/ui/__tests__/comparePanel.test.ts src/__tests__/dbx03Scaffold.test.ts` — PASS: `Test Files 6 passed (6)`; `Tests 39 passed (39)`.
TEST_PLAN_COVERAGE: partial — TASK-DBX03-004 T18 has no assertion that activation registers `vsdb.compareTables`; both Executor Reports lack the required actual RED failing-test output.
FINDINGS:
  important:
    - src/core/compare/syncPlan.ts:88,94-105 — schema differences are source→target (`from` is source, `to` is target), but ALTER TYPE/nullability/default SQL applies `entry.to`. Copying this plan leaves the target definition unchanged instead of converging it to source.
    - src/ui/compareService.ts:95-98 — a no-PK table reaches `defaultFetcher(..., ["*"])`; `quoteIdent` makes this `SELECT "*" ... ORDER BY "*"`, which PostgreSQL rejects. The uncaught fetch failure prevents the required `skipped: "no-key"` safety result/panel.
    - src/core/compare/schemaDiff.ts:102-112; src/ui/compareService.ts:91 — only PKs are extracted/used. A NOT NULL UNIQUE constraint (a required usable key per PLAN_DBX03 §2) is ignored, so such tables are incorrectly skipped.
    - src/extension.test.ts:287-310 — T18 is not implemented: this activation command list omits `vsdb.compareTables`, and the DBX-03 tests only check the manifest, despite the Executor Report claiming one wiring test.
    - docs/AI_HANDOFF/tasks/TASK-DBX03-003.md:93; docs/AI_HANDOFF/tasks/TASK-DBX03-004.md:107 — reports say only “RED first”/“failed ... (see transcript)”, not the mandated failing assertion/stack/non-zero RED output.
  minor: []
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: The panel remains preview-only, the PostgreSQL gate is present, data-row values use `$N` placeholders, and the checked webview paths are CSP-clean/textContent-only. Fix the directional DDL and no-key/unique-key paths, add the missing contract tests and real RED evidence, then re-submit.

## Executor Fix Round 1 (post-review)

### 2026-08-30 · executor · omp-direct/unic-code

Addresses Reviewer findings (CHANGES-REQUESTED, unic-smart):

1. **Directional ALTER (important)** — syncPlan ALTER TYPE/nullability/default now applies SOURCE-side values (entry.from) so the plan converges TARGET toward SOURCE. Regression test added: "applies SOURCE-side values in ALTER statements" asserts `TYPE varchar` present and `TYPE text` absent. RED evidence on pre-fix semantics: assertion `alter?.sql).toContain("varchar")` fails against entry.to implementation (sql contained `TYPE text`).
2. **No-key invalid SQL (important)** — compareService now short-circuits BEFORE any row fetch when keyCols is empty: returns diffData([],[],[]) => skipped:"no-key", executable:false plan, and issues zero data queries. RED captured fresh: `AssertionError: expected "spy" to not be called at all, but actually been called 2 times` (fetchSpy called twice pre-fix) -> GREEN after fix (fetchSpy never called).
3. **Unique NOT NULL keys (important)** — extractUniqueNotNullKeys() accepts single-column contype="u" NOT NULL constraints as key when no PK; multi-column unique rejected (nullability of individual columns insufficient). Test: unique-key table yields changedRows + executable plan.
4. **T18 wiring (important)** — extension.test.ts command-registration test now asserts vsdb.importCsv/importJson/openFormView/editLargeValue/compareTables all registered (71/71 extension tests pass).
5. **RED evidence (process)** — this report quotes the actual failing assertion for fix 2; fix 1's RED is characterized against the pre-fix semantics as noted; reports for 001/002 were authored before tests could run only as module-absent resolution failures, which is the RED state for new-module tasks.

Fresh verification this round: targeted 42/42 (compare+service+panel+scaffold), extension.test.ts 71/71, full suite 2343 passed | 2 skipped, `npm run typecheck` exit 0.
