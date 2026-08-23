# ACTIVE

Cycle: K   Date: 2026-08-23   Base: main
Goal: AI DB-assist — DB tool registry (list_tables/describe_table/run_sql read-only) + schema-context formatter + AI Chat panel + extension wiring
Tasks: 4 total (TASK-001..004; waves 1:[001,002] 2:[003] 3:[004])
Status: planning_done — plan review round 1 issues applied (F1-F7)

Notes:
- Interface freeze: AgentTool/ToolRegistry/runAgent NGUYÊN VĂN từ src/ai/agent.ts:16-62 (đọc trực tiếp khi plan). DbAdapter surface từ src/adapters/types.ts:89-114.
- Read-only guard ở tool layer (isReadOnlySql): SELECT/SHOW/EXPLAIN/WITH, single statement, no INTO. Comments stripped trước check.
- adapterFactory injected (no global); null = no active connection message.
- PG-only runtime; NotImplementedError từ mysql/mssql bắt trong tool.
- Không streaming; Stop qua abort token; markdown final text only.
- Unit tests only (fake adapter/fetch) — không PG container cycle này.

Kết quả gần nhất:
- Cycle J (2026-08-23): AI core 4/4 approved, +60 tests (616 total), pushed 65a151a.
- Cycle I (2026-08-23, table designer): 6 tasks done; archived.
