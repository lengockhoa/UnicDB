Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 9 in flight — TASK-CHATV2-013 (attachments + attach-context menu + schema controls) running in .worktrees/task-chatv2-013. NOTE: the first 013 agent died SILENTLY (no notification) and wrote nothing; re-spawned fresh at 07:19. Wave 8 committed 4994213. Full suite 4636 pass/5 skip/0 fail. Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017. NOTE: 013 and 014 both edit src/ui/aiChatPanel.ts — keep them serialized (do NOT parallelize). 016 depends on 006–015; 017 depends on all.
Next: when TASK-CHATV2-013 reports, copy back + delete its worktree/branch (merge-apply webview/aiChat/styles.css if touched; base 4994213; main already has 005/006/007/008/010/011/012/015 blocks); boundary = `npm run compile` then full-suite `npm test`; commit "handoff: wave 9 — TASK-CHATV2-013"; then spawn TASK-CHATV2-014. Do NOT re-plan.
