# TASK-CHATUX2-004 — Steer wiring + overlap cutover (controller, activity, CSS)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 · Spec: `docs/AI_HANDOFF/SPEC.md` FR-003 (wiring half), FR-004

## Goal

Wire the steer queue into the controller (`steer` decision →
`STEER_ENQUEUED`; `turn_finished` → FIFO flush via `requestRetry` →
`submit_turn`), and fix the overlapping transcript by removing the
duplicate activity timeline renderer and the nested `#thread` scroller.

## Spec references

- SPEC.md §5 FR-003 (controller half), FR-004, §7, §8.6-§8.7, §14 Q7

## Target Files

- `webview/aiChat/controller.ts` — (a) `handleDecision` case `"steer"`:
  `event.preventDefault()` + `dispatch({type:"STEER_ENQUEUED"})`;
  (b) `applyHostFrame` `turn_finished` branch → `flushSteerQueue()`:
  while `state.steerQueue.length > 0 && !busyPhase(state.phase)` →
  `dispatch(STEER_DEQUEUED)` then `requestRetry({ draft: dequeued })`
  (existing method ~1165); guard `disposed`; (c) delete
  `createActivityTimeline(...)` (~859-865), `activity.render(state)`
  (~305), and the `createActivityTimeline`/`ActivityTimeline` imports;
  KEEP `phaseCopyLabel` (used by `announcePhase` ~1064).
- `webview/aiChat/activity.ts` — delete the DOM renderer:
  `createActivityTimeline`, `ChatActivityRefs`, `ActivityCallbacks`,
  `ActivityTimeline`, `ActivityViewInput`, `ActivityDetailInput`,
  `ToolRecord`, `nextId`, icon/detail/copy helpers. KEEP pure exports:
  `phaseCopyLabel`, `mapToolState`, `toolStateLabel`, `formatDuration`,
  `deriveEngineState`, `engineStateLabel`, `isActivePhase`,
  `ActivityToolState`.
- `webview/aiChat/styles.css` — delete the `-activity-*` block
  (~1382-1662); add `.UnicDB-ai-chat-v2-transcript > .UnicDB-chat-thread
  { flex: 0 0 auto; overflow: visible; scroll-behavior: auto;
  margin-bottom: 0; }` (single scroll owner — `#thread` becomes a normal
  flow child).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `turn_finished` flush posts one `submit_turn` per queued item, FIFO | two queued → two `submit_turn` intents in enqueue order, each after its own `turn_finished`; fresh clientRequestIds | controller harness, turn open, 2 steers, then finish |
| 2 | unit | `steer` decision dispatches `STEER_ENQUEUED` | Enter while streaming → preventDefault + queue length 1 + draft cleared; NO `submit_turn`, NO `stop_turn` | controller harness, streaming phase |
| 3 | regression | mounted controller → single renderer | `shell.transcript` contains NO `-activity-header`/`-activity-body`/`-activity-row`; each tool id has exactly ONE `[data-chat-key]` node | controller harness + tool_started/tool_finished frames |
| 4 | regression | `#thread` is not a scroller | CSS override rule exists (`overflow: visible`, `flex: 0 0 auto`); transcript remains sole `overflow-y:auto`; no `-activity-` selector remains | readFileSync styles.css (shellGrid pattern) |
| 5 | edge (lifecycle) | steer during `stopping` flushes after close | queued while stopping; `turn_finished` (outcome stopped) → `submit_turn` posted | stopping phase → finish |
| 6 | edge | `turn_finished` with empty queue → no-op | zero `submit_turn`; no throw | terminal frame, empty queue |
| 7 | unit | `requestSubmit()` while busy still stops | one `stop_turn`; no `submit_turn` — Enter steers, button stops | busy phase, primary click |
| 8 | edge (boundary) | steer at queue cap → preventDefault + enqueue no-op | Enter while streaming with steerQueue length 8 → preventDefault, queue stays 8, draft text unchanged, NO newline inserted, NO `submit_turn` | controller harness, streaming phase, queue at cap |

## Test Files
- `webview/aiChat/__tests__/controller.test.ts` — cases 1, 2, 5, 6, 7, 8 (rewrite "busy phases refuse submit" ~156 to assert steer).
- `webview/aiChat/__tests__/controllerSurfaces.test.ts` — case 3 (single-renderer regression).
- `webview/aiChat/__tests__/activity.test.ts` — prune DOM-mount tests; keep pure-helper tests (`mapToolState`, `toolStateLabel`, `formatDuration`, `phaseCopyLabel`, `deriveEngineState`, `engineStateLabel`, `isActivePhase`).
- `webview/aiChat/__tests__/shellGrid.test.ts` — case 4 (CSS scans; file shared with TASK-001, sequential waves).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/controllerSurfaces.test.ts webview/aiChat/__tests__/activity.test.ts webview/aiChat/__tests__/shellGrid.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] Queue drains strictly FIFO, one `submit_turn` per `turn_finished`; no drain while busy.
- [ ] No `createActivityTimeline` reference outside git history; no `-activity-*` selector in styles.css.
- [ ] `shell.transcript` children come from the keyed renderer only; `#thread` carries the flow-child override.
- [ ] `npm run typecheck` clean; no regression in related suites.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CHATUX2-001 (styles.css owner — footer/grid/tree CSS lands first)
- TASK-CHATUX2-002 (produces `steerQueue`, `STEER_ENQUEUED`/`STEER_DEQUEUED`, `steer` decision this task wires)

## Interfaces

- Consumes: `canSteerDraft`/`steer` decision, `ChatViewState.steerQueue`,
  `STEER_ENQUEUED`/`STEER_DEQUEUED` (TASK-002); `requestRetry({draft})`,
  `busyPhase()` (existing controller internals).
- Produces: single-renderer invariant for `shell.transcript`; the live
  steering behavior (SPEC §7).

---

## Discussion

### 2026-09-21 · planner · devin/swe-2
Two concerns merged deliberately: steer wiring AND overlap cutover both
live in controller.ts — splitting them would chain two waves on one file
for no review gain (validator caps target files at 3). Overlap root cause
(verified): `createActivityTimeline` appends header+body+reasoning into
`shell.transcript` (activity.ts:327) duplicating every tool/reasoning
item the keyed renderer paints; `#thread` (`aiChatPanelMain.ts:220`) is a
nested `overflow-y:auto` scroller inside the transcript;
`activity.dispose()`'s `container.textContent=""` would wipe the keyed
transcript — deleting the renderer removes that landmine too. Do NOT move
`#thread` out of the transcript (legacy bridge ordering); the CSS
override is sufficient. `#jumpLatest` becomes a permanent no-op (its
show-logic reads `#thread.scrollTop`) — acceptable, recorded here.

### 2026-09-21 · planner revision R1 · devin/swe-2
Plan-review Round 1 resolved the queue-at-cap contract: Enter at cap is a
`steer` decision whose `STEER_ENQUEUED` no-ops (draft kept, no newline) —
NOT `native`. `canSteerDraft` deliberately takes no queue-length input;
cap enforcement lives solely in the reducer (SPEC §7/§10, PLAN §3). Case
8 pins the end-to-end behavior.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
