# TASK-CLIP-003 — Cmd/Ctrl+V keyboard paste wiring + stale-range clear fix

<!--
The only wave-2 production task. Owns webview/main.ts + src/ui/messages.ts +
src/ui/resultsPanel.ts exclusively this wave (TASK-CLIP-001/002 are tests-only and landed
in wave 1; TASK-CLIP-004 is tests-only and waits for this task in wave 3).
-->

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (TASK-CLIP-003), §4 rows CLIP-003, §5 wave 2

## Goal

Make Cmd/Ctrl+V paste the OS clipboard into the results grid exactly like a real `paste`
event, and fix the stale-range defect (`suppressNextCellClickClear` written at
`webview/main.ts:479,1260` but never read) so clicking a non-cell area clears the active
rectangle instead of silently redirecting the next copy/paste.

## Target Files

- `webview/main.ts` — add capture-phase Cmd/Ctrl+V keydown listener (guard `isFilterInput`;
  `preventDefault`/`stopPropagation`; posts new `readClipboard` message; on `clipboardText`
  reply dispatches the SAME `onGridPaste` path with the received text — exactly one
  application per chord, no double-fire with any native paste event); consume
  `suppressNextCellClickClear` in the capture `mousedown` listener: when
  `findCellFromEvent(ev)` returns null (toolbar/header/footer/non-cell) call
  `setCellRange(null)` unless the flag is set; reset the flag after every mousedown that
  reads it; add `__UnicDB.debugClipboard = { simulatePaste(text), getCellRange() }` test
  seam next to the existing debug object (`main.ts:4523`).
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
| 3 | edge (stale-range, regression-vs-defect) | `click on non-cell clears stale range → paste anchors at focused cell` | after drag-range + toolbar click, `__UnicDB.debugClipboard.getCellRange()` returns `null`; paste lands at focused cell, NOT tiled into the dead rectangle | drag 2×2 range via mouse events; `mousedown` on toolbar element (outside `.ag-cell`); RED before fix: flag never read, range survives |
| 4 | edge (input) | `Cmd+V with focus in filter input is not intercepted` | zero dirty; zero `readClipboard` posts; `isFilterInput` guard holds | `<input>` inside gridWrap, focused (pattern: `webviewKeybinding.test.ts` K1) |
| 5 | edge (permission) | `clipboardText with empty string is a silent no-op` | zero dirty; no state change; no crash | host replies `text: ""` |
| 6 | edge (permission) | `readClipboard with no active connection/statement still round-trips` | host still replies `clipboardText`; webview paste into empty grid is a safe no-op | bundle without prior `state` dispatch (fresh `ready` path) |
| 7 | regression | existing keybinding suite K1-K3 + `webviewBundle` copy tests + drag-range tests (`tests/webviewEditHighlight.test.ts`) | unchanged GREEN | existing files |
| 8 | regression | `aiChatPanelCloneCss.test.ts` structural pins (incl. `UnicDB-cell-range` CSS + toolbar column contract) | unchanged GREEN | existing file |

## Test Files

- `src/ui/__tests__/webviewKeybinding.test.ts` — extend with tests #1-#6.
- `src/ui/__tests__/webviewClipboardPaste.test.ts` — regression reference (must stay GREEN).

## Verification Commands

```bash
npm run typecheck
npm run compile        # REQUIRED — webview/main.ts changed; stale dist/webview.js self-skips
npx vitest run src/ui/__tests__/webviewKeybinding.test.ts src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/webviewBundle.test.ts tests/webviewEditHighlight.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
```

## Acceptance Criteria

- [ ] Cmd+V and Ctrl+V each apply exactly one paste; `isFilterInput` guard verified.
- [ ] `suppressNextCellClickClear` is now READ at a mousedown clear path; non-cell click clears `cellRange`+`cellRangeAnchor` (test #3 RED before fix, GREEN after).
- [ ] `readClipboard`/`clipboardText` messages are additive; unknown-type fall-through untouched; stale bundles safe.
- [ ] `npm run typecheck` exit 0; `npm run compile` clean before tests; all listed suites GREEN.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CLIP-002 (its paste-semantics pin suite must exist GREEN before this wiring changes the entry path; also produces the synthetic-clipboard harness this task's tests reuse). Wave 2.

## Interfaces

- Consumes:
  - `onGridPaste(ev: ClipboardEvent): void` — `webview/main.ts:3300` (the wiring must funnel into this dispatch, not re-implement tiling).
  - `postToHost(msg)` / host `handleMessage(msg: WebviewMessage)` — `resultsPanel.ts:923`; `vscode.env.clipboard` read at host.
  - `setCellRange(range: CellRange | null): void` — `webview/main.ts:548`; `findCellFromEvent` — `main.ts:1308`; flag `suppressNextCellClickClear` — `main.ts:479`.
  - From TASK-CLIP-002: synthetic paste-event harness + `editState`/`undoStack` seams.
- Produces:
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

---

## Executor Report

(appended by Phase 3)

## Reviewer Verdict

(appended by Phase 4)
