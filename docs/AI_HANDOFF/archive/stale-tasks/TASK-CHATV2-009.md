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

- 2026-09-16 (executor): Landed in the order the contract demanded, one commit per
  milestone. `keyboard.ts` was green on first run (pure functions, no DOM). The two real
  RED moments are recorded below. Two implementation decisions worth a reviewer's eye:
  1. **The controller is the ONLY `window.message` listener.** The existing V1 suite's
     esbuild/jsdom harness captures whichever `window.message` handler is registered LAST;
     a second listener split the legacy frame stream and broke 36 tests. Fixed by making the
     controller own the single listener and forwarding non-V2 frames through an injected
     `onLegacyMessage` callback instead of installing a second listener — which is also the
     stricter reading of "one message effect".
  2. **The V1 composer card is archived, not deleted.** The contract rejects "two live UI
     trees behind a permanent flag", but also requires the legacy send path to be *reduced to
     a compatibility shim*. The card is kept in the DOM (V1 flows such as `/clear`, the slash
     dropdown and mention-token insertion still address `#prompt`) but is marked
     `data-chat-v1-archived` + `aria-hidden`, installs no submit keyboard path, and the V2
     `#promptV2` is the single transport-bearing input. Deletion stays in CHATV2-017.
  3. **Boot readiness rides the V2 seam only.** The host's `handleReady` is not idempotent
     (it re-posts the init/models/capabilities fan-out each call), so sending a legacy
     `{type:"ready"}` in addition to `{kind:"ready_v2"}` would have duplicated hydration.
     `ready` is no longer sent; `ready_v2` is.
  4. Three V1 tests pinned exactly the legacy `#prompt` Enter=send behavior this task
     removes; they were updated to assert the new single-owner contract (no legacy `send`
     from `#prompt`; `#promptV2` exists and owns the path) rather than deleted, so the
     regression intent survives.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -

RED_OUTPUT:
Files were written incrementally (one module + its test per commit). Real failing output,
not a fabricated RED:

1. `controller.test.ts` first run (2 genuine failures — both my test bugs, fixed):
```
 ❯ webview/aiChat/__tests__/controller.test.ts  (21 tests | 2 failed) 75ms
   ❯ ... > controller — submit dedupe and ack lifecycle > rapid Enter + pointer click emits exactly one submit_turn (one clientRequestId)
     → Cannot read properties of undefined (reading 'primaryButton')
   ❯ ... > controller — submit dedupe and ack lifecycle > busy phases refuse submit but keep the draft editable
     → expected 'two' to be 'one' // Object.is equality
 Tests  2 failed | 19 passed (21)
```
Fix 1: the harness never exposed `composer`; added `composer: controller.composer` to the harness.
Fix 2: my assertion was wrong — a busy turn keeps the NEXT draft the user typed (`two`), it
does not revert to the submitted text; corrected the expectation to `two`.

2. Step 3 first run (3 REAL regression failures from removing the legacy V1 keydown/send path —
   exactly the tests that pinned it):
```
 FAIL  src/ui/__tests__/aiChatPanelCloneWebview.test.ts > AiChatPanelCloneWebview — TASK-AGTUI-007 #5 legacy flows unchanged > #5b Enter on non-empty text posts {type:'send',text}
 FAIL  src/ui/__tests__/aiChatPanelWebviewTask002.test.ts > AiChatPanelWebview — Enter/Shift+Enter keybind (TASK-002 #3) > plain Enter sends + clears; Enter never inserts a newline
 FAIL  src/ui/__tests__/aiChatPanelWebviewTask005.test.ts > AiChatPanelWebview — Enter / Tab select, never send (TASK-005 #4) > #4c Enter with dropdown CLOSED still sends (wave-2 keybind preserved)
 Test Files  3 failed | 3 passed (6)
      Tests  3 failed | 139 passed (142)
```
Also caught en route: with two `window.message` listeners the V1 harness split the frame
stream (36 failures); resolved by making the controller the sole listener and forwarding
non-V2 frames via `onLegacyMessage`.

Verification Output:
```
$ npm test -- --run webview/aiChat/__tests__/keyboard.test.ts webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/composer.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
 ✓ webview/aiChat/__tests__/keyboard.test.ts  (23 tests) 7ms
 ✓ webview/aiChat/__tests__/composer.test.ts  (18 tests) 47ms
 ✓ webview/aiChat/__tests__/controller.test.ts  (21 tests) 81ms
 ✓ src/ui/__tests__/aiChatPanelWebview.test.ts  (43 tests) 279ms
 Test Files  4 passed (4)
      Tests  105 passed (105)

$ npm run typecheck
> tsc --noEmit
(exit 0)

$ npm run compile
esbuild: build complete
(exit 0)

Broad lane `npm test` (unbidden, run because removing legacy paths risks regressions):
Test Files  1 failed | 290 passed | 2 skipped (293)
     Tests  1 failed | 4360 passed | 5 skipped (4366)
The single failure is `src/__tests__/vsixSecretsExclusion.test.ts`, which shells out to
`node_modules/.bin/vsce`; no node_modules is installed in this worktree (the same
environmental ENOENT class as esbuild). Not a regression from this task.
```

Status: PASS

Note: The worktree has no installed dependencies; bundle-based V1 tests shell out to
`node_modules/.bin/esbuild`, which was ENOENT there. I linked the repo root's esbuild binary
into the worktree `node_modules/.bin` (gitignored, not committed) so those tests could
actually run. `node_modules/.bin/vsce` has no root binary to link, so that one test remains
unrunnable here — environmental, pre-existing, unrelated to this task.

HANDOFF_TO_REVIEWER: yes — executor model differs from the reviewer slot.
