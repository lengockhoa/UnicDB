# TASK-CHATUX-004 — W4 compact composer: ≤104px collapsed, 36–88 auto-grow, 32px send, IME/Enter contract pinned

- Status: `pending_review`
- Owner: `ExecT004`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (W4)
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-007, §8.3, §8.5

## Goal

Shrink the composer to standard chat proportions — collapsed footprint ≤104px: textarea auto-grow clamp 36–88px (was 64–160), tighter paddings, 36px bottom lane, 32px send/primary button. Pin the already-correct keyboard contract (Enter send / Shift+Enter newline / IME composition never sends) and in-session draft persistence with regression tests.

## Target Files

- `webview/aiChat/composer.ts` — `COMPOSER_AUTO_GROW_MIN_PX = 36`, `COMPOSER_AUTO_GROW_MAX_PX = 88` (lines 64-65 + comment at 63).
- `webview/aiChat/styles.css` — `-composer-top` `min-height:36px; max-height:88px; padding:6px 10px 4px` (~298-304); `-input` + `-input-v2` `max-height:76px` (~310, ~941-943); `-composer-bottom` `min-height:36px; padding:4px 8px` (~329-337); `-send` + `-primary` `width/height/min-width/min-height: 32px` (~347-364, ~1118-1134); update stale comments (297, 310, 328, 347, 1118).
- `webview/aiChat/__tests__/composer.test.ts` — extend (see Test Files).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `auto-grow clamps to 36–88px and scrolls beyond max` | scrollHeight 20 → `36px`; 60 → `60px`; 400 → `88px` + `input-scroll` class | existing `stubScrollHeight` harness, `idleValid()` state |
| 2 | edge (boundary) | `CSS pins the compact metrics` | styles.css: `-composer-top` `min-height:36px`+`max-height:88px`; `-input-v2` `max-height:76px`; `-composer-bottom` `min-height:36px`; `-send`+`-primary` `32px` | readFileSync styles.css |
| 3 | edge (input/IME) | `IME composition Enter never submits` | `decideComposerKey({key:"Enter", isComposing:true, …})` → `{kind:"ignore"}`; `keyCode:229` → `ignore`; plain Enter on valid idle draft → `submit`; Shift+Enter → `insert-newline` | pure `decideComposerKey` calls (keyboard.ts) |
| 4 | edge (state) | `draft text survives a render round-trip` | set `state.draft.text="select *"`, `view.render(state)` twice → `prompt.value === "select *"` | existing composer harness |

## Test Files

- `webview/aiChat/__tests__/composer.test.ts` — extend: rows 1–4 (row 1 updates the existing clamp test at ~403 which reads the exported constants; add explicit literal expectations).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/composer.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] Collapsed composer ≈ 36px top + 36px bottom + hint ≤ 104px total (CSS-scan rows prove the inputs).
- [ ] `<320px` two-row composer media query still present (existing test #6 stays green).
- [ ] No regression in related suites (`npx vitest run webview/aiChat/__tests__/`).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CHATUX-003 must complete first (both edit `webview/aiChat/styles.css`).

## Interfaces

- Consumes: `(none)` — keyboard.ts `decideComposerKey` is only read by tests, not modified.
- Produces: `COMPOSER_AUTO_GROW_MIN_PX = 36`, `COMPOSER_AUTO_GROW_MAX_PX = 88` — the existing clamp test reads these constants and self-adjusts.

---

## Discussion

### 2026-09-21 · planner · unic-smart
Keyboard contract is already correct in `keyboard.ts` (`isComposing`/`keyCode 229` → `ignore` at :89-91; Shift+Enter → `insert-newline` at :119; Enter → `submit` at :155) — this task PINS it with tests rather than reimplementing. Draft persistence is reducer-owned (`state.draft.text`, composer.ts:423) — in-session only; cross-reload persistence is out of scope (SPEC §14 Q5). Send/primary icons are already 16px via `createChatIcon`/`replaceSingleIcon` — only the button box shrinks to 32px.

---
<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Progress

- 2026-09-21T14:43:00+07:00 · milestone: compact-composer-green · last-green: composer.test.ts 22/22, aiChat suite 442/442, typecheck+compile clean · files: webview/aiChat/composer.ts, webview/aiChat/styles.css, webview/aiChat/__tests__/composer.test.ts, webview/aiChat/__tests__/errorsScrollA11y.test.ts, webview/aiChat/__tests__/shell.test.ts · drift: errorsScrollA11y.test.ts + shell.test.ts re-pinned the send slot 40px→32px — the task's own contract change obsoleted those assertions

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecT004
SUMMARY: Shrunk the V2 composer to compact chat proportions: auto-grow clamp 36–88px (was 64–160), composer-top padding 6px 10px 4px, bottom lane 36px min/4px 8px padding, send + primary slots 32x32 (was 40x40), textarea max-height 76px. Pinned the already-correct keyboard contract (IME Enter → ignore, keyCode 229 → ignore, Enter → submit, Shift+Enter → insert-newline) and in-session draft persistence with regression tests.
TEST_PLAN_FOLLOWED: task §Test Cases rows 1–4 — row 1 updated the existing clamp test with literal 36/88 expectations; rows 2–4 added as a new `TASK-CHATUX-004` describe block in composer.test.ts.
FILES_CHANGED:
  - webview/aiChat/composer.ts: COMPOSER_AUTO_GROW_MIN_PX 64→36, COMPOSER_AUTO_GROW_MAX_PX 160→88, comment updated to SPEC §8.3
  - webview/aiChat/styles.css: -composer-top 36/88px + 6px 10px 4px padding; -input and -input-v2 max-height 76px; -composer-bottom 36px min + 4px 8px padding; -send and -primary 32x32; stale comments updated
  - webview/aiChat/__tests__/composer.test.ts: literal-pinned clamp test + new describe (CSS metrics scan, IME/Enter contract, draft render round-trip)
  - webview/aiChat/__tests__/errorsScrollA11y.test.ts: send/stop assertion re-pinned 40px→32px (contract change)
  - webview/aiChat/__tests__/shell.test.ts: send slot assertion re-pinned 40px→32px (contract change)
TESTS_ADDED:
  - webview/aiChat/__tests__/composer.test.ts: "CSS pins the compact metrics (≤104px collapsed footprint)", "IME composition Enter never submits; the Enter contract is pinned", "draft text survives a render round-trip"; updated "clamps measured scrollHeight to 36–88px and scrolls beyond the max"
RED_OUTPUT: |
  FAIL webview/aiChat/__tests__/composer.test.ts > TASK-CHATV2-008 composer — auto-grow boundary (#5) > clamps measured scrollHeight to 36–88px and scrolls beyond the max
  AssertionError: expected 64 to be 36 // Object.is equality
  FAIL webview/aiChat/__tests__/composer.test.ts > TASK-CHATUX-004 composer — compact metrics + pinned contracts > CSS pins the compact metrics (≤104px collapsed footprint)
  AssertionError: expected '\n display: flex: \n min-width: 0: \n…' to contain 'min-height: 36px'
  Test Files 1 failed (1) | Tests 2 failed | 20 passed (22)
  (IME/Enter + draft-persistence tests passed pre-change — they pin already-correct behavior per the task's Discussion note.)
VERIFICATION:
  command: npx vitest run webview/aiChat/__tests__/composer.test.ts
  result: 22 pass / 0 fail
  output_excerpt: |
    ✓ webview/aiChat/__tests__/composer.test.ts  (22 tests) 43ms
    Test Files  1 passed (1)
         Tests  22 passed (22)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit, no output)
  command: npm run compile
  result: exit 0 — dist/webview.js 2.3mb, dist/webview.css 41.6kb
  command: npx vitest run webview/aiChat/__tests__/
  result: 24 files / 442 tests, all pass
ISSUES: none — collapsed footprint = 36px top + 36px bottom + hint ≤104px; <320px two-row media query untouched (test #6 green); send/primary icons unchanged (16/18px inside the 32px box).
HANDOFF_TO_REVIEWER: yes — Status set to pending_review in INDEX.md; reviewer must run on a different model.
NEXT: ready for review

