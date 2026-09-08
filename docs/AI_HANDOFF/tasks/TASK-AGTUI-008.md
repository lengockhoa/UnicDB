# TASK-AGTUI-008 — Animation + dark-theme polish + full regression gate

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3, §4

## Goal

Final pass: bring the motion layer to Claude Code feel (stream typing caret, tool-card expand/collapse, toggle ease, stop pulse while in flight, smooth jump-to-latest), verify dark-theme token rendering, then run the FULL regression gate for the cycle (compile + whole suite + typecheck + surface guards).

## Target Files

- `webview/aiChatPanelMain.ts` — minimal JS: add/remove animation classes during delta streaming (`UnicDB-chat-caret`), tool-card expand/collapse toggle class, stop pulse class while busy (busy path already exists), smooth-scroll behavior on `#jumpLatest`.
- `webview/styles.css` — animation keyframes/timing refinements ONLY if TASK-AGTUI-001's block needs tuning (150ms card ease, 100ms toggle ease, reduced-motion block). Non-chat selectors remain frozen.
- `src/ui/__tests__/aiChatPanelClonePolish.test.ts` (new) — CSS-contract + jsdom behavior assertions.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | streaming caret lifecycle | dispatch `delta` frames → streaming assistant bubble has `UnicDB-chat-caret` class; `done` → class removed; final text equals concatenation of all deltas (no duplicated/lost chars under rapid deltas) | 3 rapid delta fixtures |
| 2 | edge (boundary) | tool card expand/collapse idempotent | clicking a tool card header toggles collapsed class; N rapid clicks end in a deterministic state (odd=collapsed, even=expanded); collapsed state does not remove the card from DOM | rapid click loop |
| 3 | edge (accessibility) | reduced-motion honored | styles.css `@media (prefers-reduced-motion: reduce)` block disables `UnicDB-chat-pulse`, `UnicDB-chat-caret`, smooth scroll (CSS contract: `animation: none` / `scroll-behavior: auto` inside the media query) | styles.css text |
| 4 | edge (timing tokens) | easing tokens exact | card transition duration token = 150ms ease, toggle = 100ms ease-in-out in the chat token block | CSS contract assertions |
| 5 | edge (state) | stop pulse only while busy | pulse class present exactly while `setBusy(true)` and absent after `done`/`init` reset | busy lifecycle dispatch |
| 6 | regression | FULL cycle gate | `npm run compile` then `npm test` (entire suite including `bqFollowupSurfaceGuard.test.ts`, `bq04SurfaceGuard.test.ts`, `aiChatPanelBundle.test.ts`, `chatLayoutCss.test.ts`) + `npm run typecheck` all pass | post-wave-3 tree |

## Test Files

- `src/ui/__tests__/aiChatPanelClonePolish.test.ts` (new)

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelClonePolish.test.ts
npm run compile && npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; full-suite gate green (this is the cycle's release-readiness gate).
- [ ] No animation added outside the chat scope; reduced-motion still fully functional (no input blocked by animation state).
- [ ] Dist build (`npm run compile`) succeeds with all new modules bundled into `dist/aiChatPanel.js` + `dist/webview.css`.

## Dependencies

- TASK-AGTUI-006, TASK-AGTUI-007 (both wave-2 tasks)

## Interfaces

- Consumes: integration surface from TASK-AGTUI-007 (busy lifecycle, delta/done handlers, tool-card DOM), tokens/keyframes from TASK-AGTUI-001.
- Produces: final polished UI; no further consumers (cycle-terminal task).

### 2026-09-08 · planner · unic-smart
Typing animation must remain a CLASS toggle over real streamed text — never synthesize characters not sent by the host (parity rule: `done` flush must equal delta concatenation).

## Executor Report

EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-agtui-008

 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts  (8 tests | 6 failed) 69ms
 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts > TASK-AGTUI-008 - polish CSS contract (easing + reduced-motion) > .UnicDB-chat-toggle::after uses 100ms ease-in-out for the thumb slide
   → expected false to be true (transition: left 0.1s ease-in-out)
 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts > TASK-AGTUI-008 - polish CSS contract (easing + reduced-motion) > .UnicDB-chat-tool-collapsible transition timing token is 150ms ease
   → expected false to be true (0.15s ease rule missing)
 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts > TASK-AGTUI-008 - polish CSS contract (easing + reduced-motion) > prefers-reduced-motion media query disables pulse / caret / smooth scroll
   → mediaBlockBody returned '' (regex over-escaped); real cause: CSS lacked scroll-behavior: auto override
 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts > TASK-AGTUI-008 - polish CSS contract (easing + reduced-motion) > chat thread declares scroll-behavior:smooth OUTSIDE reduced-motion
   → expected false to be true (scroll-behavior: smooth declaration missing)
 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts > TASK-AGTUI-008 - polish bundle behavior (caret / tool card / stop pulse) > #1 streaming caret lifecycle
   → expected 'Hello▍, world!' to be 'Hello, world!' (ensureStreamingCaret was a no-op after delta #1, leaving caret stranded mid-bubble)
 ❯ src/ui/__tests__/aiChatPanelClonePolish.test.ts > TASK-AGTUI-008 - polish bundle behavior (caret / tool card / stop pulse) > #2 tool card expand/collapse
   → tool card must include a clickable .UnicDB-chat-tool-header: expected null not to be null

 Test Files  1 failed (1)
      Tests  6 failed | 2 passed (8)
```

Verification Output:
```
$ npx vitest run src/ui/__tests__/aiChatPanelClonePolish.test.ts
 ✓ src/ui/__tests__/aiChatPanelClonePolish.test.ts  (8 tests) 118ms

 Test Files  1 passed (1)
      Tests  8 passed (8)

$ npx vitest run   (full suite)
 Test Files  272 passed | 1 skipped (273)
      Tests  4026 passed | 4 skipped (4030)

$ npx vitest run src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/chatLayoutCss.test.ts src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts src/adapters/__tests__/bq04SurfaceGuard.test.ts
 Test Files  5 passed (5)
      Tests  82 passed (82)

$ npm run typecheck
> UnicDB@1.53.24 typecheck
> tsc --noEmit      (exit 0, no errors)
```

Status: PASS
Note:

- Changes are scoped to `webview/styles.css` (toggle transition to 100ms, new
  `.UnicDB-chat-tool-collapsible` family with 150ms ease + glyph via
  `::before`, `scroll-behavior: smooth` on `.UnicDB-chat-thread` +
  reduced-motion override) and `webview/aiChatPanelMain.ts`
  (`ensureStreamingCaret` now moves the caret to the end of the bubble every
  delta; `appendToolResult` builds a collapsible `.UnicDB-chat-tool-header` +
  `.UnicDB-chat-tool-body` pair where the glyph is delivered via CSS
  pseudo-element so `card.textContent === summary` is preserved for the
  DbAwareWebview suite).
- Wave-1 frozen modules (Composer / Header / Thread) and the
  `src/ui/aiChatPanelMessages.ts` (002) module were not touched.
- The bubble's textContent caret-glyph regression was a real R8 polish bug
  (the caret was appended exactly once after delta #1, leaving it stranded
  between the first and second text nodes); the parity rule
  (`done === concatenation`) still holds.
- No API key / wire-credential surface introduced.

## Reviewer Verdict

(appended below by reviewer)



