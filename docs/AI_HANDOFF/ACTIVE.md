# ACTIVE

Cycle: (none — pick from ROADMAP.md; AG/AH/AI plan stubs exist untracked)
Goal: —
Status: idle — cycle AF released v1.12.0

---
Previous:
Cycle: AF   Date: 2026-08-28   Base: main @ v1.11.0
Goal: DataGrip parity wave 1 — catalog introspection, real DDL viewer (vsdb-ddl:), SQL formatter, Console v2.
Status: done — released v1.12.0 (2021 tests green, typecheck 0, tag pushed, GitHub release live).

---
Cycle: AI   Date: 2026-08-28   Base: main @ v1.11.0
Goal: Results panel opens below the editor by default (DataGrip-style vertical split), with below/beside setting and user-drag placement preserved. Release target v1.11.2 (next free patch).
Tasks: 1 total (AI-001 ResultsPanel placement + manifest setting + construction wiring + tests). Plan: PLAN_AI.md · Index: INDEX_AI.md
Status: planning_done — ready for executor

Pending cycles (do not plan over):
- AH (PLAN_AH.md, INDEX_AH.md, next free minor): accumulating multi-statement results — staged ready, 3 tasks. AI-001 + AH-002 share src/ui/resultsPanel.ts in disjoint regions; dispatch sequentially and re-read current file before edit.
- AG (PLAN_AG.md, INDEX_AG.md, v1.11.1): webview composer icons — staged ready; owns styles.css.
- AF (PLAN_AF.md, INDEX_AF.md, v1.12.0): DataGrip parity wave 1 — in_progress; wave 1 pgCatalog + sqlFormat landed, wave 2 tree/DDL committed, wave 3 Console v2 pending. AF owns src/ai/**, src/adapters/**, src/core/ddl/**, src/core/sqlFormat.ts.
- AE.5 (queued idea): drop ompChatEngine stub shim — live engine wiring at activation (R2 critical carried from AE).

---
Previous:
Cycle: AE   Date: 2026-08-28   Base: main @ v1.10.0
Goal: OMP runtime session wiring (omp engine + hostMcp).
Status: done — released v1.11.0 with known caveat (1963 tests / 2 skipped; typecheck green; GitHub release live).

---
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
