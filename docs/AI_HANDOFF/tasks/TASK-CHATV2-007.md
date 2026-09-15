# TASK-CHATV2-007 — Activity timeline and truthful turn status

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §6

## Goal
Render all working/reasoning/tool lifecycle events as a compact, truthful, accessible timeline, replacing generic fake “Thinking” and silent tool work.

## Target Files
- `webview/aiChat/activity.ts` — new timeline component.
- `webview/aiChat/statusTimers.ts` — injected-clock stall/elapsed timer logic.
- `webview/aiChat/__tests__/activity.test.ts` — event/state/labels/security tests.
- `webview/aiChat/__tests__/statusTimers.test.ts` — 12s/30s/retry timing tests.

## Required Work / Exact Spec
Timeline sits between user request and assistant answer. Collapsed header is 28px: 12px chevron, state icon, summary and right duration. Expanded rows min 30px with 16px icon, label, status, optional duration and safe details toggle. Tool states: queued gray dot; running blue 12px spinner; succeeded green check; denied amber shield; failed red x; cancelled gray stop-square. Results default collapsed and only show host allowlisted summary; safe copy control appears only when capability/frame marks detail copyable.

Do not label private reasoning `Thinking`. When `supports.streamThought=false` or no allowed reasoning event exists, render `Working… Ns`. When allowed events arrive, render a collapsed `Reasoning` section and append text safely; it is excluded from persisted transcript by default. Do not announce reasoning chunks in live region.

Map phases to exact copy: validating `Preparing your request…`; connecting `Connecting to <displayName>…`; waiting first event `Working… Ns`; streaming `Responding…`; permission `Waiting for your permission`; stopping `Stopping…`; completed `Completed in N.Ns`; failed uses error component. Header engine state is Ready/Starting/Working/Unavailable, never hard-coded streaming.

Timer service receives an injected clock/scheduler. Elapsed visible update at most once/second. At 12,000ms since last user-visible event show `Still working. You can stop this turn.` At 30,000ms show `Still waiting for <engine>. Check engine status or stop.` A new visible event resets stall timer. Host retry frame shows `Retrying connection (1 of 2)…`; it never fabricates a retry.

Timeline rows keyed by event ID; tool_started must appear before tool_finished update. Unknown tool statuses render safe generic warning, do not inject class name from wire. Collapse transition <=150ms and none under reduced motion. Summary uses semantic counts/durations, not raw tool output.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | DOM | tool lifecycle | one keyed row progresses running→success/fail/deny/cancel |
| 2 | capability | reasoning unavailable | neutral Working only; no Thinking/Reasoning disclosure |
| 3 | capability | allowed reasoning | collapsed Reasoning section, safe text, no live spam |
| 4 | timer | 12s and 30s | exact warnings at thresholds; event resets clock |
| 5 | edge | unknown status/host strings | safe generic class/text, no class injection/XSS |
| 6 | regression | always-streaming header | idle/completed show Ready, not streaming |
| 7 | accessibility | expanded state | button/aria-expanded/controls synchronized |

## Test Files
- `webview/aiChat/__tests__/activity.test.ts`
- `webview/aiChat/__tests__/statusTimers.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/activity.test.ts webview/aiChat/__tests__/statusTimers.test.ts src/ui/__tests__/aiChatPanelThoughtRegen.test.ts src/ui/__tests__/aiChatPanelToolParity.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Every host operation is visible with truthful status and stable identity.
- [ ] Reasoning is gated/labeled correctly and not persisted/announced by default.
- [ ] Timers are deterministic, reset correctly and keep Stop available.
- [ ] Details are allowlisted/safe and collapsed by default.

## Dependencies
- TASK-CHATV2-004, TASK-CHATV2-005, TASK-CHATV2-006

## Interfaces
- Consumes: activity entities/turn phase/capabilities from state.
- Produces: `createActivityTimeline(refs, callbacks)`, `createStatusTimers(clock,dispatch)` for 014/016.

## Discussion
(no comments yet)

## Progress
- 2026-09-16T02:20:00+07:00 · milestone: statusTimers + tests · last-green: 17/17 statusTimers tests pass · files: webview/aiChat/statusTimers.ts, webview/aiChat/__tests__/statusTimers.test.ts · drift: none
- 2026-09-16T02:22:20+07:00 · milestone: activity timeline + tests · last-green: 17/17 activity tests pass · files: webview/aiChat/activity.ts, webview/aiChat/__tests__/activity.test.ts · drift: none
- 2026-09-16T02:23:30+07:00 · milestone: activity timeline styles · last-green: focused tests 50/50, typecheck clean, compile ok · files: webview/aiChat/styles.css · drift: none

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: Claude:feature-implementer
RED_OUTPUT: statusTimers.test.ts written first and failed for real by temporarily lowering the working-stall threshold to 99s:
```
 FAIL  webview/aiChat/__tests__/statusTimers.test.ts > createStatusTimers — stall thresholds > fires the 12s working warning exactly once at the threshold
AssertionError: expected [] to have a length of 1 but got +0
- Expected
+ Received
- 1
+ 0
 ❯ webview/aiChat/__tests__/statusTimers.test.ts:136:21
```
activity.test.ts then failed for real on the first run (3 failures), driving the implementation:
```
❯ webview/aiChat/__tests__/activity.test.ts  (17 tests | 3 failed) 38ms
  → reasoning unavailable: expected '0 tools · Working… 3sReasoning' not to contain 'Reasoning'
  → allowed reasoning: expected 'Preparing your request…' to be '' // Object.is equality
  → hostile detail text: expected null not to be null
```
All three were fixed in `activity.ts` (lazy Reasoning section, copy control added on later copyable render) and the a11y assertion tightened to the real invariant.
Verification Output:
```
===== CMD1: npm test -- --run webview/aiChat/__tests__/activity.test.ts webview/aiChat/__tests__/statusTimers.test.ts src/ui/__tests__/aiChatPanelThoughtRegen.test.ts src/ui/__tests__/aiChatPanelToolParity.test.ts
 ✓ src/ui/__tests__/aiChatPanelThoughtRegen.test.ts  (15 tests) 33ms
 ✓ webview/aiChat/__tests__/statusTimers.test.ts  (17 tests) 5ms
 ✓ webview/aiChat/__tests__/activity.test.ts  (17 tests) 39ms
 Test Files  4 passed (4)
      Tests  50 passed (50)

===== CMD2: npm run typecheck
> tsc --noEmit
(no output, exit 0)

===== CMD3: npm run compile
 esbuild: build complete
```
Status: PASS
Note: `queue` is NOT in the `createChatIcon()` allowlist (icons.ts ships database/plug/ellipsis/plus/slash/chevrons/file/selection/table/view/routine/schema/shields/arrow-up/stop-square/copy/edit/retry/check/x/warning/spinner). The queued state therefore renders a CSS gray dot (`.UnicDB-ai-chat-v2-activity-dot`), not an invented glyph — no new raw markup was added. Reasoning is rendered only when `capabilities.supports.streamThought === true` AND an allowed reasoning event exists; the section is created lazily so a non-thought engine never sees a `Reasoning` label. Details are rendered only from the host `view.details` allowlist; copy appears only when `copyable === true`. No package/version/publish changes. Cosmetic `esbuild` "Unrecognized target environment ES2024" warning pre-exists and is unrelated.
