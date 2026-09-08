# TASK-AGTUI-004 — Composer module: `+` / model chip / `/` affordance / bypass toggle / mic / send-stop

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3, §4

## Goal

New pure-DOM webview module building the Claude Code–style sticky composer: attach strip + multiline textarea + bottom control row (`+` attach, model chip dropdown, `/` slash affordance, bypass-permissions toggle default OFF, mic placeholder, send button that swaps to a red square stop while busy, plus the legacy action buttons `#resumeBtn` / `#clearBtn` / `#regenerateBtn` — icon-only, one inline SVG each, living in the composer row and owned HERE per the PLAN §3 element-id contract, not in main). Preserves all existing element ids. Busy-disable contract (pinned by `aiChatPanelWebview.test.ts:788-801` `#AG4`): send-in-flight sets `disabled` on `sendBtn`/`resumeBtn`/`regenerateBtn`/`attachBtn`, `done` re-enables; `clearBtn` is never disabled by busy (legacy `setBusy`, `webview/aiChatPanelMain.ts:466-478`). Emits intent via callbacks; no host wiring.

## Target Files

- `webview/aiChatPanelComposer.ts` (new) — exports `renderComposer` factory.
- `webview/__tests__/aiChatPanelComposer.test.ts` (new) — jsdom unit test.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | renders full clone row | composer element contains ids `prompt`, `sendBtn`, `stopBtn`, `attachBtn`, `attachStrip`, `modelChipBtn`, `bypassToggle`, `micBtn`, `slashHintBtn`; textarea placeholder non-empty; aria-labels present on all buttons | empty jsdom document |
| 2 | edge (state/boundary) | busy swap to red square stop | `setBusy(true)` → `sendBtn` hidden+disabled, `stopBtn` visible with class `UnicDB-chat-stop UnicDB-chat-stop-live` (pulse class); `setBusy(false)` → inverse; prompt disabled while busy | toggle twice, assert both directions |
| 3 | edge (default value) | bypass defaults OFF | `bypassToggle` initial `aria-checked="false"`, no `UnicDB-chat-toggle-on` class; click → callback `onBypassChange(true)` + ON class + `aria-checked="true"`; second click → `onBypassChange(false)` (exact alternation) | fresh composer |
| 4 | edge (empty) | empty models list | `setModels([], "work")` → chip disabled, label `No models configured`, clicking it fires no callback | empty list |
| 5 | edge (selection) | chip dropdown select | `setModels([{role:"work",modelId:"gpt-x",vision:false},{role:"smart",modelId:"o3",vision:true}], "smart")` → chip label shows active (`smart` · `o3`); opening menu renders one row per entry (textContent = role · modelId); clicking `work` row fires `onModelSelect("work")` exactly once and closes menu | 2-entry list |
| 6 | edge (input guard) | send only when text non-empty | `onSend` fires with trimmed-nonempty value; whitespace-only value fires nothing (button click path) | `"   "` vs `"hi"` |
| 7 | happy | legacy action buttons render in composer row | composer renders `resumeBtn`, `clearBtn`, `regenerateBtn` as `<button>` elements with those exact `id` attributes and the legacy icon-only affordance (one inline SVG each — the six-button id list incl. these three is pinned by `aiChatPanelBundle.test.ts:237-240` and `aiChatPanelWebview.test.ts:519-523`) | empty jsdom document |
| 8 | edge (state) | busy-disable set matches legacy contract | `setBusy(true)` → `sendBtn`, `resumeBtn`, `regenerateBtn`, `attachBtn` all report `disabled === true`; `clearBtn` is untouched (`disabled === false`); `setBusy(false)` → all four re-enabled (mirrors `aiChatPanelWebview.test.ts:788-801` `#AG4`, which TASK-AGTUI-007 must pass UNMODIFIED) | fresh composer, toggle both directions |

## Test Files

- `webview/__tests__/aiChatPanelComposer.test.ts` (new)

## Verification Commands

```bash
npx vitest run webview/__tests__/aiChatPanelComposer.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; no `vscode` import; slash `/` button inserts `/` into the textarea + focuses it (dropdown behavior itself stays in main, TASK-AGTUI-007); mic is rendered `disabled` with `title="Voice input (coming soon)"`.
- [ ] Model chip menu closes on outside click / Escape (assertable via dispatched events).

## Dependencies

- none

## Interfaces

- Consumes: CSS classes `.UnicDB-chat-input`, `.UnicDB-chat-actions`, `.UnicDB-chat-chip`, `.UnicDB-chat-chipmenu`, `.UnicDB-chat-toggle(-on)`, `.UnicDB-chat-stop(-live)`, `.UnicDB-chat-primary/secondary`, `.UnicDB-chat-attachments` from TASK-AGTUI-001.
- Produces (exact signature — consumed by TASK-AGTUI-007):
```ts
export interface ComposerModelEntry { role: string; modelId: string; vision: boolean }
export interface ComposerCallbacks {
  onSend(text: string, attachments: ComposerAttachment[]): void;
  onStop(): void;
  onModelSelect(role: string): void;
  onBypassChange(enabled: boolean): void;
  onAttachPicker(): void;          // "+" click — main owns the hidden file input
}
export interface UnicDBComposer {
  el: HTMLElement;
  setBusy(busy: boolean): void;
  setModels(entries: ComposerModelEntry[], active: string): void;
  setBypass(enabled: boolean): void;
  setVisionCapable(capable: boolean): void;  // false → disables "+" + shows amber notice slot
  value(): string; setValue(v: string): void; // textarea access for main's slash/mention logic
  attachments(): ComposerAttachment[]; addAttachments(files: FileList): void; clearAttachments(): void;
}
export function renderComposer(root: HTMLElement, cb: ComposerCallbacks): UnicDBComposer;
export interface ComposerAttachment { id: string; mime: string; base64: string; bytes: number }
```
  Note: `onSend` does NOT post — main keeps slash interception, mention dropdown, `liveTurnPending`, bubble echo (existing behavior in `aiChatPanelMain.ts` `wireControls()` lines 713-790).

### 2026-09-08 · planner · unic-smart
Attachment dedupe/limits stay in main (existing `state.attachments` flow); composer only collects Files → base64 entries exactly like the current attach strip does.

## Executor Report

```
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (initial) Failed to resolve import "../aiChatPanelComposer" — confirmed RED.
Verification Output: vitest run webview/__tests__/aiChatPanelComposer.test.ts → 8 tests passed; npm run typecheck → 0 errors; tsc --noEmit -p tsconfig.webview.json → no errors in composer file.
Status: PASS
Note: Pre-existing webview/main.ts, newTableFormMain.ts, renameFormMain.ts, schemaFormMain.ts typecheck errors are unrelated to this task and were present before my change. Composer is wired for the existing aiChatPanelMain.ts setBusy contract (send/resume/regenerate/attach disabled while busy; clearBtn untouched) and consumes styles.css CSS classes from TASK-AGTUI-001.
```

---

## Reviewer Verdict

(appended below by reviewer)
