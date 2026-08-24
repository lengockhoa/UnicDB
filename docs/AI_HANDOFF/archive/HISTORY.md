| Cycle | Date | Scope | Result |
|-------|------|-------|--------|
| I | 2026-08-23 | DataGrip-style New/Modify Table designer + table utility menus (PG only) | 6/6 approved, pushed 4e6fecc; +556 unit tests, 6 PG integration tests |

## Cycle J — AI Core (2026-08-23)
- 4/4 approved (2 after 1 fix round): settings validation+storage, OpenAI-compatible provider (dual method), agent loop, AI Settings webview. +60 unit tests (616 total). README privacy/egress section. No DB tools (seam ready), no streaming — by design, cycle K+.

## Cycle K — AI DB-assist (2026-08-23)
- 4/4 approved (2 after 1 fix round): read-only tools (list_tables/describe_table/run_sql w/ 26-vector-tested guard), schema-context formatter, AI Chat panel, extension wiring. +72 tests (688 total). Pushed c389ac3.

## Cycle L — omp agent integration (2026-08-23)
- 4/4 approved after two fix rounds: long-lived RPC bridge, read-only DB host tools, detect/fallback, Chat engine switch and guarded streaming. +117 tests (729 passed, 1 availability-gated smoke skipped); real omp 18.0.1 full start→prompt→agent_end smoke passed. Pushed dee1430.

## Cycle M — ACP approval bridge (2026-08-24)
- 4/4 approved (TASK-004 after 1 fix round: production child-exit → AcpClient.dispose → panel default-deny). JSON-RPC/NDJSON `omp acp` replaces yolo RPC bridge; `session/new` proven live; permission UI Allow/Deny, default-deny on stop/dispose/exit/replacement/timeout; legacy rpc.ts/process.ts deleted. +22 tests (751 passed, 2 opt-in smoke skipped). Pushed b3ab260.

## Cycle N — builtin engine streaming (2026-08-24)
- 3/3 approved (T001, T003 after 1 fix round each; T002 direct). provider streamComplete SSE (CRLF+abort hardened), agent opt-in streaming with one-shot onStreamFallback + pinned abort/fallback catch order, panel delta wiring + banner + deStreamOpenBubble (orphan-bubble regression). Unfroze provider.ts/agent.ts deliberately. +27 tests (778 passed / 2 opt-in skipped, exit 0 — webviewExport timer-drain fix). Pushed this cycle.
