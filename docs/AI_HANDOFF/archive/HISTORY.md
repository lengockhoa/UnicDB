| Cycle | Date | Scope | Result |
|-------|------|-------|--------|
| I | 2026-08-23 | DataGrip-style New/Modify Table designer + table utility menus (PG only) | 6/6 approved, pushed 4e6fecc; +556 unit tests, 6 PG integration tests |

## Cycle J — AI Core (2026-08-23)
- 4/4 approved (2 after 1 fix round): settings validation+storage, OpenAI-compatible provider (dual method), agent loop, AI Settings webview. +60 unit tests (616 total). README privacy/egress section. No DB tools (seam ready), no streaming — by design, cycle K+.

## Cycle K — AI DB-assist (2026-08-23)
- 4/4 approved (2 after 1 fix round): read-only tools (list_tables/describe_table/run_sql w/ 26-vector-tested guard), schema-context formatter, AI Chat panel, extension wiring. +72 tests (688 total). Pushed c389ac3.
