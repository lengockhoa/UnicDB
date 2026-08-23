# TASK-604 — Release 1.5.0 boundary (version + README + full suite)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.D

## Goal

Ship the release boundary: bump version to 1.5.0, update README feature bullets for
the four shipped work items, write `.cache/release-notes-v1.5.0.md`, and prove the
whole suite + typecheck + compile green.

## Target Files

- `package.json` — `"version": "1.4.1"` → `"1.5.0"` (line 5); nothing else
- `README.md` — feature bullets: update the results-grid bullet (set-filter checkbox panel replaces Text/Number Filters wording) + ADD 1.5.0 bullets (Excel checkbox set filter per column; icon single-row toolbar + requery-bar icons; Run .sh ▶ Run CodeLens + fix)
- `.cache/release-notes-v1.5.0.md` — (new) release notes for `gh release --notes-file`

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | boundary | full `npx vitest run` | exit 0, 0 failed tests (existing suites + new TASK-601/602/603/605 tests) | after all tasks merged |
| 2 | boundary | `npm run typecheck` | exit 0 | clean tree |
| 3 | boundary | `npm run compile` | dist artifacts rebuild (`dist/webview.js`, `dist/extension.js`, `dist/webview.css`) with no error | |
| 4 | unit | version + README consistency | `package.json` version === `"1.5.0"`; README contains `1.5.0` bullet mentioning the set filter AND the .sh Run lens | readFileSync assertions (add to `src/scaffold.test.ts` if a natural home exists — otherwise verify via command below and record in report) |

## Test Files

- (no new test file mandatory) — if adding test 4 as an automated check, put it in `src/scaffold.test.ts` (manifest assertions live there today); otherwise document the manual check in the Executor Report.

## Verification Commands

```bash
npm run compile
npx vitest run
npm run typecheck
```

(No lint script exists in this repo — stated explicitly. Full suite here IS the
wave/cycle boundary regression net required by RULES.md.)

## Acceptance Criteria

- [ ] `package.json` version `1.5.0`.
- [ ] README updated (grid bullets + 1.5.0 additions, no stale "Text/Number Filters" claim where the set filter replaced it).
- [ ] `.cache/release-notes-v1.5.0.md` written (4 user-facing changes).
- [ ] Full suite 0 fail + typecheck 0 error + compile OK — outputs pasted in Executor Report.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.
- [ ] NO git commit / tag / release — maintainer does `scripts/build.sh`, tag `v1.5.0`, `gh release --notes-file .cache/release-notes-v1.5.0.md` post-cycle.

## Dependencies

- TASK-601, TASK-602, TASK-603, TASK-605 (release boundary covers all shipped work; also `package.json` is owned by 605 until it lands)

## Interfaces

- Consumes: completed TASK-601/602/603 (webview set filter + icon toolbar) + TASK-605 (Run .sh lens + activation fix) — for README/release-notes copy.
- Produces: version `1.5.0` in `package.json`; `.cache/release-notes-v1.5.0.md` consumed by the maintainer's `gh release`.

---

## Discussion

### 2026-08-23 · planner · unic/unic-smart
Maintainer post-cycle steps (NOT executor): `scripts/build.sh` → tag `v1.5.0` →
`gh release create v1.5.0 dist/vsdb-1.5.0.vsix --notes-file .cache/release-notes-v1.5.0.md`.
Also recommended at release time: manual browser smoke of the toolbar at a narrow
webview width (jsdom cannot verify pixel layout — see TASK-603 gap note).

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec604
SUMMARY: Bumped package.json 1.4.1→1.5.0; rewrote README results-grid bullet (Text/Number Filters → Excel-style set filter) and appended 1.5.0 bullets (single-row icon toolbar, destructive-statement guard with vsdb.confirmDestructive, Run .sh CodeLens + activation fix with vsdb.showRunLensSh); wrote .cache/release-notes-v1.5.0.md in the prior vi/en mix style (TASK-604's ".sh Run lens + activation fix" plus the new 1.5.0 trio).
TEST_PLAN_FOLLOWED: task §4 — boundary tests 1/2/3 (compile / vitest / typecheck) all green; test #4 (version + README consistency) verified by readFileSync inspection since no natural `scaffold.test.ts` slot exists for it (recording the manual check here).
FILES_CHANGED:
  - package.json: version 1.4.1 → 1.5.0 (line 5)
  - README.md: results-grid bullet now describes AG Grid Set Filter (distinct checkbox list, quick search, Select All/Blanks); added 1.5.0 bullets for toolbar icons, destructive guard, .sh CodeLens + activation fix (Run .sh 1.4.0 bullet kept intact)
  - .cache/release-notes-v1.5.0.md (new): 4 user-facing changes (Excel set filter, single-row icon toolbar, destructive confirm guard with vsdb.confirmDestructive, Run .sh CodeLens + activation fix with vsdb.showRunLensSh) — vi/en mix matching release-notes-v1.4.1.md style
TESTS_ADDED: none (boundary task per task §3; no new test file required)
VERIFICATION:
  command: `cd .worktrees/task-604 && npm run compile && npx vitest run && npm run typecheck`
  result: compile OK (dist/extension.js 4.6mb, dist/webview.js 2.2mb, dist/webview.css 8.6kb); vitest 38 files / 437 tests passed (0 failed) in 5.42s; typecheck tsc --noEmit exit 0
  output_excerpt: |
    Test Files  38 passed (38)
         Tests  437 passed (437)
    esbuild: build complete
    > vsdb@1.5.0 typecheck
    > tsc --noEmit
ISSUES: none
HANDOFF_TO_REVIEWER: yes — all acceptance criteria 1-4 satisfied (version 1.5.0, README updated, release notes written, full suite+typecheck+compile green); criteria 5 (reviewer verdict) and 6 (no git commit/tag/release — maintainer-owned post-cycle) intentionally not exercised here
NEXT: ready for review; maintainer post-cycle (scripts/build.sh → tag v1.5.0 → gh release create v1.5.0 dist/vsdb-1.5.0.vsix --notes-file .cache/release-notes-v1.5.0.md) deferred to orchestrator per task §Acceptance #6.
