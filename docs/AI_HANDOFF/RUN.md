Command: handoff-fullstack
Goal: Ship ARP-02 Shutdown-safe query ownership and connection provenance (fault-injection proof that late work cannot leak across close/deactivate/connection-change).
Base: main @ 367cb80 (v1.37.0)
Phase: I4
Cursor: wave 2 done — commit f5afd4f; full net 2983 passed | 2 skipped, typecheck 0, compile 0; all 4 tasks PASS (004 produced the gap fix: ownsRun finally gate + deactivating sentinel).
Next: I4 — INDEX consolidation (all PASS → pending_review), then R2 parallel review on range b032b98..HEAD.
