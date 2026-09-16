# TASK-CHATFIX-004 — Wire the dead message action icons (copy / edit / retry / 3-dot)

- Status: `pending_review`
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

### 2026-09-16 · executor · bao-sonnet
- **onMoreAssistant shape**: chose the additive optional third arg `trigger?: HTMLElement`
  (transcript.ts), exactly as the planner predicted the smaller option; call site passes `more`.
- **onInsertSql**: NOT wired — documented-as-hidden. Searched the full `AiChatWebviewIntentV2`
  union in `src/ui/aiChatPanelMessages.ts`; no existing intent kind inserts SQL into an editor
  (`run_command` is slash-command execution, not editor insertion). The button stays hidden as
  today (renderer keeps it gated on `record.sql`); inventing a new intent kind was out of scope.
- **writeClipboard rejection fix**: test 5's spec ("no unhandled rejection") exposed that the
  pre-existing `void nav?.clipboard?.writeText(text)` left rejections unhandled (its docstring
  already promised "never throws"). Added `.catch(() => {})` — same function, no behavior change
  beyond swallowing the advisory rejection; the renderer's toast still reports failure.
- **Test 6 mechanism**: a blank user item is unreachable through public flows (`canSubmitDraft`
  blocks blank UI submits); it is only producer-reachable via the reducer. The test captures the
  controller's REAL callbacks with a transparent `vi.mock` wrapper around `createTranscriptRenderer`
  (delegates to the actual module) and drives them through the REAL renderer + REAL reducer
  (`TRANSCRIPT_PAGE_LOADED`) — the same state-building pattern transcript.test.ts uses.
- **Test 7 form**: a persistent source-level regression test (regex for the three wirings in
  controller.ts) — RED before the fix, GREEN after, and it stays green; the RED run output below
  is the required evidence for tests 2/3/4/6/7 failing against the old controller.
- **Retry draft shape**: `requestRetry({ draft: { text, revision: state.draft.revision,
  context: [], attachments: [] } })` exactly per plan; `ComposerDraft` fully satisfied, no type
  widening. Empty text is additionally guarded in `onRetryUser` (defense in depth for test 6).

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

### What was implemented

- `webview/aiChat/controller.ts` — the transcript callbacks object now wires ALL message actions:
  - `onEditUser` → `applyDraftEdit(text, text.length, text.length)` (the existing `DRAFT_CHANGED`
    path) + `prompt.focus()`; the coalesced `composer.render` paints the draft.
  - `onRetryUser` → existing `requestRetry({ draft: { text, revision: state.draft.revision,
    context: [], attachments: [] } })`; blank text guarded; busy turns stay a no-op.
  - `onMoreAssistant(_id, raw, trigger?)` → ONE `createOverlayMenu` (anchor `shell.root`,
    ariaLabel "Message actions") created lazily per clicked trigger, rows `[Copy message,
    Regenerate response]` (ids "copy"/"regenerate"), trigger keydown routed to `menu.handleKey`
    (Escape closes), activation reuses `writeClipboard(raw)` / new `requestRegenerate()` helper
    (shared with the row button — still ONE regenerate intent path), then `close("select")`.
    Menu destroyed in `dispose()`.
  - `onInsertSql` — NOT wired; no existing intent supports it (see Discussion).
  - `writeClipboard` now swallows the clipboard promise rejection (no unhandled rejection).
- `webview/aiChat/transcript.ts` — `TranscriptCallbacks.onMoreAssistant` gained the additive
  optional third arg `trigger?: HTMLElement`; the call site passes the clicked `more` button.
- `webview/aiChat/__tests__/messageActions.test.ts` — new, tests 1-7 per §Test Cases.

### RED_OUTPUT

`npx vitest run webview/aiChat/__tests__/messageActions.test.ts` against the unmodified controller
(commit `6b86350` "milestone: RED"):

```
 ❯ webview/aiChat/__tests__/messageActions.test.ts (7 tests | 5 failed) 189ms
   × #1 ... (passed — copy was already wired)
   × #2 edit loads the message text back into the composer draft and focuses it
     → expected '' to be 'hello' // Object.is equality
   × #3 retry re-sends the message text as one submit_turn while idle
     → expected [ { kind: 'submit_turn', …(3) } ] to have a length of 2 but got 1
   × #4 assistant 3-dot opens the actions menu with Copy + Regenerate; Escape closes it
     → expected the overlay menu to be mounted: expected null not to be null
   × #5 ... (passed — transcript copyText already handled rejection; the run also surfaced the
     controller's pre-existing unhandled rejection, fixed under GREEN)
   × #6 blank message is inert: edit focuses an empty composer, retry never posts
     → expected <body><div …(4)>…(8)</div>  (prompt not focused by dead edit button)
   × #7 regression: the controller wires edit/retry/3-dot (no dead buttons)
     → expected '// webview/aiChat/controller.ts — TAS…' to match /onEditUser\s*\(/


 Test Files  1 failed (1)
      Tests  5 failed | 2 passed (7)
```

Tests 2/3/4 fail for exactly the dead-button reasons (§Test Case 7 satisfied). #1/#5 passed
pre-implementation because copy was already wired — per task §Goal.

### Verification Output

Worktree: `.worktrees/task-chatfix-004` (branch `handoff/task-chatfix-004`).

1. `npx vitest run webview/aiChat/__tests__/messageActions.test.ts webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/transcript.test.ts`

```
 ✓ webview/aiChat/__tests__/transcript.test.ts (26 tests) 175ms
 ✓ webview/aiChat/__tests__/controller.test.ts (23 tests) 144ms
 ✓ webview/aiChat/__tests__/messageActions.test.ts (7 tests) 187ms


 Test Files  3 passed (3)
      Tests  56 passed (56)
```

2. `npm run typecheck` → `> tsc --noEmit` — exit 0, no errors.

3. `npm run compile` →

```
 dist/extension.js       6.6mb ⚠️
 dist/extension.js.map  12.0mb
 ⚡ Done in 173ms
 esbuild: build complete
```

4. `npm test` (acceptance: full suite green at the wave boundary) →

```
 Test Files  312 passed | 2 skipped (314)
      Tests  4663 passed | 5 skipped (4668)
```

Note: the FIRST full-suite run in this worktree showed 7 failing files that were all
environmental, not code: 5 × `spawnSync .../node_modules/.bin/esbuild ENOENT` (the worktree had
no `node_modules/.bin` shims; the aiChatPanel webview tests shell out to esbuild from `cwd`),
plus `vsixSecretsExclusion` and `webviewPerTableTabs` which both pass in isolation. After adding
gitignored `.bin` shims (symlinks to the main checkout), the full suite is fully green (output 4)
and each previously failing file passes individually.

Status: PASS
Note: none blocking. `onInsertSql` left hidden per plan (no host intent); recorded in Discussion.
Reviewer verdict pending (phase 4).
