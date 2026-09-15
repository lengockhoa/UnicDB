Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: wave 1 done — TASK-CHATV2-002 PASS (src/ai/capabilities.ts + panel wiring; full suite 4211 pass/5 skip). Waves: W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017.
Next: run I3 wave 2 = TASK-CHATV2-003 only. git worktree add -b handoff/task-chatv2-003 .worktrees/task-chatv2-003 main; spawn feature-implementer (task file, TDD RED->GREEN, append Executor Report, return <=10 lines); copy back + delete worktree; full-suite boundary; commit "handoff: wave 2". Do NOT re-plan.
