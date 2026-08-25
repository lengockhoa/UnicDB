# INDEX

Cycle V -- **SQL COLORING + SERVER-SIDE FILTER/PAGING/SORT**: TextMate injection grammar,
schema-aware semantic tokens, webview SQL tokenizer, dialect query composer, server-side
column filter + Load More paging, MSSQL sort helper. 6 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | SQL TextMate injection grammar + package.json contribution | done | claude-sonnet-5 | bao-opus |
| TASK-002 | Schema-aware SQL semantic tokens provider | done | claude-sonnet-5 | bao-opus |
| TASK-003 | Webview SQL tokenizer + themed styles | done | claude-sonnet-5 | bao-opus |
| TASK-004 | Dialect query composer: filter WHERE + OFFSET/LIMIT paging + sort dispatch | done | claude-sonnet-5 | bao-opus |
| TASK-005 | Server-side column filter + Load More paging (host + webview wiring) | done | claude-sonnet-5 | bao-opus |
| TASK-006 | MSSQL server-side sort query (T-SQL dialect) | done | bao-sonnet | bao-opus |

Graph: 004 --> 005, 004 --> 006. 001, 002, 003, 004 are all independent.

- **Wave 1 (4, parallel):** 001, 002, 003, 004
- **Wave 2 (2, parallel):** 005, 006

File-collision decisions:
- `webview/main.ts` is touched by TASK-003 (wave 1, one-line swap at `:2760`) and TASK-005
  (wave 2, filter/paging wiring). Different waves, so not a same-wave collision; TASK-005
  must re-read the file before editing.
- `src/ui/queryComposer.ts` is created by TASK-004 (wave 1) and amended by TASK-006
  (wave 2) -- serialized by the dependency, never concurrent.
- `src/ui/__tests__/queryComposer.test.ts` likewise: created by TASK-004, appended by
  TASK-006.
- `webview/styles.css` belongs solely to TASK-003; TASK-005 reuses existing classes.
- TASK-001 owns `package.json` + `syntaxes/`; TASK-002 owns `src/extension.ts` +
  `src/ui/sqlSemanticTokens.ts`. No overlap in wave 1.

## Previous cycles

Cycle U (9 tasks, all done) shipped at `08c8de3` (v1.6.4). See `archive/cycle-U-*` for
completed task files and the cycle plan.
Cycle T (12 tasks, all done) shipped at `4a35fec`. See `archive/cycle-T-*`.

## Next cycles (queued)

- **Sort header-click wiring for all three dialects.** `getTableSortQuery` (postgres) and
  its MSSQL twin (cycle V TASK-006) exist as pure builders with no production call site;
  the AG Grid column-header sort event still sorts client-side only. Deferred because the
  click handler lives in `webview/main.ts`, which cycle V already edits in both waves.
- **Server-side distinct values for the set-filter list.** The filter dropdown is still
  built from loaded rows (`buildSetFilterEntries`), so with server-side filtering a value
  outside the loaded window cannot be selected. Needs a `SELECT DISTINCT col ... LIMIT n`
  round trip per column plus a cache.
- **`(Blanks)` should also match empty strings.** Cycle V maps `(Blanks)` to `col IS NULL`
  only; AG Grid groups `null`/`undefined`/`""` together. Needs a dialect-aware
  `IS NULL OR col = ''` and a decision about whitespace-only values.
- **Keyset (cursor) paging.** Cycle V uses OFFSET/LIMIT, which degrades on deep offsets.
  A keyset scheme needs a stable unique sort key per result set.
- **Typed filter values beyond the loaded window.** Cycle V derives `typed[]` from loaded
  grid rows; when a selected value's row has been evicted the predicate falls back to
  string literals (index-losing on MySQL). Pairs naturally with the server-side distinct
  values work above, which would carry real types from the server. Also revisit the
  UTC-naive timestamp normalization for MySQL/MSSQL sessions not running in UTC.
- **General ORDER BY dialect quoting.** Cycle V only routes a single bare identifier from
  the requery bar through `composeSortQuery`; `a, b DESC` and expressions pass through raw.
