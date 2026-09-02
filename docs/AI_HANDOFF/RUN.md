Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ af88e47 (v1.43.0 + plan commit)
Phase: I1
Cursor: P3 done — plan committed af88e47 (Approved r1, minors applied). Tasks 001-004 all ready.
Next: I1 — verify clean tree, then I2 waves: w1 = TASK-ARP08-001; w2 = 002+003 (parallel, disjoint); w3 = 004.
