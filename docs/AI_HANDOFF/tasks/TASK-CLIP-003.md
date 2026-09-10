# TASK-CLIP-003 — Active-range tiling fix + Cmd/Ctrl+V keyboard paste wiring + stale-range clear fix

<!--
The only wave-2 production task. Owns webview/main.ts + src/ui/messages.ts +
src/ui/resultsPanel.ts exclusively this wave. It ALSO owns the production correction for
the active-range tiling defect that TASK-CLIP-002's tests-only suite exposed (1×1 clipboard
into a 2×2 active range stamped `""` into the second column). TASK-CLIP-001/002 landed in
wave 1; TASK-CLIP-004 is tests-only and waits for this task's seam.
Dependencies: `none` — CLIP-002's regression already exists on disk and must be re-run
GREEN here, not waited on. Wave placement is an operational serialization point.
-->

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (TASK-CLIP-003 incl. the added tiling correction), §4 rows "regression (CLIP-002 → CLIP-003)" + CLIP-003, §5 wave 2

## Goal

Make Cmd/Ctrl+V paste the OS clipboard into the results grid exactly like a real `paste`
event, fix the stale-range defect (`suppressNextCellClickClear` written at
`webview/main.ts:479,1260` but never read) so clicking a non-cell area clears the active
rectangle instead of silently redirecting the next copy/paste, and repair the
active-range tiling defect in `pasteIntoRange` (`webview/main.ts:3417`) so a clipboard
narrower than the active range tiles across every visible target column instead of
padding the overhang with `""`.

## Target Files

- `webview/main.ts` — (a) fix `pasteIntoRange` column tiling: the per-target-column slice
  at `main.ts:3464` uses `row[srcColOffset] ?? ""`, so a 1×1 clipboard into a 2×2 range
  writes `"z"` to column 0 and `""` to column 1. Tile the source column instead
  (`row[srcColOffset % row.length]`, keeping the empty-row fallback) so a 1×1 value fills
  the whole range while multi-column clipboards, hidden-column exclusion, row tiling and
  clipping stay unchanged. TASK-CLIP-002's `webviewClipboardPaste.test.ts` is the frozen
  contract — fix production, never the test. (b) add capture-phase Cmd/Ctrl+V keydown
  listener (guard `isFilterInput`; `preventDefault`/`stopPropagation`; posts new
  `readClipboard` message; on `clipboardText` reply dispatches the SAME `onGridPaste` path
  with the received text — exactly one application per chord, no double-fire with any
  native paste event); (c) consume `suppressNextCellClickClear` in the capture `mousedown`
  listener: when `findCellFromEvent(ev)` returns null (toolbar/header/footer/non-cell) call
  `setCellRange(null)` unless the flag is set; reset the flag after every mousedown that
  reads it; (d) add `__UnicDB.debugClipboard = { simulatePaste(text), getCellRange() }`
  test seam next to the existing debug object (`main.ts:4523`).
- `src/ui/messages.ts` — additive message types: `ReadClipboardMessage { type:
  "readClipboard" }` (webview→host) and `ClipboardTextMessage { type: "clipboardText";
  text: string }` (host→webview); extend `WebviewMessage` + `HostMessage` unions.
- `src/ui/resultsPanel.ts` — handle `case "readClipboard":` inside `handleMessage`
  (`resultsPanel.ts:923`): `const text = await vscode.env.clipboard.readText();
  this.postMessage({ type: "clipboardText", text });` — symmetric with the existing
  `copy` write case at `resultsPanel.ts:1033-1036`.
- `src/ui/__tests__/webviewKeybinding.test.ts` — (existing) extend with the CLIP-003 cases
  below (it already loads the bundle + dispatches Cmd chords).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `Cmd+V pastes host clipboard text through the round-trip` | webview posts `{type:"readClipboard"}`; test stub replies `clipboardText` `"7\tseven"`; `dirtyCount === 2` at focused anchor; exactly ONE application (no double paste) | bundle loaded; `api.setFocusedCell(0,"id")`; fake host answers the `readClipboard` post via `__UnicDB.postMessage` echo |
| 2 | happy | `Ctrl+V (ctrlKey variant) behaves identically` | same as #1 with `ctrlKey: true, metaKey: false` | same harness |
| 3 | happy (production regression) | `1x1 clipboard tiles across every visible cell of the active range` | all four cells of the 2×2 range are `"z"`; `dirtyCount === 4`; the second column is NOT `""` | **Owned, frozen test = TASK-CLIP-002 `webviewClipboardPaste.test.ts` case `1x1 clipboard tiles into active 2x2 range`, currently RED with `0:0="z", 0:1="", 1:0="z", 1:1=""`; drag-range fixture + paste `"z"`. This task MUST make it GREEN by editing production only.** |
| 4 | edge (stale-range, regression-vs-defect) | `click on non-cell clears stale range → paste anchors at focused cell` | after drag-range + toolbar click, `__UnicDB.debugClipboard.getCellRange()` returns `null`; paste lands at focused cell, NOT tiled into the dead rectangle | drag 2×2 range via mouse events; `mousedown` on toolbar element (outside `.ag-cell`); RED before fix: flag never read, range survives |
| 5 | edge (input) | `Cmd+V with focus in filter input is not intercepted` | zero dirty; zero `readClipboard` posts; `isFilterInput` guard holds | `<input>` inside gridWrap, focused (pattern: `webviewKeybinding.test.ts` K1) |
| 6 | edge (permission) | `clipboardText with empty string is a silent no-op` | zero dirty; no state change; no crash | host replies `text: ""` |
| 7 | edge (permission) | `readClipboard with no active connection/statement still round-trips` | host still replies `clipboardText`; webview paste into empty grid is a safe no-op | bundle without prior `state` dispatch (fresh `ready` path) |
| 8 | regression | existing keybinding suite K1-K3 + `webviewBundle` copy tests + drag-range tests (`tests/webviewEditHighlight.test.ts`) | unchanged GREEN | existing files |
| 9 | regression | `aiChatPanelCloneCss.test.ts` structural pins (incl. `UnicDB-cell-range` CSS + toolbar column contract) | unchanged GREEN | existing file |
| 10 | regression (cross-task) | full TASK-CLIP-002 suite `src/ui/__tests__/webviewClipboardPaste.test.ts` (9 tests) | GREEN — in particular the formerly RED `1x1 clipboard tiles into active 2x2 range`; this is the acceptance proof for the tiling fix | existing test file, NOT edited by this task |

## Test Files

- `src/ui/__tests__/webviewKeybinding.test.ts` — extend with tests #1-#2 and #4-#7.
- `src/ui/__tests__/webviewClipboardPaste.test.ts` — (existing, owned by TASK-CLIP-002) MUST
  be re-run GREEN; its `1x1 clipboard tiles into active 2x2 range` case is the production
  regression proof for the tiling fix. Do NOT edit this file — a failure here means the
  production fix is wrong, not the test.

## Verification Commands

```bash
npm run typecheck
npm run compile        # REQUIRED — webview/main.ts changed; stale dist/webview.js self-skips
# The CLIP-002 suite below is NOT optional: it carries the formerly RED 1x1 → 2x2 tiling case.
npx vitest run src/ui/__tests__/webviewKeybinding.test.ts src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/webviewBundle.test.ts tests/webviewEditHighlight.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
```

## Acceptance Criteria

- [ ] `pasteIntoRange` tiles a clipboard narrower than the active range across every visible
      target column: TASK-CLIP-002's `1x1 clipboard tiles into active 2x2 range` is GREEN
      (RED before this fix); no `""` overhang edits; multi-column pastes unchanged.
- [ ] Cmd+V and Ctrl+V each apply exactly one paste; `isFilterInput` guard verified.
- [ ] `suppressNextCellClickClear` is now READ at a mousedown clear path; non-cell click clears `cellRange`+`cellRangeAnchor` (test #4 RED before fix, GREEN after).
- [ ] `readClipboard`/`clipboardText` messages are additive; unknown-type fall-through untouched; stale bundles safe.
- [ ] `npm run typecheck` exit 0; `npm run compile` clean before tests; all listed suites GREEN.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none. (Implementation-discovery revision: this task originally listed TASK-CLIP-002 as a
  dependency. CLIP-002 is tests-only and its suite — including the failing 1×1 → 2×2 tiling
  regression — already exists on disk, so there is nothing to wait for; the regression is a
  required verification target of THIS task instead. The wave-2 placement is operational
  serialization: this task remains the only production task in that wave, and TASK-CLIP-004
  still depends on the `debugClipboard` seam produced here.)

## Interfaces

- Consumes:
  - `onGridPaste(ev: ClipboardEvent): void` — `webview/main.ts:3300` (the wiring must funnel into this dispatch, not re-implement tiling).
  - `pasteIntoRange(range: CellRange, parsed: string[][]): void` — `webview/main.ts:3417`, called from `onGridPaste`; the defective per-column slice is at `main.ts:3464`; the helper it delegates to is `applyRangePasteToDirty` — `src/ui/resultsGridModel.ts:1387` (already tiles rows via `parsed[r % parsed.length]`, line 1408).
  - `postToHost(msg)` / host `handleMessage(msg: WebviewMessage)` — `resultsPanel.ts:923`; `vscode.env.clipboard` read at host.
  - `setCellRange(range: CellRange | null): void` — `webview/main.ts:548`; `findCellFromEvent` — `main.ts:1308`; flag `suppressNextCellClickClear` — `main.ts:479`.
  - From TASK-CLIP-002: its frozen `webviewClipboardPaste.test.ts` suite (re-run, never edited) + synthetic paste-event harness + `editState`/`undoStack` seams.
- Produces:
  - Corrected `pasteIntoRange` column-tiling behavior in `webview/main.ts` — signature unchanged, semantics now total over the active range (no `""` padding for a narrower clipboard).
  - `ReadClipboardMessage { type: "readClipboard" }` and `ClipboardTextMessage { type: "clipboardText"; text: string }` in `src/ui/messages.ts` (TASK-CLIP-004 does not consume them but must not collide with the union).
  - `__UnicDB.debugClipboard = { simulatePaste(text: string): void; getCellRange(): CellRange | null }` — `webview/main.ts:4523` block (TASK-CLIP-004 tests MAY use `simulatePaste` to seed dirty cells).

## Discussion

### 2026-09-10 · planner · unic/unic-smart
-> @executor: the keydown handler MUST NOT call `navigator.clipboard.readText()` — VS Code
webviews deny clipboard-read permission silently and jsdom cannot test it; the host
round-trip is the only reliable seam (mirrors the `copy` write path). The Cmd/Ctrl+V
listener goes on `gridWrap` in capture phase exactly once (A16 double-fire rule,
`main.ts:2505-2509`). For test #1, the fake host loop: capture the `readClipboard` post
from the `acquireVsCodeApi` sink, then call `dispatchHost({type:"clipboardText", text})` —
same echo pattern as `webviewKeybinding.test.ts` `dispatchHost`.

### 2026-09-10 · planner · unic/unic-smart — implementation-discovery revision
-> @executor: TASK-CLIP-002's wave-1 run exposed a REAL production defect, not a bad test.
`pasteIntoRange` (`webview/main.ts:3417`) builds each target column's clipboard slice with
`row[srcColOffset] ?? ""` (`main.ts:3464`); when the clipboard is narrower than the active
range the overhang columns are stamped with `""` — observed as
`0:0="z", 0:1="", 1:0="z", 1:1=""` for a 1×1 `"z"` pasted into a 2×2 range. Row tiling is
already handled by `applyRangePasteToDirty` (`resultsGridModel.ts:1408`); column tiling is
missing. This task now owns that correction (test case #3/#10). The CLIP-002 test file is
FROZEN: fix production, never the test. This task's `Dependencies` is relaxed to `none`
because the failing regression already exists on disk — there is nothing to wait for, and
the pre-existing dependency risked being read as "blocked by a failing task". Wave-2
serialization and TASK-CLIP-004's dependency on this task's `debugClipboard` seam are
unchanged.

---

## Executor Report

EXECUTOR_TOOL: omp
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: ImplementClipboardWiring
RED_OUTPUT:
```text
Command: npx vitest run src/ui/__tests__/webviewKeybinding.test.ts --reporter=verbose
Exit code: 1
× Cmd+V pastes host clipboard text through the round-trip exactly once → expected false to be true
× Ctrl+V behaves identically to Cmd+V → expected [] to have a length of 1 but got +0
× clicking a non-cell clears stale range before paste → expected null to be truthy
× clipboard round-trip without state is a safe no-op → expected [] to have a length of 1 but got +0
Test Files 1 failed (1); 4 failed, 7 passed
```
Verification Output:
```text
$ npm run typecheck
> UnicDB@1.53.42 typecheck
> tsc --noEmit
exit 0

$ npm run compile
> node esbuild.js
dist/comparePanel.js 4.5kb
dist/comparePanel.js.map 9.1kb
exit 0

$ npx vitest run src/ui/__tests__/webviewKeybinding.test.ts
Test Files 1 passed (1)
Tests 11 passed (11)
exit 0

$ npx vitest run src/ui/__tests__/webviewClipboardPaste.test.ts
Test Files 1 passed (1)
Tests 9 passed (9)
exit 0

$ npx vitest run src/ui/__tests__/webviewKeybinding.test.ts src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/webviewBundle.test.ts tests/webviewEditHighlight.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
Test Files 5 passed (5)
Tests 44 passed (44)
exit 0
```
Status: PASS
Summary: Fixed active-range column tiling, added host-mediated Cmd/Ctrl+V with clipboardText routing, consumed stale range clear state, and exposed the debugClipboard seam. Added six keybinding regression cases covering both modifiers, stale ranges, filter inputs, empty clipboard, and no-state safety.
Files Changed:
  - webview/main.ts: active-range tiling, shortcut/host round-trip, stale-range clearing, debug seam
  - src/ui/messages.ts: additive readClipboard/clipboardText unions
  - src/ui/resultsPanel.ts: host clipboard read handler
  - src/ui/__tests__/webviewKeybinding.test.ts: Cmd/Ctrl+V and edge-case regression tests
Tests Added:
  - src/ui/__tests__/webviewKeybinding.test.ts: Cmd+V round-trip, Ctrl+V variant, stale range clear, filter guard, empty clipboard, no-state safety
Note: npm emitted the existing ES2024 target warning during Vitest; all required commands passed.

## Reviewer Verdict

(appended by Phase 4)
