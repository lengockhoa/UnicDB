# TASK-AG-001 — Composer toolbar → icon-only SVG buttons with hover tooltips

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AG.md` §7

## Goal

Replace the 5 text-labeled buttons in the AI chat composer toolbar (`Resume session`, `Clear`, `Regenerate`, `Stop`, `Send`) with inline SVG icons that expose native hover tooltips (`title`) and accessible names (`aria-label`), keeping every existing ID, class, state and click behavior intact.

Icon mapping (bind in `COMPOSER_ICONS`): `resumeBtn` → history/clock-rewind, `clearBtn` → trash, `regenerateBtn` → refresh-ccw (circular arrow), `stopBtn` → square (filled or outlined), `sendBtn` → paper-plane, `attachBtn` → paperclip (replaces the bare `+`). Labels for tooltips: "Resume session" / "Clear conversation" / "Regenerate" / "Stop" / "Send" / "Attach image".

## Target Files

- `webview/aiChatPanelMain.ts` — renderInitial() (:449-457): swap text labels for inline SVGs from a new shared `COMPOSER_ICONS` map ({svg, label} per button id); add `title` + `aria-label` to each composer button (attach `+` normalized to the same pattern). No ID/class/listener/state changes.
- `webview/styles.css` — `.vsdb-chat-actions button svg {width:16px;height:16px;pointer-events:none}`, square icon-button sizing, hover affordance, `:focus-visible` ring; Send primary accent untouched.
- `src/ui/__tests__/aiChatPanelBundle.test.ts` — UPDATE 3 label-based Resume locators (:150/:165/:182 `textContent.includes("Resume")` → `#resumeBtn` by ID) + add a "no text labels remain" probe.
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — ADD tooltip/a11y assertions (each composer icon button: `title` non-empty, `title === aria-label`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | composer buttons render SVG icons | each of sendBtn/clearBtn/stopBtn/resumeBtn/regenerateBtn/attachBtn contains exactly one `<svg>` child | bundle loaded, init dispatched |
| 2 | unit | composer row has zero visible text labels | all 6 buttons have empty trimmed textContent (labels fully gone, not just Resume) | bundle loaded |
| 3 | unit | tooltip + accessible name stay in sync | for each of the 6: `title` non-empty AND `title === aria-label` | bundle loaded |
| 4 | edge | busy state: send disabled + resume/regen disabled-while-busy still works | setBusy(true) → sendBtn.disabled true; busy-state logic from existing code paths unchanged | init + setBusy fixtures (existing) |
| 5 | edge | attach button keeps distinct affordance | attachBtn keeps `+`→ now svg icon, title remains "Attach image"-class constant, file input opens on click (existing handler untouched) | init fixture |
| 6 | edge | buttons clicked while hidden/absent → no throw | dispatch messages when composer elements missing (defensive null-guards already present) stay green | jsdom without full DOM |
| 7 | regression | send/clear/stop/resume/regenerate click handlers fire exactly as before | send posts message type "send"; resume posts "resume_list" once; clear/stop/regen post their existing message types | bundle loaded, spies on post |
| 8 | regression | existing bundle suite green after selector migration | aiChatPanelBundle.test.ts passes with #resumeBtn-by-ID locators (3 sites) | current suite at HEAD |
| 9 | regression | grid toolbar icon pattern unaffected | `.vsdb-btn svg` rule intact in styles.css; grid bundle tests untouched and green | current suite at HEAD |

## Test Files

- `src/ui/__tests__/aiChatPanelBundle.test.ts` — tests 1–3, 7–9 (UPDATE 3 sites + ADD 1–3 probes).
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — tests 4–6 (host/webview message-path tests extended with tooltip assertions).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
npm run typecheck
npm test
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first, GREEN after).
- [ ] Composer row shows 6 icon buttons, zero visible text labels; every icon has `title` === `aria-label`, both non-empty.
- [ ] All existing behaviors verified green: send/clear/stop/resume/regenerate/attach click paths.
- [ ] Send keeps `.vsdb-chat-primary` accent (still visually primary).
- [ ] `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.
- [ ] No diff in `src/ui/aiChatPanel.ts` (host untouched) and no diff in cycle AF/AE artifacts.
- [ ] CHANGELOG entry (user-facing UI change); version `1.11.1` at release step (next free patch if taken).

## Dependencies

- (none)

## Interfaces

- Consumes: existing DOM contract in `webview/aiChatPanelMain.ts` (button IDs `sendBtn`/`clearBtn`/`stopBtn`/`resumeBtn`/`regenerateBtn`/`attachBtn`; message `post()` types `send`/`resume_list` etc. — unchanged); `.vsdb-btn svg` CSS pattern (styles.css:58-64) as visual precedent.
- Produces: `COMPOSER_ICONS` map in aiChatPanelMain.ts (`Record<ComposerButtonId, {svg: string; label: string}>`) — the icon+label pattern later webview toolbars can reuse; CSS class hook `.vsdb-chat-actions button svg` for future icon sizing.

---

## Discussion

### Executor decisions (2026-08-29)

- **Resume picker Cancel stays text**: `renderResumePicker` builds its Cancel button outside `.vsdb-chat-actions`; the "zero text labels" probe scopes to the 6 composer buttons only (by ID). `btnContaining(root, "Resume")` migrations landed in all owned + neighboring suites (aiChatPanelWebview.test.ts ×4, aiChatPanelWebviewTask002.test.ts ×1, aiChatPanelBundle.test.ts ×3); the task002 copy of `btnContaining` became unused and was removed (its webview.test.ts sibling stays — "Allow once"/"**Refuse**" permission-card locators still need text matching).
- **`#regenerateBtn` CSS rule removed**: the per-ID font-size/padding rule was dead weight on an icon tile; the shared `.vsdb-chat-actions button` block now sizes/styles all six. The pinned chatLayoutCss contract test was migrated to accept the shared tile rule as the affordance source (per-ID override and `.vsdb-chat-secondary` kept as accepted alternatives to not over-constrain).
- **`vsdb-chat-secondary` class retained in markup** on resume/regen/stop (zero CSS rules target it now) — kept only as a semantic hook for future styling; removal would have touched the same template lines anyway, but the class costs nothing and preserves the existing chatLayoutCss fallback branch.
- **setBusy attach sync**: title and aria-label are now re-asserted together on every busy/vision flip (`COMPOSER_ICONS.attachBtn.label` is the source for the normal label), so the vision-incapable tooltip flip ("Current model does not support images") can never leave aria-label behind (covered by #AG5b).
- **Icon glyphs**: reused grid-toolbar idioms where they exist (trash = ICON_DELETE_ROW, refresh-ccw = ICON_ROLLBACK, square = ICON_CANCEL's rect); history/clock-rewind, paperclip, and paper-plane are new 16×16 stroke paths in the same drawing idiom.
- **AG7 test nuance**: regen/resume handlers guard on `state.busy`, so the click sequence dispatches `init{hasHistory:false}` after Clear (emulating the host reply) before clicking them — testing the guards themselves is pre-existing coverage (task002 #11).

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

- STATUS: DONE
- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: ExecAG001
- SUMMARY: Composer toolbar is icon-only: new `COMPOSER_ICONS` map (svg+label per button id) + `composerIconSvg`/`iconButtonHtml` render helpers in `webview/aiChatPanelMain.ts`; all 6 buttons (resumeBtn/clearBtn/regenerateBtn/stopBtn/attachBtn/sendBtn) render a 16×16 currentColor inline SVG with `title` === `aria-label` from the map; `setBusy` re-asserts the attach title+aria-label pair on busy/vision flips; CSS turns `.vsdb-chat-actions button` into 28×28 icon tiles with 16px svg, hover (`--vsdb-input-hover-bg`), `:focus-visible` ring; obsolete `#regenerateBtn` per-ID rule removed; all text-based "Resume" locators migrated to `#resumeBtn` (bundle ×3, webview ×4, task002 ×1; unused task002 `btnContaining` helper removed; chatLayoutCss regenerate affordance contract migrated to accept the shared tile rule); CHANGELOG entry under [Unreleased].
- TEST_PLAN_FOLLOWED: task §Test Cases (1–9) — implemented as #AG1–#AG3, #AG3b, #AG4–#AG6, #AG7–#AG9 across the two suites in §Test Files.
- FILES_CHANGED:
  - webview/aiChatPanelMain.ts: COMPOSER_ICONS map + render helpers; icon-only composer markup; setBusy aria sync
  - webview/styles.css: `.vsdb-chat-actions button` icon-tile rules (svg sizing, hover, focus-visible); removed `#regenerateBtn` rule
  - src/ui/__tests__/aiChatPanelBundle.test.ts: 3 Resume locators → `#resumeBtn`; added #AG1–#AG3, #AG7–#AG9
  - src/ui/__tests__/aiChatPanelWebview.test.ts: 4 Resume locators → `#resumeBtn`; added #AG3b, #AG4–#AG6, #AG5b
  - src/ui/__tests__/aiChatPanelWebviewTask002.test.ts: Resume locator → `#resumeBtn`; removed unused `btnContaining`
  - src/ui/__tests__/chatLayoutCss.test.ts: regenerate affordance contract accepts shared `.vsdb-chat-actions button` tile rule
  - CHANGELOG.md: [Unreleased] entry for the icon-only composer toolbar
- TESTS_ADDED:
  - src/ui/__tests__/aiChatPanelBundle.test.ts: #AG1 (one svg per button), #AG2 (zero text labels), #AG3 (title === aria-label), #AG7 (all click handlers post), #AG8 (resume via #resumeBtn), #AG9 (.vsdb-btn svg rule intact)
  - src/ui/__tests__/aiChatPanelWebview.test.ts: #AG4 (busy disables send/resume/regen/attach, done re-enables), #AG5 (attach svg + constant tooltip + opens file input), #AG5b (vision-incapable tooltip flip keeps aria-label synced), #AG6 (composer-absent messages don't throw), #AG3b (per-button svg/text/title assertions)
- VERIFICATION:
  - RED: `npx vitest run src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts` → 8 failed | 41 passed (all 8 failures = new AG icon/tooltip/attach tests: svg count 0, text labels present, attach aria-label stale)
  - command: npx vitest run src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
    result: 49 pass / 0 fail
    output_excerpt: |
      ✓ src/ui/__tests__/aiChatPanelBundle.test.ts  (17 tests) 61ms
      ✓ src/ui/__tests__/aiChatPanelWebview.test.ts  (32 tests) 93ms
      Test Files 2 passed (2)
      Tests 49 passed (49)
  - command: npm run typecheck → exit 0 (tsc --noEmit, no output)
  - command: npm test
    result: 2032 pass / 0 fail / 2 skipped (139 files: 138 passed, 1 skipped)
  - command: npm run compile → exit 0 ("esbuild: build complete")
- ISSUES: none
- HANDOFF_TO_REVIEWER: yes — task status set to `pending_review` in INDEX_AG.md and this file; reviewer must use a different model than unic-code.
- NEXT: ready for review.
