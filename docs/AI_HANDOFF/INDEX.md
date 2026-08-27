# INDEX

Cycle AA — **AI CHAT PANEL UX OVERHAUL**: modern AI-chat standards (pinned composer, collapsible Thinking,
copy affordances, Enter/Shift+Enter, scroll discipline, message states, Regenerate) plus a permanent
privacy regression lock (auto-context is DDL-only). Four tasks, one wave-1 of three parallel + one
dependent consumer wave.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-001 | Message contract: thought + regenerate (host side) | approved | none | unic-smart |
| TASK-002 | Webview chat UX: thinking block, copy, keybind, scroll, message states | approved | TASK-001 | unic-smart |
| TASK-003 | Chat layout: pinned composer, full-height thread (CSS) | approved | none | unic-smart |
| TASK-004 | Privacy regression lock: auto-context is DDL-only (HARD invariant) | approved_minor | none | unic-smart |
| TASK-005 | @-mention references (DB objects + workspace files) | approved | TASK-001, TASK-002 | unic-smart |

Graph: TASK-001 → TASK-002; TASK-003 independent; TASK-004 independent.

- Wave 1 (3): TASK-001, TASK-003, TASK-004
- Wave 2 (1): TASK-002
- Wave 3 (1): TASK-005

No same-wave file overlap: TASK-001 owns src/ui/aiChatPanelMessages.ts + src/ui/aiChatPanel.ts;
TASK-002 owns webview/aiChatPanelMain.ts (+ its existing test file); TASK-003 owns webview/styles.css
(+ new test file); TASK-004 owns only its new test file.

Queue note: image attach/clipboard-paste (AI-CHAT-INPUT-UX reqs 3-5) and slash commands remain queued
for later cycles. Prior cycles are archived under `docs/AI_HANDOFF/archive/`; Cycle Z (Console,
v1.7.0) completed and released.
