# PLAN_AG — Cycle AG: AI Chat composer → icon-only toolbar with hover tooltips (v1.11.1)

## §1 Intent

User (verbatim): "[Image] Cái ô không chat này ở AI chat phải sửa lại là icon hết. Chỉ dùng Icon và khi đưa chuột vào hover thì ra tooltip để thấy chữ. Dùng Icon vừa chuyên nghiệp lại vừa tiết kiệm được chỗ"

Answers from the one asking window (treat as user's own words downstream):

1. Scope: "Chỉ composer toolbar (Recommended)" — only the composer buttons (`Resume session`, `Clear`, `Regenerate`, `Stop`, `Send`) become icon-only with hover tooltips. The `+` attach button already follows the icon+title pattern (it becomes a 6th icon in the row for consistency). Do NOT touch: `Jump to latest` floating button, markdown Copy buttons, permission-card buttons.
2. Icon rendering: "Inline SVG theo pattern .UnicDB-btn sẵn có (Recommended)" — inline SVG 16×16 `currentColor` copying the existing `.UnicDB-btn svg` pattern (styles.css:58-64, used by the data grid toolbar). No icon-font dependency.
3. Cycle lifecycle: "Cycle AG riêng, chạy trước AF (Recommended)" — ACTIVE.md switches to AG; AF moves to the pending list (AE-style), untouched and preserved.

**Success definition**: the AI chat composer shows ONLY icon buttons (no text labels) with native hover tooltips; clicking each still fires its exact existing behavior (resume/clear/regenerate/stop/send/attach); existing tests green after switching their label-based selectors to ID/aria-label; Send keeps its primary accent; version patch-bumped at release.

## §2 Scope

**In scope (1 task):**

1. `webview/aiChatPanelMain.ts` — `renderInitial()` markup: replace the 5 text labels with inline SVG icons (send, clear, regenerate, stop, resume), every icon button gets `title` + `aria-label` from one shared label-constant map (label text lives once, feeds tooltips). Keep: button IDs, classes, event wiring, hidden/disabled state logic, attach `+` behavior (only ensure its tooltip matches the shared pattern). `Send` keeps `.UnicDB-chat-primary` accent, becomes icon.
2. `webview/styles.css` — square icon-button sizing for `.UnicDB-chat-actions button` (icon 16×16, `pointer-events:none` on svg, hover affordance matching `.UnicDB-btn:hover`), Send accent preserved, `:focus-visible` ring for keyboard users.
3. Test updates: `src/ui/__tests__/aiChatPanelBundle.test.ts` (3 sites locating Resume by `textContent.includes("Resume")` at :150/:165/:182 → locate by `#resumeBtn`), `src/ui/__tests__/aiChatPanelWebview.test.ts` (add tooltip/a11y assertions: every composer icon button has non-empty `title` equal to its `aria-label`).

**Out of scope:** other panels' toolbars (grid/console/forms — they already use `.UnicDB-btn` icons or are separate panels), jumpLatest, markdown code Copy buttons, permission-card buttons, attach pipeline logic (the file-input opening flow), any host-side (`src/ui/aiChatPanel.ts`) change, engine/settings forms.

**Hard constraint:** single task, no same-wave overlap possible.

## §3 Approach

- **Inline SVG + shared label map**: a `COMPOSER_ICONS` map (button id → `{svg, label}`) at the top of aiChatPanelMain.ts renders each button's SVG via innerHTML. Tooltip = native `title` attribute (webview-native, no custom component). `aria-label` = same constant → a11y + tooltips stay in sync with zero drift. This copies the attach button's existing precedent (title + aria-label) to every composer button.
- **Keep every existing hook intact**: button IDs, `.UnicDB-chat-secondary`/`-primary`/`-attach-btn` classes, disabled/hidden state logic (renderBusyState :425-436, regenerate enable/disable :519-528, resume disabled while busy), event listeners — none change. Only inner content + tooltip attributes change.
- **CSS**: `.UnicDB-chat-actions button svg {width:16px;height:16px;pointer-events:none}` + square min-width so icon buttons look uniform; `:focus-visible` ring; Send keeps its primary accent via existing class.
- **Send as icon (paper-plane)**: still `.UnicDB-chat-primary`, visually distinct by accent color alone — matches the user's "chuyên nghiệp" ask while staying minimal.
- **Versioning**: patch bump `v1.11.0 → v1.11.1` (UI polish, no new capability). AE released v1.11.0; AF targets v1.12.0 — AG slips between as a patch. Contingency: if a parallel cycle releases first, take the next free patch at release time (releasing cycle wins).
- **Alternative rejected**: @vscode/codicons (icon font) — adds a dependency + font loading in webview; unicode glyphs — font-dependent rendering, less professional. Inline SVG = zero-dep, theme-adaptive via currentColor, jsdom-testable.
- **Alternative rejected**: custom tooltip component (CSS or JS) — native `title` is webview-native, zero code, discoverable; a custom tooltip needs jsdom tests + CSS care for no user-visible gain.

## §4 Test Plan (TDD)

| Area | Happy path | Edge 1 (state) | Edge 2 (a11y/robustness) | Regression |
|---|---|---|---|---|
| Composer icon-only rendering | all 6 composer buttons render `<svg>` children; zero visible text labels in the composer row | busy state: send disables, stop/regen/resume disabled-while-busy logic still works (existing logic untouched) | every icon button: `title` non-empty AND `title === aria-label`; attach button tooltip unchanged | click handlers fire exactly as before (send posts, clear posts, stop posts, resume posts resume_list, regen posts, attach opens file input) |
| Bundle tests | 3 Resume sites locate via `#resumeBtn` | no button textContent contains "Resume" (proves labels gone) | click Resume posts resume_list exactly once (behavior unchanged) | aiChatPanelBundle.test.ts green after selector migration |
| CSS icon sizing | svg 16×16 + pointer-events:none + hover affordance in styles.css | jsdom bundle-eval: composer buttons expose no visible text content | `:focus-visible` ring rule exists in styles.css | grid `.UnicDB-btn svg` pattern users (grid toolbar) unaffected |

## §5 Verification

```bash
npx vitest run src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
npm run typecheck
npm test
npm run compile
```

Manual smoke: open AI Chat → composer shows 6 icon buttons, no text labels → hover each → native tooltip shows the action name → Send still green/primary → click each icon: attach opens picker, send/clear/stop/resume/regenerate behave as before → run one generation: Stop icon swaps in, busy disables work.

## §6 Acceptance

- [ ] Every test in TASK-AG-001 §Test Cases passes (RED first, GREEN after).
- [ ] Composer row contains zero visible text labels; 6 icon buttons with `title`+`aria-label`.
- [ ] All pre-existing behaviors verified by green tests: send/clear/stop/resume/regenerate/attach.
- [ ] `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.
- [ ] No change to `src/ui/aiChatPanel.ts` (host side untouched — webview-only cycle).
- [ ] Cycle-AF and cycle-AE files/artifacts untouched (AF deferred pending, pointer preserved in ACTIVE.md).
- [ ] CHANGELOG entry for the composer icon toolbar; version `1.11.1` at release step (next free patch if taken).

## §7 Task split

| Task | Slice | Owns (files) | Wave | Depends on |
|---|---|---|---|---|
| TASK-AG-001 | Composer toolbar → icon-only + tooltips | webview/aiChatPanelMain.ts, webview/styles.css + tests src/ui/__tests__/aiChatPanelBundle.test.ts (UPDATE 3 sites), src/ui/__tests__/aiChatPanelWebview.test.ts (ADD a11y assertions) | 1 | none |

Waves: W1 = AG-001 (single).

## Planner Report

PLANNER_MODEL: unic-smart

PLAN_REVIEW: Approved by unic-smart (Round 1, 2026-08-28; 3 minor findings applied directly — see Round 1 log)

## Plan Review Log

### Round 1 — Approved (reviewer model: unic-smart)
- minor: §4 Row 3 Edge 1 ("composer buttons expose no visible text content") substantially duplicates Row 2 Edge 1 ("no button textContent contains 'Resume'") — differentiate (assert empty innerText on all 6 buttons) or drop the duplicate when deriving the TASK file.
- minor: Icon metaphors are only specified for Send (paper-plane); clear/regenerate/stop/resume glyphs are left to executor inference — add a one-line mapping (e.g. clear=trash, regenerate=refresh arrows, stop=square, resume=play/history) in TASK-AG-001.
- minor: §2 wording tension — in-scope keeps "attach `+` behavior (only ensure its tooltip matches the shared pattern)" while out-of-scope lists "attach pipeline behavior"; reword the out-of-scope item to "attach pipeline logic (file-input opening)" so the boundary is unambiguous.
