Command: handoff-fullstack
Goal: Ship ARP-07 Successful-DDL cache/context invalidation — pure schema-impact classifier + success-only invalidation wired from an explicit host seam so metadata/completion/AI context never serves stale schema after a successful DDL.
Base: main @ aa01a78 (v1.42.0)
Phase: R3
Cursor: R2 done — 4/4 approved round 1 (001 approved_minor, non-blocking minors). INDEX rows → done. Committing review close-out.
Next: R5 release v1.43.0 — CHANGELOG → version bump → lockfile dual sync → verify:release + hygiene tests → commit → tag v1.43.0 → push main+tag → vsce package → gh release → close-out.
