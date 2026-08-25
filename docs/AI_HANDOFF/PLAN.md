# PLAN — Cycle W

Base: `main` · Date: 2026-08-26 · Predecessor: cycle V (`68f602a`, v1.6.5)

## §1 Intent

Cycle V pushed column filtering, paging and sort *composition* down to the server but left
four gaps recorded in `INDEX.md` → "Next cycles (queued)". Cycle W closes them:

1. **Sort is still client-side.** `getTableSortQuery` (postgres, `src/adapters/postgres.ts:169`)
   and its MSSQL twin exist as pure builders with no production call site. Clicking an AG Grid
   column header (`sortable: true`, `webview/main.ts:1535`) re-orders only the rows already
   loaded in the browser, so on a batched 500-row window the user sees "the smallest of the
   loaded 500", not "the smallest in the table".
2. **ORDER BY only understands one bare identifier.** `SIMPLE_ORDER_BY_RE`
   (`src/ui/resultsPanel.ts:61`) matches `name` / `name DESC` and nothing else; `a, b DESC`
   falls through to `composeRequery` unquoted, and a real expression is passed to the driver
   verbatim.
3. **The set-filter dropdown can only offer values that happen to be loaded.** Entries come
   from `buildSetFilterEntries` over grid rows (`SetFilterComponent.recomputeEntries`,
   `webview/main.ts:1261`), so with server-side filtering a value outside the loaded window is
   unselectable, and `typed[]` degrades to string literals when a selected row is evicted
   (`buildServerFilterModel`, `webview/main.ts:1976` — index-losing on MySQL).
4. **`(Blanks)` matches only NULL.** AG Grid groups `null` / `undefined` / `""` together;
   the composed predicate is `col IS NULL` (`buildFilterWhere`, `src/ui/queryComposer.ts:123`
   — the `parts.push(\`${quoted} IS NULL\`)` line),
   so empty-string rows silently disappear from a `(Blanks)` selection.
5. **OFFSET paging is not deterministic.** `buildPagedQuery` emits `LIMIT n OFFSET m` with
   whatever ORDER BY the user supplied. When that ORDER BY is non-unique (or absent) the
   database is free to return overlapping or skipped rows between "Load More" pages.

**Success looks like:** clicking a column header re-queries the *server* with a dialect-quoted
`ORDER BY`; a multi-column `a, b DESC` from the requery bar is quoted per dialect and an
expression is rejected with a visible message instead of being passed through raw; the filter
dropdown lists server-side `DISTINCT` values with their real types; `(Blanks)` matches empty
strings; and "Load More" receives a total ORDER BY whenever the statement projects every column
of its primary key. If any PK component is not projected, paging keeps cycle-V behaviour and the
UI makes no gap-free promise.

## §2 Scope

### In scope

| # | Change | Owner task |
|---|--------|------------|
| A | `parseOrderBy` / `buildOrderByClause` — multi-term ORDER BY, explicit identifier charset (bare **or** pre-quoted), per-dialect quoting, expression rejection | TASK-001 |
| B | `(Blanks)` → `(col IS NULL OR col = '')` for columns whose **declared type** is a string type | TASK-001 |
| C | `buildPagedQueryTerms` — append the full projected PK as deterministic ORDER BY tiebreakers | TASK-001 |
| D | `buildDistinctValuesQuery` — pure `SELECT DISTINCT` builder in a new module | TASK-002 |
| E | `webview/main.ts`: `onSortChanged` → server-side sort requery | TASK-003 |
| F | `webview/main.ts`: set-filter list fed by host distinct values (+ typed values beyond the loaded window) | TASK-003 |
| G | Host wiring: `distinctValues` message pair, `ResultsPanel` handler + per-(index,column) cache, and switching `composeRequerySql` onto the new parser/tiebreaker | TASK-004 |

### Out of scope (deliberate, with reason)

- **Full keyset / cursor paging.** See §3 trade-off — replaced by the tiebreaker (C).
- **Projecting missing PK columns into arbitrary result sets.** The paging tiebreaker is the full
  declared PK and is added only when every PK column is already present in
  `StatementResult.result.columns`. If any component is absent, no key is appended: appending all
  projected columns is not guaranteed unique and therefore cannot make OFFSET paging total. The
  UI must not claim gap-free paging in that fallback. Queued in `INDEX.md` as a follow-up that
  safely projects PK columns through arbitrary wrapped SELECTs.
- **MySQL/MSSQL non-UTC session timestamp normalization.** `mysql.createPool` is created
  without `timezone`/`dateStrings` and tedious's `new Connection` without `useUTC`, so a
  server session not running in UTC shifts a `datetime` literal. Fixing this needs a
  session-timezone probe per connection — a separate cycle, not a line in this one.
- **A MySQL `getTableSortQuery` adapter twin.** The mysql arm of `composeSortQuery` is
  composed inline and is byte-identical to what such a helper would emit; adding the helper
  creates a second source of truth with no call site.
- **Whitespace-only values folded into `(Blanks)`.** Would require `TRIM(col) = ''`, which
  loses the index on all three dialects. `"  "` stays its own filter entry.
- **Scoping the DISTINCT round trip to the active WHERE — accepted limitation, decided, not
  unknown.** Verified: `src/ui/resultsPanel.ts` retains **no** per-statement `where` (there is no
  `lastWhere` / `whereByStatement` field; the requery bar's text lives only in `webview/main.ts`
  and reaches the host inside a single `RequeryMessage`). So the host has nothing to scope with
  at `requestDistinctValues` time, and `buildDistinctValuesQuery` is called with `where = ""` —
  the DISTINCT list is composed over the **base statement** (the statement's own `r.sql`, whose
  schema+table the host already knows via `tableByStatement`) with its own `LIMIT`, and is NOT
  narrowed by the currently applied filter/requery WHERE. Consequence the user sees: the dropdown
  may offer a value that the current filtered view cannot contain; selecting it yields zero rows,
  which is confusing but never wrong data. Deliberately accepted for this cycle rather than
  adding a `where` field to `RequestDistinctValuesMsg` — the webview's requery-bar text is not
  the only WHERE in play (the set-filter model composes a second one host-side), so a partial
  scope would be *more* misleading than none. Queued as a follow-up in `INDEX.md`
  ("Scope DISTINCT dropdown values to the active filter/WHERE"), which needs the host to retain
  the composed WHERE per statement first.
- **`NULLS FIRST/LAST` emulation on mysql/mssql.** Cut on YAGNI grounds (review round 1): no §1
  gap asks for it and no producer emits it — TASK-003's `onSortChanged` emits only
  `"<col> ASC|DESC"`, so the clause is reachable solely by hand-typing into the requery bar. The
  **parser still accepts** `NULLS FIRST|LAST` (grammar in §3.1) and `buildOrderByClause`
  **renders it natively on postgres**. On mysql/mssql, which have no such syntax, a `nulls` term
  is **rejected** through the same single error channel as any other unsupported ORDER BY —
  `parseOrderBy(orderBy, dialect?)` returns `{ ok: false, error }` when `dialect` is `mysql` or
  `mssql` and any term carries `NULLS`. Never silently dropped (that changes row order with no
  signal) and never emulated with a synthetic `CASE` / `IS NULL` key term. This also keeps the
  mssql `CASE` branch — and its collision with the `queryComposer.test.ts:161-182` source-text
  assertions — out of the cycle entirely.
- **`docs/CHANGELOG.md` / version bump / commit.** Release chores belong to the orchestrator.

### Same-file constraint (checked)

| File | Task | Wave |
|------|------|------|
Complete list — every file named in any task's `## Target Files`, source and test alike:

| File | Task | Wave |
|------|------|------|
| `src/ui/queryComposer.ts` | TASK-001 only | 1 |
| `src/ui/__tests__/queryComposer.test.ts` | TASK-001 only | 1 |
| `src/ui/distinctValues.ts` (new) | TASK-002 only | 1 |
| `src/ui/__tests__/distinctValues.test.ts` (new) | TASK-002 only | 1 |
| `webview/main.ts` | TASK-003 only | 1 |
| `src/ui/__tests__/webviewServerSort.test.ts` (new) | TASK-003 only | 1 |
| `src/ui/__tests__/webviewDistinctValues.test.ts` (new) | TASK-003 only | 1 |
| `src/ui/messages.ts` | TASK-004 only | 2 |
| `src/ui/resultsPanel.ts` | TASK-004 only | 2 |
| `src/extension.ts` (implement `SaveContext.listColumnTypes`, ~8 lines) | TASK-004 only | 2 |
| `src/ui/__tests__/resultsPanelDistinctValues.test.ts` (new) | TASK-004 only | 2 |
| `src/ui/__tests__/resultsPanelOrderBy.test.ts` (new) | TASK-004 only | 2 |
| `src/ui/__tests__/resultsPanelServerFilter.test.ts` (case 16 block only) | TASK-004 only | 2 |

No file appears in two tasks at all, so no same-wave collision is possible. TASK-003 (webview)
and TASK-004 (host) implement two ends of one message contract; that contract is frozen in §7
and repeated verbatim in both tasks' `## Interfaces` so they can be written in parallel.

## §3 Approach

### 3.1 ORDER BY: a real parser, not a wider regex

Today `SIMPLE_ORDER_BY_RE = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:(ASC|DESC))?\s*$/i` accepts
exactly one identifier. Widening the regex to cover `a, b DESC` invites the same failure again
on the next shape, so cycle W adds a **term parser** in `queryComposer.ts`:

```ts
export interface OrderByTerm { column: string; direction: "ASC" | "DESC"; nulls?: "FIRST" | "LAST"; }
export type ParseOrderByResult =
  | { ok: true; terms: OrderByTerm[] }
  | { ok: false; error: string };
export function parseOrderBy(orderBy: string, dialect?: Dialect): ParseOrderByResult;
export function buildOrderByClause(terms: OrderByTerm[], dialect: Dialect): string;
```

#### Accepted identifier charset (decided — binds TASK-001 and TASK-003)

A term's column part is accepted in exactly two forms, and nothing else:

1. **Bare identifier** — matches `/^[A-Za-z_][A-Za-z0-9_$]*$/` (the same charset
   `SIMPLE_ORDER_BY_RE` accepts today, so cycle V's behaviour is a strict subset).
2. **Already-quoted identifier in the active dialect's style**: `"First Name"` for postgres
   (`""` escapes a quote), `` `First Name` `` for mysql (a doubled backtick escapes a backtick),
   and `[First Name]` for mssql (`]]` escapes a bracket). The parser strips the matching quotes
   and un-doubles the escapes, yielding `column: "First Name"` — an *unquoted logical name*,
   exactly what `quoteIdent` expects. `buildOrderByClause` then re-quotes it canonically for that
   dialect, so quoted input is normalized, never passed through as raw text. When `dialect` is
   omitted, all three styles are accepted for pure-builder use.

**Mismatched quote styles are not supported.** With a live dialect, a token quoted in another
style is not unquoted. It may be treated as an ordinary bare identifier only if the entire token
also matches `/^[A-Za-z_][A-Za-z0-9_$]*$/`; in practice delimiters such as backticks, double
quotes and brackets fail that charset, so e.g. ``parseOrderBy("`First Name`", "postgres")`` and
`parseOrderBy('"First Name"', "mysql")` return the standard `{ ok: false, error }`. A raw
unquoted identifier containing a space, dot, quote/delimiter character or non-ASCII letter also
fails. Thus the only route into SQL is an accepted logical name subsequently passed through
`quoteIdent`.

This charset alone would regress today's client-side sort, because AG Grid `colId` is the raw DB
column name (`webview/main.ts:1533`, `field: spec.field`) and a column literally named
`First Name` would produce `orderBy: "First Name ASC"` → rejected → error toast where the user
previously got a (locally) sorted grid. **So TASK-003 must quote before sending**: when a
`colId` fails the bare-identifier test, `orderByFromColumnState()` wraps it in the dialect quote
character (doubling any embedded quote char) before joining the term. The webview learns the
dialect from the `state` message header, which `extension.ts:623` builds as
``Run at <ISO> — <driver>@<host>/<db>`` — TASK-003 parses the driver out of it and falls back to
postgres double-quoting when the header carries `no connection` or an unrecognized shape (a
double-quoted identifier is also what a `null`-dialect host path composes today). Bare
identifiers are sent bare, so the common case is byte-identical to what cycle V's regex saw.

**Rejected alternative:** having TASK-003 post structured terms (`{column, direction}[]`) instead
of a string. It is the cleaner contract, but `orderBy` is a *shared* field: the requery bar
(`webview/main.ts:2029/2351/2608/3005`) posts a free-text string into the same message, so the
host would need both paths anyway, and the message shape would stop being additive for an older
bundle. Quoting at the producer keeps one contract and one parser.

`parseOrderBy` splits on top-level commas and matches each term against
`identifier [ASC|DESC] [NULLS FIRST|NULLS LAST]`. Anything else — a parenthesis, a function
call, a dotted qualifier, an ordinal `1`, a bare `*` — returns `{ ok: false, error }`. **The
error is user-visible** (host surfaces it via `vscode.window.showErrorMessage` and a synthetic
error `StatementResult`); the expression is *never* passed to the driver raw. This is a
deliberate behaviour change from cycle V's silent pass-through: pass-through means an
unquoted, unvalidated user string reaches the database, and the user cannot tell whether their
ORDER BY was applied or ignored. **Rejected alternative:** keep pass-through for
"advanced users" — it makes the quoted and unquoted paths indistinguishable in the UI, and
`composeRequery` already wraps the SQL in a subquery, so an expression referencing an inner
alias is not reliably valid at the outer level anyway.

`NULLS FIRST/LAST` — **accepted by the grammar, rendered natively on postgres, rejected on
mysql/mssql, never emulated.** Round-1 review flagged the emulation as YAGNI and it is cut (see
§2 out-of-scope). `parseOrderBy` still parses the clause into `nulls?: "FIRST" | "LAST"` so the
grammar is honest about what the user typed; `buildOrderByClause` renders `"a" ASC NULLS LAST`
on postgres. When the dialect is mysql or mssql, `parseOrderBy(orderBy, dialect)` returns
`{ ok: false, error }` naming the unsupported clause, which flows through the *same* single
rejection channel as `lower(name)` — one error path, no second wrapper, no synthetic key term.
**Rejected alternative:** silently dropping the clause on those two dialects — it produces a
different row order than the one the user asked for, with no signal.

#### Composition path for a multi-term ORDER BY (decided — pins TASK-004)

`composeSortQuery` takes a single `column` + `direction` and structurally cannot express two
terms, so the plan pins the wrapper rather than letting the executor pick one:

| `msg` shape | Composition | Wrapper alias |
|---|---|---|
| no `filters`, no `offset`, **0 terms** | `composeRequery(sql, where, orderBy)` — unchanged | `vsdb_sub` (existing) |
| no `filters`, no `offset`, **exactly 1 term, no `nulls`** | `composeSortQuery(dialect, sql, where, col, dir)` — **unchanged cycle-V path** | `vsdb_sort` (existing) |
| no `filters`, no `offset`, **≥2 terms (or 1 term with `nulls`)** | new multi-term wrap, below | `vsdb_sub` |
| `filters` or `offset` present | `buildPagedQueryTerms(...)` (TASK-001) | `vsdb_page` (existing) |

The multi-term wrap uses the **same builder chain shape as `buildPagedQuery`** — strip the
trailing semicolon from the original SQL, wrap it verbatim, apply WHERE and ORDER BY at the
outer level:

```
SELECT * FROM (<original sql, trailing ; stripped>) AS vsdb_sub[ WHERE <where>] ORDER BY <buildOrderByClause(terms, dialect)>
```

The alias is exactly **`AS vsdb_sub`**, matching `composeRequery`'s existing wrapper name
(`src/ui/resultsGridModel.ts:1108`), so the only difference from the no-ORDER-BY path is that
the ORDER BY is present and dialect-quoted. No `LIMIT`/`OFFSET` is emitted on this path — by
definition `msg.offset` is absent; when it is present the row above routes to
`buildPagedQueryTerms`, which owns paging.

**An ORDER BY already present in the original SQL is replaced, not merged.** Because the original
is wrapped as a subquery, its inner ORDER BY becomes ordering of the *derived table* and the
outer ORDER BY is what the database honours — postgres and mysql may keep the inner sort as a
tiebreak-ish artifact, mssql rejects a bare inner `ORDER BY` without `TOP`/`OFFSET`. This is
**pre-existing** behaviour of every wrapper in the file (`composeRequery`, `composeSortQuery`,
`buildPagedQuery` all wrap the same way and have shipped since cycle T); cycle W does not change
it and does not attempt inner-ORDER-BY detection. Documented here so the executor does not
"fix" it mid-cycle: a user whose statement already ends in `ORDER BY x` and who then clicks a
header gets ordering by the clicked column, which is the correct and expected outcome.

### 3.2 Paging determinism: a tiebreaker, not keyset paging

Real keyset paging replaces `OFFSET m` with `WHERE (sortkey) > (last seen sortkey)`, which
requires (a) a unique sort key per result set, (b) carrying the last row's key through the
webview→host round trip, (c) a different composition for the first page vs subsequent pages,
and (d) reversing the comparison for `DESC`, per term. For a wrapped arbitrary user SELECT —
which is what `buildPagedQuery` receives — a unique key is not guaranteed to exist at all.

**Decision: add a total ORDER BY only when the full primary key is usable.**
`buildPagedQueryTerms` accepts `tiebreakers: string[]` and appends **every** missing PK column in
`listPkColumns`' declared order, each `ASC`; a PK component already present in the user terms is
not repeated, regardless of that user's direction. A composite PK is indivisible for this
purpose: using only its first column is not unique. With all PK components trailing the user
terms, ordering is total and `OFFSET`/`FETCH` returns disjoint, gap-free pages.

The host derives the candidate from `tableByStatement.get(index)` →
`saveContext.listPkColumns(schema, table)`, never from the webview, and checks it against the
statement's existing projection metadata: `StatementResult.result.columns` is the ordered list
of projected column names already available in `handleRequery` (`r.result?.columns`). Only when
**every** PK name is present (exact identifier comparison) does it pass the full array to
`buildPagedQueryTerms`; otherwise it passes `[]`. It must not append all projected columns as a
fallback because they need not be unique, and it must not reference a non-projected PK because
the outer wrapper cannot order by a column it does not expose. With `[]` (no PK, missing result
metadata, or any PK component absent), the clause is byte-identical to today's
`buildPagedQuery`; the UI makes no gap-free promise. Deep-offset performance and safely
projecting missing PK columns stay queued. No invented `ctid`/`ROWID` is allowed.

### 3.3 `(Blanks)`: opt-in, never silent

`buildFilterWhere` gains an options argument deciding which columns' `(Blanks)` also matches
`''`. Making it unconditional would emit `col = ''` against integer/date columns, which is a hard
type error on postgres and mssql, so it must be per-column. Default (option absent) is
byte-identical to today's output, which keeps every existing `queryComposer.test.ts` assertion
green.

**The decision is static, from the column's declared type — never from sniffing loaded values.**
Round-1 review caught the sniffing version: "at least one loaded value is a `string`" is
page-dependent (the same selection composes `IS NULL` on one page and `IS NULL OR = ''` on the
next) and is inert for an all-NULL varchar window — precisely the case the user notices. So:

```ts
export interface FilterWhereOptions {
  /** column name → declared DB type (e.g. "varchar", "text", "int4").
   *  A column whose type is a string type gets the `= ''` arm on (Blanks). */
  columnTypes?: Record<string, string>;
}
```

`buildFilterWhere` normalizes the declared type with `trim().toLowerCase()` and recognizes the
whole string family without broad substring matching: `char...`, `varchar...`, `nchar...`,
`nvarchar...`, `enum...`, and `set...` are accepted prefixes (therefore parameters such as
`nvarchar(50)` work); `text` plus suffix variants `tinytext`, `mediumtext`, `longtext` and `ntext`
are accepted; multi-word `character varying...` is accepted; and exact `citext` / `cstring` are
accepted when adapters report them. This covers case-insensitive `TEXT`, `TINYTEXT`,
`MEDIUMTEXT`, and `LONGTEXT` while avoiding false positives such as `context_id` or
`textbook_code`. **A column absent from `columnTypes`, or carrying an unknown/empty type,
defaults to `false`** → bare `IS NULL`, i.e. exactly cycle-V behaviour. Unknown never widens the
predicate; that keeps the failure mode "the fix did not fire" rather than "a type error killed
the query".

TASK-004 supplies whatever type metadata it has and nothing more. Verified sources, in order:
`StatementResult.result.columns` is `string[]` (`src/adapters/types.ts:12` — **names only, no
types**, so the result header cannot supply this), therefore TASK-004 resolves types through the
adapter's column metadata for the statement's `(schema, table)` — `ColumnInfo { name, dataType,
nullable, isPrimaryKey? }` (`src/adapters/types.ts:47-52`), reachable the same way
`saveContext.listPkColumns` already reaches it (`extension.ts:98-106` calls
`adapter.listColumns(table, schema)` and filters). When the statement has no addressable table
(`tableByStatement` miss) or the lookup throws, TASK-004 passes **no** `columnTypes` and every
`(Blanks)` stays `IS NULL` — the cycle-V path. See TASK-004 for the `SaveContext` extension that
exposes this without importing `ConnectionManager` into the panel.

### 3.4 Distinct values: host round trip, cached per (index, column)

The webview asks the host for a column's distinct values; the host composes
`SELECT DISTINCT <col> FROM (<original sql>) vsdb_distinct ORDER BY 1 LIMIT n+1`
(mssql: `SELECT DISTINCT TOP (n+1)`), runs it through the same `runner.runSql` path as a
requery, and replies with the raw values plus a `truncated` flag when more than `n` came back
(default `n = 1000`). Because these are real DB values, the webview can attach them as `typed[]`
even for rows that were never loaded — which is exactly gap 3 above. The response is cached per
`(statement index, column)` and invalidated whenever `render()` replaces the statement.
Each request captures its `index`, `column`, and the current statement identity/generation before
awaiting `runSql`. Its reply carries that same request `index` and `column`; after the await, the
host drops the response unless the captured index still names the same current statement. A late
response for a replaced statement must neither repopulate the cache nor call `postMessage` — the
same stale-completion principle as `requerySeq`, applied per DISTINCT request.

**Scope of the DISTINCT query: the base statement, NOT the current filtered view — decided.**
`buildDistinctValuesQuery` keeps its `where: string` parameter (it is a pure builder and the
parameter is exercised by TASK-002 cases 6-7), but **TASK-004 calls it with `""`**, because the
host retains no per-statement WHERE to pass: verified, `src/ui/resultsPanel.ts` has no
`lastWhere` / `whereByStatement` field, and the requery bar's text only ever arrives inside a
single `RequeryMessage`. The list is therefore composed over the statement's own `r.sql` — the
base table, whose `(schema, table)` the host already knows from `tableByStatement` — bounded by
its own `LIMIT n+1`. `RequestDistinctValuesMsg` stays `{ index, column }`; **no contract change,
so TASK-003 and TASK-004 remain writable in parallel.** The accepted limitation and the queued
follow-up are recorded in §2 out-of-scope and §7.
**Rejected alternative:** computing distinct values inside the webview from all loaded rows —
that is what is broken today; the loaded window is the problem, not the aggregation.

`buildDistinctValuesQuery` lives in a **new** module `src/ui/distinctValues.ts` rather than in
`queryComposer.ts`. Two reasons: it keeps TASK-002 off TASK-001's file (wave-1 parallelism),
and `queryComposer.test.ts` contains source-text assertions (see §7) that any new import in
that file risks breaking.

### 3.5 Webview sort wiring

`createGrid` (`webview/main.ts:1653`) gains `onSortChanged`, which reads
`api.getColumnState()`, keeps entries with a non-null `sort` ordered by `sortIndex`, renders
them as an `orderBy` string (`"a ASC, b DESC"` — **`colId` quoted per §3.1 when it is not a bare
identifier**), and posts the existing `requery` message
carrying the current filter model — i.e. it reuses `postFilterRequery`'s payload shape so sort,
filter and paging compose instead of racing. A `suppressSortRequery` re-entrancy guard is set
while applying host-driven column state so a programmatic restore does not re-post.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | `parseOrderBy` single term | `{ ok: true, terms: [{ column: "name", direction: "ASC" }] }` for `"name"` |
| happy | `parseOrderBy` multi term | `"a, b DESC"` → 2 terms, second `direction: "DESC"` |
| happy | `buildOrderByClause` per dialect | `[{a,ASC},{b,DESC}]` → `"a" ASC, "b" DESC` / `` `a` ASC, `b` DESC `` / `[a] ASC, [b] DESC` |
| edge (malformed input) | expression rejected | `parseOrderBy("lower(name)")` → `{ ok: false, error: /not a plain column/ }` |
| edge (malformed input) | trailing/empty term rejected | `parseOrderBy("a, ")` → `ok: false`; `parseOrderBy("")` → `{ ok: true, terms: [] }` |
| edge (injection) | quoting neutralizes payload | `parseOrderBy('name"; DROP TABLE t--')` → `ok: false` (not an identifier) |
| edge (dialect capability) | NULLS native vs rejected | postgres `"a" ASC NULLS LAST`; `parseOrderBy("a NULLS LAST", "mysql")` and `"mssql"` → `{ ok: false, error: /NULLS/i }` |
| edge (malformed input) | active-dialect quoting only | postgres accepts `parseOrderBy('"First Name" DESC', "postgres")` and unquotes it; postgres rejects backticks/brackets, mysql rejects double quotes, and raw `First Name DESC` is rejected through the same non-empty error |
| happy | multi-term wrapper is pinned | `orderBy: "a, b DESC"`, no filters/offset → composed SQL `=== 'SELECT * FROM (SELECT id FROM t) AS vsdb_sub ORDER BY "a" ASC, "b" DESC'` |
| edge (type safety) | `(Blanks)` from declared type | `columnTypes:{n:"varchar"}` → `"n" IS NULL OR "n" = ''`; `LONGTEXT` also widens; `int4`, unknown and absent types remain bare `"n" IS NULL` |
| happy | composite-PK tiebreaker | `buildPagedQueryTerms(..., [{name,ASC}], ..., ["tenant_id","id"])` emits `ORDER BY "name" ASC, "tenant_id" ASC, "id" ASC` in declared PK order |
| edge (duplicate) | existing PK term not doubled | terms containing `tenant_id DESC` plus tiebreakers `["tenant_id","id"]` retain the DESC term once and append only `"id" ASC` |
| edge (boundary) | no usable full PK | `tiebreakers=[]` → output byte-identical to today's `buildPagedQuery`; host passes `[]` when any declared PK column is missing from `r.result.columns` |
| edge (type safety) | `(Blanks)` opt-in | `columnTypes:{n:"text"}` → `("n" IS NULL OR "n" = '' OR "n" IN ('a'))`; option absent → today's string |
| edge (integration wiring) | all-NULL varchar window still gets `= ''` | host-side: statement whose loaded rows are all `null` for a `varchar` column composes `IS NULL OR = ''` (proves the type source, not row sniffing) |
| edge (all-or-nothing) | `typed[]` length parity | a 2-value selection where only 1 resolves from the distinct cache posts `typed` with BOTH resolved (length 2) or omits `typed` entirely — never length 1 |
| happy | distinct query per dialect | postgres/mysql `… ORDER BY 1 LIMIT 1001`; mssql `SELECT DISTINCT TOP (1001) … ORDER BY 1` |
| edge (boundary) | distinct truncation flag | `n+1` rows returned → `values.length === n` and `truncated === true` |
| edge (concurrency) | stale distinct response | request `(index:0,column:"name")`, replace/requery statement 0, then resolve the old request: captured index/column remain on the response object but the handler detects the current statement mismatch, performs no `postMessage`, and leaves the replacement cache unchanged |
| happy | header click → server sort | `onSortChanged` with one sorted column posts `requery` with `orderBy: "name ASC"` |
| edge (ordering) | multi-column sort respects `sortIndex` | state `[{b, sortIndex 1}, {a, sortIndex 0}]` → `orderBy: "a ASC, b DESC"` |
| edge (idempotence) | clearing sort | all `sort: null` → `orderBy: ""`, exactly one `requery` posted |
| regression | ORDER BY pass-through no longer silent | `resultsPanelServerFilter.test.ts` case 16 (`"lower(name)"`) now expects a rejection, not `composeRequery` parity — RED against today's code |
| regression | single-identifier ORDER BY unchanged | `"name DESC"` still composes `ORDER BY "name" DESC` / `[name] DESC` (cycle V case 15 stays green) |

## §5 Verification

Package manager is **npm** (`package.json` scripts verified). There is no `lint` script; the
type gate is `typecheck`.

```bash
npm run typecheck                       # tsc --noEmit, must be clean
npm run compile                         # node esbuild.js — REQUIRED before any webview bundle test
npx vitest run <the task's test files>  # per-task targeted run
npm test                                # full suite, boundary run only
```

**Webview tsc gate (TASK-003 only).** `tsconfig.webview.json` sets `rootDir: webview`, so
`webview/main.ts` carries 14 *pre-existing* errors (TS6059 rootDir escapes, TS2304 for the
`LoadMoreMsg`/`CopyMsg`/`ExportFileMsg` aliases, AG Grid v36 colDef variance). Verification is a
**per-file count snapshot diff**, never "no errors":

```bash
npx tsc -p tsconfig.webview.json --noEmit 2>&1 | grep -oE "^[^ (]+\.ts" | sort | uniq -c
```

Baseline at cycle W start (`main`, total 40):

```
14 webview/main.ts
10 webview/connectionFormMain.ts
10 webview/aiSettingsFormMain.ts
 5 webview/schemaFormMain.ts
 1 webview/newTableFormMain.ts
```

The per-file counts must be **identical** after the change. Any increase — including importing
a `src/` module into `webview/main.ts`, which adds a TS6059 line — is a failure.

**Full-suite baseline (post-cycle-V):** 1400 passed / 2 skipped / 0 failed. One known flake:
`src/ui/__tests__/resultsGridModelNull.test.ts` test 6 (value-viewer overlay) fails under the
full suite and passes in isolation — pre-existing, not a cycle-W regression.

## §6 Acceptance

- [ ] `npm run typecheck` clean. (all tasks)
- [ ] `npm run compile` succeeds. (all tasks)
- [ ] `npx vitest run` green for every test file listed in every task. (all tasks)
- [ ] `parseOrderBy` accepts `a, b DESC`, the active dialect's quoted `"First Name"` equivalent,
      and `a NULLS LAST` on postgres; rejects `lower(a)`, `(a)`, `1`, `t.a`, raw `First Name ASC`,
      mismatched quote styles under a live dialect, and `a NULLS LAST` on mysql/mssql, each with a
      non-empty `error` string. → TASK-001 (§1 item 2)
- [ ] `buildOrderByClause` output for the same terms differs per dialect in quoting only. → TASK-001
- [ ] A multi-term ORDER BY with no filters/offset composes exactly
      `SELECT * FROM (<sql>) AS vsdb_sub[ WHERE …] ORDER BY <quoted terms>` — alias
      `AS vsdb_sub`, no LIMIT/OFFSET. → TASK-004 (§3.1)
- [ ] A header click on a column whose name is not a bare identifier posts a **quoted** `colId`
      in `orderBy` and the host composes it successfully (no rejection). → TASK-003 + TASK-004
- [ ] `buildPagedQueryTerms` appends all usable PK columns in declared order, and with
      `tiebreakers: []` is byte-identical to today's `buildPagedQuery`; TASK-004 passes `[]` if any
      PK component is absent from `r.result.columns`. → TASK-001 + TASK-004 (§1 item 5)
- [ ] `(Blanks)` emits `IS NULL OR = ''` only for columns whose `columnTypes` entry is a string
      type; unknown/absent type ⇒ bare `IS NULL`. → TASK-001 (§1 item 4)
- [ ] The host derives `columnTypes` from adapter column metadata (not from loaded row values),
      so an all-NULL `varchar` window still gets the `= ''` arm. → TASK-004 (§1 item 4)
- [ ] `buildDistinctValuesQuery` is a pure function with no `vscode` / driver import, and
      quotes the column through `quoteIdent`. → TASK-002 (§1 item 3)
- [ ] Clicking a grid column header posts a `requery` whose `orderBy` reflects the grid's
      column state, carrying the active filter model. → TASK-003 (§1 item 1)
- [ ] The set-filter list renders host-supplied distinct values when present and falls back to
      loaded rows when not. → TASK-003 (§1 item 3)
- [ ] `webview/main.ts` per-file tsc error count is still exactly 14. → TASK-003
- [ ] The host answers `requestDistinctValues` with `distinctValues`, caches per
      `(index, column)`, and drops responses for a replaced statement. → TASK-004 (§1 item 3)
- [ ] A rejected ORDER BY surfaces an error to the user and runs no SQL. → TASK-004 (§1 item 2)
- [ ] `npm test` full suite ≥ 1400 passed, 0 unexpected failures (known flake excepted). → boundary run

## §7 Global Constraints

Every `TASK-xxx.md` in this cycle inherits this section by reference.

- **npm only.** Never `yarn`. Scripts: `compile`, `watch`, `test`, `test:integration`,
  `typecheck`, `package`.
- **`npm run compile` before any webview bundle test.** `src/ui/__tests__/webview*.test.ts`
  loads `dist/webview.js` and self-skips when it is missing — a skipped file reads as green.
- **Never import `src/**` into `webview/**`.** `tsconfig.webview.json` has `rootDir: webview`;
  every such import adds a TS6059 error and breaks the snapshot gate. `webview/main.ts` already
  imports `../src/ui/resultsGridModel` and `../src/ui/undoStack` — those two are baselined; do
  not add a third. Mirror new host types structurally inside `webview/main.ts` (the file already
  does this for `ServerFilterModel`, line 132).
- **Zero hand-rolled SQL escaping.** Identifiers go through `quoteIdent`
  (`src/core/saveStatements.ts`), values through `sqlLiteral` (`src/ui/resultsGridModel.ts`).
  Never interpolate a webview-supplied string into SQL unquoted.
- **Never type-sniff display strings.** A `varchar` `'007'` must stay `'007'`. Typed literals
  come only from a caller-supplied `typed[]`/DB value.
- **`queryComposer.test.ts` contains source-text assertions.** It asserts the *file text* of
  `src/ui/queryComposer.ts` contains `getTableSortQuery(` exactly once and does not contain
  `quoteIdent(..., "mssql")`. Read those tests before editing that file; a new helper call can
  break them without touching behaviour.
- **Back-compat of the `requery` message is load-bearing — behavioural, NOT SQL-text identity.**
  Three pre-existing senders (Re-Run, Refresh, post-save auto-requery) omit `filters`/`offset`.
  The guarantee is: **when `msg.filters` is absent, `handleRequery` keeps its EXACT cycle-V
  behaviour** — same message flow, same `requerySeq` guard, same `setBusy`/`running` post order,
  same cursor close, same `adopt`, and the same *dispatch* through `composeRequerySql`:
  - no dialect ⇒ `composeRequery(sql, where, orderBy)` — unchanged;
  - 0 terms ⇒ `composeRequery(sql, where, "")` — unchanged;
  - exactly 1 bare term, no `offset` ⇒ **`composeSortQuery` — unchanged**, i.e. it keeps emitting
    `SELECT * FROM (…) vsdb_sort ORDER BY "name" DESC` with cycle-V's dialect quoting.
  There is **no** claim that this path is byte-identical to `composeRequery`, and none must be
  introduced: `composeRequery` wraps as `vsdb_sub` with an *unquoted* ORDER BY
  (`resultsGridModel.ts:1108`) while the live-dialect sort path is `vsdb_sort` + quoted
  (`resultsPanel.ts:913-918`). Asserting text identity across those two would revert cycle V's
  dialect quoting and break `resultsPanelServerFilter.test.ts:556-571` (case 15). The only
  byte-identity claims in this cycle are TASK-004 case 11 (`orderBy: ""` ⇒
  `toBe(composeRequery(sql, "", ""))`) and cases 13/13b (no usable full PK ⇒
  `toBe(buildPagedQuery(...))`).
- **Paging's gap-free guarantee is conditional.** Append the full PK in declared order only when
  every PK component is present in `r.result.columns`; otherwise pass no tiebreakers and expose no
  gap-free promise. Never substitute all projected columns. See §2/§3.2 and the `INDEX.md`
  follow-up for safely projecting missing PK columns.
- **DISTINCT values are base-table scoped (accepted limitation).** `buildDistinctValuesQuery`
  is called with `where = ""`; the dropdown is not narrowed by the active filter/WHERE, because
  the host retains no per-statement WHERE. Do not invent host state to fix this inside cycle W —
  see §2 out-of-scope and the `INDEX.md` follow-up.
- **New webview→host messages must be additive and optional.** Unknown message types are
  ignored on both sides; an older webview bundle must keep working against the new host.
- **TypeScript strict.** No `any` in new code; use the structural-type style the surrounding
  files already use.
- **Do not commit.** The orchestrator owns commit/version/CHANGELOG.
- **Comment language:** existing files mix English and Vietnamese comments — match the file you
  are editing.

## Planner Self-Audit

Checklist: 12/12 pass

- **Coverage.** Every §6 criterion names its owning task. Every task traces to a §1 gap:
  TASK-001 → gaps 2/4/5, TASK-002 → gap 3, TASK-003 → gaps 1/3, TASK-004 → gaps 1-5 (wiring).
  Unhappy paths are planned: DISTINCT query failure (T4 case 5), no active connection (T4 case
  6), no or partially projected PK (T1 case 13 / T4 cases 13/13b), rejected ORDER BY (T4 case 9),
  stale in-flight DISTINCT response after replacement (T4 case 6b), mismatched webview response
  (T3 case 10), and sort-restore re-entrancy loop (T3 case 6).
- **Correctness.** All target paths verified on disk; the six new files are marked `(new)`.
  Verification commands use only scripts defined in `package.json` (`typecheck`, `compile`,
  `test`) plus `npx vitest run` / `npx tsc -p tsconfig.webview.json`. No file is shared between
  any two tasks, so no same-wave collision exists (re-audited after the round-1 revision added
  `src/extension.ts` to TASK-004 — TASK-004 is alone in wave 2 and no wave-1 task names that
  file). TASK-004's dependencies cover every symbol it imports.
- **Test quality.** Each task has ≥1 happy path and ≥2 edge cases of different kinds (malformed
  input, injection, dialect capability, duplicate, boundary, concurrency/re-entrancy, cache
  invalidation, permission error). Every `Expected` is a concrete string, count or strict value;
  none would pass against an empty implementation. Regression cases exist for the two
  behaviour-preserving guarantees (T1 case 13, T4 cases 10/11/13/13b) and for the one deliberate
  behaviour change (T4 case 9, RED against today's pass-through).

Fixed during audit:
- Moved `buildDistinctValuesQuery` out of `queryComposer.ts` into a new `src/ui/distinctValues.ts`
  — it would otherwise have put TASK-002 on TASK-001's file in wave 1 and risked the source-text
  assertions at `queryComposer.test.ts:161-182`.
- Merged what began as separate "webview sort" and "webview set-filter" tasks into TASK-003, and
  separate "messages" and "resultsPanel" tasks into TASK-004; both pairs shared a file, so one
  task with two test groups beats two serialized waves.
- Dropped a planned MySQL `getTableSortQuery` adapter twin (would have been a second source of
  truth with no call site) — recorded in §2 out-of-scope.
- Made TASK-004 responsible for resolving the PK *before* calling `composeRequerySql` after
  reading the `requerySeq` guard at `resultsPanel.ts:956`; an async composer would have reordered
  it.
- Verified the webview tsc baseline by running it (40 errors total; 14 in `webview/main.ts`) and
  pasted the real counts into §5 rather than trusting the briefed numbers.

Known gaps:
- **`resultsPanelServerFilter.test.ts` case 16 must be rewritten by TASK-004.** It is the one
  existing test this cycle intentionally invalidates (silent ORDER BY pass-through becomes an
  explicit rejection). Called out in that task's Discussion so the reviewer sees it as planned,
  not as a broken test quietly patched.
- ~~**Whether the panel retains a per-statement `where` for the DISTINCT query is unverified.**~~
  **RESOLVED in the round-1 revision.** Verified: it does not. TASK-004 passes `""`, the DISTINCT
  list is base-table scoped, and this is now an explicit accepted limitation in §2/§7 with an
  `INDEX.md` follow-up — not an open unknown.
- **Whether AG Grid v36 gives `SetFilterComponent` a popup-open hook is unverified.** TASK-003
  may fire the distinct request from `init`; the cache case (T3 case 9) bounds the cost.
- **Deep-offset paging performance is not addressed.** Full-PK tiebreakers make paging
  deterministic only when all PK columns are projected; statements missing any PK component keep
  cycle-V paging with no gap-free promise. Keyset paging and safe PK projection are re-queued in
  `INDEX.md`.
- **`NULLS FIRST/LAST` is parse-only on mysql/mssql** (round-1 revision): accepted by the
  grammar, native on postgres, rejected with a message elsewhere. A user who wants that ordering
  on mysql/mssql still cannot get it — deliberate, since no producer emits the clause. Re-queued.
- **The webview infers the dialect from the `state` header string** (`extension.ts:623`) rather
  than from a typed field, in order to quote non-bare `colId`s. It falls back to postgres
  double-quoting on an unparseable header. A typed `dialect` field on `StateMessage` would be
  cleaner but is a host-side change that would put TASK-003 and TASK-004 on the same contract in
  the same cycle. Re-queued in `INDEX.md`.
- **MySQL/MSSQL non-UTC session timestamps stay wrong.** Evidence gathered (no `timezone` /
  `dateStrings` on `mysql.createPool`, no `useUTC` on tedious `new Connection`), but a fix needs
  a session-timezone probe. Re-queued.


## Plan Review Log

### Round 1 — 2026-08-26 · bao-opus

Status: Issues Found

COMPLETENESS:
  - §3.1/§4/TASK-001 never define the identifier grammar `parseOrderBy` accepts. TASK-003
    Discussion #4 builds the string as `` `${colId} ${sort.toUpperCase()}` `` from
    `webview/main.ts:1533` (`field: spec.field` = the raw DB column name, `sortable: true`
    at `:1535`). A column named `First Name` or a non-ASCII name therefore yields
    `orderBy: "First Name ASC"`, which cannot match `identifier [ASC|DESC]` and is REJECTED
    by TASK-004 (error toast, no SQL) — a user-visible regression versus today's client-side
    sort. `quoteIdent` (`src/core/saveStatements.ts:136-148`) and its own comment exist
    precisely because this codebase supports mixed-case/spaced/non-ASCII identifiers, so the
    parser is narrower than the rest of the system. Decide the charset (or have TASK-003 post
    structured terms) before wave 1.
  - Gap 4 (`(Blanks)` matching `''`) has zero integration coverage. TASK-001 cases 14/16 pass
    `emptyIsBlank` explicitly and TASK-004 has no case for deriving it, so the §6 criterion
    for gap 4 only exercises the builder, never the wiring that decides which columns qualify.
  - §2 "Same-file constraint (checked)" table is incomplete as a collision audit: it omits
    `src/ui/__tests__/webviewDistinctValues.test.ts` (TASK-003 Target Files) and
    `src/ui/__tests__/resultsPanelServerFilter.test.ts` (TASK-004 modifies case 16). No actual
    collision results, but the table is billed as the authoritative check.

CONSISTENCY:
  - **§7 "Back-compat of the `requery` message is load-bearing"** is factually wrong and
    contradicts TASK-004 case 10 and §4's "single-identifier ORDER BY unchanged". It states
    the three filter-less senders' SQL "must stay byte-identical to
    `composeRequery(sql, where, orderBy)`". With a live dialect and a simple ORDER BY,
    `composeRequerySql` (`src/ui/resultsPanel.ts:913-918`) today returns `composeSortQuery`
    → `SELECT * FROM (...) vsdb_sort ORDER BY "name" DESC`, whereas `composeRequery`
    (`src/ui/resultsGridModel.ts:1090-1108`) returns `... vsdb_sub ORDER BY name DESC` —
    different alias AND unquoted. Taken literally, TASK-004's executor reverts cycle V's
    dialect quoting and breaks `resultsPanelServerFilter.test.ts:556-571` (case 15). Scope the
    bullet to the no-dialect / empty-orderBy paths.
  - The composition path for a **multi-term ORDER BY with no `filters` and no `offset`** is
    unspecified. `composeSortQuery` takes a single `column`+`direction` and cannot express two
    terms, so TASK-004 must invent a different wrapper for `"a, b DESC"` than for `"name DESC"`
    — TASK-004 case 7 only asserts `toContain("ORDER BY ...")` and pins no alias/shape, while
    case 10 pins the single-term path to cycle V. Two wrappers for the same user gesture is a
    coin flip the plan should decide, not the executor.
  - TASK-003 case 12 (`typed[]` from the distinct cache) does not state the length-parity
    invariant. `buildFilterWhere` (`src/ui/queryComposer.ts:106`) gates on
    `typed.length === values.length` — all-or-nothing. A 2-value selection where only one
    resolves from the cache silently degrades BOTH to string literals, i.e. exactly gap 3's
    MySQL failure mode. Case 12 uses a single value and cannot catch it.

CLARITY:
  - TASK-004 Discussion #4 derives `emptyIsBlank` from "at least one loaded value is a
    `string`". This is loaded-window-dependent, so the same filter selection composes
    `IS NULL` on one page and `IS NULL OR = ''` on the next; and when a varchar column's
    loaded window is all-NULL — the case the user actually notices — the fix does not fire at
    all. Prefer the column type metadata already available at `src/ui/resultsPanel.ts:1014`
    (`freshResult.columns`) or TASK-002's distinct values.
  - The DISTINCT `where` question is listed under "Known gaps" as unverified, but it is
    decidable and I confirmed it: `src/ui/resultsPanel.ts` retains no per-statement `where`
    (no `lastWhere`/`whereByStatement`), and TASK-003's `RequestDistinctValuesMsg` carries only
    `{index, column}`. So TASK-004 will pass `""` and the dropdown will offer values the
    current filtered view cannot contain. Because §2 freezes that contract for wave-1
    parallelism, fixing it in wave 2 means re-opening a completed TASK-003. Add an optional
    `where?: string` to the message now (additive, host may ignore) or move this to §2
    out-of-scope as an accepted limitation.
  - Minor line drift: §1 item 4 cites `queryComposer.ts:123` for the `IS NULL` predicate
    (actual push is `:126`); TASK-004 Discussion #1 cites
    `resultsPanelServerFilter.test.ts:576-590` (actual describe is `:578-591`).

SCOPE:
  - none. Four tasks stay inside one subsystem (results-grid query composition); the wave
    graph (001+002+003 ∥ → 004) matches the stated dependencies, and no source file is shared
    between two tasks.

YAGNI:
  - `NULLS FIRST/LAST` with per-dialect emulation (§3.1, TASK-001 cases 9-10, plus the mssql
    `CASE` branch that must also dodge the `queryComposer.test.ts:161-182` source-text
    assertions) traces to no §1 gap and to no producer: TASK-003's `onSortChanged` emits only
    `"col ASC|DESC"`. It is reachable solely by hand-typing into the requery bar. The plan
    debates *how* to emulate it but never whether to accept the clause at all. Consider
    deferring to a later cycle and rejecting `NULLS` in `parseOrderBy` for now.

NOTES: Verified on disk — every non-`(new)` Target File exists, `src/ui/distinctValues.ts` is
correctly marked new, `package.json` has no `lint` script (so §5's `typecheck` gate is right),
and I re-ran the webview tsc snapshot: it matches the §5 baseline exactly (14/10/10/5/1). The
two CONSISTENCY items (§7's back-compat bullet and the unspecified multi-term composition path)
should be resolved before TASK-004 starts; the identifier-grammar item should be resolved before
wave 1, since it binds TASK-001 and TASK-003 simultaneously.

### Planner Revision — Round 1 findings applied — 2026-08-26 · bao-opus

1. **§7 back-compat bullet rewritten (CRITICAL).** The "byte-identical to `composeRequery`" claim
   is gone. §7 now states the contract behaviourally: with `msg.filters` absent, `handleRequery`
   keeps its exact cycle-V flow and dispatch — including `composeSortQuery` (`vsdb_sort`, quoted)
   for the single-bare-term path — and explicitly notes that `composeRequery` (`vsdb_sub`,
   unquoted) is a *different* string, so no text-identity assertion may be introduced across the
   two. Round 2 later adds the same `buildPagedQuery` parity assertion for case 13b when only part
   of a composite PK is projected; no identity claim compares `composeSortQuery` to
   `composeRequery`.
2. **Identifier charset defined (§3.1 new sub-section "Accepted identifier charset").** Accepted:
   bare `[A-Za-z_][A-Za-z0-9_$]*`, or already-quoted per dialect (`"…"` / `` `…` `` / `[…]`,
   escapes un-doubled into an unquoted logical name that `quoteIdent` re-quotes). Raw unquoted
   names with spaces/dots/quotes/non-ASCII are rejected and NEVER reach SQL unquoted. TASK-003
   now quotes a non-bare `colId` (dialect taken from the `state` header, postgres fallback)
   before building the sort message; TASK-001's `parseOrderBy` grammar, Test Cases and Interfaces
   updated to match, plus §4 and §6 rows.
3. **Multi-term composition path pinned (§3.1 new sub-section + table).** ≥2 terms (or 1 term with
   `NULLS`) and no filters/offset compose exactly
   `SELECT * FROM (<sql, ; stripped>) AS vsdb_sub[ WHERE …] ORDER BY <clause>` — alias `AS vsdb_sub`,
   no LIMIT/OFFSET. Pre-existing "wrap replaces an inner ORDER BY" behaviour documented as
   unchanged. TASK-004 case 7 now asserts the exact string; case 8 mirrors it for mssql.
4. **`emptyIsBlank` row-sniffing removed.** `FilterWhereOptions` is now
   `{ columnTypes?: Record<string, string> }` with a declared-type predicate (char/varchar/text/
   enum/set families), unknown ⇒ `false` ⇒ cycle-V `IS NULL`. §3.3 rewritten; TASK-001 cases
   14/15/16 + Interfaces updated; TASK-004 Discussion #4 replaced with an adapter-metadata
   derivation (`ColumnInfo.dataType` via a new optional `SaveContext.listColumnTypes`) and a new
   integration case 14 covering the all-NULL varchar window.
5. **DISTINCT scope decided, not deferred.** Verified the panel keeps no per-statement `where`;
   §3.4 + §2 out-of-scope + §7 now state plainly that the list is composed over the base
   statement with `where = ""` and its own LIMIT, that `RequestDistinctValuesMsg` stays
   `{index, column}` (no contract change, wave-1 parallelism intact), and that the un-scoped
   dropdown is an accepted limitation with an `INDEX.md` follow-up. TASK-002 Interfaces annotated;
   TASK-004 Discussion #6 rewritten from "unverified" to the decided call. Self-audit "Known gaps"
   entry marked RESOLVED.
6. **NULLS emulation cut (YAGNI).** §3.1's mysql/mssql `IS NULL` / `CASE` emulation is deleted and
   recorded in §2 out-of-scope. The parser still accepts `NULLS FIRST|LAST` and postgres renders
   it natively; on mysql/mssql `parseOrderBy(orderBy, dialect)` rejects it through the same single
   error channel. TASK-001 cases 9/10 rewritten (native + rejection), the mssql `CASE`
   source-text hazard is gone from the cycle, and §4's emulation row is replaced.

Also fixed while here (round-1 CLARITY/COMPLETENESS minors): §2's same-file table is now the
complete file list including both new webview test files and the `resultsPanelServerFilter.test.ts`
case-16 edit; §1 item 4's `queryComposer.ts:123` citation is annotated with the actual
`parts.push(...IS NULL)` line; TASK-004 Discussion #1 line reference corrected to `:578-591`; and
TASK-003 case 12 now pins the `typed[]` all-or-nothing length-parity invariant with a 2-value
selection (new case 14).

### Round 2 — 2026-08-26 · bao-opus
Status: Issues Found

COMPLETENESS:
  - `docs/AI_HANDOFF/PLAN.md:236-243` promises a unique trailing key, but `docs/AI_HANDOFF/tasks/TASK-004.md:215-217` passes only the first PK column. That is not unique for a composite PK and may not even be projected by an arbitrary `r.sql`, causing duplicate/skip paging or an unknown-column SQL error. The interface must support every projected PK component (or explicitly decline the tiebreaker unless a projected unique key is available) and test composite/non-projected PKs.
  - `docs/AI_HANDOFF/PLAN.md:294,345,419` requires a response for a replaced statement to be dropped, but `docs/AI_HANDOFF/tasks/TASK-004.md:63-64` tests only cache clearing followed by a later request. An old in-flight `runSql` can complete after `render()` and repopulate/post values for the new statement at the same `(index,column)`; add a captured statement identity/generation check and a host integration test for that ordering.
CONSISTENCY:
  - The required exact multi-term shape includes `AS vsdb_sub`, but `docs/AI_HANDOFF/PLAN.md:208-210` and `docs/AI_HANDOFF/tasks/TASK-004.md:43-47,67-68` omit `AS` and pin exact tests to the wrong string. Cases 7/8 must assert `SELECT * FROM (…) AS vsdb_sub ...` exactly, still with no LIMIT/OFFSET.
  - `docs/AI_HANDOFF/PLAN.md:267-270` declares a regex that does not match `LONGTEXT`, while `docs/AI_HANDOFF/tasks/TASK-001.md:65` requires `LONGTEXT` to receive the empty-string arm. Implementing the declared regex makes required case 18 fail; define a predicate that actually covers the stated text families (including MySQL `TINYTEXT`/`MEDIUMTEXT`/`LONGTEXT`) without broad substring false positives.
CLARITY:
  - `docs/AI_HANDOFF/PLAN.md:141-146` says pre-quoted identifiers are accepted per dialect, but `docs/AI_HANDOFF/tasks/TASK-001.md:29-33,56` says every quote style is accepted without regard to the supplied dialect. Pin whether `parseOrderBy(input, liveDialect)` rejects mismatched quote styles and add the corresponding test; otherwise TASK-001 and TASK-004 can implement different grammars.
SCOPE:
  - none
YAGNI:
  - none

NOTES: The six Round-1 revisions are substantially present: behavioural requery compatibility and untouched case 15 are pinned, declared-type metadata replaces row sniffing without a wave collision, DISTINCT scope is decided, and NULLS emulation is removed. The exact wrapper/identifier contracts still need reconciliation, and the fresh paging/cache findings would otherwise leave advertised correctness gaps.

### Round 2 — findings applied without re-review — 2026-08-26 · bao-opus

- **1 — Full projected PK only:** §2/§3.2/§4/§6/§7 and TASK-001 cases 11-13 now use ordered
  `tiebreakers: string[]`; TASK-004 cases 12/13/13b and Discussion #3 resolve all PK columns from
  `listPkColumns`, verify every component exists in `r.result.columns`, and otherwise pass `[]`
  with no gap-free promise. The safe-PK-projection limitation is queued in `INDEX.md`.
- **2 — Stale DISTINCT host guard:** §3.4/§4/§6 and TASK-004 Target Files, case 6b, Acceptance and
  Discussion #5 now require captured request index/column plus statement identity/generation;
  a late response after statement replacement performs neither cache write nor `postMessage`.
- **3 — Pinned wrapper corrected:** every normative multi-term wrapper and TASK-004 cases 7/8 now
  require exact `SELECT * FROM (<stripped>) AS vsdb_sub ORDER BY <terms>` shape, including `AS`.
- **4 — String family reconciled:** §3.3 now specifies normalized, family-bounded matching for
  char/varchar/text (including TINYTEXT/MEDIUMTEXT/LONGTEXT), nchar/nvarchar, enum/set and
  citext/cstring; TASK-001 case 18 adds accepted families and false-positive probes.
- **5 — Live-dialect quote grammar pinned:** §3.1 and TASK-001 cases 10b/10c now accept and
  canonicalize only the active dialect's quote style, accept all styles only when dialect is
  omitted, and reject mismatched styles through the standard visible parse error. TASK-004 case
  8b covers the host's matching/mismatched paths.

## Planner Report
PLANNER_MODEL: bao-opus
