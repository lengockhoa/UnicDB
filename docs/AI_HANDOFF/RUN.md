Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ af88e47 (v1.43.0 + plan commit)
Phase: I3
Cursor: wave 1 done — TASK-ARP08-001 PASS (bcc0a71, codec 26/26, suite 3132). Worktree deleted.
Next: wave 2 — two parallel feature-implementer agents: TASK-ARP08-002 (host restore, owns consolePanel.ts + its test) + TASK-ARP08-003 (webview flush UX, owns webview/consolePanelMain.ts + bundle test + consoleTabs.test.ts). Then wave 3 = 004.
