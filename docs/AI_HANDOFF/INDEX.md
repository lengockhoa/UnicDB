# INDEX

Cycle: K — AI DB-assist (queued per AI-CORE-spec cycle K+ mandate)

| Task | Title | Wave | Depends | Status |
|------|-------|------|---------|--------|
| TASK-001 | DB tool registry + introspection tools | 1 | - | ready |
| TASK-002 | SQL read-only executor tool + schema→context formatter | 1 | - | ready |
| TASK-003 | AI Chat panel webview + host wiring | 2 | 001,002 | ready |
| TASK-004 | Agent↔panel integration + guardrails + README | 3 | 003 | ready |

Waves: 1 = TASK-001,002 (parallel; T1 owns src/ai/tools/registry+introspect, T2 owns src/ai/tools/sqlTool+context — no shared files) → 2 = TASK-003 → 3 = TASK-004.

Scope guards: read-only SQL only (SELECT/SHOW/EXPLAIN enforced), no DML/DDL pass-through; tools get connected-adapter via injected provider (no global); streaming optional NOT included; context budget cap.
