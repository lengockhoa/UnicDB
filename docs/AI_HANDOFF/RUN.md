Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ 8dca6d2 (v1.43.0)
Phase: P3
Cursor: P2 complete — PLAN.md + TASK-ARP08-001..004 written and ready; INDEX.md cycle section + PORT-ARP-08 row added; ACTIVE.md set to ARP-08 planning_done. Waves: w1 = 001, w2 = 002+003 (parallel, disjoint), w3 = 004. Awaiting executor.
Next: run independent plan review of PLAN.md; on approval, executor picks TASK-ARP08-001 (wave 1). Worktree note: fresh worktrees need `npm run compile` before bundle tests; symlink node_modules.
