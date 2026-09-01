Command: handoff-fullstack
Goal: Ship ARP-02 Shutdown-safe query ownership and connection provenance (fault-injection proof that late work cannot leak across close/deactivate/connection-change).
Base: main @ 367cb80 (v1.37.0)
Phase: P2 done
Cursor: PLAN_ARP02.md + TASK-ARP02-001..004 + INDEX_ARP02.md written; probes on 367cb80 confirmed 5 RED cases (runner seam 2x, loadMore close-origin poison, loadMore post-cancel append, panel stale post into recreated panel, manager stale passive re-install)
Next: P2.5 — plan review (unic-smart, REVIEW_TARGET_TYPE=plan) on docs/AI_HANDOFF/PLAN_ARP02.md; then P3 executor implements TASK-ARP02-001/002/003 (wave 1) → TASK-ARP02-004 (wave 2, conditional gate)
