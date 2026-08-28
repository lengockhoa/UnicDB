# ACTIVE

Cycle: AF   Date: 2026-08-28   Base: main @ v1.10.0
Goal: DataGrip parity wave 1 — catalog introspection (indexes/constraints/triggers/sequences/row counts), real DDL viewer (vsdb-ddl:), SQL formatter, Console v2 (multi-tab, per-statement/selection run, history, EXPLAIN). Release target v1.12.0.
Tasks: 4 total (AF-001 pgCatalog + adapter capability; AF-002 tree nodes + DDL viewer; AF-003 SQL formatter; AF-004 Console v2). Plan: PLAN_AF.md · Index: INDEX_AF.md · Roadmap: ROADMAP.md
Status: planning_done — ready for executor

Pending cycles (do not plan over):
- AE (PLAN_AE.md, v1.11.0): deferred by user — 2/3 committed (hostMcp, ompChatEngine); TASK-003 + review fixes (R1 CHANGES-REQUESTED verdicts appended in tasks/TASK-001.md, TASK-002.md) + release outstanding. omp finishes later; AF must not touch src/ai/omp/*.

---
Previous:
Cycle: AD   Date: 2026-08-28   Base: main @ v1.9.0
Goal: DB-aware AI chat (5 read-only tools + permission cards) + OMP config bridge.
Status: done — released v1.10.0 (1937 tests green, typecheck 0, tag pushed, GitHub release live).

---
Cycle: AB   Date: 2026-08-28   Base: main @ v1.8.0
Goal: Add image attach + clipboard paste to AI Chat composer; 5 MB / 4 image caps; vision-capable model routing; clear warning when model lacks vision.
Status: complete — released v1.9.0.

---
Cycle: AA   Date: 2026-08-27   Base: main
Goal: Overhaul the AI Chat panel to modern AI-chat standards (pinned composer, collapsible Thinking, copy, Enter/Shift+Enter, scroll discipline, message states, Regenerate) and lock the DDL-only privacy invariant with regression tests.
Status: complete — all 5 tasks approved (1 fix round), released.
