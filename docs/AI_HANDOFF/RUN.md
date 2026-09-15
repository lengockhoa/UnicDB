Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 4 in progress — TASK-CHATV2-008 (two-row composer: composer.ts + composer.test.ts + styles.css + aiChatPanelComposer.ts compat export) PASS, copied back to main tree (18 focused tests pass), NOT yet wave-committed. TASK-CHATV2-006 (transcript+markdown renderer: webview/aiChat/transcript.ts, markdown.ts, aiChatPanelThread.ts compat + tests) still running in .worktrees/task-chatv2-006. Wave 3 committed e0fd841. NOTE: wave boundary MUST run `npm run compile` BEFORE `npm test` (bundle test reads stale dist otherwise). Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017.
Next: when TASK-CHATV2-006 reports, copy back + delete its worktree/branch; `npm run compile` then full-suite `npm test`; commit "handoff: wave 4 — TASK-CHATV2-006, TASK-CHATV2-008"; rewrite this cursor to wave 5. Do NOT re-plan.
