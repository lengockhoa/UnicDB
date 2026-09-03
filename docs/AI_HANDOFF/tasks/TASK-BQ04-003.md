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

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
  This is a guard-only task by design — the three primary rows are GREEN at base because the frozen surfaces ARE byte-untouched relative to `75cdb08`; a guard test that failed on an empty implementation would be meaningless. TDD discipline was satisfied by adding a sanity check (`describe("sanity check")`) that demonstrates the SAME `execSync` invocation against a known-differing ref (`75cdb08~1..75cdb08 -- CHANGELOG.md`) returns 37 NON-empty diff lines, proving the assertion is not tautological and the test wiring is live. Before that sanity block existed, the file would have been a 3-line "no-op" passing on no work; after the sanity check was added, an initial run confirmed the wiring produced the expected 37 non-empty lines from the intentionally-differing ref — the equivalent of a RED signal in a guard's logic.
Verification Output:
  command: npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
  result: 4 passed (3 frozen-guard rows + 1 sanity row) | 0 failed
  command: npm run typecheck
  result: tsc --noEmit exit 0
  command: git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json
  result: empty (frozen surface intact; guard rows 003.a-c are GREEN)
  command: git status --porcelain (filtered to this task's scope)
  result: only `src/adapters/__tests__/bq04SurfaceGuard.test.ts` listed (no source edit; guard-only as designed)
Status: PASS
Note: test file resolves repo root via `path.resolve(__dirname, "..", "..", "..")` and uses `git -C <repoRoot>` for the diff invocations — robust against any CWD. Each row uses `execSync(... { encoding: "utf8" }).trim()` and asserts `=== ""`. The sanity row's 37-line CHANGELOG diff output is logged to stdout for traceability. No new npm dep, no source edit, no touch on the four frozen files.

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-5 (relayed by orchestrator; NOT self-reported on disk — see critical finding)
VERIFICATION_RERUN:
  command: npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts ; npm run typecheck ; git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json
  result: 4/4 pass ; typecheck exit 0 ; frozen diff empty
TEST_PLAN_COVERAGE: all-followed — rows 1-3 implemented exactly as §Test Cases, plus a non-tautology sanity block (75cdb08~1..75cdb08 -- CHANGELOG.md → 37 diff lines, verified live)
FINDINGS:
  critical:
    - docs/AI_HANDOFF/tasks/TASK-BQ04-003.md — "## Executor Report" is MISSING from the task file: no FILES_CHANGED, no VERIFICATION block, no EXECUTOR_MODEL/EXECUTOR_TOOL self-report. handoff.executor.appendReportToTaskFile=true and the cross-tool review contract depend on this on-disk report; the model-isolation gate cannot verify the executor model from the package itself. Fix: executor appends the full report (same content class as TASK-BQ03-001.md:86). No code change required — the implementation itself verified clean on independent re-run.
  important:
    - none
  minor:
    - src/adapters/__tests__/bq04SurfaceGuard.test.ts:70-77 — sanity check inlines execSync instead of reusing gitDiff(), which would accept the "75cdb08~1..75cdb08" range string unchanged; helper reuse would make the "same execSync call" proof literal.
    - src/adapters/__tests__/bq04SurfaceGuard.test.ts:31 — comment "keeps stderr from leaking on stderr" is garbled; intended meaning: stderr is piped so it cannot interleave with the asserted stdout.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation is correct and fully verified on independent re-run (guard targets exact, repo-root resolution correct via git -C, loud failure on unreachable ref is documented intended behavior, CI shallow-clone caveat accepted by planner in Discussion). The only blocker is the missing executor self-report — a package-completeness fix, not a code fix.
