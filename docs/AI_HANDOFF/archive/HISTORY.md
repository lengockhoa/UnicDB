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

## Cycle N — builtin engine streaming (2026-08-24)
- 3/3 approved (T001, T003 each 1 fix round; T002 direct). Provider SSE streamComplete (CRLF+abort hardened), agent opt-in streaming + one-shot onStreamFallback + pinned catch order, panel delta wiring + banner + deStreamOpenBubble. Unfroze provider.ts/agent.ts deliberately. 778 passed / 2 skipped exit 0. Released df28b75.

## Cycle O — ACP session history & resume (2026-08-24)
- 4/4 approved (T003 + 1 fix round: streaming guard + mutation-killing tests; others direct/minor). AcpClient sessionList/sessionLoad + AcpReplayBuffer (window closes on next outgoing write — multi-flush safe), acpProcess wiring + latent mcpServers:[] fix (live -32603), panel picker + replay (cwd filter, Date.parse sort, own-id filter, drop-guard, cap 50), webview picker + history rendering (textContent, hostile-input safe). Live-probe-driven: session/list, session/load replay 157 notifs, resume end_turn. 819 passed / 2 skipped exit 0. Pushed this cycle.

## Cycle O — ACP session history & resume (2026-08-24)
- 4/4 approved (T003 + 1 fix round). AcpClient list/load + AcpReplayBuffer (outgoing-write window), acpProcess mcpServers latent fix, panel picker + replay, webview picker + history. Live-probe-driven. 819 passed / 2 skipped exit 0. Released da413cb.

## Cycle P — permission detail + tool-call UI + VSIX release (2026-08-24)
- 3/3 approved (T003 after 1 changelog fix round: cycles I–L coverage; T001/T002 direct-minor). Permission card detail sanitizer (secret-key redaction, SQL preview, 2000 cap, textContent-only collapsible), builtin engine live tool-call step lines (onToolCall additive, dead onStep branch deleted), VSIX release pass (1.6.0, CHANGELOG I–P, docs/RELEASE.md, .vscodeignore leak fix, vsdb-1.6.0.vsix 15 files 1.55MB, no publish). Lock-root hygiene test caught package-lock version drift → synced. 838 passed / 2 skipped exit 0. Pushed this cycle.
