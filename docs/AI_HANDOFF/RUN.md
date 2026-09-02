Command: handoff-fullstack
Goal: Ship ARP-07 Successful-DDL cache/context invalidation — pure schema-impact classifier + success-only invalidation wired from an explicit host seam so metadata/completion/AI context never serves stale schema after a successful DDL.
Base: main @ aa01a78 (v1.42.0)
Phase: I3
Cursor: wave 1 done — commit 10ea253; 001 PASS (classifier hasSchemaImpact/completedSchemaImpact), 002 PASS (verify-only, probe-confirmed), 003 PASS (hydrate stale-commit fix). Full net 3111+2.
Next: I3 wave 2 — worktree for TASK-ARP07-004 (execution wiring, src/extension.ts runStatements success seam), single feature-implementer.
