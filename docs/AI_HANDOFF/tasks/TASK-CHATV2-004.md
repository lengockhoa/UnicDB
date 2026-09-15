# TASK-CHATV2-004 — Pure reducer and serializable UI state

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§2,4,6

## Goal
Create the single state authority for V2. Host frames and local semantic actions update a pure serializable state; renderers never infer business state from DOM/classes.

## Target Files
- `webview/aiChat/store.ts` — new state types, initial state and pure reducer.
- `webview/aiChat/__tests__/store.test.ts` — state transition/race/invariant tests.

## Required Work / Exact Spec
Define `TurnPhase`: idle, validating, connecting, waiting_for_first_event, streaming, awaiting_permission, stopping, completed, failed. Define `ComposerMode`: draft, slash, mention, model-menu, engine-menu, permission. `ComposerDraft` holds text, selectionStart/end, revision, attachments and `ContextRef[]`. `ChatViewState` holds protocol/session/lastSequence, capabilities, active turn, transcript entities/order, draft, autocomplete, layout, banners/toasts, models/schema, pending host requests and hydration state.

Export `createInitialChatState(): ChatViewState` and `reduceChatState(state, action): ChatViewState`. Host action validates protocol/session/sequence before applying. Local actions include DRAFT_CHANGED, SELECTION_CHANGED, AUTOCOMPLETE_OPENED/CLOSED/ACTIVE_MOVED, CONTEXT_REMOVED, COLLAPSE_TOGGLED, SCROLL_PROXIMITY_CHANGED and SUBMIT_REQUESTED. The reducer is side-effect free: no DOM, clock, random ID, postMessage or storage.

Rules: wrong session ignored; stale/duplicate sequence ignored; late delta for terminal/wrong turn ignored; terminal frame closes pending turn once; Stop intent only changes phase to stopping after controller dispatch; draft is not cleared until host turn_started acknowledges matching clientRequestId. Busy phases retain/edit next draft but cannot create SUBMIT effect. Autocomplete response applies only when requestId+revision match open state. Escape-close sets a generation/closed marker so late result cannot reopen.

Normalize transcript by stable IDs and order array. Streaming updates the same assistant item raw text. Keep at most 200 renderable item IDs after paging metadata; never drop host session record, only viewport representation. No non-serializable Event/Element/function/Blob in state; attachment uses validated data shape only until submit and is excluded from persistence actions.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | unit | full turn lifecycle | exact phase transitions and one stable stream item |
| 2 | edge | wrong session/stale sequence | returns same logical state |
| 3 | race | terminal then delta | late delta ignored; completed remains terminal |
| 4 | race | old mention result after Escape/new revision | popover stays closed/new results intact |
| 5 | regression | busy draft editing | text/revision updates, submit effect absent |
| 6 | boundary | >200 rendered items | viewport list capped, paging marker retained |
| 7 | purity | serializable state | JSON round-trip succeeds; no DOM/function values |

## Test Files
- `webview/aiChat/__tests__/store.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/store.test.ts src/ui/__tests__/aiChatPanelMessagesV2.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] All state transitions are pure, exhaustive and test-covered.
- [ ] Draft clearing and engine/model changes are host-acknowledged.
- [ ] Stale/wrong-turn/race frames cannot corrupt visible state.
- [ ] Components can render all states without provider-name branching.

## Dependencies
- TASK-CHATV2-003

## Interfaces
- Consumes: `AiChatHostFrameV2`, capability/context/model types.
- Produces: `ChatViewState`, `ChatAction`, `createInitialChatState()`, `reduceChatState()` for controller/renderers.

## Discussion
(no comments yet)
