# ACTIVE

Cycle: AD   Date: 2026-08-28   Base: main @ v1.9.0
Goal: Make AIChat a real DB-aware chat-extension. Add 5 read-only DB tools (sample/count/readonly query/explain/relationships) with ACP-style permission cards; bridge the panel's OpenAI-compatible config to a local `omp` install via a `.vscode/vsdb-ai-config.yml` overlay so `omp --config <path> -p "…" --append-system-prompt <contextPath>` connects to the same provider.
Tasks: ~3 (T1 readonly parser + DB-aware tools + host permission gate, T2 webview permission card reuse, T3 OMP config exporter + VS Code command + formatSystemPrompt extraction)
Status: implementation complete; wave 1 + wave 2 merged; review R2/R3 complete (TASK-001 approved, TASK-002/TASK-003 approved_minor); 1937 tests passed / 2 skipped; typecheck 0. Pending release v1.10.0 packaging and push.

---
Cycle: AB   Date: 2026-08-28   Base: main @ v1.8.0
Goal: Add image attach + clipboard paste to AI Chat composer; 5 MB / 4 image caps; vision-capable model routing; clear warning when model lacks vision.
Tasks: 4 total (TASK-001/002/003/005)
Status: complete — all 4 tasks implemented (1137 tests green, typecheck 0). Ready for review (R1-R4) and release v1.9.0.

---
Previous:
Cycle: AA   Date: 2026-08-27   Base: main
Goal: Overhaul the AI Chat panel to modern AI-chat standards (pinned composer, collapsible Thinking, copy, Enter/Shift+Enter, scroll discipline, message states, Regenerate) and lock the DDL-only privacy invariant with regression tests.
Tasks: 5 total
Status: complete — all 5 tasks approved (1 fix round), ready for release
