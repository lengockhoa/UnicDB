Command: handoff-fullstack
Goal: Ship ARP-02 Shutdown-safe query ownership and connection provenance (fault-injection proof that late work cannot leak across close/deactivate/connection-change).
Base: main @ 367cb80 (v1.37.0)
Phase: R2
Cursor: I4 done — commits f2d92ff (wave 1), f5afd4f (wave 2), 0652c75 (INDEX); all 4 tasks pending_review. 3 code-reviewer agents launched on range b032b98..0652c75.
Next: R3 — collect verdicts; R4.5 auto-fix only if changes_requested/critical_block; else R5 release v1.38.0.
