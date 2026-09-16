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

## Progress

- 2026-09-16T22:54+0700 · milestone: red-tests · last-green: none (RED confirmed: tests 1/3/5 fail for the expected reason) · files: webview/aiChat/__tests__/autoScroll.test.ts · drift: none
- 2026-09-16T22:56+0700 · milestone: drive-scroll-controller · last-green: autoScroll 5/5 + errorsScrollA11y 42 + controller 23 + controllerSurfaces 13; typecheck exit 0; compile exit 0 · files: webview/aiChat/controller.ts, webview/aiChat/__tests__/autoScroll.test.ts · drift: none
- 2026-09-17T00:12+0700 · milestone: fix-round-1 · last-green: autoScroll 7/7 + errorsScrollA11y 42 + controller 23 + controllerSurfaces 13 (85/85); full suite 4665 passed / 0 failed / 5 skipped; typecheck exit 0; compile exit 0 · files: webview/aiChat/controller.ts, webview/aiChat/__tests__/autoScroll.test.ts · drift: none

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run webview/aiChat/__tests__/autoScroll.test.ts  (before implementation)

  FAIL #1 a new user-visible response auto-follows to the bottom
  AssertionError: expected 1600 to be 2000  // Object.is equality
    ❯ webview/aiChat/__tests__/autoScroll.test.ts:149:28
  FAIL #3 user scrolled up: position preserved and the pill counts the missed response
  AssertionError: expected true to be false  // pill.hidden — pill never unhidden
    ❯ webview/aiChat/__tests__/autoScroll.test.ts:171:27
  FAIL #5 regression: the coalesced render pass is the ONE driver
  AssertionError: expected undefined to be 1  // scroll.beginFrame() match count = 0
    ❯ webview/aiChat/__tests__/autoScroll.test.ts:190:61
  Test Files  1 failed (1) | Tests  3 failed | 2 passed (5)

  RED matches the expected reason exactly (controller never driven): rows 2/4 are
  never-scroll invariants and pass pre-wiring by design; rows 1/3/5 fail. No
  immediately-green test — no test fix needed.
Verification Output: |
  npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts
    ✓ errorsScrollA11y.test.ts (42 tests)
    ✓ autoScroll.test.ts (5 tests)
    Test Files  2 passed (2) | Tests  47 passed (47)
  (plus acceptance suites: controller.test.ts 23 passed, controllerSurfaces.test.ts 13 passed
   — 4 files, 83 tests, all green)

  npm run typecheck
    > tsc --noEmit      → exit 0

  npm run compile
    > node esbuild.js
    ⚡ Done in 150ms / dist/extension.js 6.6mb / esbuild: build complete → exit 0

  Extra: full `npx vitest run` in the worktree = 4599 passed / 1 failed / 5 skipped.
  The 6 failing FILES are pre-existing environmental failures: they spawn
  `node_modules/.bin/esbuild` / `.bin/vsce` by absolute worktree path and the
  worktree has no node_modules installed (ENOENT at collect time) — impossible to
  cause from this diff (webview/aiChat/controller.ts + one new test file).
Implementation: |
  - controller.ts renderState(): `scroll.beginFrame()` first (pre-paint geometry),
    then after transcript/activity paints a user-visible-signature diff —
    ids of user/text/tool rows in `state.transcript.order` + each text row's
    `raw.length`, previous signature kept per-controller — decides
    `notifyNewResponse()` (new id) vs `notifyReasoningActivity()` (reasoning /
    raw-length growth). `scroll.sync()` stays the last statement of the pass.
  - `scroll.sync()` added once after `createScrollController` (task step 4);
    `scroll.destroy()` was already in `dispose()` — unchanged.
  - Driver call sites: exactly ONE each (guarded by test #5). No exported
    signature changes. Per-controller closure state chosen over a module-global
    so multiple mounted controllers can never cross-contaminate the signature
    (module-local intent preserved: not exported, invisible outside the file).
Status: PASS
Note: plan-review input-focus edge exercised as test #4 (scrollTop preserved with composer
textarea focused mid-turn). Test #5 also asserts the driver runs before `transcript.render`
inside `renderState` and that `scroll.sync()` closes the pass.

<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report (fix round 1)

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run webview/aiChat/__tests__/autoScroll.test.ts  (new tests #6/#7 added, fix NOT yet applied)

  FAIL #6 fix-round regression: same-message streaming growth keeps following (no spurious pill)
  AssertionError: expected 2000 to be 2400  // Object.is equality
    ❯ webview/aiChat/__tests__/autoScroll.test.ts:241:28
    (first mid-message growth delta on the SAME messageId left scrollTop at
     2000 — growth routed to notifyReasoningActivity, which never scrolls)
  #7 passed pre-fix by design (never-scroll invariant side: far-from-bottom
  growth already went to notifyReasoningActivity); it guards the far branch of
  the new conditional (a regression that always calls notifyNewResponse on
  growth would flip it RED with "↓ 1 new response").
  Test Files  1 failed (1) | Tests  1 failed | 6 passed (7)
Verification Output: |
  npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts
    ✓ errorsScrollA11y.test.ts (42 tests)
    ✓ autoScroll.test.ts (7 tests)
    Test Files  2 passed (2) | Tests  49 passed (49)

  npx vitest run webview/aiChat/__tests__/controller.test.ts
       webview/aiChat/__tests__/controllerSurfaces.test.ts (same run as above two)
    ✓ controller.test.ts (23 tests) / ✓ controllerSurfaces.test.ts (13 tests)
    Test Files  4 passed (4) | Tests  85 passed (85)

  npm run typecheck
    > tsc --noEmit      → exit 0

  npm run compile
    > node esbuild.js → dist/extension.js 6.6mb → esbuild: build complete → exit 0

  Extra: full `npx vitest run` in the worktree = 4665 passed / 0 failed / 5 skipped
  (312 files passed, 2 skipped) — the wave report's 6 environmental ENOENT
  failures are gone because this worktree has the node_modules symlink.
Implementation: |
  - controller.ts renderState(): `const preDistance = scroll.beginFrame()` (the
    interface already returned the pre-frame distance; it was discarded) and the
    growth-only diff branch now follows while pinned:
    `if (preDistance <= SCROLL_BOTTOM_THRESHOLD_PX) scroll.notifyNewResponse();
    else scroll.notifyReasoningActivity();` — judged on the PRE-frame distance,
    so input-focus suppression (scroll.ts) stays intact and the far-from-bottom
    case keeps zero scroll / zero unread count. SCROLL_BOTTOM_THRESHOLD_PX
    imported from ./scroll. No exported signature changes.
  - Test #5 updated: the "ONE driver" guard now asserts ZERO notify sites
    outside the coalesced pass (global count === in-pass count) instead of a
    textual count of 1 — the pinned-growth branch legitimately calls
    notifyNewResponse a second time inside the SAME pass (reviewer-prescribed).
  - Tests #6/#7 added per the verdict: #6 same-message growth keeps following
    across two +clientHeight bumps and the NEXT new id never lands far-from-bottom
    (pill stays hidden, "↓ 0 new responses"); #7 the same growth while scrolled up
    keeps position 0, pill hidden, count 0.
  - Minor findings: NOT taken — (a) hydration tail pill: the "suppress when ids
    were fully replaced" option would also suppress the pinned session-switch
    follow-to-newest behavior (no test covers it; a behavior regression risk),
    and "accept + pin with a test" needs session-history hydration fixtures the
    current harness lacks — left to the planner as deliberate follow-up;
    (b) test #5 anchor strings: reviewer already judged acceptable as-is.
Status: PASS
Note: mock geometry caveat documented in test #6 — bumps are +clientHeight
(400px) per frame because the mock's scrollTo overshoots to scrollTop =
scrollHeight where a real browser clamps; a real browser's pre-frame capture
(old scrollHeight) tolerates any growth per frame. Milestone commit d94ad64 on
handoff/fix-002 (worktree .worktrees/fix-002), never pushed.
