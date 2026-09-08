# TASK-AGTUI-001 — Clone design tokens + chat-scoped CSS layer (BLUE palette, no JS)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3, §4

## Goal

Add the Claude Code clone design-token block + all chat component styles (header, brand "U", thread bubbles, thinking block, tool cards, composer grid, model chip, toggle switch, red-square stop, keyframes) to `webview/styles.css`, scoped strictly to `.UnicDB-chat*`. CSS only — no JS/DOM changes (JS tasks consume these classes).

## Target Files

- `webview/styles.css` — append chat-scoped token block `:root`-less `.UnicDB-chat { --UnicDB-chat-accent: … }` + component rules. DO NOT modify any non-chat selector (shared by ALL webview panels via `dist/webview.css`).
- `src/ui/__tests__/aiChatPanelCloneCss.test.ts` (new) — CSS contract test, regex-over-file-text pattern copied from `src/ui/__tests__/chatLayoutCss.test.ts`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | clone token block exists | `.UnicDB-chat` rule declares `--UnicDB-chat-accent:#3b82f6`, `--UnicDB-chat-accent-hover:#60a5fa`, `--UnicDB-chat-accent-strong:#2563eb`, `--UnicDB-chat-stop:#dc2626`, `--UnicDB-chat-warn:#f59e0b` | styles.css on main has none of these |
| 2 | edge (value/boundary) | exact hexes, no Claude orange | assertions match case-insensitive exact hexes above; regex `#d97757\|#e8703a\|orange` finds NO accent usage inside `.UnicDB-chat` rules | text scan of styles.css |
| 3 | edge (isolation/scope) | non-chat selectors untouched | `.UnicDB-toolbar`, `.UnicDB-tab`, `.UnicDB-grid-host`, `.UnicDB-btn` rule bodies still match their pre-cycle shapes (read via `ruleBody()`); every NEW rule added starts with `.UnicDB-chat` or `.UnicDB-chat-` | styles.css text; snapshot of existing selectors via existing chatLayoutCss expectations |
| 4 | edge (malformed) | balanced braces in chat section | count of `{` equals count of `}` in the appended block | appended text |
| 5 | regression | existing chat layout contract intact | `src/ui/__tests__/chatLayoutCss.test.ts` passes unmodified | full file pre-cycle |

Required selectors (consumed by TASK-AGTUI-003/004/005/007 — keep these exact names): `.UnicDB-chat-header`, `.UnicDB-chat-brand` (28px+ bold blue "U"), `.UnicDB-chat-title`, `.UnicDB-chat-sessionchip`, `.UnicDB-chat-thread`, `.UnicDB-chat-msg-user`, `.UnicDB-chat-msg-assistant`, `.UnicDB-chat-thought`, `.UnicDB-chat-step`, `.UnicDB-chat-tool`, `.UnicDB-chat-tool-failed`, `.UnicDB-chat-tool-denied`, `.UnicDB-chat-plan`, `.UnicDB-chat-error`, `.UnicDB-chat-usage`, `.UnicDB-chat-input`, `.UnicDB-chat-attachments`, `.UnicDB-chat-actions`, `.UnicDB-chat-chip` (model chip), `.UnicDB-chat-chipmenu`, `.UnicDB-chat-toggle`, `.UnicDB-chat-toggle-on`, `.UnicDB-chat-stop` + `.UnicDB-chat-stop-live` (square, red, pulse keyframes `UnicDB-chat-pulse`), `.UnicDB-chat-primary`, `.UnicDB-chat-secondary`, `.UnicDB-chat-jump`, plus `@keyframes UnicDB-chat-pulse`, `UnicDB-chat-caret`, and a `@media (prefers-reduced-motion: reduce)` block that disables them.

## Test Files

- `src/ui/__tests__/aiChatPanelCloneCss.test.ts` (new)

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelCloneCss.test.ts
npx vitest run src/ui/__tests__/chatLayoutCss.test.ts   # must stay green
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; chatLayoutCss.test.ts + non-chat selectors unchanged.
- [ ] No JS/TS source file modified (`git diff --stat` shows only styles.css + the new test).
- [ ] Colors match PLAN §3 exactly; no new npm deps.

## Dependencies

- none

## Interfaces

- Consumes: (none)
- Produces: CSS classes listed in Test Case "Required selectors" + tokens `--UnicDB-chat-accent|accent-hover|accent-strong|stop|warn` — consumed by TASK-AGTUI-003/004/005 (DOM builders) and TASK-AGTUI-007/008 (integration, animations).

### 2026-09-08 · planner · unic-smart
`prefers-reduced-motion` handling is CSS-only here; JS tasks must not gate animations in code — add/remove classes and let the media query win.

## Executor Report

### 2026-09-08 · executor · unic-code
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (pre-implementation, from `npx vitest run src/ui/__tests__/aiChatPanelCloneCss.test.ts` — 5 failed / 3 passed of 8):

  FAIL  TASK-AGTUI-001 - clone CSS tokens + chat-scoped layer > .UnicDB-chat declares the BLUE/stop/warn clone token block
    AssertionError: .UnicDB-chat must declare --UnicDB-chat-accent:#3b82f6: expected false to be true
    ❯ src/ui/__tests__/aiChatPanelCloneCss.test.ts:70:7

  FAIL  TASK-AGTUI-001 - clone CSS tokens + chat-scoped layer > non-chat selectors are untouched and every new rule is chat-scoped
    AssertionError: .UnicDB-tab must still declare display:flex: expected false to be true
    ❯ src/ui/__tests__/aiChatPanelCloneCss.test.ts:122:89
    (resolved by switching the assertion to `cursor:pointer` after inspecting pre-cycle `.UnicDB-tab` body, which has no `display:flex`)

  FAIL  TASK-AGTUI-001 - clone CSS tokens + chat-scoped layer > .UnicDB-chat-brand is the big BLUE 'U' brand glyph
    AssertionError: .UnicDB-chat-brand rule block must exist: expected '' not to be ''
    ❯ src/ui/__tests__/aiChatPanelCloneCss.test.ts:206:66

  FAIL  TASK-AGTUI-001 - clone CSS tokens + chat-scoped layer > .UnicDB-chat-stop is a red square; .UnicDB-chat-stop-live animates the pulse
    AssertionError: .UnicDB-chat-stop rule block must exist: expected '' not to be ''
    ❯ src/ui/__tests__/aiChatPanelCloneCss.test.ts:222:65

  FAIL  TASK-AGTUI-001 - clone CSS tokens + chat-scoped layer > .UnicDB-chat-toggle BLUE OFF, .UnicDB-chat-toggle-on amber ON
    AssertionError: .UnicDB-chat-toggle rule block must exist: expected '' not to be ''
    ❯ src/ui/__tests__/aiChatPanelCloneCss.test.ts:264:66

  Test Files  1 failed (1) | Tests  5 failed | 3 passed (8)

GREEN (post-implementation) — all 8 tests pass.

Verification Output (full output from §Verification Commands):

```
$ npx vitest run src/ui/__tests__/aiChatPanelCloneCss.test.ts
 ✓ src/ui/__tests__/aiChatPanelCloneCss.test.ts  (8 tests) 16ms
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ npx vitest run src/ui/__tests__/chatLayoutCss.test.ts
 ✓ src/ui/__tests__/chatLayoutCss.test.ts  (31 tests) 6ms
 Test Files  1 passed (1)
      Tests  31 passed (31)

$ npm run typecheck
> UnicDB@1.53.24 typecheck
> tsc --noEmit
(no output → exit 0, pass)
```

Scope check (`git diff --stat HEAD`):
```
 webview/styles.css | 211 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 211 insertions(+)
```
Plus the new test file (untracked): `src/ui/__tests__/aiChatPanelCloneCss.test.ts`.
No JS/TS source files modified.

FILES_CHANGED:
- webview/styles.css: added `--UnicDB-chat-{accent,accent-hover,accent-strong,stop,warn}` tokens on the existing `.UnicDB-chat` block, plus a chat-scoped clone layer at the bottom of the file containing `.UnicDB-chat-header`, `.UnicDB-chat-brand` (28px/700/sans-serif/BLUE), `.UnicDB-chat-title`, `.UnicDB-chat-sessionchip`, `.UnicDB-chat-msg-user`, `.UnicDB-chat-msg-assistant`, `.UnicDB-chat-thought`, `.UnicDB-chat-tool` (+ `-failed` / `-denied`), `.UnicDB-chat-plan`, `.UnicDB-chat-usage`, `.UnicDB-chat-chip` + `.UnicDB-chat-chipmenu`, `.UnicDB-chat-toggle` (BLUE OFF) + `.UnicDB-chat-toggle-on` (amber `#f59e0b` ON), `.UnicDB-chat-stop` (square 16x16 red `#dc2626`) + `.UnicDB-chat-stop-live`, `.UnicDB-chat-secondary`, `@keyframes UnicDB-chat-pulse`, and a `@media (prefers-reduced-motion: reduce)` block disabling the pulse/caret/queued animations and the toggle thumb transition. Pre-existing `.UnicDB-chat*` rules and every non-chat selector are untouched.
- src/ui/__tests__/aiChatPanelCloneCss.test.ts (new): TDD test file covering the 5 task-spec cases + brand glyph + stop button + bypass toggle contracts; uses `git show HEAD:webview/styles.css` as the pre-cycle baseline so the isolation check is robust against future non-chat selector growth.

TESTS_ADDED:
- src/ui/__tests__/aiChatPanelCloneCss.test.ts:
  - "loads webview/styles.css"
  - ".UnicDB-chat declares the BLUE/stop/warn clone token block"
  - "Claude-orange hexes are NOT used as accent inside .UnicDB-chat rules"
  - "non-chat selectors are untouched and every new rule is chat-scoped"
  - "chat section has balanced braces"
  - ".UnicDB-chat-brand is the big BLUE 'U' brand glyph"
  - ".UnicDB-chat-stop is a red square; .UnicDB-chat-stop-live animates the pulse"
  - ".UnicDB-chat-toggle BLUE OFF, .UnicDB-chat-toggle-on amber ON"

Status: PASS
Note: Per the task's note that "JS tasks must not gate animations in code — add/remove classes and let the media query win", the prefers-reduced-motion block in this CSS file uses `animation: none !important` on the same chat-scoped selectors the JS will toggle, so consumers (TASK-AGTUI-007/008) only need to add/remove `.UnicDB-chat-stop-live` / `.UnicDB-chat-toggle-on` etc. and the OS-level preference is respected automatically. No npm deps added. Files left as-is in worktree (no `git add` / `commit` / `push`).

---

## Reviewer Verdict

(appended below by reviewer)

## Reviewer Report
REVIEWER_MODEL: unic-smart
Verdict: APPROVED-WITH-MINOR
Findings:
- [minor] src/ui/__tests__/aiChatPanelCloneCss.test.ts:159 — the "non-chat selectors untouched" isolation check uses `git show HEAD:webview/styles.css` as the pre-cycle baseline. Once this task was committed (87ec6e2), HEAD contains the chat selectors, so the "every new rule is chat-scoped" half of the check is tautological and will not catch future non-chat-selector additions. The declaration-level pins (toolbar flex-wrap, tab cursor, grid-host flex, btn var) and the direct diff evidence keep the property enforced for this task (wave-1 styles.css diff is 211 insertions / 0 deletions, verified). To keep the guard alive, pin the cycle base commit (`git show 515d87e:webview/styles.css`) or a hardcoded pre-cycle selector allowlist.
- [minor] docs/AI_HANDOFF/tasks/TASK-AGTUI-001.md:27 vs webview/styles.css — spec names `@keyframes UnicDB-chat-caret`, but the file relies on the pre-existing `UnicDB-chat-caret-blink` (pinned by chatLayoutCss.test.ts "streaming caret"). Functionally satisfied; spec text only. No code change needed, or align the spec wording in a docs pass.
- Clean: tokens byte-exact per PLAN §3 (`#3b82f6`/`#60a5fa`/`#2563eb`/`#dc2626`/`#f59e0b` on the existing `.UnicDB-chat` block); no Claude orange anywhere in chat rules; brand 28px/700/blue sans-serif; stop 16x16 square red with `UnicDB-chat-pulse`; toggle BLUE OFF / amber ON; reduced-motion block targets existing `.UnicDB-chat-stop-live`/`.UnicDB-chat-caret`/`.UnicDB-chat-queued`; all 19 newly added selectors are `.UnicDB-chat*`-scoped and match the test's pinned set; legacy element-id/class contract untouched (pure-additive CSS) and chatLayoutCss.test.ts passes unmodified.
Verification (reviewer re-run): `npx vitest run src/ui/__tests__/aiChatPanelCloneCss.test.ts src/ui/__tests__/chatLayoutCss.test.ts` → 39/39 pass; `npm run typecheck` → exit 0.
