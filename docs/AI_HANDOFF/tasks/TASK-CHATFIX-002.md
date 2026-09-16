# TASK-CHATFIX-002 — Drive the scroll controller (auto-scroll to newest + unread pill)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Auto-scroll), §4 (rows 002)

## Goal

`createScrollController` (webview/aiChat/scroll.ts) is fully implemented — stick-to-bottom within
48px, unread pill, prepend re-anchor, input-focus suppression — but is instantiated at
`webview/aiChat/controller.ts:777` and NEVER driven (zero `beginFrame`/`notifyNewResponse`/
`notifyReasoningActivity` call sites in the repo). Wire it into the single coalesced render pass
so the transcript auto-follows the newest message once TASK-CHATFIX-001 makes it scrollable.

## Target Files

- `webview/aiChat/controller.ts` — in the coalesced render pass (~lines 260-285, where
  `transcript.render(state)` at line 270 and `activity.render(state)` at line 271 run):
  1. call `scroll.beginFrame()` BEFORE the transcript/activity paints;
  2. compute a user-visible signature (concatenated ids of `state.transcript.order` items whose
     kind is `user`/`text`/`tool`, plus each text item's `raw.length`) — keep the previous
     signature in a module-local;
  3. after paints: a NEW user-visible id appended → `scroll.notifyNewResponse()`; only
     reasoning/raw-length growth → `scroll.notifyReasoningActivity()`;
  4. call `scroll.sync()` once after controller construction, and `scroll.destroy()` inside the
     controller's `dispose()` (find the existing dispose that disposes transcript/activity).
  No exported signature changes.
- `webview/aiChat/__tests__/autoScroll.test.ts` — (new) jsdom tests (`// @vitest-environment
  jsdom` pragma). Reuse the harness pattern of `controllerSurfaces.test.ts:44 makeHarness`
  (stub `postMessage`, real `createChatController`). Mock scroll geometry with
  `Object.defineProperty(transcriptEl, "scrollHeight", {value: N})` + `clientHeight`, and a
  plain settable `scrollTop` — jsdom does no layout.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | new response auto-follows to bottom | scrollHeight=2000, clientHeight=400, near bottom → after submit+`text_delta`+`h.controller.flushRender()`, `transcript.scrollTop === 2000` | mocked geometry |
| 2 | edge (reasoning-only) | reasoning delta never scrolls | same geometry, only `reasoning_delta` frames → scrollTop unchanged, `[data-chat-scroll-pill]` stays hidden | mocked geometry |
| 3 | edge (user scrolled up) | position preserved + pill counts | scrollTop forced to 0 (distance > 48px), new assistant text → scrollTop stays 0 AND pill visible with textContent "↓ 1 new response" | mocked geometry |
| 4 | edge (input focus) | typing suppresses the jump | focus the composer textarea, new response arrives → scrollTop unchanged (scroll.ts contract) | mocked geometry |
| 5 | regression | controller is never driven today | tests 1, 3 fail against current controller.ts (RED) — paste RED output, then GREEN | current code |

## Test Files

- `webview/aiChat/__tests__/autoScroll.test.ts` — (new) tests 1-5.

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts
npm run typecheck
npm run compile
```

(errorsScrollA11y.test.ts guards the existing scroll-controller contract — must stay green.)

## Acceptance Criteria

- [ ] Tests 1-5 pass; RED evidence for the regression row pasted in the Executor Report.
- [ ] The controller is driven from exactly ONE place (the coalesced pass) — no scattered
      notify calls inside frame handlers.
- [ ] Existing suites touching scroll (errorsScrollA11y, controller, controllerSurfaces) green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CHATFIX-001 — the scroll region only exists after the grid fix; also both tasks'
  behavior is jointly user-visible. (File sets are disjoint: 001 owns styles.css.)

## Interfaces

- Consumes: `createScrollController(options): ScrollController` (webview/aiChat/scroll.ts:106) —
  existing methods `beginFrame(): number`, `notifyNewResponse(): void`,
  `notifyReasoningActivity(): void`, `sync(): void`, `destroy(): void`, marker
  `SCROLL_PILL_MARKER = "data-chat-scroll-pill"`; render pass site `controller.ts:264-285`.
- Produces: no new exports — the coalesced pass now drives the controller; the user-visible
  signature format is internal to controller.ts.

---

## Discussion

### 2026-09-16 · planner · bao-opus
`scrollToBottom()` sets `viewport.scrollTop = viewport.scrollHeight` (scroll.ts:148) — with the
mock, assert scrollTop === 2000 exactly. Do not change scroll.ts; if the signature diff proves
awkward, a simpler equivalent (last user-visible id comparison) is acceptable as long as tests
1-4 hold. Composer-focus suppression is already inside scroll.ts:notifyNewResponse (isInputFocused)
— test 4 verifies it end-to-end through the controller.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
