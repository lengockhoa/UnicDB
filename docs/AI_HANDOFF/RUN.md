Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 5 done — TASK-CHATV2-007 (activity timeline), TASK-CHATV2-009 (keyboard/controller), TASK-CHATV2-015 (sessions/export) PASS, committed 6fec4b6. Full suite 4448 pass/5 skip/0 fail. Fixed one stale V1 bundle test (boot now emits ready_v2 not ready — updated aiChatPanelBundle.test.ts #2). Wave 6 in flight: TASK-CHATV2-010 (slash commands + autocomplete + descriptor registry) running alone. Merged styles.css from both 007 and 015 by manual append. Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017.
Next: when TASK-CHATV2-010 reports, copy back + delete its worktree/branch (merge-apply webview/aiChat/styles.css if touched — base is 6fec4b6, and main already has 005/006/007/008/015 blocks appended); boundary = `npm run compile` then full-suite `npm test`; commit "handoff: wave 6 — TASK-CHATV2-010"; rewrite cursor to wave 7 (TASK-CHATV2-011). Do NOT re-plan.
