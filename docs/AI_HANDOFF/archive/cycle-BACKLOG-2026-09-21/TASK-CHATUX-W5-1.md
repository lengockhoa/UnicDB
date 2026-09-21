# TASK-CHATUX-W5-1 — W5 a11y audit: reduced-motion coverage + focus-ring/aria pins

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-006, FR-007, FR-008 (§5); edge cases §10; test matrix §11

## Goal

Close the accessibility half of the advisor W5 audit on the V2 chat surface:
extend `prefers-reduced-motion` coverage to every animated/transitioned
selector, and pin the focus-ring + aria invariants with CSS-scan and DOM
tests so the audit stays green permanently.

## Target Files

- `webview/aiChat/styles.css` — extend the `@media (prefers-reduced-motion:
  reduce)` blocks so every selector that sets `animation`/`transition`
  outside them is suppressed inside (verified gaps: `-live-dot` :896,
  `-activity-icon.-activity-state-running` :1428, `-autocomplete-spinner`
  :1937, `-engine-working` descendants, `-toast`, menu/overlay/dialog
  transitions); add any missing `:focus-visible` rule the scan exposes.
- `webview/aiChat/a11y.ts` — only if the aria audit finds a concrete gap in
  helpers it owns (live regions, announcer, combobox, tooltip); otherwise
  unchanged.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (CSS scan) | reduced-motion coverage | every selector carrying `animation:`/`transition:` outside a reduce block appears inside one — fails today (`-live-dot`, `-activity-state-running`, `-autocomplete-spinner` uncovered) | readFileSync styles.css, parse reduce blocks |
| 2 | edge (CSS invariant) | `outline: none` uniqueness | exactly 1 occurrence, on `.UnicDB-ai-chat-v2-input` | styles.css scan |
| 3 | happy (CSS scan) | focus-visible pinned list | every selector in SPEC FR-007's list has a `:focus-visible` rule with `outline` + `outline-offset` | styles.css scan |
| 4 | unit (happy) | live-region invariant | `countLiveRegions(shell)` → `{ polite: 1, assertive: 1 }` after `mountChatShell` | jsdom shell mount |
| 5 | edge (malformed) | announcer refuses stream text | `isAnnounceablePhase(longMultiLine)` → false; announcer drops it | `createLiveAnnouncer` fake regions |
| 6 | edge (boundary) | combobox active descendant | `activeDescendantResolves(input, list)` true only while the id exists in `list` | `linkCombobox` + jsdom list |

## Test Files

- `webview/aiChat/__tests__/errorsScrollA11y.test.ts` — extend, cases 1–6
  (it already imports a11y/scroll/shell and does CSS scans).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/errorsScrollA11y.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for #1).
- [ ] No `animation:`/`transition:` declaration outside reduced-motion coverage.
- [ ] `outline: none` only on `-input`; all pinned `:focus-visible` selectors present.
- [ ] No hard-coded colors — `var(--UnicDB-ai-chat-v2-focus)` / `--vscode-focusBorder` only.
- [ ] No regression in `webview/aiChat/__tests__/`.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: (none) — CSS + test-only change; no new exports expected. If an
  a11y.ts helper is added, record it here before marking pending_review.

---

## Discussion

### 2026-09-21 · planner · unic-smart
Scope guard: aria gaps found in `transcript.ts`/`markdown.ts` belong to
TASK-CHATUX-W5-2 — record them in ITS Discussion, do not edit those files
here (same-wave file-sharing rule). The CSS scan should extract selectors
textually (the file has no build-time CSS parser); a regex over
`selector { … animation|transition … }` blocks is sufficient — see the
existing scan patterns in `errorsScrollA11y.test.ts` and `shellGrid.test.ts`.

### 2026-09-21 · executor · unic-code
Audit findings beyond the planner's verified gaps:
- `-tool-head` (FR-007 pinned) is a non-focusable `<div>` — the real button is
  `-tool-toggle` inside it. Added the pin rule for `-tool-head` plus a real
  rule for `-tool-toggle`; noted here per the scope guard (transcript.ts is
  W5-2's file, untouched).
- Additional focusable elements had no `:focus-visible` rule and got one:
  `-mark`, `-title`, `-engine`, `-overflow`, `-composer-menu-row`,
  `-activity-detail-toggle`, `-activity-copy`, `-autocomplete-retry`,
  `-context-chip-preview`, `-title-editor`, `-attachment-thumb-remove`.
- `-overlay-menu-row` is `role=option` (activedescendant pattern, never
  focused) — intentionally no `:focus-visible` rule.
- `-stop` class is dead CSS (no TS emits it; the stop state is `-primary-busy`)
  — left untouched.
- `-toast`/`-menu-row`/`-overlay-modal`/`-dialog` carry no
  `animation:`/`transition:` declarations — nothing to suppress there.
- `.UnicDB-ai-chat-v2-composer .UnicDB-ai-chat-v2-control` out-specified the
  old RM rule (real specificity bug, not just a scan gap) — fixed by listing
  the descendant selector in the new composer RM block.
- No a11y.ts gap found: live regions, announcer, combobox, tooltip helpers all
  satisfy the pinned invariants — file unchanged.

## Progress

- 2026-09-21T21:31:00+07:00 · milestone: green · last-green: 45/45 errorsScrollA11y + 445/445 aiChat dir + tsc clean · files: webview/aiChat/styles.css, webview/aiChat/__tests__/errorsScrollA11y.test.ts, docs/AI_HANDOFF/tasks/TASK-CHATUX-W5-1.md · drift: none

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecW51 (feature-implementer)
SUMMARY: Extended prefers-reduced-motion coverage to every animated/transitioned
selector (5 real gaps: -tool-status[running], -live-dot, composer -control,
-primary, -autocomplete-spinner) and added :focus-visible rings for the 4
missing FR-007 pins plus 12 audit-found focusable classes. Three CSS-scan tests
pin the invariants permanently.
TEST_PLAN_FOLLOWED: task §Test Cases — cases 1-3 added as new CSS-scan tests;
cases 4-6 already existed verbatim in this file (live regions :415, announcer
refusal :445, combobox activedescendant :481).
FILES_CHANGED:
  - webview/aiChat/styles.css: 3 new RM blocks + 16 new :focus-visible rules
  - webview/aiChat/__tests__/errorsScrollA11y.test.ts: new "W5 a11y audit"
    describe (3 tests: RM coverage scan, outline:none uniqueness, focus pins)
TESTS_ADDED:
  - errorsScrollA11y.test.ts: "reduced-motion coverage: every
    animation/transition selector is suppressed inside a reduce block",
    "`outline: none` appears exactly once, on the composer input",
    "focus-visible: every pinned interactive selector has an outline + offset ring"
RED_OUTPUT: |
  FAIL > reduced-motion coverage … expected [ …(5) ] to deeply equal []
    + ".UnicDB-ai-chat-v2-tool-status[data-status=\"running\"]"
    + ".UnicDB-ai-chat-v2-live-dot"
    + ".UnicDB-ai-chat-v2-composer .UnicDB-ai-chat-v2-control"
    + ".UnicDB-ai-chat-v2-primary"
    + ".UnicDB-ai-chat-v2-autocomplete-spinner"
  FAIL > focus-visible … expected [ …(16) ] to deeply equal []
    (+16 selectors incl. -codeblock-copy, -load-earlier, -reasoning-toggle,
     -tool-head, -mark, -title, -engine, -overflow, -composer-menu-row,
     -activity-detail-toggle, -activity-copy, -tool-toggle,
     -autocomplete-retry, -context-chip-preview, -title-editor,
     -attachment-thumb-remove)
  Tests 2 failed | 43 passed (45)
VERIFICATION:
  command: npx vitest run webview/aiChat/__tests__/errorsScrollA11y.test.ts
  result: 45 pass / 0 fail
  output_excerpt: |
    ✓ webview/aiChat/__tests__/errorsScrollA11y.test.ts (45 tests) 38ms
    Test Files 1 passed (1)
    Tests 45 passed (45)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit clean)
  command: npx vitest run webview/aiChat/__tests__/
  result: 445 pass / 0 fail across 24 files (no regression)
ISSUES: none — a11y.ts untouched (no gap); transcript.ts/markdown.ts untouched
  per same-wave file-sharing rule.
HANDOFF_TO_REVIEWER: yes — DONE with fresh PASS output.
NEXT: ready for review

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (EXECUTOR_SUBAGENT: ExecW51)
VERIFICATION_RERUN:
  command: npx vitest run webview/aiChat/__tests__/errorsScrollA11y.test.ts
  result: 45 pass / 0 fail
  command: npm run typecheck
  result: exit 0 (tsc --noEmit clean)
TEST_PLAN_COVERAGE: all-followed — cases 1-3 added as new CSS-scan tests with real
  assertions (RED_OUTPUT contains genuine failing-diff output); cases 4-6 verified
  pre-existing at :415 (countLiveRegions), :445-454 (announcer refusal +
  isAnnounceablePhase), :490-506 (linkCombobox + activeDescendantResolves).
FINDINGS:
  critical: none
  important: none
  minor:
    - file: webview/aiChat/__tests__/errorsScrollA11y.test.ts:~735 — the
      reduced-motion coverage test asserts the animated selector *appears* inside
      a reduce block but not that the block actually suppresses motion
      (`animation: none`/`transition: none`). A future reduce block that lists the
      selector without a `none` declaration would pass the pin while leaving the
      animation running. Current CSS is correct (all 3 new blocks use `none`), so
      this is a future-proofing gap, not a present defect.
    - file: webview/aiChat/styles.css:2020,2224,2462 — three new rings use
      `var(--vscode-focusBorder, #5f9eff)` while most use
      `var(--UnicDB-ai-chat-v2-focus)`; matches the pre-existing convention in
      this file (:2592, :2666, :2796) and the test accepts both, so consistent —
      noted only for awareness.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Spot-checked executor's audit claims: `-activity-state-running` (:1485)
  and `-engine-working .-engine-dot` (:163) were already covered by pre-existing
  RM blocks (:541, :1651); `-toast` carries no animation/transition — claims
  accurate. `outline: none` confirmed unique at :329 on `-input`.
