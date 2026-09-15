Command: handoff-fullstack
Goal: Implement the full AI Chat V2 replacement (17 coder-ready tasks, TASK-CHATV2-001..017)
Base: main
Phase: I3
Cursor: I1+I2 done — 17 tasks ready, waves conflict-checked. W0=001 · W1=002 · W2=003 · W3=004,005 · W4=006,008 · W5=007,009,015 · W6=010 · W7=011 · W8=012 · W9=013 · W10=014 · W11=016 · W12=017. maxParallelAgents=2 -> W5 batches [007,009] then [015]. Next = wave 0.
Next: run I3 wave 0 = TASK-CHATV2-001 only. 3a: git worktree add -b handoff/task-chatv2-001 .worktrees/task-chatv2-001 main. 3b: spawn feature-implementer (reads its task file, TDD RED->GREEN, append Executor Report, return <=10 lines). 3c: copy back + delete worktree. 3d: commit "handoff: wave 0" + rewrite cursor to wave 1. Do NOT re-plan.
