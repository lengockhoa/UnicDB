# TASK-CHATUX-W5-1 — W5 a11y audit: reduced-motion coverage + focus-ring/aria pins

- Status: `ready`
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
