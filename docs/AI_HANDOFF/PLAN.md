# PLAN — Cycle T: UNBREAK

> Base: `main` · Date: 2026-08-25 · 12 tasks · 3 waves
> Supersedes cycle S (its lazy-ctid intent is **shipped**; cycle T continues on top of it).

---

## §1 Intent

VSDB currently ships three user-visible "does not work at all" surfaces:

1. **Grid editing is unsafe and half-dead.** Add Row never inserts, the grid shows stale values
   after a successful commit, edits on a schema-qualified table hit the wrong table via
   `search_path`, mixed-case identifiers hit the wrong table or error, the postgres no-PK ctid
   resolver returns zero rows on every lookup (and leaks one cursor per row against a `max:1`
   pool), and a row whose `__rowId` drifted from its server index silently updates the **wrong
   record**.
2. **AI chat never completes a turn.** The ACP turn waits for `session/update` kinds that ACP
   never emits, so the panel spins forever; streamed text is read from the wrong field so
   bubbles are blank; Stop is a no-op; the tab leaks the `omp acp` child; and in the default
   engine the assistant has zero database access — which is the entire point of the feature.
   Opening chat is additionally gated behind an OpenAI API key it does not need.
3. **The statement splitter collapses transactional scripts into one statement**, so `BEGIN;
   INSERT…; COMMIT;` shows a single `▶ Run` and executes as one blob; and every Cmd+Enter pays
   for a full `information_schema.tables` scan per statement, plus one `reltuples` query per
   table on tree expand and a socket to *every* configured database at activation.

**Success:** on a live Postgres, a user can (a) browse a table or view, edit / add / delete rows
and commit — with the grid showing the committed values, the correct table, and all-or-nothing
semantics; (b) open AI chat with no configuration when `omp` is on PATH, get streamed text, a
settled turn, a working Stop, and an assistant that can list tables and run read-only SQL; (c)
run a `BEGIN…COMMIT` script as separate statements without VSDB issuing catalog queries it does
not need.

Cycle T is **unbreak only**. No new features.

---

## §2 Scope

### In scope

| Area | Defects |
|------|---------|
| Save builder (`src/core/saveStatements.ts`) | schema qualification (A8), PG identifier quoting (A9), non-PG no-PK DELETE silent no-op (A10 remainder), INSERT column/DEFAULT handling (A11), row addressing contract (A12 host type), `parseFromClause` O(n²) (A20), structured `skippedRows` so a dropped row is never reported as saved (A19-skip, §3.4a) |
| Webview grid (`webview/main.ts`, `src/ui/messages.ts`) | stale grid after commit (A5), Add Row values shape (A6), marker/cell collision (A7), server-index send (A12), Refresh discards edits silently (A13), copy leaks hidden cols / double-fires (A16) |
| Grid model (`src/ui/resultsGridModel.ts`) | duplicate column names collapse (A17) |
| Results host (`src/ui/resultsPanel.ts`) | ctid fetch reads the wrong adapter shape + cursor leak (A3), post-save refresh drops batched results (A4), empty header (A14), no transaction around the save batch (A15), skipped rows forwarded as `rowErrors` (A19-skip) |
| Statement parser (`src/core/statementParser.ts`) | `BEGIN` as block opener (C1), `FOR`/`WHILE` stack leak (C2), MySQL backslash escapes (C3), MSSQL `GO` (C4) |
| ACP transport (`src/ai/omp/acpProcess.ts`, `acp.ts`, `detect.ts`) | missing `initialized` (B4), no handshake timeout (B4), unread stderr (B10), Windows `where` + unquoted path (B12) |
| AI chat panel (`src/ui/aiChatPanel.ts`) | turn never settles (B1), wrong streamed-text field (B2), Stop no-op (B5), `token` never reset → resume dead (B6), dispose leaks child (B7), schema re-introspection per turn + discarded system prompt (B9) |
| Engine selection (`src/extension.ts`, banner, settings) | zero-config omp open (B3), honest engine banner via real `detectOmp` (B8), save-vs-test error mislabel (B13) |
| DB tools on the omp path (new `src/ai/omp/mcpBridge.ts`) | assistant has no DB access in the default engine (B11) |
| Adapters (`src/adapters/*`) | PG `listColumns` via `pg_catalog` (D4), cursor fast-path predicate (D5), MSSQL per-column `EXISTS` → single join (D6, **cost only** — `literal()` interpolation stays; see §3.9) |
| Schema tree (`src/ui/schemaTree.ts`) | per-table row-count storm (D2), auto-expanded connections (D3) |
| Keyword qualifier (`src/core/keywordQualify.ts`) | eager `information_schema.tables` scan per statement (D1) |
| Test debt | A3 and B14: fakes that encode the *wrong* adapter/protocol contract and keep the suite green while production is broken |

**A15 (wrap the save batch in one transaction) is IN scope** — it is a data-integrity bug (a
partial failure currently leaves the table half-written and unrollbackable). It is *not* the
user-facing manual-commit mode, which is out of scope.

### Out of scope — deliberately deferred

| Item | Cycle |
|------|-------|
| SQL syntax coloring (TextMate injection grammar + semantic tokens provider) | **V** |
| Per-table result tabs (top DataGrip-parity item) | **U** |
| Server-side sort / filter / paging | U |
| NULL entry UX + cell value viewer | U |
| Schema-aware autocomplete | U |
| Transaction / manual-commit mode (user-facing) | U |
| Anthropic provider | later |
| MSSQL parameter binding (`TYPES` + a `queryWithParams` wrapper, replacing `literal()` interpolation across `mssql.ts:221,235,256,329`) | U — narrowed out of D6 in review round 1; `literal()` escapes correctly today, so this is a smell to clean up deliberately, not an unbreak item |
| A19 per-row *retry* UI | Only the **failure**-path half of A19 is moot: A15 makes the batch all-or-nothing, so "keep every row dirty on the driver error" is already correct and needs no per-row attribution. The **skip-while-succeeding** half is IN scope and lands in TASK-001 + TASK-009 (see §3.4a) — a row that `buildSaveStatements` silently drops must come back as a `rowErrors` entry. What stays out is the per-row *retry* affordance (re-run only the failed rows) — cycle U. |
| `keepIndices` matches `hiddenColumns` **by name**, so hiding one of two duplicate-named columns also drops its visible twin from the export | U — pre-existing, independent of cycle T (it predates `field` uniqueness). Noted by review round 2 and deliberately **not** fixed here: it needs an index-based selection contract through the serializers, which is a redesign, not an unbreak. `headerName` remains the right call for `hiddenColumns` — it makes the filter match *at all*, where `field` would match nothing. |
| C5 (leading comments absorbed into the next statement) | Its only real cost was D5's fast-path predicate, which D5 fixes directly. Splitter behavior stays as-is. |

### Stale-input correction (important)

The defect inventory that seeded this plan predates commit `8b58f24` (cycle S). Verified at HEAD:

- **A1 / A2 are already fixed** — `maybeAppendCtidForNoPk` and the `__vsdb_browse__` subquery
  wrap no longer exist in `src/ui/browseCommands.ts` (zero `ctid` matches in that file), so
  `parseFromClause` receives plain `SELECT * FROM "s"."t"` and resolves. No task.
- **A18 is already fixed** — `resultsGridModel.inferColumns` no longer hides columns named
  `ctid`. No task.
- **A11's "INSERT includes ctid" half is moot** (no ctid column is ever appended); the blank-cell
  `""`-instead-of-DEFAULT half is real and is planned.
- **A10's postgres half is already fixed** (`saveStatements.ts:349-367` deletes by ctid). The
  *non*-postgres half — `continue` with no warning on a no-PK MySQL/MSSQL table — is still live
  and is planned.

### Wave constraint

No two tasks in the same wave list the same file. `src/extension.ts`, `src/ui/aiChatPanel.ts`,
`webview/main.ts`, `src/ui/resultsPanel.ts` and `src/core/saveStatements.ts` each have exactly
one owner per wave.

---

## §3 Approach

### 3.1 Row addressing — the contract that unlocks the save path (A12)

Today the webview sends `edits[].rowId` (a high-water-mark id) and the host does
`serverRows[rowId]`. After Add Row or a streamed append these diverge, so the WHERE clause is
built from a different row than the user edited. The webview already knows the truth
(`serverIndexByRowId`, `webview/main.ts:221`) — it just never sends it.

Contract fixed here so producer and consumer can be built in parallel:

```ts
// src/ui/messages.ts — SaveEditsMessage gains ONE optional field
serverIndexByRowId?: Record<string, number>;   // __rowId → index into result.rows

// src/core/saveStatements.ts — SaveStatementsOptions gains ONE optional field
serverIndexByRowId?: ReadonlyMap<number, number>;
```

Resolution rule, identical on both sides: `serverIndex(rowId) = options.serverIndexByRowId?.get(rowId) ?? rowId`.
Absent field ⇒ today's behavior (back-compatible; a stale webview cannot corrupt the host).

**Consequence for ctid:** `fetchPostgresCtids` currently keys its map by *server row index*
while `buildSaveStatements` looks it up by *rowId*. With the mapping in play these are no longer
interchangeable, so `ctidByRowId` is normalized to be keyed by **rowId** — the host translates
when building it. Stated in TASK-009's Interfaces.

### 3.2 INSERT DEFAULT sentinel (A6, A11)

Add Row sends `values` as a `Record` (rejected by the `Array.isArray` guard) and fills every
cell with `""`, so numeric / date / NOT NULL columns receive `''`. Fix both ends:

- webview emits `values: unknown[]` of column length, using a sentinel for untouched cells;
- builder omits sentinel columns from the INSERT column list entirely, letting the server apply
  its DEFAULT (and `INSERT INTO t DEFAULT VALUES` when *every* column is untouched).

```ts
export interface DefaultValueMarker { __vsdb_default__: true }
export function isDefaultValueMarker(v: unknown): v is DefaultValueMarker;
```

Rejected alternative: send `null` for untouched cells. It is indistinguishable from a user
typing NULL and breaks NOT NULL-with-default columns — the exact bug we are fixing.

### 3.3 Marker/cell collision (A7)

Insert and delete markers both live at `colIndex 0`, and `EditState.markDirty` coalesces on
`rowId:colIndex`, so typing in column 0 of a new row destroys the marker. Use reserved negative
slots — `MARKER_COL_INSERT = -1`, `MARKER_COL_DELETE = -2` — which cannot collide with a real
column and are already skipped by the builder's marker checks. The builder must additionally
never reach `columns[e.colIndex]` with a negative index (guard + test).

### 3.4 Save execution becomes atomic (A15) and the grid tells the truth (A4, A5)

Statements are wrapped in one `BEGIN … COMMIT`, with `ROLLBACK` on the first failure, executed
through `runner.runSql` in a single call so the `max:1` pool keeps one session. On success the
refresh re-runs the original SQL through `pickResult()` — the same helper `handleRequery` already
uses (`resultsPanel.ts:641`) — which handles both the plain and the batched/cursor shape and
closes the cursor. The webview then needs a third `renderGrid` branch: same statement, same row
count, changed values ⇒ swap `rowData` in place instead of falling through and showing stale
cells.

Rejected alternative: driver-level `adapter.transaction()`. It would touch all three adapters
for a fix the SQL string already expresses, and MySQL/MSSQL DDL-free save batches are
transactional under the same syntax.

### 3.4a A silently skipped row must never be reported as saved (A19-skip half)

`buildSaveStatements` can return `ok:true` while having dropped individual rows. Those rows produce
no statement, the transaction commits, the host posts `ok:true`, and `handleSaveResult`'s
else-branch (`webview/main.ts:2321-2330`) runs `editState.clear()` + `undoStack.clear()`. The
user's edit is destroyed with no banner and no undo — and §3.4's transaction does *not* cover
this, because nothing failed.

**The rule is structural, not a line-number list** (corrected in review round 2, where a
line-number list I had presented as exhaustive turned out to miss four sites). The obligation is:

> **Every `continue` or `break` in the three build loops that causes a row's edits to produce no
> statement must record a `skippedRows` entry.** A warning string is not sufficient and its
> absence is not an exemption — one of these paths pushes no warning at all.

Enumerated against HEAD (illustrative, not a closed list — re-derive from the source):

| Loop | Site | Warns? | Note |
|------|------|--------|------|
| 1 insert | `:334-338` `values` length ≠ column count | yes | |
| 2 delete | `:350`+`:367` non-postgres no-PK | **no** | TASK-001 item 3 adds the warning; needs a `skippedRows` entry too |
| 2 delete | `:354-357` postgres no-PK, missing ctid | yes | |
| 2 delete | `:371-373` no server row | yes | |
| 2 delete | `:379-384` PK column not in result (`break` ⇒ `whereOk:false` ⇒ no emit at `:390`) | yes | **`break`, not `continue`** |
| 3 update | `:443-448` unknown col index | yes | **cell-level** — drops one cell of a row that may still emit; record it |
| 3 update | `:453` `cols.length === 0` | **NO WARNING** | silent whole-row drop; a `warnings.push` grep does **not** find it |
| 3 update | `:465-467` only PK columns edited | yes | |
| 3 update | `:471-474` no server row for UPDATE | yes | |
| 3 update | `:478-485` + `:491` PK column missing (`break` then `if (!whereOk) continue`) | yes | |
| 3 update | `:497-502` postgres no-PK, missing ctid | yes | **the most reachable path today** — A3 makes ctid resolution fail for *every* row, so this is the live one, and it is the UPDATE twin of the DELETE case at `:354` |

**Explicitly NOT a skip:** `:436` (`insertRowIds.has(rowId)` ⇒ `continue`) — that row is already
addressed by its INSERT, so recording it would produce a false "your edit was lost" banner.
`:432` (`!rowEdits`) is defensive and unreachable. Neither may appear in `skippedRows`.

The fix is structured, not string-scraped: `SaveStatementsOk` gains

```ts
/** NEW (A19-skip): rows whose edits produced NO statement. Empty ⇒ everything was emitted. */
skippedRows?: ReadonlyArray<{ rowId: number; reason: string }>;
```

populated at every one of those sites (TASK-001) — `reason` carries the same text as the
corresponding warning, or a newly written one where no warning exists today (`:453`) — and the
host maps each entry into the
**already-consumed** `SaveResultMsg.rowErrors` (`messages.ts:121`, consumed by `clearExceptRowIds`
at `webview/main.ts:2304`) so the row stays dirty and the banner names it (TASK-009). No webview
change is needed — the consumer predates this cycle.

### 3.5 ctid lookup actually returns rows (A3)

`runSql('SELECT ctid FROM …')` has no `;`, so `postgres.runQuery` routes it to `DECLARE CURSOR`
and returns `{results: [], batched}` — `res.results[0]` is `undefined`, every row "fails", and
one cursor is leaked per row. Fix at the consumer with `pickResult()` (which drains and closes),
and fix the test fake, which returns `{results:[{…}]}` and therefore *cannot* observe the bug.
The fake must mirror `PostgresAdapter.runQuery`'s real branch: single `SELECT` without `;` ⇒
batched shape.

### 3.6 ACP turn lifecycle (B1, B2, B5)

Completion is the `session/prompt` **response** `{stopReason: "end_turn"}` — the code awaits it
at `aiChatPanel.ts:576` and throws it away, then blocks on a resolver that only fires for
`agent_end` / `turn_complete`, which are cycle-L `--mode rpc` names ACP never emits. Settle the
turn on the response; keep the notification resolver only as a belt for `stopReason` variants
(`cancelled`, `refusal`, `max_tokens`). Streamed text moves from `update.delta` to
`update.content.text` (the envelope the same file already uses at `:927` for
`user_message_chunk`), same fix in `deriveHistoryFromReplay`. Stop sends ACP `session/cancel`,
resolves pending resolvers, and posts `done`.

### 3.7 Zero-config omp (B3, B8) — locked decision #2

`commandOpenAiChat` returns early unless a full OpenAI config exists. Replace that gate with:
`detectOmp()` succeeds ⇒ open on the omp engine with no config at all; otherwise fall back to
the builtin provider and only then require a config (routing to AI settings as today). The
banner stops being a constant: it reports the engine actually resolved, and re-posts an `engine`
message when ACP fails over to builtin at `aiChatPanel.ts:552`, surfacing `OMP_INSTALL_HINT`
through the already-defined-but-dead `engine.hint` field.

### 3.8 DB tools on the omp path (B11) — the one genuine unknown

`hostTools.ts` targets a `set_host_tools` RPC that no longer exists. ACP's supported extension
point is `session/new`'s `mcpServers` array (verified non-optional,
`queue/ACP-SESSION-research.md:7`). Plan: expose the existing, already-tested `DbToolRegistry`
(`list_tables`, `describe_table`, `export_structure`, `run_sql` with its read-only guard at
`sqlTool.ts:99`) as an in-process MCP server on `127.0.0.1` with a per-session bearer token, and
pass its descriptor in `mcpServers`. Credentials never leave the extension host, and the
read-only guard remains the single chokepoint.

Both `session/new` (`acpProcess.ts:165`) **and** `session/load` (`acp.ts:216`) hardcode
`mcpServers: []`; fixing only the first would give a fresh chat tools and silently strip them from
every resumed one, so TASK-012 owns both call sites.

**Unknown:** whether omp 18 accepts an HTTP-transport MCP entry, a stdio one, or neither. This
was *not* probed. TASK-012 therefore begins with a live probe whose evidence is recorded in
`docs/AI_HANDOFF/queue/ACP-TOOLS-research.md`. Two things make that probe decidable rather than
open-ended:

- **Acceptance = an observed inbound `tools/list` or `tools/call` frame** from omp, pasted raw into
  the research note. A `session/new` that merely does not error proves nothing — omp may accept the
  JSON and never dial the server — so "no error, no traffic" counts as *not accepted*.
- **Bounded probe:** at most two descriptor shapes (HTTP, then stdio), one session each, 60 s per
  session, driven by a prompt that forces a tool call. No iterating on descriptor variants.

If neither shape yields an inbound frame, the executor records the evidence and flips the task to
`needs_breakdown` rather than inventing a protocol. The dead-`hostTools.ts` cleanup is
unconditional and lands either way, so it is not stranded behind the unknown. The unit-testable core
(`handleMcpRequest`, `buildMcpServerDescriptor`) is specified independently of that outcome, and
TASK-007 separately restores schema context to the omp prompt so chat is useful even if
TASK-012 stalls.

### 3.9 Query cost (D1-D6)

- **D1:** delete the eager `await publicTables()` warm-up; the catalog scan then happens only
  when a reserved-keyword candidate is actually present. Add an opt-in
  `createKeywordTableCache(ttlMs)` handle so `extension.ts` hoists one cache across a
  multi-statement run instead of paying per statement.
- **D2:** one grouped `reltuples` query per schema (`estimateTableRowsBatch`) instead of N
  serialized queries against a `max:1` pool.
- **D3:** connection nodes render `Collapsed`, so activation stops opening a socket to every
  configured database.
- **D4:** switch `PostgresAdapter.listColumns` to the existing, faster pure-`pg_catalog` SQL in
  `src/core/ddl/pgIntrospect.ts` (`INTROSPECT_COLUMNS_SQL`), dropping the triple `::regclass`
  cast and the DB-wide `has_column_privilege` evaluation.
- **D5:** replace `/^\s*SELECT\b/` + `!text.includes(";")` with a comment-stripped check that
  also accepts `WITH … SELECT` (as `mssql.ts:182` already does) and a semicolon test that
  ignores semicolons inside string literals — otherwise the query silently falls through to
  `pool.query`, which materializes the whole result set.
- **D6:** one `sys.index_columns` join instead of a correlated per-column `EXISTS`. **Cost fix
  only** (narrowed in review round 1): `this.literal(...)` interpolation stays, because
  `MssqlAdapter` has no parameter-binding path at all — `newRequest(sql)` (`mssql.ts:474-476`)
  constructs a bare `new Request(sql, cb)` and never calls `addParameter`. `literal()`
  (`mssql.ts:728`) does escape `'` → `''`, so this is a code smell rather than a live injection.
  Adding a `TYPES`-based `queryWithParams` is an adapter-wide change with its own test surface and
  is queued for cycle U, not smuggled into an unbreak cycle.

---

## §4 Test Plan

Every row is a real assertion with a concrete expected value. `R` = regression case that fails
against today's code.

| Type | Test Name | Expected |
|------|-----------|----------|
| Happy | `buildSaveStatements` UPDATE on `analytics.orders` | emits `UPDATE "analytics"."orders" SET …`, not `UPDATE orders` |
| Edge-quoting | mixed-case identifiers | `"Users"` / `"createdAt"` emitted double-quoted; round-trips on PG |
| Edge-boundary | INSERT where all columns are `__vsdb_default__` | exactly `INSERT INTO "public"."t" DEFAULT VALUES` |
| R (A8) | qualified table + non-`public` `search_path` | statement targets `analytics.orders`; fails today (bare `orders`) |
| R (A9) | PG `quoteIdent("createdAt")` | returns `"createdAt"`; today returns `createdAt` |
| R (A10) | MySQL no-PK DELETE marker | `warnings` contains a `no primary key` note; today: silent `continue` |
| Edge-perf | `parseFromClause` on 200 KB of SQL with comments and literals | returns the same `ParsedFrom` and completes < 50 ms; today quadratic (`inSkippedRegion` per character) |
| R (A20) | 200 KB script, timed | after the single-pass rewrite the parse is > 10× faster and `inSkippedRegion` is not called per character |
| Edge-partial-skip | 3 dirty rows, row 2 has no server row | `ok:true`, 2 statements, `skippedRows === [{rowId:2, …}]` — good rows still emit |
| Edge-nothing-skipped | every row emits a statement | `skippedRows` is `undefined`/`[]`, never a phantom entry |
| R (A19-skip, builder) | edit a row the builder drops | today the row is reported only in a prose `warnings` string; after fix `skippedRows` names its `rowId` |
| R (A19-skip, live path) | postgres no-PK table, empty `ctidByRowId` (exactly what A3 produces today), one cell edit | today `ok:true` with **zero** statements and only a prose warning, so the webview clears the edit as saved; after fix `skippedRows` names the row (`saveStatements.ts:497-502` — the UPDATE twin of the enumerated DELETE case, and the most reachable of all) |
| Edge-no-warning-drop | row whose edits all hit unknown col indexes ⇒ `cols.length === 0` (`:453`) | `skippedRows` contains the `rowId` even though that path pushes **no warning** — the case a `warnings.push` audit misses |
| Edge-false-positive | row with an insert marker **and** cell edits | INSERT emitted and the rowId is **absent** from `skippedRows` (`:436` is correct behavior, not data loss) |
| R (A19-skip, host) | save where the builder returns `ok:true` + one `skippedRows` entry | posted `saveResult` carries `rowErrors:[{rowId, error}]` so `clearExceptRowIds` keeps the row dirty; today no `rowErrors` ⇒ `editState.clear()` destroys the edit with no banner and no undo |
| Happy | Add Row → commit | one INSERT built; `warnings` empty |
| Edge-collision | Add Row then type in column 0 | insert marker survives; snapshot has marker **and** cell edit |
| Edge-ordering | append-delta row edited after stream | WHERE built from `serverIndexByRowId`, not `rowId` |
| R (A6) | `values` sent as `Record` | builder no longer receives a Record; webview sends `unknown[]` of column length |
| R (A12) | `rowId 4 → serverIndex 3` | UPDATE targets row 3's PK; today targets row 4 |
| Happy | commit → grid shows new values | `setGridOption("rowData", …)` called with refreshed rows |
| Edge-idempotent | commit with identical values | no crash, no duplicate render, dirty state cleared |
| Edge-permission | Refresh with unsaved edits | confirm prompt shown; declining leaves `dirtyCount` unchanged |
| R (A5) | same statement, same row count, changed values | grid renders **new** values; today renders stale |
| R (A13) | Refresh click | posts a message to the host; today posts nothing |
| Happy | Ctrl+C on a selected range | TSV of visible columns only |
| Edge-double-fire | single Ctrl+C keypress | exactly **one** `copy` message; today two |
| Edge-hidden-col | copy with a hidden column present | hidden column absent from payload |
| Edge-duplicate-names | `SELECT a.id, b.id` with the 2nd column hidden, then copy/export | `hiddenColumns` is `["id"]` (from `headerName`, matching raw `result.columns`) and the column is still excluded; derived from `field` it would be `["id__2"]` and match nothing |
| Edge-duplicate-names-values | `SELECT a.id, b.id` with distinct values, Add Row then Ctrl+C | both values copied in column order — `webview/main.ts:1855`/`:2199` stay keyed on `field` (object keys), which `headerName` would collapse onto one value |
| Happy | `inferColumns(["a","b"])` | two specs, fields `a`, `b` |
| R (A17) | `SELECT a.id, b.id` → `["id","id"]` | fields unique (`id`, `id__2`), `headerName` both `id`; today both read index 0 |
| Happy | `splitStatements("BEGIN; INSERT…; COMMIT;")` | **3** statements |
| Edge-nesting | `CREATE FUNCTION … BEGIN … END; SELECT 1;` | 2 statements (plpgsql block not split) |
| Edge-dialect | MySQL `SELECT 'it\'s'; SELECT 2;` | 2 statements |
| Edge-batch | MSSQL `SELECT 1 GO SELECT 2 GO` | 2 statements |
| R (C1) | `BEGIN; INSERT…; COMMIT;` | 3, not 1 |
| R (C2) | `SELECT … FOR UPDATE; SELECT 1;` | 2 statements, construct stack empty after statement 1 |
| Happy | ctid resolve on a no-PK PG table | map has one entry per matched row |
| Edge-batched-shape | fake returns `{results: [], batched}` | resolver still reads the row **and** closes the cursor |
| Edge-ambiguous | two identical rows | `{ok:false, reason:"ambiguous_only"}` |
| R (A3) | corrected fake (batched shape) | today: `all_failed` + N leaked cursors |
| R (A4) | post-save refresh on a batched driver | `state` posted with refreshed rows; today no post at all |
| R (A14) | any post after `render()` | `header` equals the header passed to `render()`; today `""` |
| Happy | save batch of 2 statements | one `BEGIN…COMMIT`, both applied |
| Edge-failure | statement 2 fails | `ROLLBACK` issued; `ok:false`; statement 1 not persisted |
| R (A15) | mid-batch failure | table unchanged; today statement 1 is committed |
| Happy | ACP turn | `assistant` + `done` posted, bubble carries the streamed text |
| Edge-cancel | `stopReason: "cancelled"` | `done` posted, no `assistant` history entry |
| Edge-timeout | handshake never answers | rejects within the bound; `error` posted; no permanent spinner |
| R (B1) | prompt response `{stopReason:"end_turn"}`, no `agent_end` notification | turn settles; today hangs forever |
| R (B2) | `agent_message_chunk` with `content.text` | delta rendered; today blank |
| Happy | ACP handshake (TASK-006) | recorded outbound frames are exactly `initialize`, `initialized` (notification, no `id`), `session/new`, and `start()` resolves with the `sessionId` from the result |
| Edge-timeout | agent never answers `initialize` (TASK-006) | rejects within the configured bound with a message naming the phase; the child is killed — no permanent spinner |
| Edge-backpressure | child writes 1 MB to stderr (TASK-006) | pipe is drained, retained tail ≤ 8 KB, child does not block on a full pipe |
| Edge-platform | `process.platform === "win32"` (TASK-006) | detect shells `where`, not `which` |
| Edge-path-quoting | omp installed at `/opt/my apps/omp` | the `--version` probe succeeds; the path is argv-passed/quoted, never concatenated into a shell string |
| R (B4) | handshake frame order | `initialize` → `initialized` → `session/new`; today `initialized` is missing |
| R (B10) | child writes an auth error to stderr then exits non-zero | the thrown startup error contains that stderr tail; today stderr is piped but never read, so the text is discarded |
| R (B12) | win32 detect | uses `where` and reports the installed omp; today runs `which` on Windows and reports `not-installed` |
| R (B13) | AI settings **save** throws | the webview receives a save-channel error; today the failure is rendered as "test failed" (`aiSettingsForm.ts:130-143`) |
| R (B5) | Stop mid-turn | `session/cancel` sent + `done` posted; today neither |
| R (B6) | resume after one completed turn | `resume_list` handled; today swallowed |
| R (B7) | panel dispose | child killed, pending permissions cancelled; today leaked |
| R (B14) | the corrected fakes | `aiChatPanelResume.test.ts` no longer feeds `agent_end`; fakes carry `content.text` |
| Happy | `commandOpenAiChat` with omp present, no API key | panel opens on the omp engine |
| Edge-missing-binary | omp absent, no config | AI settings opened, install hint surfaced |
| Edge-too-old | omp 16.0.0 | `ok:false`, `version-too-old`, builtin engine, banner says builtin |
| R (B3) | no stored API key, omp present | opens; today returns early |
| R (B8) | ACP failover to builtin | a second `engine` message is posted; today the banner lies |
| Happy | `handleMcpRequest("tools/list")` | the 4 registry tools, names exact |
| Edge-auth | wrong bearer token | 401, tool not executed |
| Edge-guard | `run_sql` with `DELETE FROM t` | refused by `isReadOnlySql`, no adapter call |
| Edge-resume | `loadSession()` on a saved session | `session/load` carries the **same** descriptor array as `session/new` — a resumed chat keeps its tools |
| R (B11a) | `session/new` params | `mcpServers` non-empty; today `[]` (`acpProcess.ts:165`) |
| R (B11b) | `session/load` params | `mcpServers` non-empty; today hardcoded `[]` (`acp.ts:216`), so a resumed session silently loses every tool |
| Happy | `qualifyKeywordTables("SELECT 1")` | **zero** `listTables` calls |
| Edge-candidate | SQL with a reserved-keyword table | exactly one `listTables` call |
| Edge-cache | 20 statements, one shared cache | exactly one `listTables` call total |
| R (D1) | plain SQL, no candidates | today: 1 call per statement |
| Happy | `estimateTableRowsBatch("public", [t1,t2,t3])` | one query, 3 entries |
| Edge-empty | empty table list | no query issued, empty map |
| Edge-missing | table dropped mid-flight | entry omitted, no throw |
| R (D2) | expand a 300-table schema | 1 query; today 300 |
| R (D3) | activation with 3 saved connections | 0 `listSchemas` calls; today 3 |
| Happy | PG `listColumns` | same `ColumnInfo[]` as before the switch, PK flags intact |
| Edge-cte | `WITH x AS (…) SELECT * FROM x` | routed to the cursor path |
| Edge-literal | `SELECT ';' AS a` | routed to the cursor path (semicolon is inside a literal) |
| R (D5) | leading-comment `SELECT` | cursor path; today materializes the full result set |
| R (D4/D6) | column list + PK for a 40-column table | identical output, single round trip for PK detection |

---

## §5 Verification

This repo has **no lint script** — `package.json` `scripts` are exactly: `compile`, `watch`,
`test`, `test:integration`, `typecheck`, `package`, `vscode:prepublish`. The static gate is
therefore `npm run typecheck` (`tsc --noEmit`), which every task must run. Do not invent
`npm run lint`.

```bash
# static gate — mandatory in every task
npm run typecheck

# targeted unit tests (vitest.config.ts: src/**/*.test.ts + tests/**/*.test.ts,
# excludes *.integration.test.ts)
npm test -- <test-file-path>

# webview / bundle-affecting tasks
npm run compile

# full unit suite — final gate before the cycle closes
npm test
```

Integration tests (`npm run test:integration`, `vitest.integration.config.ts`) hit
`src/adapters/__tests__/*.integration.test.ts` and **require a live Postgres/MySQL/MSSQL**. They
are *not* part of per-task verification. Run once at cycle close, on the adapter-touching tasks
only:

```bash
npm run test:integration
```

---

## §6 Acceptance

- [ ] `npm run typecheck` clean.
- [ ] `npm test` green, with **no test still encoding a wrong contract**: no fake feeds
      `sessionUpdate: "agent_end"`, no ACP fake supplies `delta` instead of `content.text`, and
      the ctid fake returns the batched shape for a single `SELECT` without `;`.
- [ ] `npm run compile` succeeds (webview bundle builds).
- [ ] Every bugfix task carries at least one regression test that provably fails on `main`
      (executor records the failing output in its task report).
- [ ] Grid: Add Row inserts; committed values are visible without a manual re-run; editing
      `analytics.orders` emits a schema-qualified statement; a mixed-case table round-trips; a
      mid-batch failure rolls back.
- [ ] **No edit is ever discarded silently.** A row the builder skips while still returning
      `ok:true` comes back as a `rowErrors` entry, stays dirty in the grid, and is named in the
      banner (§3.4a) — the save path never clears an edit it did not persist.
- [ ] Statement splitter returns 3 statements for `BEGIN; INSERT…; COMMIT;`.
- [ ] AI chat opens with no OpenAI configuration when `omp` is on PATH, streams text, settles
      the turn, Stop works, and closing the tab kills the child process.
- [ ] Engine banner reflects the engine actually in use, including after an ACP failover.
- [ ] DB tools reachable from the omp path (TASK-012) **or** TASK-012 is `needs_breakdown` with
      the recorded probe evidence — never a fabricated protocol.
- [ ] `qualifyKeywordTables` issues zero catalog queries for SQL with no reserved-keyword
      candidate; schema-tree expand issues one row-count query per schema; activation opens no
      connection.
- [ ] `npm run test:integration` green on a live Postgres for the adapter-touching tasks.

---

## §7 Global Constraints

Inherited by every `TASK-xxx.md` by reference — not repeated per task.

- **No new runtime dependencies.** `devDependencies` are exactly `@types/vscode`, `@vscode/vsce`,
  `esbuild`, `jsdom`, `typescript`, `vitest`; runtime deps stay as shipped. MCP transport must be
  built on Node built-ins.
- **VS Code engine floor `^1.75.0`**, Node 22 toolchain, `extensionKind: ["ui"]`. No API newer
  than 1.75.
- **`omp` floor is `MIN_OMP_VERSION = "17.0.0"`** (`src/ai/omp/detect.ts:5`) — do not lower it.
- **The webview is semi-trusted.** The host derives table + PK from its own parse of the SQL
  (`resultsPanel.ts:381-399`); webview-supplied `tableName`/`pkColumns` stay ignored. The new
  `serverIndexByRowId` is an *index remap only* and must never widen what the host will address.
- **`run_sql` stays read-only** — `isReadOnlySql` (`sqlTool.ts:99`) remains the single chokepoint
  for every path, including any MCP bridge.
- **Secrets never leave the extension host.** No API key, password or connection string in a
  spawn argv, an MCP descriptor, a log line, or webview-visible state.
- **Postgres pool is `max: 1`** (`postgres.ts:83`). Never issue N serialized queries where one
  grouped query works, and always close a cursor you open.
- Identifier quoting is per-dialect via `quoteIdent(name, dialect)`; never interpolate a raw
  identifier or value into SQL.
- Preserve existing comment provenance markers (`TASK-xxx` references) when editing around them.
- No behavior change to features listed out of scope in §2.

---

## Planner Self-Audit

Checklist: 12/12 pass

Fixed during audit:
1. **Stale defect inventory caught against HEAD.** A1, A2, A18 and the postgres half of A10 were
   already fixed by cycle S (`8b58f24`); `maybeAppendCtidForNoPk` does not exist at HEAD. Four
   tasks that would have "fixed" working code were never written; the correction is recorded in
   §2 so the reviewer does not re-file them.
2. **Same-wave compile coupling removed.** TASK-002 originally imported `MARKER_COL_INSERT` /
   `DefaultValueMarker` from `src/core/saveStatements.ts` — a file TASK-001 edits in the *same*
   wave, so landing order would have broken `npm run typecheck`. The wire contract is now fixed
   here in §3.2/§3.3 and each side declares its own constants, pinned by tests on both sides.
3. **A19 split, not dropped** (corrected in review round 1 — the original "no consumer" claim was
   wrong; `clearExceptRowIds` at `webview/main.ts:2304` is the consumer). The failure path is
   covered by A15's transaction; the *skip-while-succeeding* path is a real silent data-loss hole
   and is now planned as §3.4a (TASK-001 `skippedRows` + TASK-009 mapping). Only the per-row
   *retry* affordance is deferred to cycle U.
4. **`npm run lint` never written.** This repo has no lint script; §5 says so explicitly and every
   task's static gate is `npm run typecheck`.
5. Misplaced new test file `src/ui/__tests__/engineChoice.test.ts` moved to
   `src/ai/__tests__/engineChoice.test.ts` to match the module it covers.

Verification of grounding: all 20 target source paths and all 43 referenced existing test files
were confirmed to exist on disk; the 7 genuinely new files are marked `(new)`. All verification
commands use scripts actually defined in `package.json` (`compile`, `test`, `test:integration`,
`typecheck`).

Known gaps:
- **TASK-012's transport is a genuine unknown.** Whether omp 18 accepts an HTTP or stdio MCP entry
  in `mcpServers` was never probed — the only verified fact is that the array is required. The
  task therefore starts with a live probe and carries an explicit stop rule (record evidence, flip
  to `needs_breakdown`) instead of a guessed protocol. TASK-007 restores schema context to the omp
  prompt independently, so a blocked TASK-012 degrades the chat rather than killing it.
- **`src/extension.ts` activation behavior is not unit-tested** — it imports `vscode` at module
  scope. TASK-011 mitigates this by extracting the engine *policy* into a pure `resolveEngine`;
  the remaining `vscode`-bound wiring (panel show, settings routing) is verified manually and
  called out in that task's acceptance list.
- **Integration tests need live databases.** D4/D5/D6 output parity is asserted against fakes in
  the per-task gate; the real-server check is one `npm run test:integration` run at cycle close on
  TASK-005. MySQL and MSSQL parity depends on a reviewer having those servers.
- **A16's double-binding fix requires a runtime judgement** (which of the two Ctrl+C handlers
  reaches the AG Grid focused range) that could not be settled by reading alone; TASK-002 names
  both call sites and states the likelier keeper rather than guessing in the acceptance criteria.

## Planner Report
PLANNER_MODEL: claude-opus-5

---

## Plan Review Log

### Round 1 — 2026-08-25 · claude-opus-5 (independent reviewer, P2.5)

Status: Issues Found

**Verified clean (no action needed):** the stale-input correction in §2 is *correct* — `grep ctid src/ui/browseCommands.ts` and `src/ui/resultsGridModel.ts` both return zero matches, and `saveStatements.ts:352-367` does delete by ctid on postgres, so A1/A2/A18 and A10's PG half are genuinely already fixed and rightly dropped. No task targets already-fixed code: every remaining defect was re-confirmed live at HEAD (A3 `resultsPanel.ts:771`, A4 `:525`, A14 `header` never assigned, A9 `saveStatements.ts:112` returns the raw name, A20 `:242` per-char `inSkippedRegion`, A17 `resultsGridModel.ts:77` `columns.indexOf`, A16 dual binding at `webview/main.ts:720` + `:1537`, C1 `statementParser.ts:407`, C2 `:421`, D1 `keywordQualify.ts:142`, D3 `schemaTree.ts:214`, D5 `postgres.ts:161-164`, B1 `aiChatPanel.ts:692`, B2 `:682`, B6 `:858`, B7 `:344`, B4a/B12 `acpProcess.ts:155-167` / `detect.ts:72,80`, B3 `extension.ts:387`, B13 `aiSettingsForm.ts:135`, B11 `acpProcess.ts:165`). §5 is accurate — `package.json` has exactly the seven named scripts and no `lint`. All 45 referenced existing test files exist on disk. The INDEX dependency graph matches all 12 `Dependencies` fields, the three waves follow from it, **no two tasks in a wave share a Target File**, and no same-wave *compile* coupling remains (TASK-002's locally-declared markers and TASK-004/005's optional-parameter contract are handled correctly). No deferred item is smuggled in.

**Findings:**

1. **BLOCKING — Scope/data-loss: the A19 drop rationale is unsound, and cycle T widens the hole (PLAN §2 "Out of scope" row for A19; fix belongs to TASK-009).** §2 argues A15 makes per-row attribution moot because "keep every row dirty on failure becomes the correct behavior". That covers only the *failure* path. `buildSaveStatements` also **skips rows while still succeeding**: `saveStatements.ts:335-340` (insert `values` length mismatch) and `:356-360` (postgres no-PK, missing ctid) push a warning and `continue`, and TASK-001 adds a *third* such case (MySQL/MSSQL no-PK DELETE). Those rows never become statements, so the transaction commits, the host posts `ok:true`, and `webview/main.ts:2321-2330` runs `editState.clear()` + `undoStack.clear()` — the user's edit to the skipped row is discarded with no banner and no undo. §2 also asserts per-row attribution "has no consumer"; that is factually wrong — the consumer already exists at `webview/main.ts:2304-2318` (`clearExceptRowIds`, which keeps errored rows dirty and renders `row N: <error>`). **Fix:** add to TASK-009 an acceptance criterion plus a test that the host maps every skipped-row `warning` from `SaveStatementsResult` into `SaveResultMsg.rowErrors` (or, minimally, returns `refused:true` + `reason` when any row was skipped) so those edits stay dirty; rewrite the A19 row in §2 to say only the *failure*-path half is moot.

2. **BLOCKING — Consistency: TASK-012 cannot satisfy its own `session/load` criterion from its Target Files.** TASK-012 Target Files list `src/ai/omp/acpProcess.ts` "(pass `mcpServers` through to `session/new` and `session/load`)", and its R (B11) case requires `session/load` to carry the same descriptor. But `session/load` is not sent from `acpProcess.ts` at all — it is issued by `AcpClient.loadSession` at **`src/ai/omp/acp.ts:213`** (`{ sessionId, cwd, mcpServers: [] }`). As written the executor must either edit a file outside its declared scope or silently drop the criterion. **Fix:** add `src/ai/omp/acp.ts` and `src/ai/omp/__tests__/acp.test.ts` to TASK-012's Target Files, Test Files and Verification Commands. No wave conflict — TASK-006 owns `acp.ts` in wave 1, TASK-012 runs in wave 3.

3. **BLOCKING — Clarity/consistency: TASK-011's cited `engine` message interface is stale, and the file that defines it is not a Target File.** TASK-011 Interfaces present `{ type: "engine", name: string, version?: string, hint?: string }` as *existing* at `src/ui/aiChatPanelMessages.ts:62`, and its Happy case asserts the panel posts `engine {name:"omp", version:"18.0.1"}`. The real declaration (`aiChatPanelMessages.ts:58-63`) is `{ type: "engine"; name: "omp" | "builtin"; hint?: string }` — **there is no `version` field**, so that test cannot compile and the executor will hit a `tsc` error with no owner for the file. **Fix:** add `src/ui/aiChatPanelMessages.ts` to TASK-011's Target Files and mark `version?: string` as a NEW field on `AiChatPanelEngine` rather than an existing one. (No wave-2 collision — no other task targets that file.)

4. **IMPORTANT — Clarity/YAGNI: TASK-005's MSSQL "bind every identifier/value" criterion is unimplementable as specified.** `MssqlAdapter` has no parameter-binding path at all: the sole query constructor is `new Request(sql, () => undefined)` (`mssql.ts:475`), there is zero `addParameter` / `TYPES` usage in the file, and `literal()` (`mssql.ts:728`, correct `''` escaping) is the only mechanism — used identically at `:221`, `:235`, `:256`, `:329`. TASK-005 names no helper to add, lists none under Produces, and its Edge (injection) case (`'` and `]`) would pass against today's `literal()` anyway, so it cannot distinguish the fix. **Fix:** either specify the mechanism concretely (import `TYPES` from `tedious`, add a private `queryWithParams(sql, params)` wrapper at `mssql.ts:475`, list it under Produces, and re-scope the injection case to assert `@schema`/`@table` placeholders appear in the emitted SQL) — or drop the "no `this.literal(...)` remains" criterion and the injection case, keeping D6 honestly scoped to the single-join cost fix, which is the actual defect.

5. **IMPORTANT — Consistency: same-wave runtime coupling between TASK-003 and TASK-002 that TASK-003 is forbidden to fix.** TASK-003 makes `ColumnSpec.field` unique (`id` → `id__2`). `webview/main.ts:2110-2113` builds `hiddenColumns` as `currentSpecs.filter(s => s.hidden === true).map(s => s.field)` and passes it to serializers that match those strings against the **raw** `result.columns` (`resultsGridModel.ts:470,610`); `webview/main.ts:2199` and `:1855` likewise key off `spec.field`. After TASK-003, a hidden column whose name is duplicated stops being excluded from export/copy. TASK-003's own Discussion instructs the implementer to grep and fix `webview/main.ts` — a file TASK-003 must not touch and **TASK-002 owns in the same wave**, so the mitigation is not executable by whoever is told to do it. **Fix:** move it to TASK-002 as an explicit acceptance line ("`hiddenColumns` and the Ctrl+C hidden-column filter are derived from `spec.headerName`, not `spec.field`") plus a duplicate-name test case, and delete the un-actionable instruction from TASK-003's Discussion.

6. **IMPORTANT — Risk: TASK-012's stop rule does not define "accepted", so branch 1 can be satisfied by a dead bridge.** §3.8 and TASK-012's Discussion branch on whether the `mcpServers` descriptor is "accepted", but a `session/new` that returns a `sessionId` proves only that the array parsed — per `queue/ACP-SESSION-research.md:7`, even `mcpServers: []` returns a `sessionId`. omp may accept the descriptor and never connect to or call the server, which is precisely the "ships a chat that looks wired up and answers from imagination" outcome the stop rule exists to prevent. The probe is also unbounded, so "probe more shapes" can absorb the whole wave. **Fix:** define accepted = the bridge's own request log recorded at least one inbound `tools/list` **or** `tools/call` from omp during the probe (record the frame in `ACP-TOOLS-research.md`); a non-erroring `session/new` with no inbound request falls through to branch 3 (`needs_breakdown`). Bound the probe explicitly (e.g. at most two transport shapes, one session each). With that tightened, a blocked TASK-012 leaves the cycle coherent — it is alone in wave 3, nothing depends on it, §6 already accepts `needs_breakdown` as a terminal state, and TASK-007's schema context is a real fallback. (Note: TASK-012's `hostTools.ts` dead-module cleanup would also be stranded if the task blocks — consider making that criterion unconditional.)

7. **MINOR — Completeness: §4 under-covers TASK-006 and omits four planned defects.** §4 gives TASK-006 no happy path and only one edge (`Edge-timeout`); B10 (stderr tail surfaced in startup error), B12 (win32 `where` / quoted path), B13 (save-vs-test error channel) and A20 (`parseFromClause` perf) have no §4 row at all, although each task file covers them properly. **Fix:** add one happy + two differing edges for TASK-006 and one row each for B10 / B12 / B13 / A20 so §4 is a complete digest of the task-level gates.

8. **MINOR — Clarity: stale line anchor.** PLAN §3.1 and TASK-003's Interfaces cite `webview/main.ts:395` for `obj[s.field] = rows[i][j]`; it is at `:397`. Re-anchor before an executor greps for it.

NOTES: Grounding quality is high — the planner's own stale-input audit checks out and I found no fabricated file, symbol or script. Findings 1-3 are the ones that would silently produce wrong work: #1 is a real user-data-loss path that cycle T makes *more* reachable, #2 and #3 are missing Target Files that guarantee a scope violation or a typecheck failure. #4-#6 are executable-but-underspecified seams. Recommend one revision round before P3.

### Round 1 — revisions applied · 2026-08-25 · planner · claude-opus-5

All 8 findings were independently re-verified against HEAD before editing; **all 8 were correct**,
including #1's correction of my own false "no consumer" claim. All 12 tasks remain `ready`; no
wave, dependency or Target-File-collision change resulted.

1. **A19 skip-path (BLOCKING) — accepted in full; this was a real data-loss hole.** New PLAN
   **§3.4a** specifies the fix structurally rather than by scraping prose warnings:
   `SaveStatementsOk` gains `skippedRows?: ReadonlyArray<{rowId, reason}>`, populated by TASK-001
   at every site that abandons a row while returning `ok:true` (`saveStatements.ts:335`, `:356`,
   `:372`, `:466`, `:473`, plus the new MySQL/MSSQL no-PK DELETE); TASK-009 maps each entry into
   the already-consumed `SaveResultMsg.rowErrors` (`messages.ts:121` →`clearExceptRowIds`,
   `webview/main.ts:2304`). No webview change needed. §2's A19 row is rewritten — only the
   per-row **retry affordance** is deferred, and the "no consumer" claim is retracted (the
   Self-Audit entry is corrected too). TASK-001 gains 3 cases + 1 regression + a grep-the-sites
   acceptance line (13→17 cases); TASK-009 gains 2 edges + 1 regression + the mapping criterion
   (12→15 cases) and its dependency line now names `skippedRows`.
2. **TASK-012 `session/load` (BLOCKING) — accepted.** `src/ai/omp/acp.ts` (the real `session/load`
   site, `acp.ts:216`) and `src/ai/omp/__tests__/acp.test.ts` added to Target Files, Test Files and
   Verification Commands; R (B11) split into **B11a** (`session/new`) and **B11b**
   (`session/load`) plus an `Edge (resume)` case, with a matching acceptance line and an Interfaces
   note. PLAN §3.8 now states both call sites explicitly. No wave conflict: TASK-006 owns `acp.ts`
   in wave 1, TASK-012 is alone in wave 3.
3. **TASK-011 `AiChatPanelEngine.version` (BLOCKING) — accepted.**
   `src/ui/aiChatPanelMessages.ts` and `src/ui/__tests__/aiChatPanelMessages.test.ts` added to
   Target/Test Files; the interface is now quoted verbatim as it exists on `main`
   (`type`/`name`/`hint`, **no `version`**) with `version?: string` moved to **Produces** and
   marked NEW, plus an acceptance line. No other task targets that file in any wave.
4. **TASK-005 MSSQL (IMPORTANT) — accepted; took the second option (re-scope, don't invent).**
   D6 is now the **cost fix only**: one `LEFT JOIN` on `sys.index_columns` replacing the
   per-column correlated `EXISTS`. The "binds every identifier/value / no `this.literal(...)`
   remains" criterion is **dropped**, with the reason recorded in both the task and PLAN §3.9:
   `MssqlAdapter` has no binding path (`newRequest`, `mssql.ts:474-476`, never calls
   `addParameter`) and `literal()` (`:728`) already escapes `'` → `''`, so this is a smell, not a
   live injection — a `TYPES`-based `queryWithParams` is an adapter-wide change queued for cycle U,
   not smuggled into an unbreak cycle. The `Edge (injection)` case that could not distinguish the
   fix is replaced by `Edge (quoting)`: `listColumns("dbo","O'Brien")` must still emit `'O''Brien'`
   exactly once, i.e. the rewrite must not *lose* the existing escape.
5. **`hiddenColumns` / `headerName` (IMPORTANT) — accepted, moved to the file's owner.** TASK-002
   gains the acceptance line verbatim as suggested (plus an audit of `webview/main.ts:1855` and
   `:2199`), a duplicate-name test case (`SELECT a.id, b.id` with the 2nd column hidden), a
   Discussion note explaining why it lives there, and a matching §4 row. TASK-003's un-actionable
   "go grep `webview/main.ts`" instruction is deleted and replaced with an explicit "that file is
   TASK-002's, do not touch it" note, scoped to `resultsGridModel.ts` for anything it finds in its
   own file. Note the fix is order-independent: with distinct column names `field === headerName`,
   so TASK-002's change is a no-op until TASK-003 lands — no new dependency.
6. **TASK-012 stop rule (IMPORTANT) — accepted, both halves.** "Accepted" is now defined as **at
   least one observed inbound `tools/list` or `tools/call` frame** from omp, pasted raw into
   `ACP-TOOLS-research.md`; a non-erroring `session/new` with no inbound traffic explicitly falls
   to branch 3 (`needs_breakdown`). The probe is bounded: at most two descriptor shapes (HTTP,
   then stdio), one session each, 60 s per session, driven by a tool-forcing prompt. The
   `hostTools.ts` dead-module cleanup is now **unconditional** — it lands even when the probe
   blocks the bridge, so it is not stranded behind the unknown. Mirrored in PLAN §3.8.
7. **§4 coverage (MINOR) — accepted.** Added for TASK-006: a happy path (handshake frame order +
   `sessionId` resolution) and three differing edges (timeout, 1 MB-stderr backpressure, win32
   `where`, path-with-spaces quoting). Added one regression row each for **B10**, **B12**, **B13**
   and **A20** (plus an `Edge-perf` row for A20), and the new A19-skip, B11b and duplicate-name
   rows from findings 1/2/5. §4 is again a complete digest of the task-level gates.
8. **Stale anchor (MINOR) — accepted.** TASK-003's Interfaces now cites `webview/main.ts:397` for
   `obj[s.field] = rows[i][j]`, verified against HEAD. PLAN §3.1 turned out never to carry the
   `:395` anchor (it cites `webview/main.ts:221` for `serverIndexByRowId`), so nothing to re-anchor
   there; the only remaining `:395` string in the repo is inside the reviewer's own Round 1 entry
   above, which is preserved verbatim.

### Round 2 — 2026-08-25 · claude-opus-5 (independent reviewer, P2.5 — final round)

Status: Issues Found

Scope: verification of the 8 round-1 fixes against source (not the planner's prose) + a
regression pass on what the revisions changed (TASK-001/002/003/005/009/011/012).

**Round-1 fixes — landed and verified at HEAD:**

- **#1 (A19 skip)** structure is real: `messages.ts:121` `rowErrors` exists, `webview/main.ts:2304`
  `clearExceptRowIds` consumes it, and the `:2321-2330` else-branch does run `editState.clear()` +
  `undoStack.clear()`. §3.4a, TASK-001 item 8 (+ grep acceptance line) and TASK-009 (Edge partial
  success / Edge nothing skipped / R A19-skip + acceptance + Dependencies naming
  `SaveStatementsOk.skippedRows`) are all present. **But the site enumeration is incomplete — see
  finding 1.**
- **#2 (TASK-012)** ✓ `session/load` is at `acp.ts:213-216` with hardcoded `mcpServers: []`;
  `acp.ts` + `__tests__/acp.test.ts` are in Target Files, Test Files and Verification Commands;
  B11 split into B11a (`acpProcess.ts:165`) / B11b (`acp.ts:216`) + `Edge (resume)`.
- **#3 (TASK-011)** ✓ `AiChatPanelEngine` at `aiChatPanelMessages.ts:58-63` still has only
  `type`/`name`/`hint` — no `version`; the file is now a Target File and `version?: string` is
  under Produces marked NEW. Optional field ⇒ no compile coupling with TASK-007 (wave 1).
- **#4 (TASK-005)** ✓ and the re-scope is the right call: `newRequest` (`mssql.ts:474-476`) never
  calls `addParameter`, and all six `literal()` call sites (`:221,235,256,291,292,329,330`) are
  string-literal positions where `literal()` (`:728`, `'` → `''`) escapes correctly. No live
  defect is left unaddressed by dropping it; `Edge (quoting)` (`O'Brien` → `'O''Brien'` once) is a
  real guard that the rewrite does not *lose* the escape. Deferring `TYPES` binding to cycle U is
  honest for an unbreak cycle.
- **#5 (TASK-002/003)** ✓ moved, with the duplicate-name case, and **the order-independence claim
  is correct**: `inferColumns` at HEAD emits `{ field: name, headerName: name }`
  (`resultsGridModel.ts:100`), so with distinct names the two fields are equal and TASK-002's
  switch is a no-op until TASK-003 lands. No new same-wave dependency. (See finding 2 for the
  audit line that came with it.)
- **#6 (TASK-012 stop rule)** ✓ accepted = observed inbound `tools/list`/`tools/call` frame;
  bounded to 2 shapes × 1 session × 60 s; `hostTools.ts` cleanup is unconditional.
- **#7 (§4)** ✓ TASK-006 now has a happy path + 4 differing edges; B10, B12, B13, A20 each have a
  row (A20 has two).
- **#8 (anchor)** ✓ `obj[s.field] = rows[i][j]` is at `webview/main.ts:397`.

**Structural re-check (post-revision) — clean:** no two tasks in W1 (001-008), W2 (009/010/011) or
W3 (012) share a Target File. The `skippedRows` seam crosses waves correctly (producer TASK-001 in
W1, consumer TASK-009 in W2, named in TASK-009 Dependencies). Both new fields (`skippedRows`,
`version?`) are optional ⇒ no same-wave compile coupling. INDEX's graph
(`009→{001,002}; 010→005; 011→{006,007,008}; 012→{006,007,011}`) matches all 12 `Dependencies`
fields exactly. All 12 tasks carry all 9 required sections and are legitimately `ready`.

COMPLETENESS:
  1. **BLOCKING (silent data loss) — the A19-skip site list is presented as exhaustive but omits
     4 of 10 abandon-while-`ok:true` paths in `src/core/saveStatements.ts`.** PLAN §3.4a and
     TASK-001 item 8 both say "populated at **every** site" and then name only `:335`, `:356`,
     `:372`, `:466`, `:473` + the new MySQL/MSSQL no-PK DELETE. Also abandoning a row while
     returning `ok:true`:
     - `:379-390` — DELETE where a PK column is not in `result.columns`: `whereOk = false` →
       `break` → the `if (whereOk)` guard emits nothing. Reachable on any projection that omits
       the PK (`SELECT name FROM users` + delete).
     - `:478-491` — the UPDATE twin of the above (`if (!whereOk) continue`).
     - `:497-502` — **postgres no-PK UPDATE with a missing ctid.** This is the exact twin of the
       enumerated `:356` DELETE case and the *most* reachable of all: until TASK-009 lands, A3
       makes ctid resolution fail for every row, so this is today's dominant skip path.
     - `:443-453` — every edit for a row hit `columns[e.colIndex] === undefined`, so
       `cols.length === 0` and `:453` `continue`s. `:453` itself pushes **no** warning, so
       TASK-001's "every `warnings.push` path" grep criterion does not cover it directly.
     TASK-001's grep acceptance line is a partial backstop for the three that do warn, but an
     executor who treats the enumerated list as authoritative ships a ~60%-complete fix for a
     user-data-loss bug and still ticks the box. **Fix (one edit each in §3.4a and TASK-001
     item 8):** add `:383`, `:453` (via `:445`), `:483`, `:500` to the list, or drop the line
     numbers and say "every `continue`/`break` path in the three loops that emits no statement —
     grep and list them all"; and add a §4 / TASK-001 case for the postgres no-PK UPDATE skip
     (`:500`), which is the highest-traffic instance.

CONSISTENCY:
  2. **IMPORTANT (regression the round-1 fix could introduce) — TASK-002's `headerName` audit line
     points at two sites where `field` is the correct key.** The acceptance line says "audit
     `webview/main.ts:1855` and `:2199` for the same `field`-as-database-name assumption and switch
     them to `headerName` where they mean the database column". Verified: `:2199` is
     `row.push(r[s.field])` where `r` is a row object built by `rowsToObjects` with `obj[s.field]`
     keys (`:397`), and `:1855` is `blank[col.field]` over AG Grid column defs. **Both must stay on
     `field`** — after TASK-003 makes fields unique, `r["id"]` for the `id__2` column returns the
     wrong value or `undefined`, breaking Ctrl+C and Add Row for duplicate-named results. The hedge
     "where they mean the database column" is correct but implicit, and the answer at both named
     sites is "do not change it". **Fix:** state explicitly that `:1855` and `:2199` are
     object/column-def keys and stay on `field`; only `hiddenColumns` (`:2110-2113`) and the Ctrl+C
     hidden-column filter move to `headerName`.

CLARITY:
  3. **MINOR — test-count mismatches.** TASK-001's acceptance says "All 17 test cases" but its
     table has 16 rows; TASK-012 says "All 12 test cases" but its table has 11. Executors are told
     to confirm every case, so a phantom case invites either a fabricated test or a false
     incomplete report.

SCOPE:
  - none. Nothing deferred was smuggled back in; D6's re-scope, the A19 retry/report split and the
    MSSQL binding deferral are each recorded in §2's out-of-scope table and in INDEX's cycle-U
    queue.

YAGNI:
  4. **MINOR / advisory (pre-existing, not introduced here).** `keepIndices`
     (`resultsGridModel.ts:429-444`) matches `hiddenColumns` by *name*, so for `SELECT a.id, b.id`
     with the 2nd column hidden, `hiddenColumns = ["id"]` excludes **both** columns from
     TSV/CSV/SQL export, not just the hidden one. TASK-002's `Edge (duplicate names)` expectation
     is still satisfiable exactly as worded, and `headerName` remains strictly better than `field`
     (which matches nothing and would leak the hidden column) — but the plan should not imply the
     visible twin survives. Genuinely out of scope for an unbreak cycle; noting it so the next
     reader does not file it as a TASK-002 defect.

NOTES: Grounding is again high — every anchor I spot-checked (`messages.ts:121`,
`webview/main.ts:397/2304/2321`, `acp.ts:213-216`, `acpProcess.ts:165`,
`aiChatPanelMessages.ts:58-63`, `mssql.ts:474-476/728`, `resultsGridModel.ts:100`) is exact, and
all 8 round-1 fixes genuinely landed. Only finding 1 is worth stopping for: it is the same
data-loss hole round 1 opened, closed on 6 of 10 paths, with the most reachable one
(`:500`, postgres no-PK UPDATE) among the misses. Findings 1 and 2 are both surgical text edits —
apply them and the plan is ready for P3 without a further review round.

### Round 2 — findings applied without re-review · 2026-08-25 · planner · claude-opus-5

Loop cap reached: these were applied directly and the cycle proceeds to P3. Every site was
re-derived from `src/core/saveStatements.ts` and `webview/main.ts` at HEAD before editing — the
reviewer's line numbers were correct, and reading the loops turned up **two more** sites it had
not listed. All 12 tasks remain `ready`; waves unchanged (W1 = 001-008, W2 = 009/010/011,
W3 = 012); no Target-File or dependency change.

1. **A19 enumeration was incomplete (BLOCKING) — confirmed, and worse than reported.** Took the
   reviewer's better option: PLAN §3.4a and TASK-001 item 8 now lead with the **structural rule**
   — *every `continue`/`break` in the three build loops that leaves a row's edits unemitted
   records a `skippedRows` entry* — with line numbers demoted to an illustrative table explicitly
   marked "re-derive from source". The four missed sites (`:379-384`, `:443-448`, `:453`,
   `:478-485`+`:491`, `:497-502`) are in it. Two beyond the reviewer's list: **`:350`+`:367`**
   (non-postgres no-PK DELETE — the very case TASK-001 item 3 adds a warning for) and **`:443-448`**
   (unknown col index, which drops a *cell* of a row that may still emit). The `warnings.push`
   grep backstop is **replaced**, not extended, because `:453` pushes no warning at all and a grep
   audit provably misses it. Also pinned the inverse: `:436` (row covered by its own INSERT) and
   `:432` (defensive, unreachable) must **not** be recorded — an entry there would show a false
   "your edit was lost" banner. New cases: TASK-001 gains the `:453` no-warning drop, the `:436`
   false-positive guard, and an `R (A19-skip, live path)` regression for `:497-502` (postgres
   no-PK + empty `ctidByRowId` — exactly what A3 produces today, so it is the path users hit);
   §4 gains all three plus the `:500` row the finding asked for.
2. **TASK-002 acceptance over-reached (IMPORTANT) — confirmed against source, rewritten.**
   `:1855` (`blank[col.field] = ""`) and `:2199` (`r[s.field]`) are **object-key** uses whose keys
   come from `rowsToObjects` at `:397`; moving them to `headerName` would collapse duplicate-named
   columns onto one value and break Ctrl+C and Add Row the moment TASK-003 lands. The round-1
   "audit `:1855`/`:2199`" instruction is deleted and replaced by three lines: `hiddenColumns`
   (`:2111-2113`) is the **only** site that moves to `headerName` (it is the only spec-derived
   value crossing into the serializers, which match raw `result.columns`); the new A16 copy filter
   filters on the boolean `spec.hidden` and keeps indexing by `field`; and `:1855`/`:2199` **must
   stay** on `field` — "if you touch either line, you have made the bug worse". Added a guard test
   (duplicate names with *distinct* values ⇒ both values copied in column order) that fails if
   someone converts them anyway, plus the matching §4 row and a Discussion note framing the rule
   as *object key vs. database name* rather than a site list.
3. **Case counts (MINOR) — reconciled by counting the tables.** TASK-001: 16 → **19** (three cases
   added by finding 1; prose now says 19). TASK-002: 14 → **15** (guard case from finding 2).
   TASK-012: prose corrected 12 → **11** (no case was missing; the count was wrong).
4. **`keepIndices`-by-name (ADVISORY) — recorded, not fixed,** as instructed: one row in §2
   out-of-scope and one clause in INDEX's cycle-U queue, noting it predates cycle T, needs an
   index-based selection contract through the serializers, and does not change the `headerName`
   decision — `headerName` makes the filter match at all, where `field` would match nothing.
