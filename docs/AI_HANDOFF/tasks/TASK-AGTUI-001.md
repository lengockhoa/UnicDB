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

(appended below by executor)

---

## Reviewer Verdict

(appended below by reviewer)
