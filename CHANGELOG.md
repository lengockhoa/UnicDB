# Changelog

All notable changes to VSDB are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project

## [1.7.0] — 2026-08-27

Cycle Z: DataGrip-style SQL Console — an ad-hoc scratchpad panel to type SQL, run it against the active connection, and save the buffer as a .sql file.

### Added
- **SQL Console** (`VSDB: Open Console` command, `$(window)` icon): a standalone scratchpad
  panel with a multi-line SQL editor. Run executes the whole buffer through the existing
  pipeline (danger-confirm modal → keyword qualify → Results panel), via the toolbar button,
  Cmd/Ctrl+Enter (mac/win-linux), or a custom right-click menu. Console itself renders no
  results — the existing Results panel shows them.
- **Save as SQL file**: right-click → "Save as SQL file" or the Save button opens an OS save
  dialog pre-filled with a timestamped `console_YYYYMMDD_HHMMSS.sql` name; cancelled dialogs
  are no-ops. The context menu closes on Escape, click-away, and keyboard run.
- One empty console per open (scratchpad semantics — nothing persists across open/close);
  webview bundle `dist/consolePanel.js` with strict CSP identical to other panels.

## [1.6.8] — 2026-08-27

Cycle Y: finished queued results/query work — manual-commit UI, atomic MySQL batches, keyset paging, NULLS emulation, scoped DISTINCT dropdown, typed state dialect, declared-type inference.

### Added
- **Manual-commit mode toggle in the connection form**: per-connection `manualCommit` is now
  exposed in Add/Edit Connection UI (previously buried in config); edit pre-fills the current
  value, and an explicit off genuinely clears a stored on.
- **Keyset paging with safe hidden-PK projection**: when a query is a proven single-table browse
  (structural gate, no DISTINCT/aggregate/wraps) and its PK is fully visible, deep pages use a
  portable OR-of-ANDs cursor predicate with `LIMIT` instead of deep `OFFSET` (page 0
  byte-identical to before); when no PK column is visible, the projection is widened with hidden
  PK columns that drive the cursor while the displayed grid stays clean. NULLS-ordered sorts and
  every other shape keep the legacy OFFSET path exactly.
- **Declared-type grid inference**: PostgreSQL `format_type` declarations (e.g. `numeric(10,2)`,
  `varchar(50)`, `bit(1)`) and extended MySQL/MSSQL tokens now classify numeric/boolean/string
  columns from metadata instead of sampling — all-null numeric columns get right alignment,
  string columns stay left. Unknown types still fall back to sampling.
- **Typed state dialect + positional sort**: state messages carry the live driver dialect (header
  parse remains the byte-identical fallback) and positional declared types under the browse gate;
  duplicate output column names sort via an unambiguous positional `ORDER BY 2`; a column named
  `2024` stays quoted, bare ordinals stay bare.

### Fixed
- **MySQL multi-statement batches are atomic**: one pooled connection, explicit `BEGIN`, each
  statement on the same connection, `COMMIT` on success / `ROLLBACK` + original error on any
  failure, `release()` in `finally`. Single-statement streaming runs unchanged.
- **NULLS FIRST/LAST on MySQL/MSSQL**: emulated via a leading null-rank key (`IS NULL` / `CASE`)
  that rounds-trips through paging; no raw `NULLS` token reaches those dialects.
- **DISTINCT dropdown scoped to active filter**: values are queried inside the current bar WHERE
  plus other-column filters (never the requested column's own values); failures and truncation
  are visible in the set-filter footer (`first 1000 shown`), and no-state requests keep the
  legacy `where=""` byte-identical.
- **Results panel state hygiene**: `render()` resets the stale manual statement index; a committed
  save whose refresh fails now acks `{ok:true, warnings}` instead of rethrowing out of the
  message handler.
- **Webview server-sort lifecycle**: bundle evaluated once per suite; bounded observable waits
  replace fixed sleeps (flake eliminated at the root).

### Removed
- Dead `executeText` in the MySQL adapter (sole caller migrated to the connection-pinned batch arm).

## [1.6.7] — 2026-08-26

Cycle X: adversarial QA + correctness hardening — audit findings fixed, webview flake eliminated, dialect-safe export quoting, whitespace-complete `(Blanks)`.

### Fixed
- **Webview result-grid flake eliminated at the lifecycle root**: the NULL/viewer aggregate flake (test-only symptom) was traced to the bundle being re-evaluated per test, stacking unremovable `message` listeners; the bundle is now evaluated once per suite.
- **Dialect-safe SQL export quoting**: bare identifiers export unquoted (byte-stable on PostgreSQL, MySQL, SQL Server), while reserved words and non-bare names are quoted per dialect (`` `order` `` on MySQL, `[order]` on SQL Server, `"order"` on PostgreSQL). The export toolbar now forwards the detected driver so MySQL/MSSQL exports no longer emit unexecutable ANSI quotes.
- **`(Blanks)` filter matches all JS-trimmed whitespace** (tabs, newlines, spaces) on every dialect — PostgreSQL `~ '^[[:space:]]*$'`, MySQL `REGEXP`, SQL Server `NOT LIKE '%[^ \t\r\n\f\v]%'` — instead of the old spaces-only `TRIM(col) = ''`.
- **Results panel hardening**: close-before-refresh in `render()`, ctid-probe cursor closed on every path, manual commit/rollback re-queries, batched result wires `batched` correctly.
- **Save/core hardening**: rows with NULL primary keys are skipped with a visible comment (no malformed `UPDATE … WHERE pk = NULL`), batched first-fetch errors surface instead of hanging the cursor.
- **MySQL adapter parity**: dedicated `getTableSortQuery` twin; explicit UTC session; stream-end cursor settle (no hang on empty/finished streams).
- **Distinct-values round trip**: late responses for replaced statements are dropped; batched DISTINCT responses are fully drained and the cursor closed; truncated replies replay correctly from cache.

### Removed
- Server-side `TRIM(col) = ''` composition in the `(Blanks)` filter (spaces-only) — replaced by the whitespace-complete predicates above.

## [1.6.6] — 2026-08-26

Cycle W: server-side sort on header click, DISTINCT filter values, deterministic paging.

### Added
- **Header-click server-side sort (all 3 dialects)**: clicking a column header now
  issues a server-side `ORDER BY` requery (PostgreSQL, MySQL, SQL Server) instead of
  client-side sorting; colIds that are not bare identifiers are dialect-quoted before
  being sent.
- **DISTINCT set-filter values**: the filter dropdown loads distinct values from the
  server (`SELECT DISTINCT … LIMIT n`) instead of only the loaded rows window, with a
  per-statement cache and refresh after statement replacement.
- **Multi-term ORDER BY support**: the requery bar accepts comma-separated sort terms
  with per-dialect identifier quoting (`SELECT * FROM (…) AS vsdb_sub ORDER BY …`);
  true expressions are rejected with a visible error instead of passing through raw.

### Fixed
- **`(Blanks)` also matches empty strings** for string-typed columns (declared type
  family: char/varchar/text/nchar/nvarchar/enum/set/citext/cstring) — derived from
  column metadata, not row sniffing.
- **Deterministic Load More**: composed ORDER BY now appends the full primary key as a
  tiebreaker (when all PK columns are projected), so OFFSET paging no longer skips or
  duplicates rows across pages.
- Filter/paging requeries carry the active grid sort (a sort no longer drops when a
  filter change lands inside the debounce window).
- Late DISTINCT responses for a replaced statement are dropped (statement-index guard);
  batched DISTINCT results fully drain and close their cursor; the `truncated` flag
  survives requery merges.
- Quoted identifiers containing commas parse as a single ORDER BY term; loose
  string-type matching no longer misclassifies types like `charset`/`enumeration`.

## [1.6.5] — 2026-08-26

Cycle V: SQL coloring everywhere + server-side filter/paging + MSSQL sort.

### Added
- **SQL syntax coloring in the editor** (TextMate injection grammar into
  `source.sql`): keywords, strings, numbers, comments, functions, schema/table/
  column identifiers colorize with a VSDB-scoped theme.
- **Schema-aware semantic tokens**: the SQL editor also highlights identifiers
  using the loaded schema cache (tables, columns, views) and refreshes when the
  schema cache is invalidated.
- **SQL coloring inside the results grid + AI chat**: SQL text shown in the grid
  and in the AI chat render path is tokenized and themed (`webview/sqlHighlight.ts`).
- **Server-side column filter**: the grid's column filter now issues a filtered
  server requery (`WHERE` built per dialect) instead of filtering only loaded rows.
- **Load More paging (server-side)**: paging below the grid issues `OFFSET/LIMIT`
  requeries and appends rows, so deep results stream in without a full reload.
- **MSSQL server-side sort**: a T-SQL `ORDER BY … OFFSET/FETCH` helper mirrors the
  Postgres sort contract so the composer can dispatch per dialect.

### Fixed
- Filter values are carried as typed literals (numbers/dates are not `String()`-
  coerced), preserving index-friendly predicates per dialect.
- Webview SQL highlighting never writes user content via `innerHTML`; escaped
  nodes are re-tokenized through `appendChild`/fragments.

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
