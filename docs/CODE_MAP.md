# Code Map — UnicDB

> Navigation aid for AI sessions. Source code is ground truth.
> If this conflicts with source → source wins. Update this file to match source.
> AI: when you discover new structure, fill this in. Do not wait to be asked.

## Module Map

- `src/extension.ts` — entry, `activate()`: wiring commands/panel/tree/codeLens/statusBar; danger-confirm (`confirmDangerousStatements` before `runStatements`), `capDetail` (uses `truncateAtBoundary`).
- `src/core/` — pure logic, no vscode import:
  - `connectionManager.ts` — connection CRUD/active.
  - `queryRunner.ts` — execute statements via node-postgres, batching.
  - `resultBatcher.ts` — merges results across multiple statements.
  - `statementParser.ts` — splits SQL by statement (dollar-quote/comment-aware).
  - `dangerousStatement.ts` — `analyzeStatement(sql) → {kind, hasWhere}` (skip `with` CTE prelude + `explain [analyze|analyse|verbose]` prelude), `guardTier → red|amber|none`.
  - `saveStatements.ts` — builds UPDATE/INSERT from cell edits.
  - `sslOptions.ts` — SSL config parse.
  - `text.ts` — `truncateAtBoundary(s, cap)`: slice by code point, does NOT split surrogate pairs.
- `src/ui/` — host-side UI: `resultsPanel.ts` (webview panel + postMessage), `resultsGridModel.ts` (pure: set filter model since v1.5.0), `keysetPaging.ts` (pure: browse-shape gate `assertBrowseShape` + keyset composer `composeKeysetQuery` — cycle Y), `consolePanel.ts` (SQL Console host panel, cycle Z) + `consolePanelMessages.ts` (pure: message contract + suggestSaveFileName), `schemaTree.ts`, `codeLensProvider.ts` (▶ Run, incl. shellscript), `connectionForm.ts` + messages, `statusBar.ts`.
- `src/adapters/`, `src/config/` — adapter/config helpers.
- `webview/` — webview UI: `main.ts` (AG Grid Community v36 custom IFilter + edit/requery/export), `styles.css` (incl. `.UnicDB-setfilter*`, `.UnicDB-console*` — cycle Z), `connectionFormMain.ts`, `consolePanelMain.ts` (Console scratchpad: textarea, Run/Save, Cmd/Ctrl+Enter, context menu; message shapes mirror `consolePanelMessages.ts` — rootDir forbids cross-import).
- `scripts/build.sh` — compile + package vsix; `install-UnicDB.sh` — install from vsix.
## DDL Stack (PostgreSQL Table Designer — cycles I/II)

- `src/core/ddl/createTable.ts` — pure CREATE TABLE generator: `TableSpec`, `ColumnSpec`, `KeySpec`, `generateCreateTable`, `defaultColumnSpecs`, `specErrors`, `UUID_DEFAULT_EXPR`, `CREATED_AT_DEFAULT_EXPR`.
- `src/core/ddl/alterTable.ts` — pure ALTER TABLE diff engine: `diffTable(before, after) → AlterPlan`, renames detected via `originalName`.
- `src/core/ddl/pgIntrospect.ts` — `INTROSPECT_COLUMNS_SQL` + `INTROSPECT_CONSTRAINTS_SQL` (parameterised) + `rowsToSpec(schema, table, colRows, conRows) → TableSpec`.
- `src/core/ddl/sampleData.ts` — `generateSampleInserts(spec, n) → string` multi-row VALUES by column-type family.
- `src/ui/newTableForm.ts` + `src/ui/newTableFormMessages.ts` — host-side New Table form data model + i18n messages (latter is pure data).
- `webview/newTableFormMain.ts` — webview logic for the New Table form: column/key rows, SQL preview, Apply via postMessage.


## Key Files

- `package.json` — version + activationEvents (`onCommand:UnicDB.runScript`, `onLanguage:sql|shellscript`) + settings (`UnicDB.confirmDestructive`, `UnicDB.showRunLensSh`).
- `docs/AI_HANDOFF/INDEX.md` — task queue status.
- `.cache/release-notes-*.md` — gitignored, notes for `gh release --notes-file`.

## Data Flow

Editor run command → `statementParser` splits statement → `confirmDangerousStatements` (if red/amber: modal, cancel aborts the entire batch) → `queryRunner` (postgres) → `resultBatcher` → `resultsPanel` postMessage → webview `main.ts` renders AG Grid (set filter model from `resultsGridModel`).

Requery/filter/sort → `resultsPanel.composeRequierySql` → `composeKeysetQuery` (`keysetPaging.ts`: keyset predicate + LIMIT when browse-shape + PK proven; OFFSET fallback otherwise) → runner → webview (hidden PK columns stripped on the host; `lastKey` not yet sent from webview — OFFSET in production).

## External Integrations

- PostgreSQL via node-postgres (sslOptions). Test container `my_postgres` 127.0.0.1:5432.
- GitHub Releases (`gh`) for vsix distribution.

## Test Coverage

- `src/**/__tests__/` + `src/extension.test.ts` + `src/scaffold.test.ts` + `src/__tests__/releaseHygiene.test.ts` — 117 files / 1695 tests (after cycle Z). Bundle-eval tests load `dist/*.js` → compile before vitest (`consolePanelBundle.test.ts` requires `dist/consolePanel.js`).
- Gaps: version/README consistency is automated now (releaseHygiene); browser-only behaviors (CSS/display) are jsdom-blind — need browser smoke.

## Dangerous Areas

- `webview/main.ts` — largest file, DOM state (`buildPersistentDom`, gridWrap display) has regressed before (cycle G Rev602: jsdom did not catch the display:none bug).
- `dangerousStatement.ts` — manual parser; every new prelude (cte/explain) MUST have a RED test first.
- Copy-back worktree: gitignored artifacts do NOT show up in `git diff` — copy manually + record the path in the report.
