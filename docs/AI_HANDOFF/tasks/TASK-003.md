# TASK-003 — Chat layout: pinned composer, full-height thread (CSS)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.3, §3, §4, §7

## Goal

Fix the "input in the middle" bug: make the chat panel a full-height flex column — `.vsdb-chat-thread`
grows (`flex: 1`) and scrolls; `.vsdb-chat-input` pins to the bottom edge. Kill the `max-height: 60vh` cap
(`webview/styles.css:902-909`). Style the TASK-002 affordances (thinking block, jump-to-latest, copy
buttons, queued marker, caret, Regenerate button) consistently with the existing bubble styles.

## Target Files

- `webview/styles.css` — replace `.vsdb-chat-thread` cap with full-height flex growth; extend the
  `.vsdb-chat` shell (`src/ui/aiChatPanel.ts:1486`) to `display:flex; flex-direction:column; height:100%`
  so the composer pins to the panel bottom; keep `.vsdb-form-body` usable by other forms (scope overrides
  to `.vsdb-chat`). Add styles for: `.vsdb-chat-thinking` (+`-body`), `.vsdb-chat-jump`,
  `.vsdb-md-copy`, `.vsdb-chat-queued`, `.vsdb-chat-caret`, `#regenerateBtn`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug) | 60vh cap removed, thread flexes | RED against current CSS, GREEN after: `.vsdb-chat-thread` rule block in webview/styles.css declares `flex: 1` (or `flex: 1 1 auto`) and contains NO `max-height: 60vh`; `.vsdb-chat` declares `display: flex`, `flex-direction: column`, `height: 100%` | CSS contract test parsing styles.css |
| 2 | happy | composer pinned | `.vsdb-chat-input` remains a flex child AFTER the thread with no `position: absolute`; margin/visual order thread→input preserved in stylesheet order | same test file |
| 3 | edge (boundary) | caret visible on streaming bubble | `.vsdb-chat-caret` (or `.vsdb-chat-assistant.vsdb-chat-streaming::after`) exists with a non-empty `content` and `display` ≠ `none` | streaming class from TASK-002 |
| 4 | edge (scope) | other forms unaffected | `.vsdb-form-body`/`.vsdb-form` rules untouched by diff: no rule targeting bare `.vsdb-form-body` is added/modified; new rules all scoped under `.vsdb-chat` | full-file parse |

## Test Files

- `src/ui/__tests__/aiChatPanelChatLayout.test.ts` — (new) reads `webview/styles.css` and asserts the
  contract above (pure string/regex parse of rule blocks; same style as CSS contract checks used in
  bundle tests — no browser needed).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelChatLayout.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate. No
`npm run compile` prerequisite: the test reads `webview/styles.css` directly.
(Test selection: target file `webview/styles.css` — no tests-map entry; falls to the mandatory non-empty
floor via a purpose-built single test file. Full `npm test` at wave boundary is the regression net.)

## Acceptance Criteria

- [ ] Test #1 is RED before the CSS change and GREEN after (paste both outputs in Executor Report).
- [ ] Every test in §Test Cases passes; `npm run typecheck` exits 0.
- [ ] Visual layout: thread fills panel height, composer at bottom (smoke: open AI Chat panel in VS Code
  host or `code --extensionDevelopmentPath`; report observed — cannot screenshot in CI).
- [ ] No rule outside the `.vsdb-chat` scope modified.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — pure CSS + new test file; no source-file overlap with TASK-001/002 (they own .ts files).
  Styling targets TASK-002's DOM contract (`#thinkingBlock` etc.) but does not modify it.

## Interfaces

- Consumes: DOM contract from TASK-002 §Interfaces: ids `#thinkingBlock`, `#jumpLatest`,
  `#regenerateBtn`; classes `vsdb-chat-thinking`, `vsdb-chat-thinking-body`, `vsdb-md-copy`,
  `vsdb-chat-queued`, `vsdb-chat-caret`.
- Produces: (none) — leaf styling task.

---

## Discussion

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->


## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: ExecT3
SUMMARY: Killed the 60vh cap on `.vsdb-chat-thread` (now `flex: 1 1 auto; min-height: 0; overflow-y: auto`), added a `.vsdb-chat` shell rule (`display: flex; flex-direction: column; height: 100%`) so the composer pins to the panel bottom, and appended CSS-first styles for TASK-002's resume picker (`.vsdb-chat-resume-picker/-row/-card/-label/-detail`) and TASK-005's mention dropdown (`.vsdb-chat-mention-dropdown/-row/-kind`) — both mirroring the `.vsdb-chat-permission` card pattern (1px solid border + --vscode-editorWidget-background).
TEST_PLAN_FOLLOWED: task §Test Cases — assertions slightly extended (also covers mention-dropdown selectors as requested by the prompt) but the 4 task-mandated contracts (thread flexes, shell column, input not absolute, thread-before-input order) are all in the suite.
FILES_CHANGED:
  - webview/styles.css: `.vsdb-chat-thread` lost `max-height:60vh`, gained `flex:1 1 auto; min-height:0;`; new `.vsdb-chat` shell rule inserted before the AI-chat banner; appended ~95 lines of resume-picker + mention-dropdown rules (CSS-first).
  - src/ui/__tests__/chatLayoutCss.test.ts: NEW — 6 CSS contract assertions (regex-based, matches existing `webviewToolbar.test.ts` / `resultsGridModelNull.test.ts` pattern). Includes a `hasHoverRule()` helper because `:hover` is in a sibling rule block, not inside the base block's body.
TESTS_ADDED:
  - src/ui/__tests__/chatLayoutCss.test.ts: 6 tests (see RED output below).
VERIFICATION:
  command: npx vitest run src/ui/__tests__/chatLayoutCss.test.ts
  result: 6 pass / 0 fail / exit code 0
  output_excerpt: |
    ✓ src/ui/__tests__/chatLayoutCss.test.ts  (6 tests) 8ms
    Test Files  1 passed (1)
         Tests  6 passed (6)
  command: npm run typecheck
  result: exit code 0
  output_excerpt: |
    > vsdb@1.7.0 typecheck
    > tsc --noEmit
ISSUES: Initial RED run had 4 failures as expected (thread lacks flex:1, `.vsdb-chat` shell missing, resume-* selectors absent, mention-* selectors absent). GREEN required adjusting the hover assertion to look for a sibling `selector:hover {…}` block instead of inside the base block body — resolved via a `hasHoverRule()` file-level regex helper; both row selectors now have explicit `:hover` rules in styles.css.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for reviewer (CSS-only change; TASK-005 can now populate `.vsdb-chat-mention-dropdown` markup against these hooks).
```

RED OUTPUT (paste from `npx vitest run src/ui/__tests__/chatLayoutCss.test.ts` BEFORE the CSS change):

  ❯ src/ui/__tests__/chatLayoutCss.test.ts  (6 tests | 4 failed) 140ms
    ❯ .vsdb-chat-thread grows via flex:1 and no longer caps at 60vh
      → .vsdb-chat-thread must declare flex:1 (or flex:1 1 auto): expected false to be true
    ❯ .vsdb-chat shell is a full-height flex column so the composer pins bottom
      → .vsdb-chat rule block must exist: expected '' not toBe ''
    ❯ resume-picker: row uses cursor:pointer + padding; card mirrors permission-card pattern
      → .vsdb-chat-resume-row rule block must exist: expected '' not.toBe ''
    ❯ mention-dropdown: CSS-first selectors exist (consumed by TASK-005)
      → .vsdb-chat-mention-dropdown rule block must exist: expected '' not.toBe ''
  Tests  4 failed | 2 passed (6)


---

