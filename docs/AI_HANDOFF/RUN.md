Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ af88e47 (v1.43.0 + plan commit)
Phase: I3
Cursor: wave 2 done — ARP08-002 PASS (host: draftMemento/hydrate/debounce/exactly-once flush/clear, 14 new tests) + ARP08-003 PASS (webview: debounce/visibility/beforeunload flush, Clear Drafts, draftsCleared, divergence pin, 8 new bundle tests) committed 70f032f. Worktrees deleted.
Next: wave 3 — one feature-implementer agent for TASK-ARP08-004 (extension.ts wiring: draftMemento: context.workspaceState; verify-first allowed to close not-needed). Then I4 consolidation + full suite.
