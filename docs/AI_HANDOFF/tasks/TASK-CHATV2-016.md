# TASK-CHATV2-016 — Error recovery, scroll, accessibility and responsive behavior

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§3,6,8

## Goal
Complete cross-cutting production UX: mapped recoverable errors, precise scroll discipline, keyboard/screen-reader behavior, themes, reduced motion, zoom and narrow-panel resilience.

## Target Files
- `src/ui/aiChatErrors.ts` — safe host error categories/copy/action metadata/diagnostic IDs.
- `webview/aiChat/errors.ts` — V2 error card and retry/change-engine/copy-details actions.
- `webview/aiChat/scroll.ts` — bottom proximity/unread activity controller.
- `webview/aiChat/a11y.ts` — live-region/focus/tooltip helpers.
- `webview/aiChat/styles.css` — final responsive/high-contrast/reduced-motion rules.
- `src/ui/__tests__/aiChatErrors.test.ts`, `webview/aiChat/__tests__/errorsScrollA11y.test.ts`.

## Required Work / Exact Spec
Host maps at least: engine unavailable/not installed, auth/config, connection timeout/disconnect, provider crash, tool denied/failed, context changed/missing, attachment rejected, export/storage failure, stop failure. Frame carries category, exact safeMessage, diagnosticId, retryability and allowed actions; no raw stderr/JSON/command/secret. Error card matches assistant width, padding 10×12px, 3px danger border, danger background, title `Could not complete this response`, message, short ID, collapsed safe detail, Retry/Copy details/Change engine only when allowed. Retry preserves original structured request and prevents duplicate concurrent retry.

Stop failure exact text `Could not stop yet. The engine may still be working.` Active Stop remains and later terminal event wins. DB change exact copy `Database connection changed. Start a new request when it is ready.` Do not label denial as crash. Unknown host errors map generic safe copy and ID.

Scroll controller determines bottom distance before visible frame. Auto-scroll only <=48px. Otherwise preserve scroll and increment pill: `↓ 1 new response`, `↓ n new responses`, or activities; button min 28px bottom-right, click scrolls bottom then clears. Reasoning-only events do not increment/scroll. Composer focus does not jump. Smooth behavior disabled with reduced motion. Prepended history preserves visual anchor.

Accessibility: real controls, icon title+aria-label, 2px focus ring/2px offset, listbox/combobox linkage and stable `aria-activedescendant`, modal focus traps only permission/confirm, one polite and one assertive region. Announce phase changes coalesced, not tokens/reasoning. Status always icon+text+color. Tooltip target behavior uses native title minimum and optional custom tooltip only if testable: 500ms hover, immediate keyboard focus.

Visual matrix: widths 320/420/480/768/1200; 200% zoom; VS Code dark/light/high contrast; long model/schema/path/SQL; RTL message; attachment strip; permission/error/popover. No clipped control, horizontal page overflow or overlap. At <420 labels hide; <320 two action rows; all controls >=32 and send/stop 40. Reduced motion removes caret/spinner/pulse/scroll animation while retaining static status icon/text.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | unit | error category matrix | exact safe copy/actions/diagnostic ID for every class |
| 2 | security | raw provider error | raw value absent from frame/DOM/copy details |
| 3 | regression | failed Stop | remains working/stoppable; no false Stopped |
| 4 | scroll | near/far/reasoning/prepend | <=48 scroll; far pill; reasoning no increment; anchor preserved |
| 5 | a11y | live regions/focus/listbox | no token spam; valid ARIA/focus restore |
| 6 | boundary | narrow/zoom/long text | class/CSS invariants prevent overlap and page overflow |
| 7 | motion | reduced motion | all named animations disabled, status remains understandable |
| 8 | race | Retry double activation | one retry with original immutable structured request |

## Test Files
- `src/ui/__tests__/aiChatErrors.test.ts`
- `webview/aiChat/__tests__/errorsScrollA11y.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatErrors.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/transcript.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Error classes, exact recovery actions and privacy rules are test-covered.
- [ ] 48px scroll discipline and unread pill behavior are deterministic.
- [ ] Keyboard/screen-reader/reduced-motion contracts are complete.
- [ ] Manual visual matrix is prepared for final bundled-webview gate.

## Dependencies
- TASK-CHATV2-006 through TASK-CHATV2-015

## Interfaces
- Consumes: all V2 state/components/frames and host retry/diagnostic data.
- Produces: safe errors, scroll controller and shared a11y/responsive behavior for final cutover.

## Discussion
(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
RED_OUTPUT: |
  Files were written incrementally (module + its tests per milestone). Real RED
  captured each milestone by running the suite and pasting actual failures:

  1. src/ui/aiChatErrors tier — 2 real failures on first run:
     FAIL aiChatErrors.test.ts > privacy > raw provider detail never survives into the frame
     AssertionError: expected '...ECONNREFUSED 127.0.0.1:5432...' to not contain 'ECONNREFUSED'
     (frame echoed raw detail because the allowlist accepted ':' and '.')
     FAIL aiChatErrors.test.ts > privacy > safeErrorDetail drops anything with markup...
     AssertionError: expected 'token' to be undefined
     Fix: tightened SAFE_DETAIL_RE (dropped ':' '.' and added whole-word
     token/credential/host/port rejection). GREEN: 24/24.

  2. webview/aiChat/errors.ts tier — mutation check of the retry guard:
     FAIL errorsScrollA11y.test.ts > race: Retry double activation > a retry is re-armed only by settleRetry
     AssertionError: expected true to be false
     (removing `retryInFlight` from the guard let a 2nd retry through) — reverted.

  3. webview/aiChat/scroll.ts tier — mutation check of reasoning handling:
     FAIL errorsScrollA11y.test.ts > proximity discipline > reasoning-only events neither increment nor scroll
     AssertionError: expected 2 to be +0  (reasoning was counted as a response) — reverted.

  4. webview/aiChat/a11y.ts tier — mutation check of token refusal:
     FAIL errorsScrollA11y.test.ts > live regions > refuses token and reasoning updates
     AssertionError: expected true to be false — reverted.

  5. styles.css tier — ran the CSS contract suite against the pre-append
     stylesheet (git show HEAD:...styles.css): 8 real failures, first:
     AssertionError: expected '/* webview/aiChat/styles.css ...' to contain '.UnicDB-ai-chat-v2-error-card'
     Restored the appended block; 42/42 green.

Verification Output: |
  $ npm test -- --run src/ui/__tests__/aiChatErrors.test.ts webview/aiChat/__tests__/errorsScrollA11y.test.ts webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/transcript.test.ts
   ✓ src/ui/__tests__/aiChatErrors.test.ts  (24 tests) 5ms
   ✓ webview/aiChat/__tests__/errorsScrollA11y.test.ts  (42 tests) 39ms
   ✓ webview/aiChat/__tests__/controller.test.ts  (23 tests) 102ms
   ✓ webview/aiChat/__tests__/transcript.test.ts  (20 tests) 161ms
   Test Files  4 passed (4)   Tests  109 passed (109)

  $ npm run typecheck
  > tsc --noEmit   (exit 0, no output)

  $ npm run compile
  esbuild: build complete   (dist/aiChatPanel.js, dist/extension.js, dist/webview.js/css)

Status: PASS
Note: |
  - Delivered all six target files plus the two test files. Modules are
    standalone and consume the landed V2 modules (store/shell/icons + src/ui);
    wiring the scroll controller into the transcript viewport and the announcer
    into the shell/controller is the CHATV2-017 cutover step, matching the
    task's Interfaces ("Produces ... shared a11y/responsive behavior for final
    cutover"). No V2 component was duplicated.
  - No lint script exists in package.json; typecheck is the static gate and is clean.
  - Manual visual matrix (320/420/480/768/1200, dark/light/HC, 200% zoom,
    reduced motion) is prepared as CHAT_V2_SCREENSHOT_FIXTURES in shell.ts and
    is executed in the CHATV2-017 bundled-webview gate — jsdom does not assert
    pixel geometry.
  - Milestone commits on branch handoff/task-chatv2-016:
    26195d7, e84a093, b54ade6, 9812661, 6a977dc.
