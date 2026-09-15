# TASK-CHATV2-008 — Two-row composer and every control surface

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§3–5

## Goal
Build the exact professional two-row composer visual/component contract. It emits semantic callbacks only; keyboard submit and postMessage remain exclusively owned by TASK-CHATV2-009.

## Target Files
- `webview/aiChat/composer.ts` — new semantic composer component.
- `webview/aiChat/__tests__/composer.test.ts` — DOM, geometry-state and control tests.
- `webview/aiChat/styles.css` — composer/chip/menu styles under V2 root.
- `webview/aiChatPanelComposer.ts` — temporary compatibility export only; final deletion in 017.

## Required Work / Exact Spec
Composer shell: 1px border, 16px radius, input background; focus/popover shadow only. Top region min 64/max 160px, padding 14px 16px 10px, borderless transparent textarea, 14/21px, no resize handle, max seven visual lines then overflow-y auto. Auto-grow measures scrollHeight after input/state render and preserves caret/scroll; min/max are CSS constants. Placeholder focused: `Ask about this workspace or database…`; inactive host-focus hint only when real shortcut is provided.

Bottom region min 48px, padding 7px 10px, gap 6px. Left: `attachContextBtn` plus 20px in 32×32, `slashCommandBtn` slash glyph 16px in 32×32. Center scroll lane: model chip >=36px, context chips, schema chip; `min-width:0`, no overlap. Right: permission button >=36px and one 40×40 primary slot. At <420px optional labels hide; center scrolls. At <320px two rows: attach/slash/model first, safety/send second.

Create exact IDs: `composerV2`, `promptV2`, `attachContextBtn`, `slashCommandBtn`, `modelChipBtnV2`, `contextChipList`, `schemaChipBtnV2`, `permissionBtn`, `primaryTurnBtn`, `composerHint`. All real buttons/textarea. Icon-only controls have identical `title` and `aria-label`. No disabled microphone is rendered. Upward arrow, not paper plane.

`render(state)` controls: empty/invalid idle send disabled with exact reason callback/title; valid idle shows blue arrow `Send message (Enter)`; busy shows red stop `Stop generating` while textarea/context remain editable for next draft and hint is `AI is responding. Your next draft is saved here.`; stopping disables primary slot for 250ms visual lock but does not disable textarea. Model/engine/schema state does not update optimistically.

Component callbacks: onInput(value, selection), onSelectionChange, onAttachOpen, onSlashOpen, onModelOpen, onContextPreview/remove, onSchemaOpen, onPermissionOpen, onPrimaryActivate. It may listen to input/pointer/focus but must not independently add keydown/keyup submit logic or call VS Code API.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | DOM | control inventory | exact IDs, semantic elements, title/aria labels, no mic/paper-plane |
| 2 | state | idle/busy/stopping | correct arrow/stop, enabled states, exact hints |
| 3 | regression | busy composer | textarea/context editable; primary cannot queue/send |
| 4 | edge | empty/invalid draft | disabled with exact reason, callback not fired |
| 5 | boundary | auto-grow | clamps 64–160px and uses overflow after max |
| 6 | boundary | long labels/narrow mode | CSS scroll/wrap branches prevent overlap |
| 7 | architecture | no transport/key owner | no acquireVsCodeApi/postMessage/keydown send listener |

## Test Files
- `webview/aiChat/__tests__/composer.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/composer.test.ts webview/__tests__/aiChatPanelComposer.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Exact two-row design and dimensions are implemented under scoped styles.
- [ ] Every listed control has specified size/position/tooltip/availability behavior.
- [ ] Busy drafting works without accidental queue semantics.
- [ ] Component has no send keyboard or host transport ownership.

## Dependencies
- TASK-CHATV2-004, TASK-CHATV2-005

## Interfaces
- Consumes: `ChatViewState`, shell/icon primitives.
- Produces: `ComposerView`, `ComposerCallbacks`, `renderComposerV2()` for 009–014.

## Discussion
(no comments yet)
