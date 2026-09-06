# TASK-RP-006 — Fix critical focus-command bug + append missing RP-004 executor report

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Architectural choice), §6 AC2 (Reveal path)

## Goal

Reviewer caught a critical bug in wave 1: `ResultsPanel.show()` calls
`vscode.commands.executeCommand("UnicDB-results.focus")` — but `UnicDB-results` is the
**container** id (hyphen), and VS Code auto-registers focus commands per **view** id
(dot), not per container. The correct command is `"UnicDB.results.focus"`. Every
test asserts the broken literal; the bottom panel never auto-revealed on query run.

Also append the missing `## Executor Report` to TASK-RP-004.md (the wave-3 partial
commit shipped the test file but never wrote its self-report).

This task fixes BOTH in one pass, with a coordinated string replacement across all
referencing files.

## Target Files

- `src/ui/resultsPanel.ts` — change `executeCommand("UnicDB-results.focus")` →
  `executeCommand("UnicDB.results.focus")` (1 line, line 233).
- `src/ui/__tests__/resultsPanelViewProvider.test.ts` — case 4 title + assertion
  (lines 315, 329) reference the wrong string. Fix.
- `src/ui/__tests__/resultsPanelViewManifest.test.ts` — comments + assertion
  (lines 12, 187) reference the wrong string. Fix.
- `src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts` — comments + assertions
  (lines 247, 248, 372, 387, 425) reference the wrong string. Fix.
- `src/ui/__tests__/resultsPanel.test.ts` — comments (lines 118, 125, 127). Fix.
- `src/ui/__tests__/manualCommit.test.ts` — comment + handler (lines 57, 84). Fix.
- `src/ui/__tests__/resultsPanelRequery.test.ts` (line 140), `resultsPanelRetry.test.ts`
  (line 108), `resultsPanelDistinctValues.test.ts` (line 112), `resultsPanelSaveEdits.test.ts`
  (line 115), `resultsPanelServerFilter.test.ts` (line 122), `resultsPanelErrorIntegration.test.ts`
  (line 123), `resultsPanelClose.test.ts` (line 59), `resultsPanelCloseWiring.test.ts`
  (line 55), `resultsPanelOrderBy.test.ts` (line 116) — all check
  `cmd === "UnicDB-results.focus"`. Fix every one.
- `docs/AI_HANDOFF/PLAN.md` — comments in §3 + §4 + §6 (lines 79, 98, 171, 206, 221) reference
  the wrong string. Update to `"UnicDB.results.focus"` (note: also the §3 reference to
  "container id + .focus" must change to "view id + .focus"; the §4 case 4 description
  must rename the expected command).
- `docs/AI_HANDOFF/tasks/TASK-RP-003.md` — case 4 references `viewsContainers.panel[0].id + ".focus" === "UnicDB-results.focus"`. Change to assert the view id produces the focus command: `views["UnicDB-results"][0].id + ".focus" === "UnicDB.results.focus"`.
- `docs/AI_HANDOFF/tasks/TASK-RP-004.md` — append a `## Executor Report` block with:
  ```
  ## Executor Report
  EXECUTOR_TOOL: claude-code
  EXECUTOR_MODEL: unic-code
  EXECUTOR_SUBAGENT: -
  RED_OUTPUT: (none — all 6 cases assert the post-fix world; full verification output below)
  Verification Output: <full `npm test` output from commit 405af76 era>
  Status: PASS
  Note: 6/6 cases pass; full-suite gate blocked on wave 1+2 regressions (later fixed in TASK-RP-005).
  ```
  The executor that landed this was feature-implementer on commit 405af76. Use the report
  excerpt from TASK-RP-004.md's executor (you can `git log` and `git show` for the test
  file's commit message; the original return summary was preserved in the task notification
  log).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug fix) | `resultsPanel.ts uses the view focus command, not container focus` | `readFileSync("src/ui/resultsPanel.ts")` contains `executeCommand("UnicDB.results.focus")` AND does NOT contain the literal `UnicDB-results.focus` anywhere | raw source string |
| 2 | regression (bug fix) | `every sibling resultsPanel test asserts the view focus command` | `grep -lR "UnicDB-results.focus" src/` returns ONLY this task file (RP-006) and PLAN.md (which contains it as text, not test assertion). Every other match — including the test files listed above — is replaced | grep over src/ |
| 3 | regression (suite gate) | full `npm test` exits 0 | `npm test` reports 0 failed test files and 0 failed tests | full repo |
| 4 | unit (paperwork) | `TASK-RP-004.md has a ## Executor Report block with EXECUTOR_MODEL: unic-code` | `readFileSync("docs/AI_HANDOFF/tasks/TASK-RP-004.md")` contains `EXECUTOR_MODEL: unic-code` after the `## Executor Report` heading | task file |

## Test Files

- (No new test files. This task only fixes literals + appends paperwork. The existing
  `resultsPanelViewProvider.test.ts` case 4 already enforces the focus command
  literal — once the test's string is corrected and the code matches, the assertion
  is the test.)

## Verification Commands

```bash
# Confirm no stale references remain in source
grep -rn "UnicDB-results.focus" src/ 2>&1 | grep -v "^src/.*\.md" | head -10
# Run the touched test files
npm test src/ui/__tests__/resultsPanelViewProvider.test.ts
npm test src/ui/__tests__/resultsPanelViewManifest.test.ts
npm test src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts
npm test src/ui/__tests__/manualCommit.test.ts
npm test src/ui/__tests__/resultsPanel.test.ts
npm test src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelRetry.test.ts src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelErrorIntegration.test.ts src/ui/__tests__/resultsPanelClose.test.ts src/ui/__tests__/resultsPanelCloseWiring.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts
npm run typecheck
npm run compile
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] `grep -rn "UnicDB-results.focus" src/` returns nothing (every src/ occurrence replaced).
- [ ] Full `npm test` reports 0 failed test files and 0 failed tests.
- [ ] `npm run typecheck && npm run compile` pass.
- [ ] `docs/AI_HANDOFF/tasks/TASK-RP-004.md` ends with a `## Executor Report` block declaring `EXECUTOR_MODEL: unic-code`.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-RP-001 (provides the current `show()` with the wrong command).
- TASK-RP-003 (provides the manifest that the view id comes from).
- TASK-RP-004 (the missing-report paperwork).

## Interfaces

- Consumes: `ResultsPanel.show()`'s `executeCommand` call from RP-001; manifest view id
  `"UnicDB.results"` from RP-003.
- Produces: a working bottom-panel auto-reveal on `ResultsPanel.show()`.

---

## Discussion

### 2026-09-06 · orchestrator · main session
- The bug is in plain sight: container id uses `-` (hyphen) and view id uses `.` (dot) —
  different namespaces. VS Code only registers `.<view-id>` commands. The original
  executor of RP-001 read the manifest's container id and assumed that produced a focus
  command; it does not.
- 19 file changes total: 1 source (`resultsPanel.ts`) + 14 test files + 2 doc files +
  1 task-file paperwork append + this task file. Mechanical find-and-replace, plus
  the `cmd ===` checks in 9 test mock handlers, plus the comment/assertion fixes in
  5 test files + the manifest test.
- The `## Executor Report` append for RP-004 needs an EXECUTOR_MODEL: unic-code
  declaration. The actual agent ID was `aaad3089594a7ad8d` per the prior task
  notification. The orchestrator's record of its return summary is:
  ```
  TASK: TASK-RP-004
  STATUS: FAIL
  EXECUTOR_MODEL: unic-code
  FILES: src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts
  RED: not-confirmed
  VERIFY: 4 commands, 3 pass / 1 fail — `npm test` full suite red due to 14 pre-existing
          failures across 8 files [...]
  NOTE: Cycle gate cannot close by RP-004 alone — pre-existing wave 1+2 breakage is
        out of scope per "do not touch other files". Full diagnosis in TASK-RP-004.md
        ## Executor Report.
  ```
  Status was FAIL because of the full-suite gate, not because of RP-004's own 6 cases.
  Rewrite as Status: PASS-with-suite-blocked (own cases 6/6; cycle gate was the
  blocker, later fixed by RP-005). Note this in the appended report.
- PLAN.md and PLAN_REVIEW documents use the wrong string in their prose. Fix
  every occurrence for consistency.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: (none — no source-level RED exists; tests previously asserted the broken literal in lockstep with the broken source so the suite was green but functionally wrong. The functional bug is "show() reveals nothing"; coverage gap fixed in place by the find-and-replace. New source-scan gate: `grep -rn "UnicDB-results.focus" src/` returns nothing — verified empty)
Verification Output:
- `grep -rn "UnicDB-results.focus" src/` → 0 matches (PASS)
- `npm test src/ui/__tests__/resultsPanelViewProvider.test.ts` → 1 file / 6 tests passed
- `npm test src/ui/__tests__/resultsPanelViewManifest.test.ts` → 1 file / 4 tests passed
- `npm test src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts` → 1 file / 6 tests passed
- `npm test src/ui/__tests__/manualCommit.test.ts` → 1 file / 12 tests passed
- `npm test src/ui/__tests__/resultsPanel.test.ts` → 1 file / 46 tests passed
- `npm test` on the 9 mock-handler suites → 9 files / 115 tests passed
- `npm run typecheck` → PASS (no errors)
- `npm run compile` → PASS (esbuild build complete, no errors)
- `npm test` (full suite) → 239 passed / 5 pre-existing failures (all 5 are `aiChatPanel*Webview*.test.ts` files failing on `spawnSync node_modules/.bin/esbuild ENOENT` — worktree environment issue, identical to the RP-004 wave-1+2 breakage pre-fixed in TASK-RP-005; 3541 tests passed / 0 failed from RP-006's scope)
Status: PASS — own scope (1 source + 14 test files + 3 doc files); full-suite gate blocked on the same pre-existing `aiChatPanel*` ENOENT that RP-005 resolved in main checkout
Note: Two collaboration fallouts caught mid-run and fixed in this pass:
1. `resultsPanelViewManifest.test.ts` case 4 — my initial replacement created duplicate `const views` / `const panelViews` declarations over the existing pre-fix block; collapsed to the single original declarations + appended focus derivation using `panelViews[0]!.id`.
2. `resultsPanelBottomPanelIntegration.test.ts` case 5 (line 429) — the pre-existing `expect(`${container!.id}.focus`).toBe("UnicDB.results.focus")` assertion is structurally wrong (container id ≠ view id and never was); rewrote to derive the executed command from the view id (`manifestViews[0]!.id`) which is what VS Code actually registers. Both fixes are minimal-correct, no scope creep.
`docs/AI_HANDOFF/tasks/TASK-RP-004.md` now ends with the `## Executor Report` block declaring `EXECUTOR_MODEL: unic-code` and `EXECUTOR_SUBAGENT: feature-implementer (aaad3089594a7ad8d)`, inserted between the existing separator and the prior Reviewer Verdict. The 19 target files are all in place; no commits pushed.

## Reviewer Verdict (round 2)

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS (npm test = 244 files / 3619 tests passed / 0 failed / 2 skipped; npm run typecheck exit 0; npm run compile exit 0 — re-run fresh at 72f180f)
FINDINGS:
  critical: none
  important: none
  minor: (1) PLAN.md §4 "edge (manifest consistency)" row still says viewsContainers.panel[0].id + ".focus" is the command show() executes — the same structural error this task fixed in tests; the sweep updated 5 PLAN.md lines but missed this row (contains no literal hyphen string, so the grep gate passes); (2) docs/AI_HANDOFF/tasks/TASK-RP-003.md:73 (§Interfaces) still says "UnicDB-results.focus is what show() executes" while line 34 was fixed — internal inconsistency in the same doc; (3) hyphen-string residue remains in TASK-RP-001.md:33,78 and TASK-RP-004.md:26 (historical verdict/quote mentions are fine to keep).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Test integrity verified against ground truth, not mere self-consistency: source (resultsPanel.ts:233), both manifest tests, and the integration suite now derive the focus command from the manifest VIEW id — matching VS Code's actual per-view registration. The executor also caught and fixed the pre-existing structurally-wrong case 5 derivation (container id to view id) without scope creep: all 19 changed files are in this task's target list. RED_OUTPUT "none" is justified — the defect was lockstep-green (tests pinned the broken literal), and the corrected assertions + grep gate are the real regression guard.
