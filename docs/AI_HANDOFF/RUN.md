Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 10 done — TASK-CHATV2-014 (permission policy + request sheet + change-plan safety) PASS, committed 5302733. Full suite 4701 pass/5 skip/0 fail. Wave 11 in flight: TASK-CHATV2-016 (error recovery + scroll + a11y + responsive/HC/reduced-motion) running alone in .worktrees/task-chatv2-016. Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017. NOTE: 017 depends on ALL. Agents have intermittently died by gateway stream drops AND by their own context overflow — re-spawn handlers must be context-lean and write incrementally.
Next: when TASK-CHATV2-016 reports, copy back + delete its worktree/branch (merge-apply webview/aiChat/styles.css at the end — it is the LAST styles contributor; base 5302733; main already has 005/006/007/008/010/011/012/013/014/015 blocks); boundary = `npm run compile` then full-suite `npm test`; commit "handoff: wave 11 — TASK-CHATV2-016"; rewrite cursor to wave 12 (TASK-CHATV2-017, the cutover task). Do NOT re-plan.
