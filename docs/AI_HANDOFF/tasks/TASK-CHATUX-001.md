# TASK-CHATUX-001 — W1 layout stabilization: single scroll owner, normal flow, normalized spacing

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (W1)
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-001, §7, §8.5

## Goal

Stabilize the V2 shell layout: keep the existing `40px auto minmax(0,1fr) auto auto 20px` root grid, guarantee the transcript is the ONLY scroll region, remove the fixed `width: 880px` on assistant items (normal document flow), and normalize Markdown block spacing. CSS-only task — no DOM/TS changes.

## Target Files

- `webview/aiChat/styles.css` — remove `width: 880px` from `.UnicDB-ai-chat-v2-item-text, .UnicDB-ai-chat-v2-item-reasoning` (~line 579); verify/normalize `-md-paragraph`/`md-heading` margins; confirm no `position: fixed` and no second `overflow-y: auto` scroll region; update stale comments.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `root grid keeps minmax(0,1fr) transcript track and transcript is the sole overflow-y:auto region` | styles.css contains `grid-template-rows: 40px auto minmax(0, 1fr) auto auto 20px`; exactly ONE `overflow-y: auto` inside `.UnicDB-ai-chat-v2-transcript` rule (context strip uses overflow-x only) | readFileSync styles.css |
| 2 | edge (contract) | `no fixed positioning or fixed widths on message blocks` | zero `position: fixed` file-wide; the `-item-text`/`-item-reasoning` rule body contains NO `width:`/`max-inline-size` declaration and keeps `max-width: 92%`. Scan is scoped to that rule — `-error-card` `width: 880px` (:2650) + `max-width: 880px` (:2836) and `-change-plan` `max-inline-size: 880px` (:2512) are intentional and stay | readFileSync styles.css |
| 3 | edge (spacing) | `Markdown spacing normalized` | `-md-paragraph` margin `0 0 8px`; `-md-heading` margin `12px 0 6px`; `-code` keeps `overflow-x: auto` + `white-space: pre` | readFileSync styles.css |

## Test Files

- `webview/aiChat/__tests__/shellGrid.test.ts` — extend with the three cases above (match existing CSS-scan style in this file).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/shellGrid.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED on the 880px/fixed-position rows before the edit).
- [ ] No regression in related suites (`npx vitest run webview/aiChat/__tests__/`).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.
- [ ] No `position: fixed` file-wide; no `width:`/`max-inline-size` declaration inside the `-item-text`/`-item-reasoning` rule (`-error-card`/`-change-plan` 880px caps are out of FR-001 scope); no second `overflow-y: auto` scroll region in styles.css.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)`
- Produces: `styles.css` layout contract that TASK-CHATUX-003/004 build on — root grid rows `40px auto minmax(0,1fr) auto auto 20px`; `.UnicDB-ai-chat-v2-transcript` sole `overflow-y:auto`; `-item-text`/`-item-reasoning` `max-width: 92%` with NO fixed width.

---

## Discussion

### 2026-09-21 · planner · unic-smart
CSS-only task by design — the grid and single-scroll-owner structure already exist (verified styles.css:54, 229-248); this task removes the remaining fixed-width violation and pins the contract with tests so later waves can't regress it.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

- Timestamp: 2026-09-21
- EXECUTOR_TOOL: omp (Oh My Pi)
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: ExecT001 (feature-implementer)
- Status: PASS

### Summary

Removed the fixed `width: 880px` from `.UnicDB-ai-chat-v2-item-text, .UnicDB-ai-chat-v2-item-reasoning` (styles.css:579) so assistant items size in normal flow under `max-width: 92%`, and updated the stale `max 880px/92%` comment to `max 92%`. Added the three TASK-CHATUX-001 contract tests to `shellGrid.test.ts` (root grid rows + sole `overflow-y:auto` transcript, no `position:fixed`/fixed widths on message blocks, normalized md spacing). Migrated the stale `transcript.test.ts` case that pinned `width: 880px` to assert the new contract (no `width:`/`max-inline-size`, keeps `max-width: 92%` + `padding: 4px 0`).

### RED_OUTPUT

```
❯ webview/aiChat/__tests__/shellGrid.test.ts (9 tests | 1 failed) 6ms
❯ webview/aiChat/__tests__/shellGrid.test.ts > TASK-CHATUX-001 layout stabilization contract > has no fixed positioning or fixed widths on message blocks
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
FAIL webview/aiChat/__tests__/shellGrid.test.ts > ... > has no fixed positioning or fixed widths on message blocks
AssertionError: expected '...align-self: flex-start; max-wi…' not to match /(^|;)\s*width\s*:/
❯ webview/aiChat/__tests__/shellGrid.test.ts:132:22
Test Files 1 failed (1)
```

(RED confirmed on the `width: 880px` row; the other two new cases passed pre-edit since the grid/spacing contract already held.)

### Verification Output

```
$ npx vitest run webview/aiChat/__tests__/shellGrid.test.ts
✓ webview/aiChat/__tests__/shellGrid.test.ts (9 tests) 4ms
Test Files 1 passed (1)
Tests 9 passed (9)

$ npm run typecheck
> tsc --noEmit
(clean, exit 0)

$ npm run compile
⚡ Done in 32ms
dist/webview.js 2.3mb ⚠️
dist/webview.css 41.6kb

$ npx vitest run webview/aiChat/__tests__/
Test Files 23 passed (23)
Tests 425 passed (425)
```

### Files Changed

- `webview/aiChat/styles.css` — removed `width: 880px` from `-item-text`/`-item-reasoning`; comment updated.
- `webview/aiChat/__tests__/shellGrid.test.ts` — +3 TASK-CHATUX-001 contract tests.
- `webview/aiChat/__tests__/transcript.test.ts` — migrated stale 880px assertion to the new no-fixed-width contract.

### Note

`-error-card` `width: 880px` (:2650) / `max-width: 880px` (:2836) and `-change-plan` `max-inline-size: 880px` (:2512) are intentional per §Test Cases and untouched. Other `overflow-y: auto` sites (input, scroll regions inside composer/menus) are outside the transcript contract and untouched. Milestone commit `832ba58` on `handoff/task-chatux-001`.
