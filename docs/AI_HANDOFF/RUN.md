Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 6 done — TASK-CHATV2-010 (slash commands + autocomplete + descriptor registry) PASS, committed 50c506c. Full suite 4506 pass/5 skip/0 fail. Wave 7 in flight: TASK-CHATV2-011 (structured mentions + context chips + search races) running alone. Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017.
Next: when TASK-CHATV2-011 reports, copy back + delete its worktree/branch (merge-apply webview/aiChat/styles.css if touched; base 50c506c; main already has 005/006/007/008/010/015 blocks appended); boundary = `npm run compile` then full-suite `npm test`; commit "handoff: wave 7 — TASK-CHATV2-011"; rewrite cursor to wave 8 (TASK-CHATV2-012). Do NOT re-plan.
