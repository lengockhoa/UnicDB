# INDEX

Cycle T — **UNBREAK**: make grid editing, AI chat and the statement splitter actually work; cut
the query cost that makes every Cmd+Enter and tree expand slow. 12 tasks, 3 waves.
Cycle S (lazy ctid) is **shipped** (`8b58f24`) — cycle T builds on it; its A1/A2/A18 defects no
longer exist at HEAD (see PLAN.md §2 "Stale-input correction").

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Save builder: schema qualification, PG quoting, DEFAULT inserts, row addressing (A8/A9/A10/A11/A12/A20) | pending_review | claude-sonnet-5 | - |
| TASK-002 | Webview grid: stale values after commit, Add Row, marker collision, Refresh, copy (A5/A6/A7/A11/A12/A13/A16) | pending_review | claude-sonnet-5 | - |
| TASK-003 | Grid model: duplicate column names must not collapse onto one field (A17) | pending_review | claude-sonnet-5 | - |
| TASK-004 | Statement splitter: transaction scripts, loop-stack leak, MySQL escapes, MSSQL GO (C1-C4) | pending_review | claude-sonnet-5 | - |
| TASK-005 | Adapters: cursor fast-path, pg_catalog introspection, MSSQL columns, batch row estimate (D4/D5/D6 + D2 API) | pending_review | claude-sonnet-5 | - |
| TASK-006 | ACP transport: `initialized` handshake, bounded timeout, stderr capture, Windows detect (B4/B10/B12) | pending_review | claude-sonnet-5 | - |
| TASK-007 | AI chat: turn never settles, blank bubbles, dead Stop/Resume, leaked child, schema cost (B1/B2/B5/B6/B7/B9/B14) | pending_review | claude-sonnet-5 | - |
| TASK-008 | Keyword qualifier: stop scanning `information_schema.tables` on every Cmd+Enter (D1) | pending_review | claude-sonnet-5 | - |
| TASK-009 | Results host: ctid lookup returns rows, atomic save batch, real header, post-commit refresh (A3/A4/A12/A14/A15) | pending_review | claude-sonnet-5 | - |
| TASK-010 | Schema tree: one row-count query per schema, no connection opened at activation (D2/D3) | pending_review | claude-sonnet-5 | - |
| TASK-011 | Zero-config omp engine, honest engine banner, settings error label, keyword-cache wiring (B3/B8/B13/D1) | pending_review | claude-sonnet-5 | - |
| TASK-012 | DB tools on the omp path: probe the ACP tool transport, then bridge the registry (B11) | pending_review | claude-sonnet-5 | - |

Graph: 009 → {001, 002}; 010 → 005; 011 → {006, 007, 008}; 012 → {006, 007, 011}.
All of 001-008 are independent.

- **Wave 1 (8, parallel):** 001, 002, 003, 004, 005, 006, 007, 008
- **Wave 2 (3, parallel):** 009, 010, 011
- **Wave 3 (1):** 012

TASK-012 carries a stated protocol unknown and an explicit stop rule: if the live probe shows omp
accepts neither MCP transport, the executor records the evidence and flips it to
`needs_breakdown` rather than inventing a protocol.

## Next cycles (queued)

- **Cycle U — DataGrip parity.** Per-table result tabs (top parity item, do first), then
  server-side sort / filter / paging, NULL entry + cell value viewer, schema-aware autocomplete,
  and user-facing transaction / manual-commit mode. Also: the A19 per-row **retry** affordance
  (re-run only the failed rows) — cycle T wires the reporting half (`skippedRows` → `rowErrors`)
  but not retry; and MSSQL parameter binding (`TYPES` + `queryWithParams`) to retire the
  `literal()` interpolation that D6 deliberately left in place; and the `keepIndices`-by-name
  export bug (hiding one of two duplicate-named columns also drops its visible twin), which needs
  an index-based selection contract through the serializers.
- **Cycle V — SQL syntax coloring.** TextMate injection grammar plus a semantic tokens provider.
