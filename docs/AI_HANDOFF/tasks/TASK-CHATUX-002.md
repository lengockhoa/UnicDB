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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecT002
SUMMARY: Replaced the boolean proximity model in scroll.ts with the `following-tail | reading-history` hysteresis machine (enter ≤72px / exit ≥96px, band keeps current state), removed the focus-suppression early-return, rAF-coalesced the deferred scroll write (setTimeout(0) fallback), added a guarded ResizeObserver re-pin (following-tail only; destroy() disconnects), and retitled the pill "↓ Jump to latest — N new". controller.ts: import + pinned-growth check now use SCROLL_FOLLOW_EXIT_PX.
TEST_PLAN_FOLLOWED: task §Test Cases — all 5 rows implemented (autoScroll #4/#8/#9/#10/#11) plus the errorsScrollA11y migration block.
FILES_CHANGED:
  - webview/aiChat/scroll.ts: state machine, new constants/pill copy, rAF-coalesced write, ResizeObserver re-pin, followState() replaces nearBottom(), isInputFocused/isNearBottom/SCROLL_BOTTOM_THRESHOLD_PX removed
  - webview/aiChat/controller.ts: SCROLL_BOTTOM_THRESHOLD_PX → SCROLL_FOLLOW_EXIT_PX (import + :330 pinned-growth check)
  - webview/aiChat/__tests__/autoScroll.test.ts: #4 inverted to focused-follow, pill copy updated, new #8–#11
  - webview/aiChat/__tests__/errorsScrollA11y.test.ts: imports migrated, 72px enter re-pin, new pill copy, focus test inverted, isNearBottom test → followState() boundary assertions
TESTS_ADDED:
  - webview/aiChat/__tests__/autoScroll.test.ts: #8 hysteresis band both directions, #9 scrolled-up+focused pill counts, #10 no-rAF setTimeout fallback, #11 mocked ResizeObserver re-pin/disconnect

RED_OUTPUT (pre-fix, `npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts` — 13 failed / 40 passed):
```
FAIL autoScroll > #4 focused textarea + new text_delta while pinned follows to bottom
AssertionError: expected 1600 to be 2000 // Object.is equality   ← row 1 RED (focus suppression)
FAIL autoScroll > #8 hysteresis band → expected 1520 to be 2000  ← row 2 RED (48px edge, no band)
FAIL autoScroll > #10 setTimeout fallback → expected 2000 to be 2400  ← row 4 RED (no deferred write)
FAIL autoScroll > #11 ResizeObserver → expected null not to be null  ← row 5 RED (no observer)
FAIL autoScroll > #3/#6/#7/#9 + errorsScrollA11y pill tests → '↓ 1 new response' ≠ '↓ Jump to latest — 1 new'
FAIL errorsScrollA11y > composer focus does not suppress follow → expected 800 to be 1000
FAIL errorsScrollA11y > followState edges → TypeError: c.followState is not a function
```

VERIFICATION:
  command: npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts
  result: 53 pass / 0 fail
  output_excerpt: |
    ✓ webview/aiChat/__tests__/errorsScrollA11y.test.ts (42 tests) 42ms
    ✓ webview/aiChat/__tests__/autoScroll.test.ts (11 tests) 102ms
    Test Files 2 passed (2)
    Tests 53 passed (53)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit clean)
  command: npm run compile
  result: exit 0 — dist/webview.js 2.3mb, dist/webview.css 41.6kb
  command: grep -rn "isInputFocused\|SCROLL_BOTTOM_THRESHOLD_PX\|isNearBottom\|nearBottom" webview/aiChat/
  result: zero hits (exit 1)
  command: npx vitest run webview/aiChat/__tests__/
  result: 426 pass / 0 fail (23 files) — no regression in related suites

ISSUES: none. Note: vitest jsdom ships pretendToBeVisual → rAF exists in tests; test #10 stubs it to undefined to exercise the setTimeout(0) fallback. The deferred write re-reads scrollHeight at flush and skips if the reader moved the viewport off the pin between schedule and flush.
HANDOFF_TO_REVIEWER: yes — Status DONE, reviewer picks up pending_review per pipeline.
NEXT: ready for review

Milestone commit: 5342715 (worktree branch handoff/task-chatux-002)

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (EXECUTOR_SUBAGENT: ExecT002) — differs from reviewer, isolation OK
VERIFICATION_RERUN:
  command: npx vitest run webview/aiChat/__tests__/autoScroll.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts
  result: 53 pass / 0 fail (fresh rerun by reviewer)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit clean)
  command: npm run compile
  result: exit 0 (esbuild done)
  command: npx vitest run webview/aiChat/__tests__/
  result: 442 pass / 0 fail (24 files) — shared-code regression net, clean
  command: grep -rn "isInputFocused|SCROLL_BOTTOM_THRESHOLD_PX|isNearBottom|nearBottom" webview/aiChat/
  result: zero hits
TEST_PLAN_COVERAGE: all-followed — rows 1–5 implemented as autoScroll #4/#8/#9/#10/#11 plus the errorsScrollA11y migration block; RED_OUTPUT contains real assertion failures (13 failed pre-fix), not a bare claim.
FINDINGS:
  critical: none
  important: none
  minor:
    - file: webview/aiChat/__tests__/autoScroll.test.ts:350 — `vi.stubGlobal("requestAnimationFrame", undefined)` (and :378 ResizeObserver stub) is never unstubbed; vitest.config.ts does not set `unstubGlobals`, so rAF stays undefined for #11 (harmless — #11's assertions are synchronous — but leaks across tests). Add `vi.unstubAllGlobals()` in afterEach.
    - file: webview/aiChat/controller.ts:330 — routing growth-of-existing-id at preDistance ≤96 to `notifyNewResponse` means a reader in `reading-history` inside the 72–96px band gets `unread += 1` per render pass for a single growing message (pill can read "N new" for one response). Planner-mandated EXIT edge; cosmetic, self-corrects via sync() on re-entry. Noted for awareness.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Hysteresis classify (≤72 enter / ≥96 exit / band keeps state), focus-suppression removal, rAF coalescing with setTimeout(0) fallback, and guarded ResizeObserver re-pin all match SPEC §7/FR-002–FR-004 exactly. The 40→32px send/stop hunk in errorsScrollA11y.test.ts belongs to wave-3 commit 0e4eeea (TASK-CHATUX-004), not this task.
