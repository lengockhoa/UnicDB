Command: handoff-fullstack
Goal: Ship ARP-02 Shutdown-safe query ownership and connection provenance (fault-injection proof that late work cannot leak across close/deactivate/connection-change).
Base: main @ 367cb80 (v1.37.0)
Phase: I3
Cursor: plan commit b032b98 (P2.5 Round 1 Approved); wave 1 running — 3 executors in worktrees task-arp02-001 (runner ownership, in-flight-scoped loadMore check is load-bearing) / -002 (panel-close race) / -003 (connection provenance)
Next: on all 3 PASS → copy-back + worktree removal + wave-1 commit → evaluate TASK-ARP02-004 gate (host gap?) → wave 2 or close-not-needed.
