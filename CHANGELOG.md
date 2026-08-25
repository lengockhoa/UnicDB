# Changelog

All notable changes to VSDB are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project

## [1.6.4] — 2026-08-25

Cycle U: DataGrip parity — per-table tabs, server-side sort, NULL display, failed-row retry,
schema-aware autocomplete, manual-commit transactions, MSSQL parameter binding, export fix.

### Added
- **Per-table result tabs**: each statement gets a tab labeled with its table name
  (e.g. `public.users`) instead of a generic "Statement N".
- **PostgreSQL server-side sort**: clicking a column header issues a server-side
  `ORDER BY` requery (via the `getTableSortQuery` helper) instead of client-side sorting.
- **NULL cell display + value viewer**: NULL cells render distinctly (`␀`) and a cell
  value viewer shows the full raw value of the focused cell.
- **Failed-row retry**: after a partial save failure, the banner offers "Retry failed
  rows" — only the still-dirty failed rows re-run, successful rows are kept clean.
- **Schema-aware autocomplete**: `CompletionItemProvider` with schema/table/column
  cache; completions propose table and column names while typing.
- **Manual-commit mode** (`manualCommit: true` on a connection): saves run inside a
  session-pinned transaction with explicit Commit/Rollback toolbar buttons and a
  transaction-open status indicator.

### Fixed
- **Export**: duplicate-column `keepIndices` now maps positional indices correctly —
  duplicated columns no longer export the wrong column's data.
- **MSSQL adapter**: replaced string-literal interpolation with parameterized queries
  throughout metadata introspection.
- **Manual-commit saves no longer silently discarded**: the old flow leaked the
  transaction onto a released pooled client, so the post-save requery landed on a
  different connection and Postgres rolled back a successful save. Saves now run on a
  pinned `DbTransaction` session (PostgreSQL + MySQL); the post-save requery shares
  that session, and the browse cursor is closed before the transaction opens so the
  single-connection pool can never deadlock.
- **Post-commit refresh**: the grid refresh after a successful automatic save now lands
  in the same update as the save acknowledgement, so the grid never shows stale rows
  after commit.

## [1.6.3] — 2026-08-25

Cycle S: lazy ctid — fix the view-open crash introduced in 1.6.2's no-PK save support.

### Fixed
- **PostgreSQL views/matviews/foreign tables**: opening them in the results grid no
  longer fails with `column "ctid" does not exist` — the browse query is a plain
  `SELECT` again, with no eager ctid wrapping.
- **No-PK row identity**: `ctid` is now resolved lazily at save time (updates and
  deletes) via `fetchPostgresCtids`, so it is always fresh at commit and never
  stale from when the tab was opened.
- **No-PK deletes**: missing ctid for a row now emits a warning and skips that row
  instead of silently failing; `DELETE FROM t WHERE ctid='(x,y)'` is built from the
  save-time lookup.
- **User column literally named `ctid`**: no longer auto-hidden in the grid nor
  stripped from exports — it is treated as an ordinary user column.


## [1.6.2] — 2026-08-25

Cycle R: AI reliability and full-database context, Export Structure AI tool, and Excel-like results-grid editing.

### Added
- **AI context**: full schemas/tables/views context with `export_structure` tool and `vsdb.exportAllStructures` command.
- **Results grid**: dirty-cell highlighting, add/delete row editing, Cmd/Ctrl+Enter commit, unified undo/redo, and aligned requery/filter controls.

### Fixed
- **PostgreSQL no-PK saves**: browse results carry hidden `ctid` row identity for reliable updates.
- **SQL editor Cmd/Ctrl+Enter**: cursor execution uses the complete statement/block containing the cursor.
- **AI chat**: Clear no longer leaves the panel unable to start a new chat; actionable configuration errors are shown.
- **Column defaults**: varchar fields initialize to SQL literal `''`.
- **Menu label**: renamed Copy CREATE DDL to Copy Create Query.

## [1.6.1] — 2026-08-24

Cycle Q: schema-tree UX batch (9 tasks, handoff pipeline) + Export
Structure. All reviewed (3 approved, 6 fixed round 1 → approved).

### Added
- **Browse data**: double-click table/view node opens `SELECT *` in the
  results grid with edit/save.
- **Create New Schema**: right-click a connection/schema opens a webview
  form with live `CREATE SCHEMA` preview, reveal-on-create.
- **Column designer Type dropdown**: varchar / numeric / boolean; Default
  auto-fills `''` / `0` / `FALSE`.
- **Requery bar**: WHERE / ORDER BY bar sits above the grid, below the
  toolbar.
- **AI sample data**: `Generate sample data` on a table uses the AI work
  model (skips `id_<table>` + `created_at`), INSERT-whitelist validated.
- **Postman Payload**: context menu on table/view/routine copies a JS
  object literal `{ schema, table, col: this.workingObj.col }`; routine
  columns via `listRoutineParams`.
- **Export Structure**: context menu on table/view copies `CREATE TABLE`
  DDL (PK constraint, NOT NULL, identifier-safe quoting) / view column
  list to the clipboard.
- **AI Chat toolbar icon** next to AI Settings in the schema-tree title.

### Fixed
- `SELECT * FROM order;` now qualifies unquoted keyword table names as
  `"public".order` at the execution choke point (editor + CodeLens paths).
- `listRoutineParams` reads `COALESCE(proallargtypes, proargtypes::oid[])`
  with `WITH ORDINALITY` — all-IN-arg routines no longer degrade to
  `{schema, table}` payloads (validated on PG 16).
- Command `vsdb.browseTableData` icon regression; webview parallel-race in
  the schemaForm bundle test; stale window listeners on repeated dynamic
  import of the new-table form; `gridWrap` TS2339s under webview tsconfig.
- AI sample data no longer claims implicit transaction: adapter errors
  surface an explicit "partial rows MAY have committed" warning.

## [1.6.0] — 2026-08-24

Cycles I–P. Table designer and the entire AI assistant stack landed since
v1.5.1, plus hardening of the builtin streaming path in this release.
Permission prompts now surface a sanitized detail line (SQL preview for
`run_sql`, pretty JSON for other tools, with secret-key redaction and a
2000-char cap) rendered as a collapsible block so Allow/Deny stay visible.

### Added — cycles I–L (shipped within v1.5.1..v1.6.0, listed for completeness)

- **Cycle I — PG table designer**: DataGrip-style New/Modify Table designer
  with table utility menus (PostgreSQL only); +556 unit tests, 6 PG
  integration tests.
- **Cycle J — AI core**: AI settings validation + storage, OpenAI-compatible
  provider (dual method), agent loop, AI Settings webview; README privacy /
  egress section.
- **Cycle K — AI DB-assist**: read-only DB tools (`list_tables`,
  `describe_table`, `run_sql` with 26-vector-tested guard), schema-context
  formatter, AI Chat panel, extension wiring.
- **Cycle L — omp agent integration**: long-lived bridge, read-only DB host
  tools, detect / builtin fallback, engine switch and guarded streaming.
- **Cycle M — ACP approval bridge**: `omp acp` JSON-RPC bridge replacing the
  yolo RPC path; Allow/Deny permission UI; default-deny on every abnormal
  exit path; legacy `rpc.ts`/`process.ts` deleted.
- **Cycle O — session history & resume**: Resume-session picker lists prior
  `omp` sessions for the workspace, replays them into the chat, and
  continues prompting on the loaded session.

### Added
- ACP/omp chat engine: spawn `omp acp`, stream `agent_message_chunk` as
  assistant deltas, and route `session/request_permission` through a host
  coordinator with opaque requestIds and one-shot settle semantics
  (default-deny on stop / dispose / process exit / replacement / timeout).
- Built-in engine streaming: provider SSE streams rendered as deltas with a
  `de-stream` reset on `done`/`error` so each turn gets its own bubble.
- Live tool-step lines in the chat thread (`onToolCall` hook) showing each
  tool call as it fires.
- Permission card detail rendering: short single-line detail stays a plain
  div; longer detail becomes a collapsible `<details><summary>Show tool
  details</summary><pre>` block. Empty detail omits the node. `textContent`
  only — no `innerHTML`, no markdown interpreter.
- Permission detail sanitizer (`buildPermissionToolInfo`): recursive
  redaction of secret-like keys (`apiKey`, `authorization`, `password`,
  `token`, …), SQL preview for `run_sql`, pretty JSON (indent 2) for
  everything else, capped at 2000 chars with a `… (truncated)` marker.
  Pure / total over `unknown` — never throws.

### Hardened

- Permission response handler rejects unknown / unlisted / duplicate /
  late optionIds with no extra ACP writes.
- Engine banner shows the resolved engine (`omp` / `builtin`) and a hint
  when omp is unavailable.
- Resume picker + history batch render through the same `textContent`-
  only path as the live chat.

## [1.5.1] — 2026-08-23

Cycle H hardening: explain-plan guard, codepoint cap, lock hygiene, release
boundary.

## [1.5.0] — 2026-08-23

Cycle G: set-filter, toolbar icons, `run-sh` fix.

[1.6.1]: https://github.com/lengockhoa/VSDB/compare/v1.6.0...v1.6.1
[1.6.2]: https://github.com/lengockhoa/VSDB/compare/v1.6.1...v1.6.2
[1.6.0]: https://github.com/lengockhoa/VSDB/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/lengockhoa/VSDB/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/lengockhoa/VSDB/compare/v1.4.1...v1.5.0
