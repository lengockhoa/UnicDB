# INDEX_AG

Cycle AG — **AI CHAT COMPOSER: ICON-ONLY TOOLBAR WITH HOVER TOOLTIPS**: inline SVG icons + native title tooltips, a11y via aria-label. Released in v1.12.0. Plan: PLAN_AG.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AG-001 | Composer toolbar → icon-only SVG buttons with hover tooltips | done | none | main verification |

Graph: TASK-AG-001 (single task, wave 1).

- Wave 1 (1): TASK-AG-001

Scope lock: webview-only (aiChatPanelMain.ts + styles.css + 2 test files); no host-side changes,
no other panels' toolbars, no attach pipeline behavior change, no touch of cycle AF/AE artifacts
(in-flight cycle AF wave 1 owns src/adapters/* + src/core/sqlFormat.ts right now).
