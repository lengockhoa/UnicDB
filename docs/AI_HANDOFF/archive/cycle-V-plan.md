# PLAN — Cycle V

## §1 Intent

Three queued items from cycle U's `INDEX.md` "Next cycles" list, run together:

1. **SQL syntax coloring.** The user's complaint: SQL text inside UnicDB surfaces is not
   colorized the way DataGrip colorizes it. Today the extension contributes **zero**
   `languages` / `grammars` entries in `package.json` (verified: `contributes` keys are
   `commands, keybindings, menus, views, viewsContainers, viewsWelcome, configuration`),
   so `.sql` files rely purely on VS Code's built-in `sql` TextMate grammar — which does
   not know the connected schema, does not distinguish table names from columns, and does
   not colorize SQL echoed inside UnicDB's own webviews (the Messages tab `pre.UnicDB-msg-sql`
   at `webview/main.ts:2758-2761` renders `r.sql` as flat text; the AI chat bubble's
   fenced code block at `webview/aiChatPanelMain.ts:139` emits
   `<code class="UnicDB-md-code-lang-sql">` with no token markup).
2. **Server-side column filter + paging.** Today's per-column set filter
   (`SetFilterComponent`, `webview/main.ts:1104`) filters only rows already loaded in the
   grid, and `colFilterActive` (`webview/main.ts:220`) *blocks* `loadMore` entirely while
   a filter is active (`dispatchLoadMore`, `webview/main.ts:1936-1941`). So a filter on a
   1M-row table silently searches the first 500 rows and the user cannot page further.
3. **MSSQL server-side sort.** `getTableSortQuery` exists only in
   `src/adapters/postgres.ts:167` and has **no production call site** (verified: only
   its own doc-comment and `postgres.sortQuery.test.ts` reference it). T-SQL cannot reuse
   it: `OFFSET/FETCH` requires an `ORDER BY`, and identifier quoting is `[...]`, not `"..."`.

**Success definition**

- SQL rendered anywhere in UnicDB (editor `.sql` documents, Messages-tab statement text,
  AI-chat fenced `sql` blocks) carries per-token coloring, and connected-schema table /
  column names are colorized distinctly from plain identifiers.
- A per-column filter on a browsed table produces a **server-side** `WHERE`: the host
  re-runs the statement with the filter pushed down, so the filtered result is drawn from
  the whole table, not the loaded window.
- "Load more" continues to work while a server-side filter is active, via explicit
  `OFFSET`/`LIMIT` (Postgres/MySQL) or `OFFSET … FETCH NEXT` (MSSQL) paging instead of
  the cursor-only path.
- MSSQL gains a server-side sort at parity with Postgres, and it is **live code, not just
  an API**: `getTableSortQuery` is exported from `src/adapters/mssql.ts` with the same
  4-arg signature as the Postgres one; `composeSortQuery(dialect, …)` in
  `src/ui/queryComposer.ts` dispatches by dialect; and `handleRequery` calls it, so an
  ORDER BY typed into the existing requery bar is dialect-quoted (`[name]` on MSSQL,
  `` `name` `` on MySQL, `"name"` on PG) instead of spliced in raw. This also retires the
  orphan status of the Postgres helper, which has had zero call sites since cycle U.
  **Explicitly *not* in this cycle:** wiring the AG Grid column-header click to emit a
  sort requery. No dialect has that wiring today and none gains it here — clicking a
  header still sorts client-side. This cycle closes the *dialect* gap and gives the helpers
  one real call path; the header-click lane is queued in `INDEX.md` "Next cycles" and
  recorded in §2 Out of scope, with the wave-collision reason in §3.
- Full suite stays green: baseline is **1327 passed / 2 skipped / 0 failed**.

## §2 Scope

**In scope (this cycle, 6 tasks)**

| Task | Area |
|------|------|
| TASK-001 | TextMate injection grammar + `contributes.grammars`/`languages` for `.sql` |
| TASK-002 | `DocumentSemanticTokensProvider` for SQL, fed by the existing `SchemaCache` |
| TASK-003 | Webview SQL tokenizer + CSS so Messages-tab / AI-chat SQL is colorized |
| TASK-004 | Pure dialect SQL builders: `buildFilterWhere` + `buildPagedQuery` (3 dialects) |
| TASK-005 | Host wiring: extended `requery` message → filter + page composition |
| TASK-006 | MSSQL `getTableSortQuery` (T-SQL dialect) + shared sort-dialect dispatch |

**Out of scope (this cycle)**

- Webview UI change to the SetFilterComponent panel itself (checkbox list, search box).
  TASK-005 reuses the *existing* `getModel()` payload shape `{ values: string[] }`; no
  panel redesign. A "distinct values from server" fetch for the checkbox list is
  explicitly deferred — the panel keeps counting loaded rows, as documented at
  `resultsGridModel.ts:1126-1127`.
- Infinite-row-model / server-side-row-model migration in AG Grid. Paging stays on the
  client row model with explicit Load More.
- Colorizing SQL inside the connection form, new-table designer, or schema tree.
- Non-`sql` languageIds (the `shellscript` CodeLens lane at `src/extension.ts:126` is
  untouched).
- **Column-header-click sort wiring, for every dialect.** TASK-006 ships the MSSQL
  `getTableSortQuery` builder and the `composeSortQuery` dispatch; nothing in this cycle
  makes an AG Grid header click emit a sort requery. Postgres is in the same state at HEAD
  (its builder has had no call site since cycle U), so no dialect regresses. Deferred
  because the click handler lives in `webview/main.ts`, which TASK-005 already owns in
  wave 2 — a second wave-2 editor of that file would be exactly the same-wave collision
  this plan forbids. Queued in `INDEX.md` "Next cycles".
- **`(Blanks)` matching empty strings.** TASK-004 maps the `(Blanks)` sentinel to
  `col IS NULL` only. AG Grid's client-side set filter groups `null`, `undefined` and `""`
  under one entry, so a server-side `(Blanks)` selection can return *fewer* rows than the
  client-side filter did on a column that holds empty strings. Deferred because the
  correct predicate is dialect-aware (`col IS NULL OR col = ''`, plus a separate decision
  about whitespace-only values and about MSSQL `CHAR` padding) and deserves its own test
  matrix. TASK-004's Discussion records the sentinel's exact semantics so the executor
  does not silently "improve" it. Queued in `INDEX.md` "Next cycles".
- **Server-fetched distinct values for the set-filter dropdown**, and **keyset paging**
  (this cycle uses `OFFSET`/`LIMIT`). Both queued in `INDEX.md` "Next cycles".

**Same-wave file-collision constraint**

No two tasks in the same wave may write the same file. Enforced assignment:

Waves: **wave 1** = TASK-001, 002, 003, 004 (all `Dependencies: none`); **wave 2** =
TASK-005, 006 (both depend on TASK-004 only).

| File | Wave 1 owner | Wave 2 owner |
|------|--------------|--------------|
| `package.json` | TASK-001 | — |
| `syntaxes/UnicDB-sql-injection.tmLanguage.json` (new) | TASK-001 | — |
| `src/__tests__/sqlGrammar.test.ts` (new) | TASK-001 | — |
| `src/ui/sqlSemanticTokens.ts` (new) | TASK-002 | — |
| `src/extension.ts` | TASK-002 | — |
| `src/ui/__tests__/sqlSemanticTokens.test.ts` (new) | TASK-002 | — |
| `webview/sqlHighlight.ts` (new) | TASK-003 | — |
| `webview/aiChatPanelMain.ts` | TASK-003 | — |
| `webview/styles.css` | TASK-003 | — |
| `src/ui/__tests__/sqlHighlight.test.ts` (new) | TASK-003 | — |
| `src/ui/__tests__/webviewSqlHighlight.test.ts` (new) | TASK-003 | — |
| `webview/main.ts` | TASK-003 (≈4-line swap at `:2758-2761`) | TASK-005 |
| `src/ui/queryComposer.ts` (new) | TASK-004 (creates) | TASK-006 (mssql arm only) |
| `src/ui/__tests__/queryComposer.test.ts` (new) | TASK-004 (creates) | TASK-006 (appends) |
| `src/ui/messages.ts` | — | TASK-005 |
| `src/ui/resultsPanel.ts` | — | TASK-005 |
| `src/ui/__tests__/resultsPanelServerFilter.test.ts` (new) | — | TASK-005 |
| `src/ui/__tests__/webviewServerFilter.test.ts` (new) | — | TASK-005 |
| `src/adapters/mssql.ts` | — | TASK-006 |
| `src/adapters/postgres.ts` (doc-comment only) | — | TASK-006 |
| `src/adapters/__tests__/mssql.sortQuery.test.ts` (new) | — | TASK-006 |

Every column above is collision-free: no file has two owners **in the same wave**. The
three cross-wave files are safe because a wave boundary serializes them:

- `webview/main.ts` — TASK-003 (wave 1, Messages-tab `pre.UnicDB-msg-sql` colorization) then
  TASK-005 (wave 2, filter/paging wiring). TASK-005 must **re-read** the file rather than
  work from a cached copy or a pre-computed line number.
- `src/ui/queryComposer.ts` and its test — TASK-004 creates both in wave 1; TASK-006
  replaces only the `mssql` arm of `composeSortQuery` and appends cases in wave 2.

`webview/styles.css` belongs to TASK-003 alone; TASK-005 must reuse existing CSS classes
and add none. `esbuild.js` is **not** modified by any task: TASK-003 imports
`sqlHighlight.ts` from the two existing entry points rather than adding a bundle.
`CHANGELOG.md` is owned by cycle-close, not by any task (see §6).

## §3 Approach

### Coloring (TASK-001 / 002 / 003)

Three complementary layers, because no single layer covers all three surfaces:

- **Layer 1 — TextMate injection grammar (TASK-001).** A grammar with
  `injectionSelector: "L:source.sql"` layered *on top of* VS Code's built-in `sql`
  grammar rather than replacing it. Replacing `source.sql` would fight the built-in
  grammar and regress every user who already relies on it; injection only adds scopes
  (dialect keywords VS Code's grammar misses: `ILIKE`, `RETURNING`, `MATERIALIZED`,
  `OFFSET … FETCH`, `TOP`, `[bracket]`/`` `backtick` `` quoted identifiers). This is pure
  declarative JSON + a `package.json` contribution: no runtime cost, works with every
  color theme, and needs no DB connection.
  - *Alternative rejected:* shipping a full replacement `sql` grammar. Higher regression
    surface, and it would have to be maintained against three dialects forever.
- **Layer 2 — semantic tokens (TASK-002).** The schema-aware half. A
  `DocumentSemanticTokensProvider` registered for `{ scheme: "file", language: "sql" }`
  reads the already-shipped `SchemaCache` (`src/ui/schemaCache.ts`, 60 s TTL,
  `getSchemas` / `getTables` / `getColumns`) and emits `class` for names matching a live
  table, `property` for names matching a live column, `namespace` for schemas. This is
  what makes it feel DataGrip-like: a bare identifier is colored differently once it is
  *known* to be a table. Registration mirrors the existing defensive pattern at
  `src/extension.ts:148` (`typeof vscode.languages.registerCompletionItemProvider ===
  "function"` guard) because `extension.test.ts`'s partial `vscode` mock only stubs
  `registerCodeLensProvider` (`src/extension.test.ts:159-164`).
  - *Alternative rejected:* doing schema-awareness inside the TextMate grammar. TextMate
    is regex-only and cannot consult a live connection.
  - *Decision logged:* the provider must **never** block or throw when there is no
    connection — same contract as `SqlCompletionProvider` (`return []` / empty token
    set), because a cold provider that throws would break coloring for offline `.sql`
    files entirely.
- **Layer 3 — webview tokenizer (TASK-003).** Neither layer above reaches a webview: the
  Messages tab and AI-chat bubbles are plain DOM built by our own code. A tiny pure
  tokenizer (`webview/sqlHighlight.ts`) splits SQL into
  `keyword|string|number|comment|ident|punct` spans and returns a `DocumentFragment` built
  with `document.createElement` + `textContent` only. Emitting an HTML string would
  reintroduce an injection sink in `aiChatPanelMain.ts`, whose security contract
  (`aiChatPanelWebview.test.ts` header) is that hostile content never reaches the page via
  `innerHTML`. Colors come from `--vscode-*` theme variables in `webview/styles.css`, so
  the webview matches the user's editor theme.
  - *Decision logged:* the tokenizer is duplicated logic vs. the TextMate grammar. That is
    accepted — the webview has no TextMate engine, and pulling in `vscode-textmate` +
    `vscode-oniguruma` (neither is currently a dependency; verified `node_modules` has
    only `@vscode/vsce`) would add a WASM payload to a `.vsix` for cosmetic gain.

### Server-side filter + paging (TASK-004 / 005)

`composeRequery` (`src/ui/resultsGridModel.ts:1090`) already wraps a statement as
`SELECT * FROM (<sql>) UnicDB_sub [WHERE …] [ORDER BY …]`. TASK-004 extends that idea into a
dialect-aware module rather than editing `resultsGridModel.ts`, so the webview bundle does
not grow and so `resultsGridModel.ts` (already 1214 lines) stops accreting host concerns:

- `buildFilterWhere(filters, dialect)` turns the SetFilterComponent model
  (`{ [field]: { values: string[] } }`) into `col IN ('a','b')`, with `(Blanks)` mapping
  to `col IS NULL` — the sentinel is already exported as `SET_FILTER_BLANKS_DISPLAY`
  (`resultsGridModel.ts:1138`). Values go through the existing portable `sqlLiteral`
  (`resultsGridModel.ts:378`, single-quote doubling, no backslash escaping); identifiers
  through the existing `quoteIdent(name, dialect)` (`src/core/saveStatements.ts:136`).
  Reusing both is deliberate: they are the project's audited injection boundary and
  already have dialect-correct escaping for `"`/`` ` ``/`]`.
- `buildPagedQuery(sql, where, orderBy, offset, limit, dialect)` appends
  `LIMIT n OFFSET m` for postgres/mysql and `OFFSET m ROWS FETCH NEXT n ROWS ONLY` for
  mssql. T-SQL requires an `ORDER BY` before `OFFSET`, so the mssql branch injects
  `ORDER BY (SELECT NULL)` when the caller supplied none — the standard stable-less
  ordering idiom, chosen over `ORDER BY 1` because column 1 may be non-sortable.
- TASK-005 extends `RequeryMessage` with **optional** `filters?`, `offset?`, `limit?`,
  `append?`. Optional, not required, so an older webview bundle (or the post-save
  auto-requery at `webview/main.ts:2866-2868`, and the Re-Run bar at `main.ts:2469-2473`)
  keeps working unchanged — this is the one field-compat rule that keeps the three
  existing requery call sites from all needing edits.
- The host keeps `handleRequery`'s existing safety work: close the previous batched cursor
  first (`resultsPanel.ts:877`, Postgres `pool.max=1`), post `status:"running"` before the
  run (`resultsPanel.ts:890-906`) so the webview's reset branch fires, route through
  `this.transaction` when a manual transaction is open (`resultsPanel.ts:912`), and
  `runner.adopt` afterwards (`resultsPanel.ts:942`).
- On the webview side, `onFilterChanged` (`webview/main.ts:1705`) gains a debounce that
  posts a `requery` carrying `gridApi.getFilterModel()`, and `dispatchLoadMore` stops
  hard-returning on `colFilterActive`: when a server filter is active it posts a
  `requery` with `offset = loadedRows` and `append: true` instead of a cursor `loadMore`.
  - *Decision logged:* paging is OFFSET-based, not keyset. Keyset is strictly better for
    deep pages but requires a unique sort key the grid does not always have (a view, or a
    table with no PK). OFFSET matches what `LIMIT/OFFSET` gives on all three dialects and
    matches the existing 500-row batch mental model. Noted as a known gap.
  - *Decision logged:* the client-side `doesFilterPass` is **not** removed. With server
    filtering active the predicate is a no-op (every returned row already matches), and
    keeping it means a filter still narrows the view instantly before the round trip.

### MSSQL sort (TASK-006)

Mirror the Postgres contract exactly:
`getTableSortQuery(originalSql, whereFromBar, column, direction) => string`, wrapping in
`SELECT * FROM (<inner>) UnicDB_sort [WHERE …] ORDER BY [col] ASC|DESC`, with `]`-doubling
and an ASC/DESC whitelist.

Both adapters end up exporting the same-named symbol, so something must dispatch by
dialect. *Alternative rejected:* putting the dispatch inside an adapter — that creates a
postgres→mssql import edge and makes each adapter depend on its siblings. Instead
`composeSortQuery(dialect, …)` lives in `src/ui/queryComposer.ts`, which imports nothing
from `src/adapters/*` and is the natural dialect-dispatch home. TASK-004 creates it in
wave 1 with the mssql arm written inline (four lines: `quoteIdent(col,"mssql")` + an
ASC/DESC whitelist + the subquery wrap), which is what keeps TASK-004 dependency-free;
TASK-006 then replaces that arm's body with a delegation to its new adapter export.
TASK-006 therefore depends on TASK-004.

*Decision logged — the sort helpers must not ship as dead code.* At HEAD the Postgres
`getTableSortQuery` has **zero** call sites; adding an mssql twin would double the orphans.
The call path this cycle delivers is the **existing requery-bar ORDER BY input**, whose
value already rides on every `requery` message (`webview/main.ts:2215`, `:2472`, `:2867`)
and is today spliced into the SQL raw. TASK-005's `handleRequery` routes a *single bare
identifier* (optionally `ASC`/`DESC`) through `composeSortQuery` so it gets dialect
quoting, and passes anything else — `a, b DESC`, `lower(name)`, `1`, empty — through to
`composeRequery` byte-identically. Deliberately no general ORDER BY parser: the bar is
free text, and a half-parser that quoted `lower(name)` as an identifier would turn working
SQL into a syntax error. TASK-005 case 15 is the liveness test (mssql → `ORDER BY [name]
DESC` at `runner.runSql`); case 16 is the passthrough guard.

*Decision logged:* the AG Grid **column-header click** is still not wired to a sort
requery, for any dialect — see §2 Out of scope. The click handler lives in
`webview/main.ts`, which TASK-005 already owns in wave 2, so a second wave-2 editor would
be the same-file collision this plan forbids. TASK-006 stays confined to `src/adapters/*`
plus the one composer arm, so the two tasks never touch the same file.

## §4 Test Plan

Baseline: `1327 passed / 2 skipped / 0 failed`. Every task must leave that green.

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | `grammar contributes an injection for source.sql` | `package.json` `contributes.grammars[0].injectTo` contains `"source.sql"`; the referenced `syntaxes/*.json` path exists on disk |
| happy | `grammar JSON parses and every pattern has a name+match` | `JSON.parse` succeeds; every entry in `patterns` has both `name` and (`match` or `begin`) |
| edge (packaging) | `.vscodeignore does not exclude syntaxes/` | packaged file list still contains `syntaxes/UnicDB-sql-injection.tmLanguage.json` |
| edge (regex safety) | `no grammar pattern matches the empty string` | for every `match`, `new RegExp(m).exec("")` is `null` (an empty-matching rule hangs the TextMate engine) |
| happy | `semantic tokens mark a known table as class` | `SELECT * FROM users` with `users` in cache → one token at the `users` range with type `class` |
| happy | `semantic tokens mark a known column as property` | `SELECT email FROM users` → token for `email` typed `property` |
| edge (no connection) | `provider returns empty tokens when no connection` | `provideDocumentSemanticTokens` resolves to a `SemanticTokens` with `data.length === 0`, and does not throw |
| edge (unknown identifier) | `unknown identifier gets no token` | `SELECT * FROM not_a_table` → zero tokens emitted, so TextMate coloring shows through |
| edge (cache failure) | `adapter throwing does not reject the provider` | cache provider rejects → resolves to empty tokens, no unhandled rejection |
| edge (async readiness) | `cold cache emits nothing, then refresh() fires onDidChangeSemanticTokens` | first provide (adapter still pending) → `data.length === 0`; after the adapter settles and `refresh()` runs, the listener fired exactly once and a re-provide returns the `class` token |
| edge (event lifecycle) | `refresh() is safe with zero listeners and does not coalesce` | 3 `refresh()` calls with no listener → no throw; with one listener → 3 firings |
| happy | `tokenizer splits keywords, strings, numbers, comments` | `SELECT 1 FROM t -- c` → span classes in order `keyword,number,keyword,ident,comment` |
| edge (injection) | `hostile SQL is never rendered as markup` | input `SELECT '<img src=x onerror=alert(1)>'` → fragment contains zero `HTMLImageElement`; the literal text is present via `textContent` |
| edge (unterminated literal) | `unterminated string does not loop` | `SELECT 'abc` returns in < 50 ms with the tail as one `string` span |
| happy | `buildFilterWhere emits IN list for one column` | `{name:{values:["a","b"]}}`, postgres → `"name" IN ('a', 'b')` |
| edge (blanks) | `(Blanks) maps to IS NULL and OR-joins` | `{name:{values:["(Blanks)","a"]}}` → `("name" IS NULL OR "name" IN ('a'))` |
| edge (quote injection) | `value with a single quote is doubled` | value `O'Brien` → `'O''Brien'`, never an unescaped `'` |
| edge (identifier injection) | `column name with a delimiter is quoted per dialect` | mssql column `a]b` → `[a]]b]`; mysql `` a`b `` → `` `a``b` `` |
| edge (empty model) | `empty filter model returns empty string` | `{}` and `{name:{values:[]}}` → `""` (caller omits the WHERE) |
| edge (value typing) | `numeric filter values stay unquoted on all 3 dialects` | typed `[42,7]` → `IN (42, 7)` for postgres/mysql/mssql — no `'` around the digits (quoting them costs the index on MySQL and hard-fails an MSSQL `int` column) |
| edge (temporal typing) | `an ISO timestamp is normalized per dialect` | postgres keeps `'2024-03-01T10:30:00.000Z'`; mysql/mssql get `'2024-03-01 10:30:00.000'` (no `T`, no `Z`) |
| edge (no sniffing) | `a numeric-looking string with no typed[] stays quoted` | `values:["007"]` without `typed` → `IN ('007')`, so a zero-padded varchar code still matches |
| edge (malformed payload) | `typed[] of mismatched length is ignored` | `values:["1","2"], typed:[1]` → falls back to `IN ('1', '2')`, never `IN (1, undefined)` |
| happy | `webview sends typed values alongside display values` | with rows loaded, the posted `requery.filters[col].typed` has the same length as `.values` and holds the raw cell values |
| happy | `buildPagedQuery appends LIMIT/OFFSET for postgres` | ends with `LIMIT 500 OFFSET 1000` |
| edge (dialect) | `mssql uses OFFSET/FETCH and forces an ORDER BY` | contains `ORDER BY (SELECT NULL) OFFSET 1000 ROWS FETCH NEXT 500 ROWS ONLY` |
| edge (boundary) | `offset 0 with limit still pages` | `offset:0` → `OFFSET 0` present, not omitted (omitting it breaks mssql FETCH) |
| happy | `requery with filters composes a server-side WHERE` | host receives `filters` → the SQL passed to `runner.runSql` contains `IN (` |
| happy | `append:true concatenates rows instead of replacing` | 500 existing + 500 new → posted state has `rows.length === 1000` |
| edge (concurrency) | `a second requery while one is in flight does not interleave` | the older run's result never overwrites the newer one's `lastResults` entry |
| edge (cursor) | `previous batched cursor is closed before a filtered requery` | `batched.close()` called exactly once before `runSql` |
| edge (back-compat) | `requery without filters/offset behaves exactly as today` | composed SQL is byte-identical to `composeRequery(sql, where, orderBy)` |
| happy | `mssql getTableSortQuery wraps and orders` | `SELECT * FROM (SELECT 1) UnicDB_sort ORDER BY [name] ASC` |
| edge (injection) | `column name with ] is doubled, stays one identifier` | `name]; DROP TABLE users--` → `[name]]; DROP TABLE users--]` |
| edge (direction) | `direction is whitelisted` | direction `"ASC; DROP"` cast → falls back to `ASC` |
| edge (dispatch) | `composeSortQuery routes by dialect` | postgres → `"name"`, mysql → `` `name` ``, mssql → `[name]` |
| happy (liveness) | `a requery-bar ORDER BY reaches the adapter helper` | driver mssql + `orderBy:"name DESC"` → SQL at `runner.runSql` contains `ORDER BY [name] DESC`; driver postgres → `ORDER BY "name" DESC`. Fails if the helpers are dead code |
| edge (passthrough) | `a complex ORDER BY is not mangled` | `"a, b DESC"` / `"lower(name)"` / `"1"` → composed SQL byte-identical to `composeRequery(sql, where, orderBy)` |
| edge (no duplication) | `the composer's mssql arm is a delegation, not a copy` | `queryComposer.ts` source contains no `UnicDB_sort` / bracket-quoting string building, yet `composeSortQuery("mssql", …)` returns full T-SQL |
| regression | `full suite stays at 1327 passed / 2 skipped` | `npm test` reports no fewer passing tests than baseline |

## §5 Verification

Run from the repo root. The project has **no lint script** — `package.json` `scripts` are
exactly `compile, watch, test, test:integration, typecheck, package, vscode:prepublish`.
`typecheck` is therefore the mandatory static gate and must run for every task.

```bash
npm run typecheck
npm run compile
npx vitest run <the task's test files>
npm test
```

Notes for executors:

- `npm run typecheck` runs `tsc --noEmit` against `tsconfig.json`, which **excludes
  `webview/`**. Tasks touching `webview/**` must additionally run
  `npx tsc -p tsconfig.webview.json --noEmit`.

  That config has **pre-existing** errors in six files. The bulk are `TS2393`/`TS2451`
  redeclarations caused by the webview files sharing one global scope, but the set is
  mixed — measured at HEAD `08c8de3` on 2026-08-25 the codes are `TS2393`×21,
  `TS2451`×14, `TS2339`×7, `TS2304`×3, `TS2678`×3, `TS2300`×2, `TS2353`×2, `TS2551`×2,
  `TS2739`×2, `TS6059`×2, `TS2322`×1, `TS2345`×1. That is **61 error lines** (77 lines of
  raw output once multi-line messages are counted). Per file:

  | File | Baseline errors |
  |------|-----------------|
  | `webview/aiSettingsFormMain.ts` | 21 |
  | `webview/main.ts` | 14 |
  | `webview/connectionFormMain.ts` | 10 |
  | `webview/aiChatPanelMain.ts` | 10 |
  | `webview/schemaFormMain.ts` | 5 |
  | `webview/newTableFormMain.ts` | 1 |
  | **total** | **61** |

  A "no new *file*" rule is inert for this cycle, because the two files TASK-003 and
  TASK-005 edit (`webview/main.ts`, `webview/aiChatPanelMain.ts`) are already in the
  table. Use a **snapshot diff on the per-file counts** instead. Before editing:

  ```bash
  npx tsc -p tsconfig.webview.json --noEmit 2>&1 \
    | grep -oE '^[a-zA-Z0-9_/.-]+\.ts' | sort | uniq -c | sort -rn > /tmp/UnicDB-webview-tsc-before.txt
  ```

  After editing, run the same pipeline into `/tmp/UnicDB-webview-tsc-after.txt` and assert
  the two are identical:

  ```bash
  diff /tmp/UnicDB-webview-tsc-before.txt /tmp/UnicDB-webview-tsc-after.txt && echo "WEBVIEW TSC BASELINE UNCHANGED"
  ```

  The gate is **`diff` exits 0**. Any count that rises — including on a file already in
  the table — is a new error introduced by the task and must be fixed, not waived. Do not
  "fix" the 61 baseline errors; reducing a count also fails the diff, so if a task
  legitimately removes one, say so in its Executor Report and paste both files.
  Executors must paste the `diff` output (or the "UNCHANGED" line) into their report.
- `npm run compile` must run **before** any test that loads `dist/*.js` (the bundle tests:
  `webviewSetFilter`, `webviewBundle`, `aiChatPanelBundle`, …). Those tests skip
  themselves when `dist/` is missing, which would silently hide a failure.
- `npm test` is `vitest run` and excludes `**/*.integration.test.ts`; no DB is required.

## §6 Acceptance

- [ ] `node -e "JSON.parse(require('fs').readFileSync('syntaxes/UnicDB-sql-injection.tmLanguage.json','utf8'))"` exits 0.
- [ ] `node -e "const c=require('./package.json').contributes; if(!c.grammars) process.exit(1)"` exits 0.
- [ ] `src/ui/sqlSemanticTokens.ts` exists and `src/extension.ts` registers it behind a
      `typeof vscode.languages.registerDocumentSemanticTokensProvider === "function"` guard.
- [ ] `SqlSemanticTokensProvider` exposes `onDidChangeSemanticTokens` + `refresh()`, and
      `src/extension.ts` calls `refresh()` from both cache-invalidation sites (`:141`
      `onDidChangeActive`, `:233-237` `UnicDB.refreshSchema`) — without this the first open of
      a `.sql` file paints against a cold, empty `SchemaCache` and stays uncolored.
- [ ] `webview/sqlHighlight.ts` exists, exports `highlightSql(sql: string): DocumentFragment`,
      and contains no `innerHTML`. Gate command (exits 0 on success — `grep -c` on zero
      matches exits 1, so it cannot be used bare):
      `! grep -q innerHTML webview/sqlHighlight.ts`
- [ ] `src/ui/queryComposer.ts` exports `buildFilterWhere`, `buildPagedQuery`, `composeSortQuery`.
- [ ] `RequeryMessage` in `src/ui/messages.ts` has `filters?`, `offset?`, `limit?`, `append?`
      all optional (no existing call site needs edits to compile).
- [ ] `ColumnFilterModel` entries carry `typed?: unknown[]`, and a numeric filter selection
      composes to `IN (42, 7)` — not `IN ('42', '7')` — on all three dialects.
- [ ] `getTableSortQuery` is exported from `src/adapters/mssql.ts` with the same 4-arg
      signature as the Postgres one, **and is reachable from the live requery path**: an
      mssql requery with `orderBy:"name DESC"` produces SQL containing `ORDER BY [name] DESC`.
      No sort helper ships as an orphan export this cycle.
- [ ] `npm run typecheck` → clean.
- [ ] Webview typecheck snapshot diff is empty — see §5. Command:
      `diff /tmp/UnicDB-webview-tsc-before.txt /tmp/UnicDB-webview-tsc-after.txt` exits 0
      (61 pre-existing errors across six files, unchanged).
- [ ] `npm run compile` → **7** bundles written, no esbuild error (`esbuild.js` defines
      `dist/extension.js`, `webview.js`, `connectionForm.js`, `newTableForm.js`,
      `aiSettingsForm.js`, `aiChatPanel.js`, `schemaForm.js`).
- [ ] `npm test` → ≥ 1327 passed, 0 failed.
- [ ] Every task's Test Cases table is GREEN, each verified by a fresh run pasted into its
      Executor Report.
- [ ] `CHANGELOG.md` gains a Cycle V section (user-facing: coloring, server filter, MSSQL
      sort). **Owned by cycle-close, not by any TASK** — deliberately not split into a task
      because a single writer avoids six conflicting edits to one file; it is the release
      step's job after all six tasks are approved.

Criterion → task trace: syntaxes/grammar → TASK-001; semantic tokens + extension
registration + `onDidChangeSemanticTokens`/`refresh()` → TASK-002; `webview/sqlHighlight.ts`
→ TASK-003; `queryComposer.ts` exports + `typed[]` value handling → TASK-004;
`RequeryMessage` optional fields + `typed[]` population + sort call path (liveness) →
TASK-005; mssql `getTableSortQuery` + delegation → TASK-006; typecheck / webview-snapshot /
compile / test gates → all six.

## §7 Global Constraints

Every `TASK-xxx.md` inherits this section by reference; it is not repeated per task.

- Package manager is **npm**. Never `yarn`, never `pnpm`.
- Node ≥ 18 (`esbuild target: node18`); VS Code engine floor `^1.75.0` — do not use any
  `vscode` API newer than 1.75 without a `typeof` capability guard.
- **No new runtime dependencies.** `dependencies` stays `@types/pg, ag-grid-community,
  mysql2, pg, tedious`. No `vscode-textmate`, no `vscode-oniguruma`, no highlight library.
- TypeScript `strict: true` in both tsconfigs. No `any` in new code; use `unknown` + narrowing.
- Webview code must never use `innerHTML` for content derived from SQL, DB values, or agent
  output. Build DOM with `createElement` + `textContent`.
- All SQL identifier interpolation goes through `quoteIdent(name, dialect)`
  (`src/core/saveStatements.ts:136`); all value interpolation through `sqlLiteral(v)`
  (`src/ui/resultsGridModel.ts:378`). Do not hand-roll escaping.
- Postgres runs `pg.Pool` with `max: 1` and server-side cursors: any new query path must
  close an open batched cursor before issuing another statement, or it deadlocks.
- Comments in new files follow the existing house style: a file header explaining *why*,
  and `TASK-xxx` markers on non-obvious decisions.
- Do not modify `esbuild.js`, `vitest.config.ts`, `.vscodeignore` unless the task's Target
  Files list says so.
- TDD: write the failing test first (RED), then implement (GREEN). Never mark a task done
  without a fresh pasted PASS.

---

## Planner Report
PLANNER_MODEL: bao-opus

---

## Planner Self-Audit

Checklist: 12/12 pass

Coverage
1. Every §6 criterion traces to a task — trace line added under §6. PASS.
2. No orphan tasks: all six trace to §1's three problems (001-003 coloring, 004-005 filter/paging, 004+006 MSSQL sort). PASS.
3. §1 success definition is delivered, minus the header-click sort wiring, which §1 does not claim (see Known gaps). PASS.
4. Unhappy paths planned: no-connection / adapter-rejection (TASK-002 #6-7), unterminated literal (TASK-003 #5), empty filter model and empty `IN ()` (TASK-004 #4,#7), failed append leaves rows intact (TASK-005 #8), missing-API registration guard (TASK-002 #8). PASS.

Correctness
5. Every Target File verified on disk; the four new files (`syntaxes/UnicDB-sql-injection.tmLanguage.json`, `src/ui/queryComposer.ts`, `src/ui/sqlSemanticTokens.ts`, `webview/sqlHighlight.ts`) are marked `(new)` and their parent dirs exist (`syntaxes/` is created by TASK-001). PASS.
6. Every verification command is a real script: `typecheck`, `compile`, `test` are defined in `package.json`; `npx vitest run <path>` and `npx tsc -p tsconfig.webview.json --noEmit` both verified to run. No lint script exists — stated in §5 rather than omitted. PASS.
7. No same-wave file sharing. Wave 1 owners are disjoint (001: `package.json`+`syntaxes/`; 002: `src/extension.ts`+`src/ui/sqlSemanticTokens.ts`; 003: `webview/*`; 004: `src/ui/queryComposer.ts`). Wave 2: 005 owns `src/ui/messages.ts`/`resultsPanel.ts`/`webview/main.ts`, 006 owns `src/adapters/*` + the `queryComposer.ts` mssql arm — disjoint. `webview/main.ts` is 003 (wave 1) then 005 (wave 2); `queryComposer.ts` is 004 (wave 1) then 006 (wave 2). Both serialized by wave, not concurrent. PASS.
8. No task depends on a symbol no earlier task creates: TASK-005/006 consume only TASK-004 exports plus HEAD symbols. PASS.

Test quality
9. Every task has ≥1 happy + ≥2 edge cases of different kinds (kind labels listed under each table). PASS.
10. Every `Expected` states a concrete value or a concrete assertion — no "works correctly". PASS.
11. Regression tripwires named per task rather than generic: TASK-005 re-runs `resultsPanelRequery.test.ts` + `webviewSetFilter.test.ts`; TASK-006 re-runs `postgres.sortQuery.test.ts` unmodified; TASK-002 re-runs `src/extension.test.ts`. TASK-005 #4 is the true regression case (byte-identical composition for the legacy 3-field message). PASS.
12. No case passes against an empty implementation: each asserts on a produced string, token kind, DOM node, or call ordering. PASS.

Fixed during audit:
- §6 gained an explicit criterion → task trace line.
- §6's `CHANGELOG.md` criterion was unowned; it is now explicitly assigned to cycle-close rather than to a task (a single writer avoids six conflicting edits to one file).
- TASK-003's Target Files omitted `src/ui/__tests__/webviewSqlHighlight.test.ts`, which its Test Files section already required; added.
- §2's collision table was annotated to record that `webview/main.ts` is touched by TASK-003 (wave 1) and TASK-005 (wave 2) — different waves, and TASK-005 must re-read the file.

Re-audit after Round 1 review (all 12 re-checked, still 12/12):
- Item 3 (does the plan deliver §1?) had been marked PASS on a §1 that overclaimed MSSQL header-click sort. §1 is now scoped to what actually ships — the adapter API plus a live requery-bar call path — so §1, §3, §6 and Known gaps agree.
- Item 6 (real commands) had accepted a webview-typecheck note that was both factually wrong (one file, not six; 61 mixed error codes, not just `TS2451`/`TS2393`) and defined an inert gate. Replaced with a measured per-file snapshot diff.
- Item 12 (no case passes an empty implementation) now also covers dead-code risk: TASK-006's export is asserted reachable from the live path by TASK-005 case 15, not merely constructible.
- Item 4 (unhappy paths) gained the cold-cache first-paint case (TASK-002 #9) and the malformed/partial `typed[]` payload cases (TASK-004 #19, TASK-005 #14).
- Item 9 (edge-case variety) re-counted after the additions: TASK-002 10 cases, TASK-004 19, TASK-005 17, TASK-006 9.

Known gaps (deliberate, queued in INDEX.md "Next cycles"):
- **Sort header-click wiring.** The AG Grid column-header click still sorts client-side for every dialect. (Round 2: the helpers themselves are no longer orphaned — the requery-bar ORDER BY is now a real call path, TASK-005 cases 15-17.) The click handler lives in `webview/main.ts`, which TASK-005 already owns in wave 2, and a second wave-2 editor would be a same-file collision. Deferred, not forgotten.
- **Requery-bar ORDER BY is dialect-quoted only for a single bare identifier.** Anything more complex (`a, b DESC`, `lower(name)`, ordinals) passes through raw exactly as today. Writing a general ORDER BY parser is out of scope and would risk corrupting valid user SQL; TASK-005 case 16 pins the passthrough.
- **Typed filter values depend on the row still being loaded.** `typed[]` is derived from loaded grid rows; when a selected value's row has been evicted the webview drops `typed` for that column and the predicate falls back to string literals — correct on Postgres, index-losing on MySQL, and still the pre-cycle behavior everywhere. Also, timestamps are normalized as UTC-naive for MySQL/MSSQL, which disagrees with a non-UTC session timezone on a local-time column.
- **`(Blanks)` maps to `col IS NULL` only.** AG Grid groups `null`/`undefined`/`""`; server-side that misses empty strings, so a `(Blanks)` selection can return fewer rows than the client-side filter did.
- **OFFSET/LIMIT, not keyset paging.** Correct at any depth but slow at large offsets, and rows can shift under a concurrent write between pages. Keyset needs a guaranteed-unique sort key that arbitrary user SQL does not provide.
- **Set-filter dropdown values still come from loaded rows.** With server-side filtering, a value present in the table but outside the loaded window cannot be picked from the list.
- **TASK-001's grammar is verified structurally, not visually.** Tests assert the JSON's regex patterns and the `package.json` contribution; nothing in CI renders a token in a real editor. Actual colorization needs a manual F5 Extension Host check at cycle close.

---

## Plan Review Log

### Round 1 — 2026-08-25 · bao-opus
Status: Issues Found

Verified against repo: npm scripts (`compile,watch,test,test:integration,typecheck,package,vscode:prepublish`, no lint) ✓; baseline `1327 passed / 2 skipped / 0 failed` re-run green ✓; `contributes` keys ✓; deps list ✓; `getTableSortQuery` 4-arg signature ✓; `quoteIdent`/`sqlLiteral`/`SET_FILTER_BLANKS_DISPLAY`/`composeRequery` line refs ✓; `.vscodeignore` does not exclude `syntaxes/` ✓; npm-only, no yarn/pnpm ✓; no same-wave file collision ✓; every task has ≥1 happy + ≥2 differently-kinded edge cases ✓.

COMPLETENESS:
  - **[Important] §5 webview-typecheck baseline is factually wrong and the rule it defines masks regressions.** §5 claims baseline noise is "`webview/schemaFormMain.ts` reports TS2451/TS2393". Actual `npx tsc -p tsconfig.webview.json --noEmit` emits 77 lines across **six** files: `aiChatPanelMain.ts`, `aiSettingsFormMain.ts`, `connectionFormMain.ts`, `main.ts`, `newTableFormMain.ts`, `schemaFormMain.ts` — including TS2300/TS2739 and AG Grid `CellStyle` errors in `main.ts`. The stated gate ("only assert no **new file** appears in the output") is therefore inert for exactly the two files this cycle edits: TASK-003 writes `aiChatPanelMain.ts` and TASK-005 writes `webview/main.ts`, both already on the baseline list, so any new error they introduce is invisible. *Fix:* replace both the §5 note and the §6 checkbox with a snapshot rule — capture `npx tsc -p tsconfig.webview.json --noEmit 2>&1 | sort > /tmp/webview-tsc-base.txt` at task start and require `diff` against it to be empty, or at minimum require the **error-line count per edited file** not to increase (currently 77 lines total).
  - **[Important] TASK-002 has no plan for the async/cold `SchemaCache`.** `SchemaCache.getTables`/`getColumns` (`src/ui/schemaCache.ts:75,104`) are `async` with a 60 s TTL. On the first `provideDocumentSemanticTokens` call the cache is cold, so the provider returns zero tokens; §3 and §4 never specify an `onDidChangeSemanticTokens` event to re-fire once the schema resolves, nor a test for it. As written the user opens a `.sql` file, sees no schema coloring, and it only appears after an unrelated edit — the headline feature silently fails. *Fix:* add to §3 Layer 2 that the provider exposes `onDidChangeSemanticTokens` and fires it when the cache fills / connection changes, and add a §4 case: "cold cache → first call empty, tokens appear after the change event fires".

CONSISTENCY:
  - **[Important] §1 success definition contradicts the Self-Audit and the Known gaps.** §1 line 38-39 claims "Clicking a column header on an MSSQL connection issues a server-side `ORDER BY` requery with the same contract Postgres already has." Self-Audit item 3 asserts the opposite — "minus the header-click sort wiring, which §1 does not claim" — and Known gaps confirms both sort helpers "stay call-site-free after this cycle". One of the two is wrong; as planned, the user-visible MSSQL sort does **not** ship. *Fix:* rewrite §1's fourth bullet to what is actually delivered ("a T-SQL `getTableSortQuery` + `composeSortQuery` dispatch, ready for wiring") and correct Self-Audit item 3, or move the wiring into TASK-005 (which already owns `webview/main.ts` in wave 2, so it is not a new collision).
  - **[Minor] §2's "Sole owner" table is wrong for two files.** `src/ui/queryComposer.ts` is listed as sole-owner TASK-004, but §3 (lines 190-194) has TASK-006 adding `composeSortQuery` to that same file; and `webview/main.ts` is absent from the table entirely though two tasks write it. The prose below the table and Self-Audit item 7 both get this right — only the table is stale. *Fix:* add a `webview/main.ts | TASK-003 (w1) → TASK-005 (w2)` row and change the `queryComposer.ts` row to `TASK-004 (w1) → TASK-006 (w2)`; retitle the column "Owner(s) by wave".
  - **[Minor] §6 asserts `npm run compile` writes "6 bundles"; `esbuild.js` defines 7** (`dist/extension.js`, `webview.js`, `connectionForm.js`, `newTableForm.js`, `aiSettingsForm.js`, `aiChatPanel.js`, `schemaForm.js`). An executor checking that criterion literally reports a false failure. *Fix:* change to 7.

CLARITY:
  - **[Important] `buildFilterWhere` is specified against display strings, not typed values, and no test covers a non-text column.** The set-filter model TASK-004 consumes is built at `src/ui/resultsGridModel.ts:1161` as `display.set(key, blank ? SET_FILTER_BLANKS_DISPLAY : String(v))` — every value is already `String()`-coerced. Feeding those through `sqlLiteral` (`resultsGridModel.ts:378`) emits `'123'` / `'2024-01-01'` / `'true'` for int, date, uuid and bool columns. Postgres coerces some of these; MSSQL and MySQL will either fail the comparison or do a silent implicit conversion that changes the result set — i.e. the server-side filter returns different rows than the client-side one it replaces. §4's five `buildFilterWhere` cases are all text-valued, so nothing catches it. *Fix:* state in §3 how typed values survive the round trip (carry the raw value alongside the display string in the filter model, or pass the column type so `buildFilterWhere` can emit an unquoted numeric/`CAST`ed literal), and add a §4 edge case: "integer column filtered on `123` does not emit a quoted `'123'` literal on mssql".
  - **[Minor] §6's `grep -c innerHTML webview/sqlHighlight.ts → 0` is a self-defeating check** — `grep -c` exits 1 on zero matches, so it fails any `&&`-chained or `set -e` acceptance script. *Fix:* use `! grep -q innerHTML webview/sqlHighlight.ts`.

SCOPE:
  - none — 6 tasks across 3 coherent features in 2 waves, out-of-scope list is explicit and the deferrals (AG Grid server-side row model, SetFilterComponent redesign, distinct-values fetch) are the right cuts.

YAGNI:
  - **[Minor] TASK-006 reproduces the exact dead-code condition §1 uses to justify the work.** §1 item 3 criticises Postgres's `getTableSortQuery` for having "**no production call site**"; this cycle ships an MSSQL twin plus a `composeSortQuery` dispatch that are *also* uncalled. Shipping a second unreachable helper is only justified if the wiring lands — see the §1 contradiction above. Not a blocker if §1 is corrected, but the two findings must be resolved together.

NOTES: The plan is unusually well-grounded — line references, symbol names, baseline count and the npm/no-lint constraint all check out against the repo, and the wave/collision discipline is sound. Blocking work is concentrated in four items: the miscalibrated webview typecheck gate, the untyped filter-value round trip, the cold-cache semantic-token refresh, and the §1-vs-audit contradiction over whether MSSQL sort actually ships.

### Round 2 — 2026-08-25 · planner · bao-opus
Status: findings applied — ready for re-review

All 8 Round 1 findings applied to `PLAN.md` and the affected task files. Round 1 entry left
intact above. Reviewer not re-run (orchestrated separately).

| # | Finding | Applied |
|---|---------|---------|
| 1 | §5 webview-typecheck baseline wrong + gate inert | §5 now carries a **measured** per-file baseline (61 error lines across 6 files, mixed codes: `TS2393`×21, `TS2451`×14, `TS2339`×7, `TS2304`/`TS2678`×3, others; 77 raw output lines) and replaces "no new filename" with a snapshot diff: capture per-file counts before and after, gate on `diff` exiting 0. §6 checkbox updated. TASK-003 and TASK-005 verification blocks carry the same commands, each naming why a filename check is inert for the file *it* edits. TASK-003 additionally requires `webview/sqlHighlight.ts` to be absent from the after-snapshot (a new file must add zero errors). |
| 2 | Cold `SchemaCache` → no coloring on first open | TASK-002 now specifies `onDidChangeSemanticTokens` + `refresh()` + `dispose()` on the provider, `refresh()` calls wired into the two existing invalidation sites (`src/extension.ts:141` `onDidChangeActive`, `:233-237` `UnicDB.refreshSchema`), and a guarded one-shot re-fire when a provide call hits a cold cache (with an "already scheduled" boolean, since fire→re-request→still-cold loops). New cases 9 (cold cache → refresh → token appears, listener fired exactly once) and 10 (event lifecycle: safe with zero listeners, does not coalesce). §4, §6 and the Interfaces block updated; the vscode mock now needs `EventEmitter`. |
| 3 | §1 claimed MSSQL sort ships; audit said it stays orphaned | Resolved by **making it true rather than softening it**: §1 now says MSSQL sort ships as a live path — TASK-005's `handleRequery` routes a single-identifier requery-bar ORDER BY through `composeSortQuery`, so both adapter helpers get a real call site (this also retires the Postgres orphan from cycle U). §1, §3 and §6 all state the same thing, and column-header-click wiring is explicitly out of scope for **every** dialect in §2. New TASK-005 cases 15 (liveness: mssql → `ORDER BY [name] DESC` at `runner.runSql`), 16 (complex ORDER BY passes through byte-identically), 17 (empty ORDER BY — the post-save auto-requery path). |
| 4 | `String()`-coerced filter values break MSSQL/MySQL typing | `ColumnFilterModel` entries gain `typed?: unknown[]`, used only when `typed.length === values.length`, routed through the existing `sqlLiteral` (already emits unquoted numbers, `TRUE`/`FALSE`, `NULL`). New TASK-004 cases 15 (numerics unquoted on all 3 dialects), 16 (ISO timestamp normalized per dialect — PG verbatim, MySQL/MSSQL `T`→space and `Z` stripped), 17 (booleans/nulls typed), 18 (**no** type sniffing: `"007"` without `typed` stays `'007'`), 19 (length mismatch falls back, never `IN (1, undefined)`). TASK-005 owns population (cases 12-14) and must omit `typed` wholesale when a selected value's row is no longer loaded. §4 gained 5 rows; §6 gained a criterion; the UTC-naive timestamp assumption is logged in TASK-004's Discussion and in Known gaps. |
| 5 | §2 owner table stale | Rebuilt as a wave-1/wave-2 two-column table listing all 22 files including every test file, followed by an explicit note on the three cross-wave files (`webview/main.ts`, `queryComposer.ts`, `queryComposer.test.ts`) and why a wave boundary makes them safe. |
| 6 | §6 said 6 bundles, esbuild defines 7 | Corrected to 7 in §6 (with the bundle names enumerated) and in TASK-003. |
| 7 | `grep -c … → 0` fails as a gate | Replaced with `! grep -q innerHTML webview/sqlHighlight.ts` in both §6 and TASK-003, each annotated with why the bare form exits 1. |
| 8 | TASK-006 ships dead code | Resolved with finding 3: the export is reachable via `composeSortQuery` from the live requery path, asserted by TASK-005 case 15 (which lives there because TASK-005 owns `resultsPanel.ts` and both tasks are in wave 2). TASK-006 keeps its own guard as new case 9: the composer's mssql arm must be a genuine delegation with no duplicated T-SQL left behind. §6 criterion now reads "no sort helper ships as an orphan export this cycle". |

Also recorded, per the coordinator's note: "sort header-click wiring deferred" and
"`(Blanks)` → `IS NULL` misses `''`" are now explicit **§2 Out of scope** entries with their
reasons, not only Known-gaps lines, and both remain queued in `INDEX.md`.

Consistency after the fixes: §1 ↔ §3 ↔ §6 ↔ Known gaps now agree on exactly what MSSQL
sort delivers (adapter API + requery-bar call path; **no** header-click wiring for any
dialect). Task counts changed — TASK-002 8→10, TASK-004 14→19, TASK-005 11→17, TASK-006
8→9 — and every §4 row, Test Files line, Acceptance Criteria count and Interfaces block was
updated to match. Wave structure is unchanged (wave 1: 001-004, wave 2: 005-006) and no new
same-wave file collision was introduced: all new work lands in files their task already
owned. Nothing known to be inconsistent.

### Round 3 — 2026-08-25 · bao-opus
Status: Approved

Verified against repo: `package.json` scripts/contributes/deps/engines ✓; 7 esbuild bundles ✓; `contributes` keys (no `grammars`/`languages` at HEAD) ✓; `getTableSortQuery` at `postgres.ts:167` — zero production call sites confirmed ✓; `sqlLiteral` at `resultsGridModel.ts:378` handles null/number/boolean/bigint/Date/string ✓; `quoteIdent` at `saveStatements.ts:136` covers mysql/mssql/postgres ✓; `SET_FILTER_BLANKS_DISPLAY` at `resultsGridModel.ts:1138` ✓; `composeRequery` at `resultsGridModel.ts:1090` ✓; `SchemaCache` async + 60 s TTL confirmed ✓; `UnicDB.refreshSchema` command at `extension.ts:233`, `onDidChangeActive` at `extension.ts:139` ✓; webview baseline: 61 error lines across 6 files, 77 raw lines, codes match plan ✓; full test suite: 1327 passed / 2 skipped / 0 failed ✓; `grep -c` replaced with `! grep -q` ✓.

Round 1 findings resolution (8 of 8 verified):
1. §5 webview baseline — RESOLVED: measured per-file snapshot diff, 61 errors / 6 files / 77 lines / 12 codes, correct gates for TASK-003/TASK-005.
2. TASK-002 cold cache — RESOLVED: `onDidChangeSemanticTokens` + `refresh()` wired to both invalidation sites, cases 9-10 cover cold-cache lifecycle.
3. §1 MSSQL sort contradiction — RESOLVED: §1 now describes the shipped adapter API + requery-bar call path; §2 explicitly defers header-click for all dialects; §1/§3/§6/Known gaps agree.
4. buildFilterWhere value typing — RESOLVED: `typed?: unknown[]` carried alongside display values, §3 describes round-trip, §4 has 5 new edge cases including numeric unquoting and length-mismatch fallback.
5. §2 owner table — RESOLVED: full wave-1/wave-2 table for all 22 files with cross-wave safety notes.
6. Bundle count — RESOLVED: §6 says 7, matches esbuild.js.
7. grep gate — RESOLVED: `! grep -q innerHTML webview/sqlHighlight.ts`.
8. TASK-006 dead code — RESOLVED: §1 inconsistency fixed, TASK-005 case 15 asserts liveness, §6 criterion says "no orphan export".

COMPLETENESS: none
CONSISTENCY: none
CLARITY: none
SCOPE: none
YAGNI: none

Minor note: §5 error-code breakdown omits `TS2552` (1 occurrence in `webview/main.ts:2306`) from the per-code list — the total of 61 is still correct, and the snapshot-diff gate is code-list-independent, so this is cosmetic only.

NOTES: Plan is internally consistent across all eight Round 1 findings. All factual claims verified against the repo at HEAD 08c8de3. Ready for execution.
