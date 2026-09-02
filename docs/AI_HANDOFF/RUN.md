Command: handoff-fullstack
Goal: Ship ARP-07 Successful-DDL cache/context invalidation — pure schema-impact classifier + success-only invalidation wired from an explicit host seam so metadata/completion/AI context never serves stale schema after a successful DDL.
Base: main @ aa01a78 (v1.42.0)
Phase: done
Cursor: R5 shipped — v1.43.0 released (commit 64e3ab4, tag v1.43.0, GitHub release + vsdb-1.43.0.vsix). All 4 tasks done, 4/4 approved round 1. Suite 3120 | 2.
Next: start cycle ARP-08 (Console draft recovery) — fresh planning, source docs/plans/2026-09-01-vsdb-additive-roadmap.md §ARP-08. Documented follow-ups not yet scheduled: browseCommands.ts:169-193 unguarded finally; MSSQL [insert] bracket false positive; ARP-07 known gap (form-view DDL tableCommands.ts runDdl + AI plan-apply aiChatPanel.ts not wired to invalidation seam).
