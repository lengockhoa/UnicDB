# TASK-BQ02-004 — Release copy + version gate (CHANGELOG, version bump, full-suite boundary)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 TASK-BQ02-004 / §5 Verification / §6 Acceptance

## Goal

Close the cycle as a release candidate: user-facing CHANGELOG entry for the BigQuery explorer +
preview capability, `package.json` version `1.48.0` → `1.49.0`, and the wave/cycle-boundary
regression net (full suite, typecheck, compile, frozen-surface diff) re-run fresh. This task
carries the cycle-level gates that individual code tasks must not own (they run narrowed
selections only, per RULES.md test-selection policy).

## Target Files

- `CHANGELOG.md` — new `## [1.49.0] — 2026-09-03` heading at the top, Added/Changed entries in the existing house style (see the `[1.48.0]` block: file paths in backticks, test counts, explicit frozen-surface and non-goals notes). Entries cover: real resource enumeration on `BigQueryAdapter` (datasets as schemas, tables/views/columns/estimates from client metadata), the preview builder + `vsdb.browseTableData` bigquery arm (bounded LIMIT 100/1000), explorer wiring (bigquery icon, `bigquery@<billingProject>` tooltip, dataset-not-schema labeling, zero row-count queries). Explicitly list the deferrals (no paged grid/BQ-03, `listRoutineParams` still unimplemented, no new command ids, no new dependencies).
- `package.json` — `version: "1.48.0"` → `"1.49.0"`. NOTHING else changes (no dep, no script, no contributes).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | release-hygiene suite reflects the bump | the existing release-hygiene/manifest tests inside `npm test` pass with version `1.49.0` — any test pinning the version string literally (search `grep -rn "1\.48\.0" src tests --include=*.test.ts` first) must be updated in the SAME edit or proven absent | grep before edit; `npm test` after |
| 2 | edge (consistency) | no stale version references | `grep -rn "1\.48\.0" CHANGELOG.md` matches ONLY the historical `[1.48.0]` heading + its prose; `grep -n "\"version\"" package.json` → `"version": "1.49.0"` | grep gates |
| 3 | regression | full-suite baseline holds or grows | `npm test` exits 0 with ≥ 3283 passed, ≤ 2 skipped (only additive growth from wave-1/2 tasks) | boundary run, paste the vitest summary |
| 4 | regression | static + bundle gates | `npm run typecheck` exit 0; `npm run compile` exit 0 | boundary run |
| 5 | edge (frozen surface) | BQ-00 surface byte-untouched | `git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` prints NOTHING (checks the whole cycle, not just this task) | diff gate |
| 6 | edge (scope) | no dep/contributes drift | `git diff -- package.json` shows ONLY the version line; no `dependencies`/`contributes`/`scripts` hunk | diff gate |

This task's own §Test Files is intentionally narrow: it owns no new test file; tests #1-#6 are
command gates + the pre-existing suites. That satisfies the Task Gate (the testable behavior is
"the gates pass and the copy is consistent" — verifiable, concrete, failable).

## Test Files

- (none new) — verification is command-based: existing `npm test` suite + grep/diff gates above. If test #1 finds a version-pinning test file, that file is edited in place and named in the Executor Report.

## Verification Commands

```bash
grep -rn "1\.48\.0" src tests --include=*.test.ts || echo "no version pins"
grep -rn "1\.48\.0" CHANGELOG.md | head -3
npm run verify:release && git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # full suite + typecheck + compile, frozen-surface diff must print nothing
git diff -- package.json                                                       # version line only
```

## Acceptance Criteria

- [ ] CHANGELOG `[1.49.0]` entry present, top-of-file, house style, with explicit deferrals section.
- [ ] `package.json` version is exactly `1.49.0`; diff touches only that line.
- [ ] Full suite ≥ 3283 passed | ≤ 2 skipped, exit 0 (fresh run, output pasted in Executor Report).
- [ ] `npm run typecheck` + `npm run compile` exit 0 (fresh run).
- [ ] Frozen-surface diff empty; no dep/contributes drift.
- [ ] No lint script exists — typecheck is the static gate (stated here, not silently skipped).

## Dependencies

- TASK-BQ02-001, TASK-BQ02-002, TASK-BQ02-003 must complete first — the CHANGELOG describes
  their shipped behavior and the boundary `npm test` runs their new tests.

## Interfaces

- Consumes: the wave-1/2 tasks' shipped behavior (enumeration, preview builder, explorer wiring) as documented facts for the CHANGELOG; `package.json` version field (existing); the release-hygiene suite inside `npm test` (existing).
- Produces: release state `1.49.0` with a complete CHANGELOG record — the input the human release step (`vsce package`, tag, GitHub release) consumes after review. No code symbols produced.

---

## Discussion

### 2026-09-03 · planner · unic-smart
1. File-disjointness holds by construction: CHANGELOG.md + package.json are owned by nobody
   else in this cycle (the wave-1/2 tasks are code+test only).
2. Precedent: v1.47.0's CHANGELOG block (BQ-01) is the model — Added bullets per file family
   with test counts, an explicit "frozen surface byte-untouched" sentence, and the deferral
   list. Match its density; reviewers in past cycles (BQ-00 R2) required the deferral list to
   be explicit, not implied.
3. The version grep in test #1 is deliberately run BEFORE the edit: if a hygiene test pins the
   version string (possible — release hygiene 20/20 was cited in STATUS.md), the executor must
   update that pin in the same commit, not discover it at boundary time.
4. Do NOT push, do NOT run `npm run package` — release packaging is the human/maintainer step
   per the roadmap §8.5 gate ordering; this task only makes the tree release-ready.
5. Date the CHANGELOG heading `2026-09-03` (cycle date) regardless of executor-run date; it is
   the release date field of record.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT: N/A (release copy task — no new test file; verification is command-based per §Test Files)

Verification Output:
  npm run verify:release:
    Test Files  226 passed | 1 skipped (227)
    Tests  3308 passed | 2 skipped (3310)
    (typecheck + compile exit 0; full suite 3308 passed, +25 over v1.48.0 baseline 3283|2, floor preserved at 2 skipped)

  git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts:
    (empty — BQ-00 frozen surface byte-untouched across the whole BQ-02 cycle)

  git diff -- package.json:
    @@ -2,7 +2,7 @@
    -  "version": "1.48.0",
    +  "version": "1.49.0",
    (version line only — no dependencies/contributes/scripts drift)

  git diff --stat -- package-lock.json:
    package-lock.json | 4 ++-- (the 2 `version` fields synced to 1.49.0)

  grep -rn "1\.48\.0" src tests --include "*.test.ts":
    (no matches — no test file pins the literal version string; test #1 of §Test Cases satisfied by absence)

  node -e "console.log(require('./package.json').version)":
    1.49.0

Status: PASS
Note: Worktree had no prebuilt dist/ on first verify:release run — three bundle tests failed with "dist/*.js missing — run npm run compile before this test" (test files for consolePanelBundle / aiChatPanelBundle / connectionFormBigqueryBundle). Ran `npm run compile` to build dist artifacts, re-ran `npm run verify:release` → 3308 passed | 2 skipped, exit 0. This is a worktree-freshness artifact, not a source-code regression — dist/ is gitignored and inherited via build, not via worktree. No source file outside package.json / package-lock.json / CHANGELOG.md was modified.

---

## Reviewer Verdict

(pending)
