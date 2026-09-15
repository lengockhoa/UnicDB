Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 3 in progress — TASK-CHATV2-004 PASS, copied back to main tree (webview/aiChat/store.ts + tests + vitest.config.ts include widened; 30 tests pass), NOT yet wave-committed. TASK-CHATV2-005 (webview/aiChat/shell.ts, icons.ts, styles.css, aiChatPanelMain.ts, src/ui/aiChatPanel.ts + tests) running in worktree .worktrees/task-chatv2-005 after two prior gateway stream deaths. Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017.
Next: when TASK-CHATV2-005 reports, copy back + delete its worktree/branch; run full-suite boundary (npm test) + npm run typecheck + npm run compile; commit "handoff: wave 3 — TASK-CHATV2-004, TASK-CHATV2-005"; rewrite this cursor to wave 4. Do NOT re-plan.
