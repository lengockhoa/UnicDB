# TASK-CHATV2-009 — Single keyboard and composer controller

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4

## Goal
Make one controller the only owner of composer keyboard precedence, submit/stop dedupe, focus and semantic host intents. Remove every competing V1 Enter/send path in the same task.

## Target Files
- `webview/aiChat/controller.ts` — new store/render/transport coordinator.
- `webview/aiChat/keyboard.ts` — pure key-decision and text-range helpers.
- `webview/aiChatPanelMain.ts` — boot controller; remove legacy composer capture/bubble behavior.
- `webview/aiChatPanelComposer.ts` — remove independent keydown submit path or reduce to compatibility shim.
- `webview/aiChat/__tests__/keyboard.test.ts` — precedence and text edit tests.
- `webview/aiChat/__tests__/controller.test.ts` — dedupe/ack/focus/disposal tests.

## Required Work / Exact Spec
Install exactly one capture-phase `keydown` on `promptV2`, plus compositionstart/compositionend state. Precedence: (1) `event.isComposing || composing || keyCode===229` → no prevent/select/send; (2) Shift+Enter → prevent, insert exactly `\n` over current selection, preserve both sides/caret, increment revision, close slash/mention, auto-grow; (3) focused permission sheet delegates; (4) open autocomplete handles Up/Down/PageUp/PageDown/Enter/Tab/Escape; (5) Ctrl/Cmd+Enter prevents chat submit and leaves text; (6) plain Enter submits only valid draft in idle/completed/failed; (7) otherwise native behavior.

Enter selection in autocomplete never submits. Shift+Enter wins even with autocomplete open. Escape closes one transient surface without clearing text or stopping a turn. Busy phases validating/connecting/waiting/streaming/permission/stopping cannot submit; draft remains editable. Pointer send and keyboard send route to one `requestSubmit()` with an in-memory pending clientRequestId lock. Rapid Enter/click emits one `submit_turn`. Draft clears only on matching host `turn_started` ack; rejection preserves it. Stop emits one `stop_turn` per active turn and 250ms primary-control lock; terminal event releases it.

Controller acquires VS Code API once, owns `window.message`, invokes reducer, batches render, dispatches semantic intents and disposes all listeners/timers. Repeated mount/dispose cannot duplicate listeners. IDs are minted through injectable ID source for deterministic tests; clock/scheduler injectable. Component modules cannot import/acquire VS Code API.

Implement text insertion as pure `replaceSelection(text,start,end,"\n")`; correctly handle start/end 0, reversed/clamped indexes, CRLF-containing existing text without normalization of untouched content and emoji surrogate pairs by JS string offsets.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | keyboard | plain Enter | one valid idle submit; empty sends zero |
| 2 | keyboard | Shift+Enter all modes | one newline, zero select/send, popover closes |
| 3 | IME | composing Enter/229 | no send/select/prevent corruption |
| 4 | modifier | Ctrl/Cmd+Enter | no chat submit; text unchanged |
| 5 | race | Enter + double click | exactly one clientRequestId/intent |
| 6 | regression | busy drafting | input changes state; Enter sends/queues zero |
| 7 | ack | rejected/accepted submit | preserve draft on reject, clear only matching ack |
| 8 | lifecycle | remount/dispose | one listener/message effect, timers disposed |

## Test Files
- `webview/aiChat/__tests__/keyboard.test.ts`
- `webview/aiChat/__tests__/controller.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/keyboard.test.ts webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/composer.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] One and only one send/keyboard controller exists.
- [ ] KBD-01 through KBD-08 from professional spec pass.
- [ ] Submit/stop are deduplicated and host-acknowledged.
- [ ] Busy next-draft behavior never invents queue semantics.

## Dependencies
- TASK-CHATV2-008

## Interfaces
- Consumes: reducer/store, `ComposerView/Callbacks`, `AiChatWebviewIntentV2` transport.
- Produces: `createChatController(options)`, `decideComposerKey()`, `replaceSelection()` for 010–017.

## Discussion
(no comments yet)
