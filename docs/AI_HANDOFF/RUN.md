Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ af88e47 (v1.43.0 + plan commit)
Phase: done
Cursor: R5 shipped — v1.44.0 released (commit 93efafd, tag v1.44.0, GitHub release + vsdb-1.44.0.vsix). All 4 tasks done, 4/4 approved round 1. Suite 3160 | 2.
Next: start cycle ARP-09 (Redacted support diagnostics + release-confidence profiles) — fresh planning, source docs/plans/2026-09-01-vsdb-additive-roadmap.md §ARP-09. Documented follow-ups not yet scheduled: browseCommands.ts:169-193 unguarded finally; MSSQL [insert] bracket false positive; ARP-07 known gap (form-view DDL tableCommands.ts runDdl + AI plan-apply aiChatPanel.ts not wired to invalidation seam); ARP-08 minor (snapshot name field uncapped).
