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
