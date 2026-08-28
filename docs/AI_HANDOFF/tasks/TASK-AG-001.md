# TASK-AG-001 — Composer toolbar → icon-only SVG buttons with hover tooltips

- Status: `ready`
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

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
