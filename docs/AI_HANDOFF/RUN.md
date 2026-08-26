Command: handoff-fullstack
Goal: Cycle X — "phiên bản hoàn hảo chạy được": deep QA review toàn bộ tính năng đã ship (cycles U/V/W) + fix mọi defect tìm được
Base: main
Phase: R4.5
Cursor: R1-R4 review done — TASK-003/005/006/007/008 approved or approved-minor; TASK-004 changes_requested with 2 behavior blockers (MySQL exporter ANSI quotes; server TRIM spaces-only vs client tabs/newlines) + missing RED evidence
Next: auto-fix round 1 TASK-004 only — fix dialect-safe export identifiers, make whitespace Blanks predicate match JS trim on all 3 dialects, add regression tests and RED_OUTPUT; then fresh TASK-004 review; max 2 fix rounds
