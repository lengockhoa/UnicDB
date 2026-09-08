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

(appended below by executor)

---

## Reviewer Verdict

(appended below by reviewer)
