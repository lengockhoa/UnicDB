# Code Map — VSDB

> Navigation aid for AI sessions. Source code is ground truth.
> If this conflicts with source → source wins. Update this file to match source.
> AI: when you discover new structure, fill this in. Do not wait to be asked.

## Module Map

- `src/extension.ts` — entry, `activate()`: wiring commands/panel/tree/codeLens/statusBar; danger-confirm (`confirmDangerousStatements` trước `runStatements`), `capDetail` (dùng `truncateAtBoundary`).
- `src/core/` — pure logic, không import vscode:
  - `connectionManager.ts` — connection CRUD/active.
  - `queryRunner.ts` — execute statements qua node-postgres, batching.
  - `resultBatcher.ts` — gộp kết quả nhiều statement.
  - `statementParser.ts` — tách SQL theo statement (dollar-quote/comment-aware).
  - `dangerousStatement.ts` — `analyzeStatement(sql) → {kind, hasWhere}` (skip `with` CTE prelude + `explain [analyze|analyse|verbose]` prelude), `guardTier → red|amber|none`.
  - `saveStatements.ts` — build UPDATE/INSERT từ cell edits.
  - `sslOptions.ts` — SSL config parse.
  - `text.ts` — `truncateAtBoundary(s, cap)`: slice theo code point, không đứt surrogate pair.
- `src/ui/` — host-side UI: `resultsPanel.ts` (webview panel + postMessage), `resultsGridModel.ts` (pure: set filter model từ v1.5.0), `keysetPaging.ts` (pure: browse-shape gate `assertBrowseShape` + keyset composer `composeKeysetQuery` — cycle Y), `consolePanel.ts` (SQL Console host panel, cycle Z) + `consolePanelMessages.ts` (pure: message contract + suggestSaveFileName), `schemaTree.ts`, `codeLensProvider.ts` (▶ Run, incl. shellscript), `connectionForm.ts` + messages, `statusBar.ts`.
- `src/adapters/`, `src/config/` — adapter/config helpers.
- `webview/` — webview UI: `main.ts` (AG Grid Community v36 custom IFilter + edit/requery/export), `styles.css` (incl. `.vsdb-setfilter*`, `.vsdb-console*` — cycle Z), `connectionFormMain.ts`, `consolePanelMain.ts` (Console scratchpad: textarea, Run/Save, Cmd/Ctrl+Enter, context menu; message shapes mirror `consolePanelMessages.ts` — rootDir cấm import chéo).
- `scripts/build.sh` — compile + package vsix; `install-vsdb.sh` — install từ vsix.
## DDL Stack (PostgreSQL Table Designer — cycles I/II)

- `src/core/ddl/createTable.ts` — pure CREATE TABLE generator: `TableSpec`, `ColumnSpec`, `KeySpec`, `generateCreateTable`, `defaultColumnSpecs`, `specErrors`, `UUID_DEFAULT_EXPR`, `CREATED_AT_DEFAULT_EXPR`.
- `src/core/ddl/alterTable.ts` — pure ALTER TABLE diff engine: `diffTable(before, after) → AlterPlan`, renames detected via `originalName`.
- `src/core/ddl/pgIntrospect.ts` — `INTROSPECT_COLUMNS_SQL` + `INTROSPECT_CONSTRAINTS_SQL` (parameterised) + `rowsToSpec(schema, table, colRows, conRows) → TableSpec`.
- `src/core/ddl/sampleData.ts` — `generateSampleInserts(spec, n) → string` multi-row VALUES by column-type family.
- `src/ui/newTableForm.ts` + `src/ui/newTableFormMessages.ts` — host-side New Table form data model + i18n messages (latter is pure data).
- `webview/newTableFormMain.ts` — webview logic for the New Table form: column/key rows, SQL preview, Apply via postMessage.


## Key Files

- `package.json` — version + activationEvents (`onCommand:vsdb.runScript`, `onLanguage:sql|shellscript`) + settings (`vsdb.confirmDestructive`, `vsdb.showRunLensSh`).
- `docs/AI_HANDOFF/INDEX.md` — task queue trạng thái.
- `.cache/release-notes-*.md` — gitignored, notes cho `gh release --notes-file`.

## Data Flow

Editor run command → `statementParser` tách statement → `confirmDangerousStatements` (nếu red/amber: modal, cancel = huỷ cả lô) → `queryRunner` (postgres) → `resultBatcher` → `resultsPanel` postMessage → webview `main.ts` render AG Grid (set filter model từ `resultsGridModel`).

Requery/filter/sort → `resultsPanel.composeRequerySql` → `composeKeysetQuery` (`keysetPaging.ts`: keyset predicate + LIMIT khi browse-shape + PK proven; OFFSET fallback nếu không) → runner → webview (hidden PK columns bị strip ở host; `lastKey` chưa gửi từ webview — OFFSET trong production).

## External Integrations

- PostgreSQL qua node-postgres (sslOptions). Test container `my_postgres` 127.0.0.1:5432.
- GitHub Releases (`gh`) cho distribution vsix.

## Test Coverage

- `src/**/__tests__/` + `src/extension.test.ts` + `src/scaffold.test.ts` + `src/__tests__/releaseHygiene.test.ts` — 40 files / 453 tests (sau cycle H). Bundle-eval tests load `dist/webview.js` → compile trước vitest.
- Gaps: version/README consistency tự động rồi (releaseHygiene); browser-only behaviors (CSS/display) jsdom-blind — cần browser smoke.

## Dangerous Areas

- `webview/main.ts` — file lớn nhất, DOM state (`buildPersistentDom`, gridWrap display) từng regress (cycle G Rev602: jsdom không bắt display:none bug).
- `dangerousStatement.ts` — parser thủ công; mọi prelude mới (cte/explain) phải có test RED trước.
- Copy-back worktree: gitignored artifacts không hiện trong `git diff` — copy tay + ghi path trong report.
