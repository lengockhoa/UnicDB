# TASK-CHATV2-012 — Engine/model menus and acknowledged switching

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§4–6

## Goal
Implement truthful engine and model selection with capability-gated rows, full four-engine support, host acknowledgements and unsent-draft preservation.

## Target Files
- `webview/aiChat/engineModelMenus.ts` — engine/model listboxes and confirmation flow.
- `webview/aiChat/header.ts` — session title/engine pill/overflow shell behavior.
- `webview/aiChat/overlays.ts` — non-modal menus and switch confirmation dialog.
- `src/ui/aiChatPanel.ts` — validate/apply set_engine/set_model and post new capabilities/models.
- `src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts` — host ack/failure/all engines.
- `webview/aiChat/__tests__/engineModelMenus.test.ts` — menus/a11y/draft behavior.

## Required Work / Exact Spec
Header is 40px. Engine pill >=32px high with 14px plug icon, label `<displayName> · <Ready|Starting|Working|Unavailable>`, status icon+text+color. Click idle opens engine list. Rows OMP, Claude Code, Codex, Builtin are 44px; each shows fixed display name, Ready/Starting/Unavailable/Not installed and one-line safe resolution. Unsupported/not installed rows may open setup help but cannot optimistically select.

Choosing idle engine emits `set_engine(clientRequestId,engine)`, closes menu and leaves old pill/state until capabilities ack matching request. Failure keeps old engine and toast `Could not switch to <engine>. <safe reason>`. Busy selection opens modal: `Stop the current response and switch to Codex? Your unsent draft is preserved.` Buttons `Stop and switch` / `Cancel`; default focus Cancel; Escape cancels. On confirm controller sends stop, waits terminal/ack, then switch. Never destroy next draft/context.

Model chip >=36px displays host-provided role + friendly model/quality, e.g. `unic-sonnet · High`, with provider-neutral 14px icon and chevron. `Choose model`/`No model configured` opens settings rather than empty menu. Model rows 44px: 16px active check, role Work/Smart/Lite/Autocomplete, display name, quality/latency badge, image icon only when true. Up/Down/Enter/Tab/Escape/listbox ARIA per shared popover. Host ack updates chip/capabilities; failure retains prior model.

Do not mix model selection with engine selection. `/engine` and `/model` call the same controller actions/menu. Capability state determines hidden/disabled actions; no `if engine===` UI feature branching. Status never always says streaming. Engine change resets bypass policy only through host response and leaves saved transcript semantics accurately labeled.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | capability | four engine rows | exact status/action from snapshots |
| 2 | ack | successful/failed switch | no optimistic label; matching ack commits; failure reverts/toast |
| 3 | busy | stop-and-switch | confirmation, Cancel default, draft/context preserved |
| 4 | model | roles and vision badges | exact row anatomy; empty opens settings |
| 5 | keyboard/a11y | listbox operation | focus stays trigger/textarea as designed; ARIA active state valid |
| 6 | regression | truthful header | Ready/Working/etc.; no unconditional streaming |
| 7 | race | stale engine/model ack | ignored when clientRequestId no longer pending |

## Test Files
- `src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts`
- `webview/aiChat/__tests__/engineModelMenus.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts webview/aiChat/__tests__/engineModelMenus.test.ts src/ui/__tests__/aiChatPanelAgentEngines.test.ts webview/__tests__/aiChatPanelHeader.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] ENGINE-01 through ENGINE-04 pass for all four engines.
- [ ] Every change is host acknowledged and draft/context preserved.
- [ ] Busy switch is explicit and Cancel-safe.
- [ ] Engine/model controls show exact states and no unsupported fiction.

## Dependencies
- TASK-CHATV2-002, TASK-CHATV2-003, TASK-CHATV2-008, TASK-CHATV2-009

## Interfaces
- Consumes: capabilities/models, controller intents and overlay primitives.
- Produces: header/engine/model views and acknowledged switch flows for 014–017.

## Discussion
(no comments yet)

## Progress
- 2026-09-16T04:05:00+07:00 · milestone: overlays · last-green: none · files: webview/aiChat/overlays.ts · drift: none
- 2026-09-16T04:05:30+07:00 · milestone: engine/model menus + tests · last-green: 27 tests pass (engineModelMenus.test.ts) · files: webview/aiChat/engineModelMenus.ts, webview/aiChat/__tests__/engineModelMenus.test.ts · drift: none
- 2026-09-16T04:06:00+07:00 · milestone: header view · last-green: 27 tests pass · files: webview/aiChat/header.ts · drift: none
- 2026-09-16T04:06:30+07:00 · milestone: host set_engine/set_model ack + tests · last-green: 8+27 tests pass · files: src/ui/aiChatPanel.ts, src/ui/aiChatPanelMessages.ts, src/ai/capabilities.ts, src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts · drift: none
- 2026-09-16T04:15:30+07:00 · milestone: scoped CSS + full verification · last-green: 49 tests pass, typecheck clean, compile clean · files: webview/aiChat/styles.css · drift: none

## Executor Report
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
SUMMARY: Added the V2 40px header with a truthful engine pill + acknowledged engine switching (idle select, busy stop-and-switch confirm, correlated capabilities ack, safe failure toast, stale-ack drop) and a capability-driven model chip/menu; host validates set_engine/set_model and acks with the same clientRequestId or refuses with exact safe copy.
TEST_PLAN_FOLLOWED: task §Test Cases #1-#7 implemented inline as webview unit tests + host integration tests (task file ships no separate §4 Test Plan doc).
FILES_CHANGED:
  - webview/aiChat/overlays.ts: new shared non-modal listbox + confirm-dialog primitives (44px rows, ARIA activedescendant, Cancel default focus).
  - webview/aiChat/engineModelMenus.ts: engine/model menu models, truthful pill rendering, vision icon only when true, acknowledged switch state machine.
  - webview/aiChat/__tests__/engineModelMenus.test.ts: 27 tests for cases #1-#7.
  - webview/aiChat/header.ts: 40px header, title inline edit, engine pill delegation, capability-gated overflow.
  - src/ui/aiChatPanel.ts: set_engine/set_model validation + correlated capabilities/models/toast acks.
  - src/ui/aiChatPanelMessages.ts: additive optional clientRequestId on capabilities/models/toast frames.
  - src/ai/capabilities.ts: exported engineDisplayName() allowlisted label.
  - src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts: 8 host tests for validated/refused/correlated switching.
  - webview/aiChat/styles.css: APPEND-only scoped styles under .UnicDB-ai-chat-v2 (header, pill, overlay menu/dialog).
TESTS_ADDED:
  - webview/aiChat/__tests__/engineModelMenus.test.ts: engine rows/labels, XSS-safe text, truthful pill, listbox keyboard/ARIA, model rows + vision gating, empty-menu opens settings, idle ack, failure toast, stale ack drop, busy stop-and-switch.
  - src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts: validated set_engine ack, refused engine copy, codex seam accept, unknown engine literal, correlated set_model ack, unconfigured role refusal, unknown role literal, no clientRequestId on first ready.
VERIFICATION:
  command: npm test -- --run src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts webview/aiChat/__tests__/engineModelMenus.test.ts src/ui/__tests__/aiChatPanelAgentEngines.test.ts webview/__tests__/aiChatPanelHeader.test.ts
  result: 49 pass / 0 fail (4 files, exit 0)
  output_excerpt: |
    ✓ src/ui/__tests__/aiChatPanelEngineSwitchV2.test.ts  (8 tests) 70ms
    ✓ src/ui/__tests__/aiChatPanelAgentEngines.test.ts  (4 tests) 83ms
    ✓ webview/__tests__/aiChatPanelHeader.test.ts  (10 tests) 15ms
    ✓ webview/aiChat/__tests__/engineModelMenus.test.ts  (27 tests) 31ms
     Test Files  4 passed (4)
          Tests  49 passed (49)
  command: npm run typecheck → tsc --noEmit, exit 0
  command: npm run compile → esbuild build complete, exit 0
ISSUES: A full `npx vitest run` shows 6 suite-level failures that are ENVIRONMENTAL, not regressions: this worktree's node_modules lacks `.bin` (no esbuild/vsce binaries), so 5 webview-bundle test files fail with `spawnSync .../node_modules/.bin/esbuild ENOENT` and vsixSecretsExclusion fails with `MODULE_NOT_FOUND .../.bin/vsce`. All are collection-time spawn errors, zero assertions from these changes involved.
HANDOFF_TO_REVIEWER: yes — task is a non-trivial shared UI/controller deliverable per the handoff gate.
NEXT: ready for review
