# TASK-CHATUX-002 — W2 scroll state machine: hysteresis follow, rAF coalescing, Jump-to-latest pill

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (W2)
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-002, FR-003, FR-004, §7, §8.1

## Goal

Replace the boolean proximity model in `scroll.ts` with an explicit `following-tail | reading-history` state machine (enter ≤72px, exit ≥96px), remove the `isInputFocused` suppression that breaks streaming follow while the composer is focused, coalesce scroll writes through rAF, re-pin on viewport resize via ResizeObserver, and retitle the pill "↓ Jump to latest — N new".

## Target Files

- `webview/aiChat/scroll.ts` — new `ScrollFollowState` type + `SCROLL_FOLLOW_ENTER_PX = 72` / `SCROLL_FOLLOW_EXIT_PX = 96`; remove `SCROLL_BOTTOM_THRESHOLD_PX` and `isInputFocused`; rAF-coalesced `scrollToBottom` (setTimeout(0) fallback when `requestAnimationFrame` undefined); guarded `ResizeObserver` re-pin; `followState()` replaces `nearBottom()`; new `unreadPillLabel` copy; `destroy()` disconnects the observer.
- `webview/aiChat/controller.ts` — scroll-driver lines only: `SCROLL_BOTTOM_THRESHOLD_PX` import → `SCROLL_FOLLOW_EXIT_PX` (line ~329 pinned-growth check uses the EXIT edge); any `nearBottom()` call → `followState()`.
- `webview/aiChat/__tests__/autoScroll.test.ts` — update + extend (see Test Files).
- `webview/aiChat/__tests__/errorsScrollA11y.test.ts` — migrate the scroll-proximity block (:277-377) to the new contract: imports (:28-33) `SCROLL_BOTTOM_THRESHOLD_PX`/`isNearBottom`/`unreadPillLabel` → `SCROLL_FOLLOW_ENTER_PX`/`SCROLL_FOLLOW_EXIT_PX`/`unreadPillLabel` (keep `bottomDistance`, `scrollBehavior`, `createScrollController`); :278 re-pin 48px → 72px enter edge; :306-307 + :320 pill copy → `"↓ Jump to latest — 1 new"` / `"↓ Jump to latest — 4 new"`; :341 `"composer focus does not jump the viewport"` → INVERT to `"composer focus does not suppress follow"` (pinned + focused + delta → `scrollTop` moves to bottom); :372-375 `isNearBottom` threshold test → `followState()` boundary assertions (≤72 following / ≥96 reading). `bottomDistance` and `scrollBehavior` stay exported (SPEC §8.1).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | regression+happy | `focused textarea + new text_delta while pinned follows to bottom` | `viewport.scrollTop` moves to bottom; pill hidden — RED today (isInputFocused suppresses), GREEN after | harness from existing file; `h.controller.prompt.focus()` then `text_delta` + `flushRender()` |
| 2 | edge (boundary) | `distance inside the 72–96 hysteresis band keeps the current state` | from following: distance 80 → still follows on next notify; from reading: distance 80 → still no scroll, unread increments | mockScrollGeometry at 80px distance both directions |
| 3 | edge (interaction) | `scrolled-up + focused + delta → no scroll, pill counts` | `scrollTop` unchanged; pill visible with `↓ Jump to latest — 1 new` | `viewport.top = 0`, prompt focused, `text_delta` |
| 4 | edge (environment) | `jsdom without ResizeObserver/rAF constructs and follows` | `createScrollController` does not throw; follow still works via setTimeout fallback | default jsdom env |
| 5 | edge (observer) | `mocked ResizeObserver re-pins only while following-tail` | stub `globalThis.ResizeObserver` capturing the callback; fire it with state `following-tail` → `scrollTop` moves to bottom; state `reading-history` → `scrollTop` unchanged; `destroy()` disconnects | `makeViewport()` harness + `class RO { constructor(cb){…} observe/disconnect }` |

## Test Files

- `webview/aiChat/__tests__/autoScroll.test.ts` — update existing rows to the new API (`followState`, new pill label, 72/96 constants) and add rows 1–5. Existing #5 source-scan invariant stays: `scroll.notify*` calls only inside `renderState`.
- `webview/aiChat/__tests__/errorsScrollA11y.test.ts` — apply the migration listed in Target Files (scroll-proximity block only; the a11y describe blocks :383+ are untouched).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; row 1 demonstrated RED before the fix.
- [ ] `grep -n "isInputFocused\|SCROLL_BOTTOM_THRESHOLD_PX" webview/aiChat/` → zero hits.
- [ ] No regression in related suites (`npx vitest run webview/aiChat/__tests__/`).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — shares no file with TASK-CHATUX-001 (styles.css-only).

## Interfaces

- Consumes: `(none)`
- Produces: `ScrollController.followState(): "following-tail" | "reading-history"` (replaces `nearBottom()`); `SCROLL_FOLLOW_ENTER_PX = 72`, `SCROLL_FOLLOW_EXIT_PX = 96`; `unreadPillLabel(n)` → `"↓ Jump to latest — N new"`. controller.ts keeps `scroll.beginFrame()`/`notifyNewResponse()`/`notifyReasoningActivity()`/`sync()` call sites unchanged except the constant swap.

---

## Discussion

### 2026-09-21 · planner · unic-smart
Root cause of the reported "doesn't stick to bottom": `isInputFocused()` early-return in `notifyNewResponse` (scroll.ts:180-184) — `#promptV2` keeps focus for the whole streaming turn, so every delta is suppressed. The state machine removes it entirely; the 72/96 hysteresis band (SPEC §7) replaces the single 48px edge. jsdom lacks ResizeObserver/rAF — both MUST be feature-guarded or every test crashes.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
