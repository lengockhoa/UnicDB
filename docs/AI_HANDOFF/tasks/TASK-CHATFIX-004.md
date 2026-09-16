# TASK-CHATFIX-004 — Wire the dead message action icons (copy / edit / retry / 3-dot)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Dead icons), §4 (rows 004)

## Goal

The transcript already renders working buttons that fire `TranscriptCallbacks`
(webview/aiChat/transcript.ts:67, dispatch at 248-288 — copy even self-services the clipboard
and toast), but `controller.ts:743-767` wires only copy/regenerate/load-earlier, leaving
`onEditUser`, `onRetryUser` and `onMoreAssistant` undefined — dead buttons, exactly as reported.
Wire the missing callbacks to EXISTING modules: reducer draft action, existing retry path,
existing overlay menu.

## Target Files

- `webview/aiChat/controller.ts` — extend the `createTranscriptRenderer` callbacks object
  (lines 749-766):
  1. `onEditUser(_id, text)` → `dispatch({ type: "DRAFT_CHANGED", text })` (action shape
     store.ts:284) then focus the composer textarea (`shell.composerTop.querySelector("textarea")`,
     `focus()` + caret to end). The next coalesced `composer.render(state)` paints it.
  2. `onRetryUser(_id, text)` → reuse the EXISTING `requestRetry({ draft })` (controller.ts:990)
     with `{ text, revision: state.draft.revision, context: [], attachments: [] }`; it already
     no-ops while a turn is busy. If `requestRetry`'s draft type needs the composer context
     shape, build it from `ChatViewState["draft"]` fields exactly — do not widen types.
  3. `onMoreAssistant(_id, raw, btn?)` — create ONE `createOverlayMenu` (overlays.ts:151;
     options shape overlays.ts:92: `{ anchor: shell.root, trigger: <clicked button>,
     ariaLabel: "Message actions", onActivate, onClose }`) lazily per click: set rows
     `[Copy message, Regenerate response]` (ids "copy"/"regenerate"), `open()`, and on activate
     reuse the already-wired copy/clipboard + regenerate intent, then `close("select")`.
     To receive the trigger button, extend `TranscriptCallbacks.onMoreAssistant?` with an
     optional third arg `trigger: HTMLElement` in transcript.ts (additive, backwards-compatible
     with the existing call site at line 284 — pass `more` as the trigger).
  4. `onInsertSql` — wire ONLY if an existing host intent kind already supports inserting SQL
     (search `postIntent` kinds in controller.ts / aiChatPanelMessages.ts intent union);
     otherwise leave the button hidden as today and record the finding in Discussion.
- `webview/aiChat/__tests__/messageActions.test.ts` — (new) jsdom tests; reuse the
  `controllerSurfaces.test.ts:44 makeHarness` pattern (stub postMessage, real controller).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | copy user message | stub `navigator.clipboard.writeText` → click user `[data-action="copy"]` → `writeText` called with the exact message text; `.UnicDB-ai-chat-v2-toast` contains "Copied" | jsdom + stubbed clipboard |
| 2 | happy | edit puts text back in the draft | click user `[data-action="edit"]` → composer textarea value equals the message text AND textarea `=== document.activeElement` | jsdom |
| 3 | happy | retry re-sends the message | idle controller, click user `[data-action="retry"]` → stubbed postMessage received `{kind:"submit_turn", draft:{text: <message text>}}` | jsdom |
| 4 | happy | assistant 3-dot opens the actions menu | click assistant `[data-action="more"]` → a `[data-chat-overlay-menu]` node exists with rows "Copy message" + "Regenerate response"; Escape closes it (node removed) | jsdom |
| 5 | edge (clipboard failure) | writeText rejects | stub rejects → toast "Could not copy" (`[data-level="error"]`), no unhandled rejection | jsdom |
| 6 | edge (empty text) | empty message is inert | user item with `text: ""` → edit focuses an empty composer, retry posts NO `submit_turn` | jsdom |
| 7 | regression | edit/retry/3-dot are dead today | tests 2, 3, 4 fail against current controller.ts (RED) — paste output, then GREEN | current code |

## Test Files

- `webview/aiChat/__tests__/messageActions.test.ts` — (new) tests 1-7.

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/messageActions.test.ts webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/transcript.test.ts
npm run typecheck
npm run compile
```

(controller.test.ts + transcript.test.ts guard the surfaces this task touches — must stay green;
typecheck is the static gate — there is no lint script.)

## Acceptance Criteria

- [ ] All seven tests pass; RED evidence for 7 pasted in the Executor Report.
- [ ] No new subsystem: edit uses `DRAFT_CHANGED`, retry uses `requestRetry`, 3-dot uses
      `createOverlayMenu` — no new menu/clipboard/overlay implementations.
- [ ] `onInsertSql` outcome (wired or documented-as-hidden) recorded in Discussion.
- [ ] `npm test` full suite green at the wave boundary.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CHATFIX-002 — both tasks edit `webview/aiChat/controller.ts`; 002's render-pass edits
  land first so this task's callback additions do not collide (sequential file ownership).

## Interfaces

- Consumes: `TranscriptCallbacks` (transcript.ts:67 — `onEditUser?(messageId, text)`,
  `onRetryUser?(messageId, text)`, `onMoreAssistant?(messageId, raw)` gaining optional
  `trigger: HTMLElement`), `createOverlayMenu(options: OverlayMenuOptions): OverlayMenu`
  (overlays.ts:151, options at :92 — `setRows`, `open`, `close`, `handleKey`),
  `requestRetry(request: { draft: ChatViewState["draft"] })` (controller.ts:990),
  `DRAFT_CHANGED { text, selectionStart?, selectionEnd? }` (store.ts:284),
  `writeClipboard(text)` (controller.ts:868), overlay marker `data-chat-overlay-menu`
  (overlays.ts:42).
- Produces: fully-wired `TranscriptCallbacks` in controller.ts; `onMoreAssistant` signature
  extended with optional `trigger` (transcript.ts:75 call-site passthrough).

---

## Discussion

### 2026-09-16 · planner · bao-opus
Keep the overlay to TWO rows (Copy, Regenerate) — do not invent menu actions the host does not
support. `requestRetry` already guards `busyPhase`; retry during a live turn is intentionally a
no-op (test 3 runs idle). If extending `onMoreAssistant`'s signature in transcript.ts feels
invasive, the alternative is `onMoreAssistant` reading the trigger from a data attribute on the
actions row — but the additive optional arg is smaller. Record the chosen shape here.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
