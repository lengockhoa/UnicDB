# INDEX

Cycle U -- **DATA GRIP PARITY**: export keepIndices bug fix, MSSQL parameter binding, Postgres
sort query, NULL cell display, A19 retry, post-commit refresh, per-table result tabs,
schema-aware autocomplete, manual-commit mode. 9 tasks, 5 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Export keepIndices duplicate-column bug -- positional indices | ready | - | - |
| TASK-002 | MSSQL adapter: replace literal() with parameterized queries | ready | - | - |
| TASK-003 | Postgres server-side sort query helper | ready | - | - |
| TASK-004 | NULL cell display + cell value viewer | ready | - | - |
| TASK-005 | A19 failed-row retry affordance | ready | - | - |
| TASK-006 | Post-commit grid refresh after successful save | ready | - | - |
| TASK-007 | Per-table result tabs with table-name labels | ready | - | - |
| TASK-008 | Schema-aware autocomplete (CompletionItemProvider + cache) | ready | - | - |
| TASK-009 | Manual-commit mode (begin/commit/rollback + UI toggle) | ready | - | - |

Graph: 006 --> 007 --> 009 (same-file chain on webview/main.ts + resultsPanel.ts + messages.ts).
001-005 and 008 are all independent.

- **Wave 1 (5, parallel):** 001, 002, 003, 004, 008
- **Wave 2 (1):** 005
- **Wave 3 (1):** 006
- **Wave 4 (1):** 007
- **Wave 5 (1):** 009

TASK-005 cannot share wave 1 with TASK-004 -- both modify `webview/main.ts` and
`webview/styles.css`. TASK-006 cannot share wave 2 with TASK-005 -- same collision.
TASK-007 cannot share wave 3 with TASK-006 -- same collision plus `resultsPanel.ts`
and `messages.ts`. TASK-009 cannot share wave 4 with TASK-007 -- same collision.
TASK-008 has no collisions (new files + extension.ts only).

## Previous cycles

Cycle T (12 tasks, all done) shipped at `4a35fec`. Its A1/A2/A18 defects no longer
exist at HEAD. See `archive/cycle-T-*` for completed task files.

## Next cycles (queued)

- **Cycle V -- SQL syntax coloring.** TextMate injection grammar plus a semantic tokens provider.
- **Server-side column filter + paging** (beyond the sort helper in TASK-003): WHERE clause from AG Grid SetFilter, OFFSET/LIMIT cursor-based paging. Deferred because it requires AG Grid filter event wiring in the webview + host requery composition, a significant UI integration task beyond this cycle's scope.
- **MSSQL server-side sort:** requires a `getTableSortQuery` equivalent for T-SQL dialect (OFFSET/FETCH syntax differs from Postgres). Deferred because MSSQL sort syntax needs separate adapter-level work.
