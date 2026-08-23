# INDEX

Cycle: L — omp agent integration (RPC bridge) + one-command install/update story

| Task | Title | Wave | Depends | Status |
|------|-------|------|---------|--------|
| TASK-001 | omp RPC client + process lifecycle (pure) | 1 | - | pending_review |
| TASK-002 | Host-tool bridge (set_host_tools ↔ ToolRegistry) | 1 | - | pending_review |
| TASK-003 | omp detection/version check + fallback engine switch | 2 | - | ready |
| TASK-004 | Chat panel omp mode + install/update UX + README | 3 | 001,002,003 | ready |

Waves: 1 = TASK-001,002 parallel (T1 owns src/ai/omp/rpc.ts + process.ts, T2 owns src/ai/omp/hostTools.ts — no shared files beyond frozen src/ai/tools/types.ts) → 2 = TASK-003 → 3 = TASK-004.

Scope guards: omp optional — absence/old-version/crash MUST degrade to existing cycle-J/K AI; DB tools stay read-only in VSDB hands (host_tool bridge, never omp's own SQL); no Bun dependency; apiKey flow unchanged when using non-omp path; omp mode uses omp's own provider config (no apiKey handling in bridge).
