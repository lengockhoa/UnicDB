# TASK-CLIP-004 — Save persistence pin: paste → Cmd/Ctrl+Enter posts one saveEdits batch

<!--
TESTS-ONLY wave-3 task: pins the end-to-end webview save contract for pasted edits.
Waits for TASK-CLIP-003 because it uses the debugClipboard.simulatePaste seam; its target
test file is new, so no file collision — the dependency is behavioral, not file-level.
-->

- Status: `ready`
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

(appended by Phase 3)

## Reviewer Verdict

(appended by Phase 4)
