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

### 2026-09-16 · executor · claude-code/bao-sonnet
Decision 1 — vitest `include` widened. The task §Test Files path is
`webview/aiChat/__tests__/store.test.ts`, but `vitest.config.ts` included only
`webview/__tests__/*.test.ts`. I verified empirically that passing the explicit
file path does NOT bypass `include` (vitest 1.6 reports "No test files found",
exit 1). To make the mandated §Verification Commands runnable at all, the glob
was widened to `webview/**/*.test.ts`. This is the minimal unblock and is the
shared prerequisite for CHATV2-005..016, all of which use the same
`webview/aiChat/__tests__/` path. No existing test file changes behavior: the
sweep shows 347 tests pass and only the 5 pre-existing ENOENT suites (worktree
has no `node_modules/.bin`) still fail, identically on the base checkout
(confirmed via stash). CHATV2-017 owns final cleanup; if a reviewer prefers the
glob to stay narrow, the alternative is naming this file `*.store.test.ts` under
`webview/__tests__/`, which contradicts the task's explicit Test Files path.

Decision 2 — "stop" has no terminal phase. The §6 phase vocabulary is
idle/validating/.../completed/failed — there is no `stopped` phase. A
`turn_finished` with `outcome: "stopped"` therefore lands on the terminal
`completed` phase while the turn record preserves `outcome: "stopped"`. This
matches the host frame union (`outcome: completed|stopped|failed`) and keeps the
phase set closed and exhaustive.

Decision 3 — turn gating is `turn_started`-first. `turn_started` is applied
directly (it creates the live turn); every other turn-scoped frame is ignored
unless its `turnId` matches the live open turn, and ignored after the turn
closed, so a late delta can never resurrect a terminal turn. Wrong-session and
stale/duplicate-sequence frames return the SAME state object (identity no-op).

## Progress
- 2026-09-16T01:43:00+07:00 · milestone: RED→GREEN pure reducer + serializable state · last-green: store.test.ts 13/13; aiChatPanelMessagesV2 16/16; typecheck exit 0; compile exit 0 · files: webview/aiChat/store.ts, webview/aiChat/__tests__/store.test.ts, vitest.config.ts · drift: vitest.config.ts widened (`webview/**/*.test.ts`) so the task's Test Files path is discovered — shared prerequisite for CHATV2-005..016; rationale in Discussion decision 1
- 2026-09-16T01:45:00+07:00 · milestone: stop-dispatch + host-ack regression coverage · last-green: store.test.ts 14/14; cmd1 exit 0 (30 tests); typecheck exit 0; compile exit 0 · files: webview/aiChat/__tests__/store.test.ts · drift: none

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Tests written first in webview/aiChat/__tests__/store.test.ts while
  webview/aiChat/store.ts was absent. Verbatim RED after the vitest include fix:

    $ npm test -- --run webview/aiChat/__tests__/store.test.ts
     ❯ webview/aiChat/__tests__/store.test.ts  (0 test)
    ⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯⎯
     FAIL  webview/aiChat/__tests__/store.test.ts
    Error: Failed to load url ../store (resolved id: ../store) in
      .../webview/aiChat/__tests__/store.test.ts. Does the file exist?
     Test Files  1 failed (1)
          Tests  no tests

  A second RED was surfaced during implementation: the first reducer draft gated
  `turn_started` behind "a live turn must already exist", so the turn was never
  created. 4/13 failed:

    FAIL #3 closes a turn on the first terminal frame only
      AssertionError: expected 'validating' to be 'failed'
    FAIL #5 edits the next draft while streaming but creates no submit effect
      AssertionError: expected 'validating' to be 'streaming'
    (plus 2 more)

  Fix: apply `turn_started` directly (it opens the turn); gate every other
  turn-scoped frame on the live open turn. Then 13/13 green.

Verification Output: |
  $ npm test -- --run webview/aiChat/__tests__/store.test.ts \
        src/ui/__tests__/aiChatPanelMessagesV2.test.ts
   ✓ webview/aiChat/__tests__/store.test.ts  (14 tests) 8ms
   ✓ src/ui/__tests__/aiChatPanelMessagesV2.test.ts  (16 tests) 6ms
  Test Files  2 passed (2)
       Tests  30 passed (30)
  CMD1_EXIT=0

  $ npm run typecheck
  > tsc --noEmit
  CMD2_EXIT=0

  $ npm run compile
  ⚡ Done in 203ms
  esbuild: build complete
  CMD3_EXIT=0

  Wider sweep (informational): `npx vitest run` → 347 tests pass; 5 suites fail
  with ENOENT on `<worktree>/node_modules/.bin/{esbuild,vsce}`. Reproduced
  identically on the stashed base checkout, so pre-existing worktree environment
  gaps (also recorded by TASK-CHATV2-003), not caused by this change.

Status: PASS
Note: Two spec-interpretation decisions recorded in Discussion (vitest include
  widening; stop→completed with outcome preserved). No new dependency, no
  provider-name branching, no DOM/clock/random/storage in the reducer.
