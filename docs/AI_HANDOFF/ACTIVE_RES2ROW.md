Cycle: RES2ROW   Date: 2026-09-09   Base: main @ 7e29d2e (v1.53.38)
Goal: Split results toolbar into 2 rows — row 1 keeps icon buttons + tsv; row 2 holds WHERE/ORDER BY/run/clear/header/copy/export/chip/Search
Tasks: 1 total planned
  - TASK-COLLAPSE-002 (webview): enforce exactly 2-row toolbar layout via `flex-direction: column` + two `.UnicDB-toolbar-row` wrapper divs (rows pin `flex-wrap: nowrap` + `overflow: hidden`); WHERE/ORDER BY inputs become `flex: 1 1 100%; min-width: 0` inside row 2; re-target the `transactionControls` insertBefore to row 1
Status: planning_done — ready for executor
  - Prior cycle RES-BAR archived at INDEX_RES.md / ACTIVE_RES.md / PLAN_RES.md
  - P1 locked answer (verbatim): "Chia đôi cho tôi menu này. Từ Where là đưa xuống dòng dưới. TÔi cần 2 dòng"
  - Supersedes RES-BAR's single-row pins (`.UnicDB-toolbar { flex-wrap: nowrap }`) — 3 test files flip: webviewToolbar.test.ts (tests #3 + #4), tests/webviewRequeryAlignment.test.ts (2 it() bodies), aiChatPanelCloneCss.test.ts (line 119)
