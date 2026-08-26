Command: handoff-fullstack
Goal: Cycle X — "phiên bản hoàn hảo chạy được": deep QA review toàn bộ tính năng đã ship (cycles U/V/W) + fix mọi defect tìm được
Base: main
Phase: I3
Cursor: P3 commit a103eed done; I1 tree clean, 5 tasks ready; I2 waves — W1: TASK-001∥TASK-002 (audit, không chung file); W2: TASK-003∥TASK-004 + reconciliation gate (TASK-006/007 nếu audit xác nhận P0/P1); W3: TASK-005
Next: I3 wave 1 — tạo 2 worktrees .worktrees/task-001 + task-002, spawn 2 feature-implementer chạy audit song song
