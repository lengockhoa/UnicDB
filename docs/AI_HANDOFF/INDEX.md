# INDEX

Cycle: K — AI DB-assist (queued per AI-CORE-spec cycle K+ mandate)

| Task | Title | Wave | Depends | Status |
|------|-------|------|---------|--------|
| TASK-001 | DB tool registry + introspection tools | 1 | - | approved_minor (rev: unic-smart) |
| TASK-002 | SQL read-only executor tool + schema→context formatter | 1 | - | changes_requested (rev: unic-smart) |
| TASK-003 | AI Chat panel webview + host wiring | 2 | 001,002 | changes_requested (reviewer: unic-smart) |
| TASK-004 | Agent↔panel integration + guardrails + README | 3 | 003 | approved_minor (reviewer: unic-smart) |

Waves: 1 = TASK-001,002 (parallel; T1 owns src/ai/tools/registry+introspect, T2 owns src/ai/tools/sqlTool+context — no shared files) → 2 = TASK-003 → 3 = TASK-004.

Scope guards: read-only SQL only (SELECT/SHOW/EXPLAIN enforced), no DML/DDL pass-through; tools get connected-adapter via injected provider (no global); streaming optional NOT included; context budget cap.
