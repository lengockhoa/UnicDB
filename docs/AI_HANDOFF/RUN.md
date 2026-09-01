Command: handoff-fullstack
Goal: Ship ARP-02 Shutdown-safe query ownership and connection provenance (fault-injection proof that late work cannot leak across close/deactivate/connection-change).
Base: main @ 367cb80 (v1.37.0)
Phase: R4
Cursor: R2 verdicts in — 001 approved_minor, 002 changes_requested, 003 approved_minor, 004 approved_minor. R4.5 fix round 1 PASS (commit 24c4297): 002 save-flow epoch snapshot guards RED→GREEN, 003 tunnel-stop, 001 comment refs; net 2985 passed | 2 skipped, typecheck/compile 0.
Next: R5 — release v1.38.0 (CHANGELOG, version bump + lockfile sync, commit, tag, push, vsce package) + close-out.
