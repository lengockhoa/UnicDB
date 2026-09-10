# TASK-CLIP-004 — Save persistence pin: paste → Cmd/Ctrl+Enter posts one saveEdits batch

<!--
TESTS-ONLY wave-3 task: pins the end-to-end webview save contract for pasted edits.
Waits for TASK-CLIP-003 because it uses the debugClipboard.simulatePaste seam; its target
test file is new, so no file collision — the dependency is behavioral, not file-level.
-->

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (TASK-CLIP-004), §4 rows CLIP-004, §5 wave 3

## Goal

Prove the full clipboard→persist loop at the webview boundary: cells dirtied by a paste,
then Cmd/Ctrl+Enter (or the ✓ commit button) post exactly ONE `saveEdits` batch carrying
the dirty snapshot + `serverIndexByRowId`; `saveResult ok` clears the highlights; a refusal
shows the banner reason. Host-side save mechanics are already covered by
`resultsPanelSaveEdits.test.ts` — this task pins the webview half for paste-origin edits.

## Target Files

- `src/ui/__tests__/webviewClipboardSave.test.ts` — (new) jsdom bundle-eval save-pin suite.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `paste 2 cells then Cmd+Enter posts exactly one saveEdits` | exactly 1 `{type:"saveEdits"}`; `edits.length === 2`; `index === 0`; `tableName === null`; `pkColumns === []`; `serverIndexByRowId` maps `"0"`→`0`,`"1"`→`1` | 3×2 state; `__UnicDB.debugClipboard.simulatePaste("11\ta")` at focused (0,0) spans 2 cells; `new KeyboardEvent("keydown", {key:"Enter", metaKey:true})` on `.UnicDB-grid-host` (pattern: `webviewKeybinding.test.ts` K3) |
| 2 | happy | `Ctrl+Enter (ctrlKey variant) posts identically` | same message count + payload shape as #1 | same harness, `ctrlKey: true` |
| 3 | happy | `commit ✓ button persists pasted edits identically` | 1 `saveEdits` with same `edits.length` | `__UnicDB.commit()` (pattern: `tests/webviewEditHighlight.test.ts` #3) |
| 4 | edge (noop) | `Cmd+Enter with zero dirty posts nothing` | zero `saveEdits` posts (guard `webview/main.ts:3783`) | fresh bundle + state, no paste |
| 5 | edge (refused) | `refused saveResult shows banner reason and clears dirty` | after `{type:"saveResult", ok:true, refused:true, reason:"no PK"}`: `.UnicDB-save-banner` visible containing `"no PK"`; `dirtyCount === 0` | seed via simulatePaste then commit |
| 6 | edge (failure) | `ok:false errors banner; dirty preserved for retry` | banner shows joined `errors`; `dirtyCount` unchanged from pre-commit | paste 2 cells, commit, ack `ok:false, errors:["boom"]` |
| 7 | regression | `saveResult ok:true clears highlights (paste-origin)` | `dirtyCount === 0`; `gridHost.querySelectorAll(".UnicDB-cell-dirty").length === 0` (mirror of `webviewEditHighlight.test.ts` #5) | paste-origin dirty cells |
| 8 | regression | existing `webviewKeybinding.test.ts` K1-K3 + `webviewEditHighlight.test.ts` + `webviewSaveEdits.test.ts` suites | unchanged GREEN | existing files |

## Test Files

- `src/ui/__tests__/webviewClipboardSave.test.ts` — (new) contains tests #1-#7.

## Verification Commands

```bash
npm run typecheck
npm run compile        # REQUIRED — bundle tests eval dist/webview.js; a self-skip is a FAIL
npx vitest run src/ui/__tests__/webviewClipboardSave.test.ts src/ui/__tests__/webviewKeybinding.test.ts tests/webviewEditHighlight.test.ts src/ui/__tests__/webviewSaveEdits.test.ts
```

## Acceptance Criteria

- [ ] All §Test Cases GREEN (no silent bundle skips).
- [ ] Zero production files modified (`git status` shows only the new test file).
- [ ] `npm run typecheck` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CLIP-003 (consumes `__UnicDB.debugClipboard.simulatePaste` seam; its Cmd/Ctrl+V listener must already be wired so the paste-seed path equals the shipped path). Wave 3.

## Interfaces

- Consumes:
  - `__UnicDB.debugClipboard.simulatePaste(text: string): void` — produced by TASK-CLIP-003 (`webview/main.ts` debug block ~`:4523`).
  - `__UnicDB.commit` (= `onCommitClick`, `webview/main.ts:3782`) and the capture-phase Cmd/Ctrl+Enter listener (`main.ts:1355-1370`).
  - `SaveEditsMessage` shape — `src/ui/messages.ts:216-234`; `SaveResultMessage` — `messages.ts:260-287`.
  - Banner selection `.UnicDB-save-banner` + hidden-class contract (pattern: `webviewKeybinding.test.ts` B1).
- Produces: (none) — final acceptance pin for the cycle.

## Discussion

### 2026-09-10 · planner · unic/unic-smart
-> @executor: seed dirty cells via `simulatePaste` (or the CLIP-002 synthetic paste event if
the seam's shape differs at implementation time — check TASK-CLIP-003's Interfaces and the
actual debug block before writing; a mismatch is a Discussion-thread note, not a silent
re-implementation). Assert payload equality on `edits` as a SET of `rowId:colIndex` keys —
Map snapshot order is not contractual.

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: ImplementClipboardSaveTests
SUMMARY: Added the jsdom bundle-eval save persistence pin for paste-origin edits. The suite covers Cmd/Ctrl+Enter, commit(), no-op saves, refusal/error banners, retry preservation, and successful dirty-highlight clearing.
TEST_PLAN_FOLLOWED: task §4
FILES_CHANGED:
  - src/ui/__tests__/webviewClipboardSave.test.ts: Added seven paste-origin save persistence tests using debugClipboard.simulatePaste.
  - docs/AI_HANDOFF/tasks/TASK-CLIP-004.md: Appended this executor report.
TESTS_ADDED:
  - src/ui/__tests__/webviewClipboardSave.test.ts: paste 2 cells then Cmd+Enter posts exactly one saveEdits; Ctrl+Enter (ctrlKey variant) posts identically; commit ✓ button persists pasted edits identically; Cmd+Enter with zero dirty posts nothing; refused saveResult shows banner reason and clears dirty; failed save shows errors and preserves dirty edits for retry; saveResult ok:true clears paste-origin highlights.
RED: confirmed
RED_OUTPUT: |
  npx vitest run src/ui/__tests__/webviewClipboardSave.test.ts (exit 1)
  ❯ src/ui/__tests__/webviewClipboardSave.test.ts  (7 tests | 1 failed) 879ms
  ❯ src/ui/__tests__/webviewClipboardSave.test.ts > webview/main.ts bundle (TASK-CLIP-004 save persistence) > paste 2 cells then Cmd+Enter posts exactly one saveEdits
  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
  FAIL  src/ui/__tests__/webviewClipboardSave.test.ts > webview/main.ts bundle (TASK-CLIP-004 save persistence) > paste 2 cells then Cmd+Enter posts exactly one saveEdits
  AssertionError: expected [ …(2) ] to have a length of 3 but got 2
  ❯ src/ui/__tests__/webviewClipboardSave.test.ts:208:27
  Test Files 1 failed (1)
  Tests 1 failed (6 passed)
VERIFY: 3 commands, all pass
VERIFICATION:
  command: npm run typecheck
  result: exit code 0
  full_output: |
    > UnicDB@1.53.42 typecheck
    > tsc --noEmit
    Wall time: 1.49 seconds
  command: npm run compile
  result: exit code 0
  full_output: |
    > node esbuild.js
    dist/comparePanel.js 4.5kb
    dist/comparePanel.js.map 9.1kb
  command: npx vitest run src/ui/__tests__/webviewClipboardSave.test.ts src/ui/__tests__/webviewKeybinding.test.ts tests/webviewEditHighlight.test.ts src/ui/__tests__/webviewSaveEdits.test.ts
  result: 32 passed, 0 failed, exit code 0
  full_output: |
    ▲ [WARNING] Unrecognized target environment "ES2024" [tsconfig.json]
    Test Files 4 passed (4)
    Tests 32 passed (32)
    Start at 12: 55: 31
    Duration 1.99s (transform 114ms, setup 0ms, collect 182ms, tests 4.65s, environment 1.50s, prepare 165ms)
    ../../tsconfig.json: 3: 14:
    3 │ "target": "ES2024",
    ╵ ~~~~~~~~
ISSUES: npm emitted the existing ES2024 target warning; no test failures.
HANDOFF_TO_REVIEWER: yes — handoff.reviewer is enabled for this task.
NEXT: Ready for review; production files were untouched.

## Reviewer Verdict

(appended by Phase 4)
