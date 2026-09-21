# TASK-CHATUX-004 — W4 compact composer: ≤104px collapsed, 36–88 auto-grow, 32px send, IME/Enter contract pinned

- Status: `ready`
- Owner: `-`
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
