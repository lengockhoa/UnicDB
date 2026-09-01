Command: handoff-fullstack
Goal: Ship ARP-05 Cross-driver timeout/pool resilience contract — measured per-driver matrix (connect/query/stream/cancel/pool/broken socket), finite failure behavior proven per driver, ADR records the SLO/no-retry decision.
Base: main @ 65b9c4f (v1.40.0)
Phase: I3
Cursor: wave 1 done — commit 636f145; 001 PASS (PG pool-release fix), 002 PASS (MySQL bounded acquire via Promise.race), 003 PASS (MSSQL pin-only). Full net 3042+2. ADR carries all three Probe sections.
Next: I3 wave 2 — TASK-ARP05-004 (host message, conditional — pre-gate first: check the ADR conclusion and current error UX; likely verify-only/not-needed or a small connectionManager task).
