# TASK-BQ04-003 — frozen-surface guard test (BQ-00 / BQ-01 / package.json)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 BQ-04.3, §3 Approach 5, §4 rows 003.a-c

## Goal

Add one standalone Vitest test file that proves the BQ frozen surfaces are byte-untouched relative to the v1.50.0 release snapshot (`75cdb08`) by asserting `git diff` on the frozen paths is empty: BQ-00 (`bigqueryTypes.ts`, `bigqueryAdc.ts`), BQ-01 (`src/adapters/types.ts` — `BigQueryClientLike` + `BatchedQuery`), and `package.json` (no new deps, `@google-cloud/bigquery` stays `9.0.3`). Zero source-file edits — guard-only task. (The non-BQ render regression is TASK-BQ04-002's test row 3; it belongs to the task that owns the switch helper.)

## Target Files

- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` (NEW) — contains the tests below. No other file is created or modified in this task.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | regression (frozen guard, primary) | BQ-00 surface byte-untouched vs v1.50.0 | `git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` produces EMPTY stdout (child_process `execSync` from repo root; trim output; assert `=== ""`) | repo with git history (present locally + in CI runners that check out the repo) |
| 2 | regression (frozen guard) | `BigQueryClientLike` + `BatchedQuery` unchanged | `git diff 75cdb08 -- src/adapters/types.ts` produces EMPTY stdout | same |
| 3 | regression (frozen guard) | `package.json` deps unchanged | `git diff 75cdb08 -- package.json` produces EMPTY stdout (no new deps, `@google-cloud/bigquery` stays `9.0.3`) | same |

**Kind note (planner, self-audit):** this is a guard-only task — it adds no feature, so there is no feature happy path; row 1 is the primary case and rows 1-3 pin three *different* frozen surfaces (BQ-00 pure types / adapter-seam types / dependency manifest), i.e. three distinct regression kinds a different actor could each break independently. The cycle-level test variety (happy + ≥2 edge kinds) is satisfied by TASK-BQ04-001 and TASK-BQ04-002; the non-BQ render regression lives in TASK-BQ04-002 test row 3 (with the upstream `dialect === undefined` guarantee pinned by TASK-BQ04-001 row 2). Rows 1-3 are GREEN at base by design — a guard test that failed on an empty implementation would be meaningless; its falsifiable expectation is `diff === ""`, which fails the moment any frozen file is edited.

## Test Files

- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` (NEW) — mirror the header-comment + named-export-import style of `src/adapters/__tests__/bigqueryPackage.test.ts` (fs/child_process node imports, `describe`/`it` from `vitest`, repo-root resolution via `path.resolve(__dirname, "..", "..", "..")`).

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
npm run typecheck
git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json
# (third command must print nothing)
```

## Acceptance Criteria

- [ ] `src/adapters/__tests__/bq04SurfaceGuard.test.ts` exists and contains tests 1-3 above.
- [ ] All 3 guard rows GREEN at base (frozen paths untouched) and still GREEN at cycle end.
- [ ] `git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json` empty.
- [ ] No source file modified by this task (`git status --porcelain` shows only the new test file for this task's scope).
- [ ] `npm run typecheck` green.

## Dependencies

- (none) — pure wave-1 task; runs against base state and depends on no other task's output.

## Interfaces

- Consumes: (none from other tasks) — `node:child_process.execSync`, `node:path`, `vitest` only.
- Produces: `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — the cycle's frozen-surface proof, cited by PLAN.md §6 acceptance.

---

## Discussion

### 2026-09-03 · planner · unic-smart

Note on the `75cdb08` guard base (for @executor): the ACTIVE.md request template said "Base: main @ 75cdb08", but actual HEAD at planning time is `358b183` (post-v1.50.0 close-out commits, which touched only `docs/` + `CHANGELOG` — verified `git diff 75cdb08 -- <frozen paths>` is empty at HEAD). The guard test pins `75cdb08` as instructed because that commit is the stable release snapshot; `358b183` would drift every docs-only commit and break the guard spuriously. If `75cdb08` ever becomes unreachable (history rewrite), the test fails loudly — that is the intended behavior, not a bug.

(no further comments)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
