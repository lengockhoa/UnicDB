# TASK-UX2-004 — End-to-end integration of error visibility

- Status: `done`
- Owner: `feature-implementer (sonnet)`
- Reviewer: `unic-smart` (R2) → `unic-smart` (re-pass) → cycle shipped v1.51.3
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Wire TASK-UX2-001 + TASK-UX2-002 + TASK-UX2-003 together. Verify the user-visible
reproducers (failed connection, failed SQL, tab labels) end-to-end. This is the
host-side integration scaffold — the webview integration is covered by
TASK-UX2-002's `webview/__tests__/mainTabTitle.test.ts`.

The integration specifically tests the **two distinct error paths**:
- **First-connect failure**: adapterProvider rejects → executeAll outer catch
  fires → `extension.ts:2595` calls `runner.runFailed(reason)` → onUpdate
  fires → panel renders synthetic tab.
- **Post-connect runQuery failure**: executeAll catches inside
  (`queryRunner.ts:456-475`) → per-statement error row → onUpdate fires →
  panel renders error card (NOT empty grid) — this only works because
  TASK-UX2-001's `classifyPanelKind` fix routes SELECT+error to the card.

## Target Files

- `src/extension.ts:2595` — `runStatements` outer-catch on first-connect
  failure now calls `runner.runFailed(reason)` instead of dropping a toast.
  (Post-connect runQuery errors need no outer-catch change — they reach the
  panel through the existing executeAll path.) On the next healthy `run()`,
  call `statusBar.setErrorBadge(null)` to clear the badge.
- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` — new file with the 4
  integration cases from PLAN §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | integration | first-connect failure → outer catch in `runStatements` calls `runner.runFailed(reason)` → onUpdate fires → panel renders synthetic tab | end-to-end match | mock adapter that throws on `getAdapter` resolve |
| 2 | integration | post-connect runQuery error → per-statement error row reaches `onUpdate` → panel renders error card (NOT empty grid) | match | mock adapter returning pg error on `runQuery` |
| 3 | integration | status bar error badge set on first error, cleared on next healthy `run` (via `setErrorBadge(null)`) | cleared | after step 1, then healthy run |
| 4 | regression | successful SELECT still renders the grid; no error card | grid path | healthy adapter |

## Test Files

- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` (new, 4 cases).

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test src/ui/__tests__/resultsPanelErrorIntegration.test.ts
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (4/4).
- [ ] Full test suite green (baseline 3530|2 or better).
- [ ] Screenshot reproducer (failed connection) now shows the synthetic tab
      with `Run N · Connection failed…` title, error card body, Messages
      auto-opened, status bar red badge.
- [ ] Screenshot reproducer (failed SELECT) now shows the error card in the
      tab with `Run N · <first 30 chars of SQL>` title.
- [ ] Tab labels are unique and informative — every tab with non-empty SQL or
      `r.label` shows the statement/table hint, not just `Stmt M`.
- [ ] `extension.ts` change is additive — no existing path is restructured.
- [ ] Status bar error badge is set on first error AND cleared on next
      healthy `run()`.

## Dependencies

- TASK-UX2-001, TASK-UX2-002, TASK-UX2-003 (all must be merged before this task
  runs).

## Interfaces

- Consumes:
  - `QueryRunner.runFailed(reason: string): void` (TASK-UX2-003)
  - `createStatusBar(mgr).setErrorBadge(reason: string | null)` (TASK-UX2-003)
  - `tabTitle` / `tabBadge` (TASK-UX2-002) — used by the webview to render the
    correct tab title; integration asserts the host emits the right
    `StatementResult` shape that the webview can render.
- Produces:
  - Wired `runStatements` first-connect-error path that flows through the
    entire error surface (host + webview + status bar).

---

## Discussion

(no comments yet)

---

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Wired runStatements outer-catch to runner.runFailed(reason) + statusBar.setErrorBadge(reason) for first-connect failures; added statusBar.setErrorBadge(null) on healthy runs and on per-statement error rows (post-connect runQuery path); exported runStatements with new statusBar parameter; created 4 integration tests exercising the full outer-catch → runFailed → onUpdate → panel.render chain.
TEST_PLAN_FOLLOWED: task §Test Cases (inline — wrote 4 cases per the spec table before implementation)
FILES_CHANGED:
  - src/extension.ts: exported runStatements (5th param `statusBar: StatusBarWrapper`); rewired outer catch from toast to runner.runFailed + setErrorBadge; added setErrorBadge(null) on healthy path + setErrorBadge(erroredRow.error) on per-statement error rows; threaded statusBar through runQueryFromEditor, runStatement, commandOpenConsole, commandOpenConsoleForObject, openConsoleWithTemplate, commandGenerateObjectDdl and all their call sites.
  - src/extension.test.ts: updated TASK-BQ03-005 #5 edge test to assert runner.runFailed is called with the sanitized BQ reason instead of vscode.window.showErrorMessage (outer-catch behavior change mandated by this task).
  - src/ui/__tests__/resultsPanelErrorIntegration.test.ts: new file with 4 integration cases (first-connect failure, post-connect runQuery error, status bar badge set+cleared across runs, healthy SELECT regression).
TESTS_ADDED:
  - src/ui/__tests__/resultsPanelErrorIntegration.test.ts: 4 cases ("case 1 — first-connect failure", "case 2 — post-connect runQuery error", "case 3 — status bar error badge set on first error, cleared (null) on next healthy run", "case 4 — regression: healthy SELECT still renders the grid; no error card").
VERIFICATION:
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > UnicDB@1.51.2 typecheck
    > tsc --noEmit

  command: npm run compile
  result: exit 0
  output_excerpt: |
    dist/extension.js 6.4mb
    esbuild: build complete

  command: npx vitest run src/ui/__tests__/resultsPanelErrorIntegration.test.ts
  result: 4 passed (4)
  output_excerpt: |
    ✓ src/ui/__tests__/resultsPanelErrorIntegration.test.ts  (4 tests) 7ms
    Test Files  1 passed (1)
    Tests  4 passed (4)

  command: npm test
  result: 3555 passed | 2 skipped (3557)
  output_excerpt: |
    Test Files  234 passed | 1 skipped (235)
    Tests  3555 passed | 2 skipped (3557)
    Duration  30.02s

ISSUES: TASK-BQ03-005 #5 edge test was asserting the legacy toast path; updated to assert the new TASK-UX2-004 synthetic-tab producer path (runFailed called with sanitized reason). All other baseline tests preserved.
HANDOFF_TO_REVIEWER: yes — both outer-catch wiring and the integration test surface are ready for review; the change is contained to the specified files + 1 test update to a BQ test broken by the task's mandated behavior change.
NEXT: ready for review.
```

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npm test src/ui/__tests__/resultsPanelErrorIntegration.test.ts && npm test
  result: typecheck exit 0; compile OK; 4/4 integration tests pass; full suite 3555 passed | 2 skipped (matches executor claim, >= baseline 3530|2)
TEST_PLAN_COVERAGE: all-followed — 4/4 plan cases implemented with real assertions on the real exported `runStatements` (real QueryRunner + real ResultsPanel, not stubbed renderers); case 1 pins the outer catch → runFailed → onUpdate → render chain and the synthetic-row shape; case 2 pins classifyPanelKind="card"; case 3 pins set+clear; case 4 pins the grid regression. One gap: report lacks RED_OUTPUT (see important finding).
FINDINGS:
  critical:
    - (none)
  important:
    - docs/AI_HANDOFF/tasks/TASK-UX2-004.md:96-141 — Executor Report has no RED_OUTPUT field. RULES.md:153 and executor.testFirstRequired=true require actual pre-implementation failing-test output in the report; sibling tasks UX2-001/UX2-003 both carried verified RED evidence. The tests themselves are real (reviewer re-ran them fresh and audited assertions), so this is a report-contract fix: append the RED evidence from the TDD run (failing vitest output for the 4 new cases before implementation). If test-first was not actually run, re-run the TDD cycle and paste the output.
  minor:
    - src/extension.ts:2649-2651 — belt-and-suspenders render double-renders in production (runFailed already fired onUpdate → panel.render with identical data). Idempotent, no user-visible dup; acceptable as-is, comment already documents why.
    - src/extension.ts:2652 — statusBar.setErrorBadge(reason) in the outer catch is not gated by `deactivating`, unlike the panel.render just above; a disposed StatusBarItem no-ops in VS Code so this is benign, but the inconsistency invites drift.
    - src/ui/__tests__/resultsPanelErrorIntegration.test.ts:323-363 — case 3 uses two separate FakeStatusBar instances (statusBar1/statusBar2) instead of one wrapper across failure→healthy, so the single-chip session lifecycle isn't pinned end-to-end here (wrapper flip behavior is covered by statusBar.test.ts case 6, hence minor).
    - src/ui/__tests__/resultsPanelErrorIntegration.test.ts — file lacks a trailing newline.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Code is correct and fully verified (all 4 verification commands re-run green by reviewer; outer catch call site, runFailed RunnerBusy interplay, badge lifecycle on both paths, and mock channels all confirmed sound). The only blocker is the missing RED_OUTPUT report field — a documentation fix, not a code fix.

### RED evidence (re-captured 2026-09-04, R2 follow-up)

The original executor did not paste the RED output for these 4 cases (wave 3 was committed as a single commit `a0da149`, so the pre-impl state was not preserved). To repair the report-contract gap, the orchestrator re-ran the TDD cycle on the working tree by temporarily reverting the `runStatements` outer-catch block in `src/extension.ts:2627-2652` to its pre-UX2-004 behavior (toast-only), keeping the integration test file in place, and running vitest. The captured failing output:

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB

 ❯ src/ui/__tests__/resultsPanelErrorIntegration.test.ts  (4 tests | 2 failed) 8ms
   ❯ ResultsPanel error integration — TASK-UX2-004 > case 1 — first-connect failure
     → expected "runFailed" to be called 1 times, but got 0 times
   ❯ ResultsPanel error integration — TASK-UX2-004 > case 3 — status bar error badge set on first error, cleared (null) on next healthy run
     → expected last "spy" call to have been called with [ 'ECONNREFUSED 127.0.0.1:5432' ]

⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ui/__tests__/resultsPanelErrorIntegration.test.ts > ResultsPanel error integration — TASK-UX2-004 > case 1 — first-connect failure
AssertionError: expected "runFailed" to be called 1 times, but got 0 times
 ❯ src/ui/__tests__/resultsPanelErrorIntegration.test.ts:257:26
    255|
    256|     // 1. The outer catch invoked runner.runFailed(reason).
    257|     expect(runFailedSpy).toHaveBeenCalledTimes(1);
       |                          ^
    258|     expect(runFailedSpy).toHaveBeenCalledWith(reason);

 FAIL  src/ui/__tests__/resultsPanelErrorIntegration.test.ts > ResultsPanel error integration — TASK-UX2-004 > case 3 — status bar error badge
AssertionError: expected last "spy" call to have been called with [ 'ECONNREFUSED 127.0.0.1:5432' ]
- Expected: Array [ "ECONNREFUSED 127.0.0.1:5432" ]
+ Received: undefined
 ❯ src/ui/__tests__/resultsPanelErrorIntegration.test.ts:340:38

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
```

**RED analysis — matches the TDD intent of the spec:**

- **Case 1 (RED)** — outer catch did not call `runner.runFailed(reason)`. Pre-UX2-004 behavior was a single `vscode.window.showErrorMessage` toast; the test pins the new `runFailed` contract. ✅ expected failure.
- **Case 2 (GREEN pre-impl)** — post-connect `runQuery` errors flow through `executeAll` directly (no outer-catch dependency), so the test passed even before the UX2-004 wiring. The TDD test surfaces a pre-existing capability, not a new one — case 2 is a regression guard for the `classifyPanelKind = "card"` fix from TASK-UX2-001.
- **Case 3 (RED)** — outer catch did not call `statusBar.setErrorBadge(reason)`. Pre-UX2-004 behavior had no badge at all. ✅ expected failure.
- **Case 4 (GREEN pre-impl)** — healthy SELECT regression; no catch path involved. ✅ expected pass.

The 2 RED / 2 GREEN pre-impl pattern is exactly what the spec implies: cases 1+3 are the new UX2-004 wiring (would fail without it); cases 2+4 are regression guards for TASK-UX2-001 (would already pass once that fix landed, regardless of UX2-004).

After the replay the impl was restored and full GREEN re-verified at `20:36:51` (4/4 pass, 731ms). No production code state was left disturbed.

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart (opus tier)
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npx vitest run src/ui/__tests__/resultsPanelErrorIntegration.test.ts && npm test
  result: typecheck OK, compile OK, 4/4 integration pass, 3555 passed | 2 skipped (3557)
TEST_PLAN_COVERAGE: all-followed — 4/4 spec cases implemented with real assertions; ≥2 edge-case minimum met (cases 1-3)
FINDINGS:
  critical:
    - (none)
  important:
    - docs/AI_HANDOFF/tasks/TASK-UX2-004.md (Executor Report) — RED_OUTPUT field missing; RULES.md:153 requires actual failing-test output, and TEST_PLAN_FOLLOWED is a bare claim. Fix: demonstrate RED by running the new test file against the pre-task implementation (e.g. checkout dc83a04's src/extension.ts while keeping the test file, run `npx vitest run src/ui/__tests__/resultsPanelErrorIntegration.test.ts`), paste the real failing output into the report, then re-verify GREEN and re-append the report.
  minor:
    - src/ui/__tests__/resultsPanelErrorIntegration.test.ts:217 — `lastStateMessages` helper is dead code (defined, never called); remove it or use it in an assertion.
    - src/extension.ts:2640,2652 — the toast fall-through and `statusBar.setErrorBadge(reason)` in the outer catch are not gated by `deactivating`, unlike every other panel/status write in this function (lines 2565, 2569, 2649, 2657); a first-connect failure settling during teardown can write a disposed StatusBarItem. Wrap both in `if (!deactivating)`.
    - src/extension.ts:2649-2651 — in the RunnerBusy overlap case (ownsRun=false), the belt-and-suspenders render posts a full `state` message using the stale invocation's header/appendBase while a live run is in flight; self-heals on the live run's next onUpdate, but gating on `ownsRun` would avoid the cosmetic stale header.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation is functionally correct and fully verified — outer catch → runFailed → onUpdate → panel.render → badge set/cleared all confirmed against real source (queryRunner.ts:281,350; statusBar.ts:115-137), and the TASK-BQ03-005 #5 test update is mandated by this task and preserves sanitization assertions. The only blocker is the missing RED evidence, a handoff-package contract gap, not a code defect.

---

## R3 Auto-fix (2026-09-04)

Applied R2 review fixes to address the minor findings:

1. **Dead `lastStateMessages` helper removed** — `src/ui/__tests__/resultsPanelErrorIntegration.test.ts:217-225` was unused, deleted.
2. **`deactivating` gate on outer-catch writes** — `src/extension.ts:2634-2653`: the entire outer-catch block (runFailed try/catch, belt-and-suspenders render, setErrorBadge) is now wrapped in `if (!deactivating)` so a first-connect failure settling during teardown cannot write to a disposed panel or StatusBarItem. Matches the gate already used on lines 2565, 2569, 2649, 2657.

VERIFICATION:
  - `npm run typecheck` exit 0
  - `npm test src/ui/__tests__/resultsPanelErrorIntegration.test.ts` 4/4 pass
  - `npm test` 3555 passed | 2 skipped (3557) — full suite preserved

---

## R3 Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart (opus tier, matches handoff.reviewer.model)
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm test src/ui/__tests__/resultsPanelErrorIntegration.test.ts && npm test
  result: typecheck exit 0; 4/4 integration tests pass (747ms fresh run); full suite 3555 passed | 2 skipped (3557) — >= baseline 3530|2
R2_FINDINGS_RESOLUTION:
  - RESOLVED — lastStateMessages dead helper: grep across src/ returns zero hits; the only remaining mentions are this task file's historical verdict/fix-log text. Test file confirmed clean.
  - RESOLVED — extension.ts deactivating gate: the entire outer-catch block (extension.ts:2634-2652) — runFailed try/catch, RunnerBusy toast fall-through (:2641), belt-and-suspenders render (:2650), setErrorBadge(reason) (:2651) — is now wrapped in `if (!deactivating)`, consistent with the pre-existing gates at :2565, :2569, :2657. The gate correctly also covers runFailed itself (it fires the onUpdate → panel.render chain).
  - RESOLVED (bonus) — R1 trailing-newline minor on the test file: file now ends with \n.
TEST_PLAN_COVERAGE: all-followed — 4/4 spec cases with real assertions; R2 RED-output blocker already satisfied by the appended RED evidence section (2 RED / 2 GREEN pre-impl, analyzed and plausible).
FINDINGS:
  critical:
    - (none)
  important:
    - (none)
  minor:
    - src/extension.ts:2650 — carried-over, known-accepted: in the RunnerBusy overlap case (ownsRun=false) the belt-and-suspenders render posts a full state message with the stale invocation's header/appendBase; self-heals on the live run's next onUpdate. Already documented in-code and in R1/R2 verdicts; explicitly not on the R2 fix list. No action required this cycle.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: R3 fix is minimal, correct, and verified fresh by the reviewer (typecheck + targeted 4/4 + full suite 3555|2). Both R2-requested fixes are in place with no new defects introduced; the single remaining minor is pre-existing and previously ruled acceptable. Handoff may proceed.

## Reviewer Verdict (re-pass)

VERDICT: approved_minor
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
  - npm run typecheck — exit 0
  - npm run compile — exit 0
  - npm test -- --run src/ui/__tests__/resultsPanelErrorIntegration.test.ts — 4 passed (4), fresh
  - npm test -- --run — 3555 passed | 2 skipped (3557); Test Files 234 passed | 1 skipped (235) — >= baseline 3530|2
RE_RED_EVIDENCE: ACCEPTED — evidence is real, not reconstructed: (1) commit a0da149 confirmed in git log as the single wave-3 commit matching the "pre-impl state not preserved" explanation; (2) RED output cites test lines 257/340 while the current file has those assertions at 244/327 — the 13-line offset exactly matches the R3 removal of the 13-line lastStateMessages helper (git diff), proving the paste predates the cleanup instead of being back-written to current line numbers; (3) "RUN v1.6.1" header and both assertion messages match vitest ^1.6.0 and the real assertions verbatim; (4) 2 RED / 2 GREEN is the mechanically expected result of reverting only the outer-catch block (case 2's badge rides on the healthy-path wiring at extension.ts:2611-2616, untouched by the revert); (5) restored impl confirmed at extension.ts:2634-2652 with full wiring inside the `if (!deactivating)` gate.
FINDINGS:
  critical: none
  important: none
  minor: src/extension.ts:2650 — carried-over known-accepted: RunnerBusy overlap belt-and-suspenders render posts a stale header/appendBase; self-heals on next onUpdate; documented in-code and in R1-R3 verdicts, explicitly out of fix scope.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: R2's sole blocker (missing RED evidence) is resolved with authentic captured output; append verified non-destructive (both original CHANGES-REQUESTED verdict blocks intact at task-file lines 145-165 and 214-233). R3 deactivating gate restructure also re-audited this pass — gate correctly covers runFailed, render, and setErrorBadge. Test file trailing-newline fix confirmed (file ends 0x0a, tests still 4/4). INDEX.md left to orchestrator per instruction.
