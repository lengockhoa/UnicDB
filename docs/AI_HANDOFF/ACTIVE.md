# ACTIVE

Cycle: O — ACP session history & resume
Date: 2026-08-24
Base: main

Goal: AI Chat panel lists + loads + replays + resumes persisted omp ACP sessions for the workspace.

Tasks: 4 total
Status: planning_done — ready for executor

## Notes
- Frozen protocol source: queue/ACP-SESSION-research.md (session/list, session/load + replay, mcpServers:[] on new AND load, title "<function>" junk, -32603 not-found).
- Latent bug pinned: acpProcess.ts session/new currently omits mcpServers:[] → TASK-002 regression (RED today).
- Chain: T1 → T2 → T3 → T4 (scope mandates chained waves; no same-wave overlap).
- extension.ts / detect.ts / builtin engine / Cycle M permission paths: intentionally unchanged.
