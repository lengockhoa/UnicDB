Command: handoff-fullstack
Goal: Ship ARP-05 Cross-driver timeout/pool resilience contract — measured per-driver matrix (connect/query/stream/cancel/pool/broken socket), finite failure behavior proven per driver, ADR records the SLO/no-retry decision.
Base: main @ 65b9c4f (v1.40.0)
Phase: I3
Cursor: wave 0 done — commit 0dd021e; TASK-ARP05-000 PASS (ADR 0002 written, all citations verified, wave-1 probe merge-point reserved).
Next: I3 wave 1 — THREE parallel worktrees for TASK-ARP05-001 (PostgreSQL), TASK-ARP05-002 (MySQL), TASK-ARP05-003 (MSSQL); each appends its disjoint Probe section to the ADR.
