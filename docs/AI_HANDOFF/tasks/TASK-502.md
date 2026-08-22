# TASK-502 — Export serializers + toolbar (8 format)

- Status: `pending_review`
- Owner: `executor/feature-implementer`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Pure serializers cho 8 format export + UI export menu (Header checkbox chỉ active cho TSV/CSV/XML/JSON; SQL modes có sẵn cấu trúc) + To Clipboard / Export to file.

## Target Files

- `src/ui/resultsGridModel.ts` — append: `serializeTsv`, `serializeCsv`, `serializeXml`, `serializeJson`, `serializeSqlInserts(opts.multirow)`, `serializeSqlUpdates`, `serializeWhereClause` (Where Clause export = chuỗi WHERE của các dòng đang chọn theo PK), shared `sqlLiteral(v, kind)`.
- `webview/main.ts` — export dropdown (select) + Header checkbox + 2 button Copy / Export to file. Copy → post `{type:'copy', text}` (đã có). Export to file → post `{type:'exportFile', format, text, header}` mới.
- `src/ui/resultsPanel.ts` + `src/extension.ts` — handle `exportFile`: `showSaveDialog` defaultFileName `results.{ext}` theo format → `workspace.fs.writeFile` (UTF-8).
- `src/ui/__tests__/resultsGridModelExport.test.ts` — mới.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | serializeTsv header on/off | tab-joined, header dòng 1 khi on | cols+rows |
| 2 | unit | serializeCsv cell chứa comma/quote/newline | RFC4180 quote-escape | `a,"b""c",d` |
| 3 | unit | serializeXml | well-formed XML, `&<>` escaped | rows có `&` |
| 4 | unit | serializeJson | JSON.parse được, null giữ null | mixed rows |
| 5 | unit | serializeSqlInserts single | `INSERT INTO t (c1,c2) VALUES (1,'x');` | table=t |
| 6 | unit | serializeSqlInserts multirow | 1 INSERT nhiều `(...),(...)` | 2 rows |
| 7 | unit | serializeSqlUpdates | `UPDATE t SET c2='x' WHERE c1=1;` | pk=[c1] |
| 8 | unit | serializeWhereClause | `WHERE c1=1 AND c2='a'` (nhiều dòng đang chọn → nối OR nhóm theo row) | selection |
| 9 | edge | sqlLiteral null/number/string/boolean | `NULL`, bare, `'q''uote'`, `TRUE/FALSE` | từng loại |
| 10 | edge | rows empty | mỗi serializer trả header-only hoặc chuỗi rỗng sạch (không `NaN`/`undefined`) | 0 rows |
| 11 | integration | export CSV click → postMessage copy với đúng text | message `{type:'copy', text}` | jsdom |

## Test Files

- `src/ui/__tests__/resultsGridModelExport.test.ts`
- append `src/ui/__tests__/webviewFilters.test.ts` hoặc file mới `webviewExport.test.ts` cho integration.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsGridModelExport.test.ts src/ui/__tests__/webviewExport.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Tests PASS.
- [ ] Không regression.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- (none — không phụ thuộc 501; 501 edit state chỉ cần cho save, không cần cho export)

## Interfaces

- Consumes: `formatCell` (đã có) cho cell text.
- Produces:
  - `type ExportFormat = 'tsv'|'csv'|'xml'|'json'|'sql-inserts'|'sql-inserts-multirow'|'sql-updates'|'sql-where'`
  - `function serializeExport(format: ExportFormat, columns: string[], rows: unknown[][], opts: { includeHeader: boolean; tableName: string; pkColumns: string[]; selectedRows?: unknown[][] }): string`
  - message `{ type: 'exportFile'; format: ExportFormat; text: string }` (host ghi file).
  - TASK-503 tái dùng `sqlLiteral`.

---

## Discussion

(chưa có comment)

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Added 8-format export (TSV/CSV/XML/JSON/sql-inserts/sql-inserts-multirow/sql-updates/sql-where) — pure serializers in resultsGridModel.ts, webview toolbar (format select + Header checkbox disabled for SQL modes + Copy + Export to file), host handler (showSaveDialog → workspace.fs.writeFile), and restored dense-path row clip in applyPasteToDirty.
TEST_PLAN_FOLLOWED: inline (TASK-502 §Test Cases 1-11 + extra dense-path clip test 8c per the R4 inherited item)
FILES_CHANGED:
  - src/ui/resultsGridModel.ts: append serializeTsv/serializeCsv/serializeXml/serializeJson/serializeSqlInserts/serializeSqlUpdates/serializeWhereClause/sqlLiteral + serializeExport dispatch + ExportFormat/SerializeOptions types; restore `targetRow >= rowCount` clip in dense path of applyPasteToDirty.
  - src/ui/messages.ts: add ExportFileMessage (format + text) to WebviewMessage union.
  - webview/main.ts: import serializeExport + ExportFormat; extend PersistentDom + WebviewMsg with exportFormat/Header/Copy/File; insert toolbar (select, checkbox, two buttons) in buildPersistentDom with Header-disabled-for-SQL gate; add onExportCopyClick + onExportFileClick + readExportInput (uses gridApi.getSelectedRows() for sql-where).
  - src/ui/resultsPanel.ts: handle `exportFile` → handleExportFile (showSaveDialog defaultUri = results.<ext>, filters, workspace.fs.writeFile UTF-8). No src/extension.ts change — handleMessage is dispatched by ResultsPanel.
  - src/ui/__tests__/resultsGridModelExport.test.ts: NEW — 20 tests covering §Test Cases 1-11.
  - src/ui/__tests__/webviewExport.test.ts: NEW — 6 bundle-eval tests (toolbar wiring, format dispatch, Header toggle, Copy, Export to file, sql-where with selection).
  - src/ui/__tests__/resultsGridModelEdit.test.ts: appended test 8c — dense-path row clip (anchorRow=2, rowCount=3 → only targetRow 2 lands).
TESTS_ADDED:
  - src/ui/__tests__/resultsGridModelExport.test.ts: "serializeTsv" 2, "serializeCsv" 1, "serializeXml" 1, "serializeJson" 1, "serializeSqlInserts" 2 (single + multirow), "serializeSqlUpdates" 2 (happy + no-PK throws), "serializeWhereClause" 3 (per-row OR, no-PK fallback, no-selection uses all rows), "sqlLiteral" 1, "empty rows" 5 (TSV/CSV/JSON/XML/SQL + no NaN/undefined leakage), "serializeExport dispatch" 1.
  - src/ui/__tests__/webviewExport.test.ts: 6 — format <select> 8 options; Header enabled for tsv/csv/xml/json + disabled+unchecked for sql-*; Copy posts `{type:'copy', text}` (default TSV no-header; header checked → header line included); Export-to-file posts `{type:'exportFile', format, text}` (CSV); sql-where uses gridApi.getSelectedRows() → `WHERE (id=1 AND name='alpha') OR (id=3 AND name='gamma')`.
  - src/ui/__tests__/resultsGridModelEdit.test.ts: test 8c — `applyPasteToDirty(s, anchorRow=2, anchorCol=0, [[x1],[x2],[x3]], colCount=1, rowCount=3)` → dirtyCount=1, only rowId=2 lands.
VERIFICATION:
  command: npx vitest run src/ui/__tests__/resultsGridModelExport.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts src/ui/__tests__/webviewExport.test.ts src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/webviewFilters.test.ts
  result: 60 pass / 0 fail (5 files)
  output_excerpt: |
    ✓ src/ui/__tests__/resultsGridModelEdit.test.ts  (12 tests) 3ms
    ✓ src/ui/__tests__/resultsGridModelExport.test.ts  (20 tests) 5ms
    ✓ src/ui/__tests__/resultsPanel.test.ts  (15 tests) 16ms
    ✓ src/ui/__tests__/webviewExport.test.ts  (6 tests) 538ms
    ✓ src/ui/__tests__/webviewFilters.test.ts  (7 tests) 958ms
    Test Files  5 passed (5)
         Tests  60 passed (60)
  command: npm run typecheck
  result: exit 0
  command: npm run compile
  result: esbuild OK (dist/webview.js 3.9mb, dist/extension.js 4.6mb)
  command: npx vitest run
  result: 25 files / 289 tests pass (no regression)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

### RED output captured pre-implementation (real, not stub)

```
FAIL  src/ui/__tests__/resultsGridModelExport.test.ts > serializeTsv > 1. header on → header row + tab-joined rows
TypeError: serializeTsv is not a function
...
FAIL  src/ui/__tests__/resultsGridModelExport.test.ts > empty rows — all serializers return a clean shape > 10. no NaN / undefined tokens leak into output
TypeError: serializeExport is not a function
...
Test Files  2 failed (2)
     Tests  21 failed | 11 passed (32)
```

11 passing tests at RED time were the existing EditState / parseTsvPaste / applyPasteToDirty tests (8/8b cover the simple rowCount clip which was already implemented). 21 failures all due to `serializeX is not a function` / `serializeExport is not a function` / `sqlLiteral is not a function` / `ExportFormat is not exported`. After implementation, 32/32 pass + 6 new webview bundle tests pass.

### Design notes

- `SerializeOptions.selectedRows` only affects `sql-where`. Other formats ignore it (the contract says `selectedRows?: unknown[][]` is plumbed through, but the wire semantics are unambiguous: WHERE-clause uses selection; full export uses the dataset).
- Header checkbox is disabled + forced unchecked for any `sql-*` format because the structure (INSERT column list / UPDATE SET list / WHERE groups) is fixed.
- The dense-path clip `if (!targetRowIds && targetRow >= rowCount) continue` sits AFTER the `targetRow < 0` check so the common no-clip path is a single compare. Pre-fix dense path silently wrote into non-existent rows when `anchorRow + r >= rowCount` even though `r < n = rowCount` (impossible if `anchorRow >= 0`, but possible when caller passes `anchorRow > 0`).


## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/resultsGridModelExport.test.ts src/ui/__tests__/webviewExport.test.ts && npm run typecheck
  result: all pass (26 + typecheck exit 0); edit suite 12 pass incl 8c clip; full suite 25 files / 289 pass
TEST_PLAN_COVERAGE: all-followed — 11/11 test cases + extra dense-clip 8c; RED_OUTPUT is real TypeError output (21 fail / 11 pass)
FINDINGS:
  critical: (none)
  important:
    - src/ui/resultsGridModel.ts:354-361 — sqlLiteral backslash-escapes (`\`→`\\`, `\n`→literal `\n`). PostgreSQL (default standard_conforming_strings=on) and MSSQL give backslash NO special meaning in string literals, so a value `a\b` exports as `'a\\b'` (inserts `a\\b`) and a newline exports as literal `\n` text — exported SQL silently corrupts data on 2 of 3 supported DBs; only MySQL interprets it. Fix: drop the backslash/`\n`/`\r`/`\t` escape step entirely — emit raw characters inside the quoted literal, doubling only `'` (what pg_dump does). Update expected strings in tests 5/6/7/8 + add a round-trip case with `\` and newline.
    - webview/main.ts:1272 + src/ui/resultsGridModel.ts:504 — `readExportInput()` hardcodes `pkColumns: []` while `serializeSqlUpdates` throws on empty PK, so Copy/Export-to-file with format=sql-updates throws inside the click listener: nothing posted, no user feedback — a silently dead option among the 8 advertised. Fix: gate the option (disable until PK metadata exists), or catch in onExportCopyClick/onExportFileClick and surface the error, or fall back to full-row WHERE like sql-where. Add a click test for sql-updates.
    - src/ui/resultsGridModel.ts:457 — serializeXml interpolates the raw column name as the element tag. `SELECT 1 AS "total count"` (space; also names starting with a digit) yields `<total count>1</total count>` — NOT well-formed XML, violating test #3's own requirement; verified by probe. Fix: `<col name="<xmlEscape(c)>">value</col>` form (or sanitize to XML Name); add an aliased-column test.
  minor:
    - src/ui/resultsGridModel.ts:741,747 — duplicate `if (targetRow < 0) continue;`; the second is dead and contradicts the executor note about a single compare on the hot path. Delete one.
    - src/ui/messages.ts:53 — ExportFileMessage re-declares the 8-value format union inline instead of reusing `ExportFormat`; drift risk when a 9th format lands.
    - src/ui/resultsPanel.ts:253 — a rejected `workspace.fs.writeFile` (permissions, dropped network path) surfaces only as an unhandled rejection; wrap in try/catch → showErrorMessage.
    - webview/main.ts:422-428 — toggling CSV→sql-inserts→TSV loses the Header-checked pref (forced unchecked while in SQL mode); remember non-SQL state.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: All 3 verification commands pass fresh and the test plan is genuinely followed; the blockers are edge-value correctness (SQL string escaping, XML tag names) and one dead format in the toolbar — each is a small, well-scoped fix.

---

## Executor Report (Fix Round 1)

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Fixed 3 blocking findings + 4 minors. (1) sqlLiteral emits portable literals — only single-quote doubling; backslash and \n/\r/\t pass through raw (PG/MSSQL-safe). (2) serializeSqlUpdates degrades safely on empty PK → all-cols WHERE (no throw); onExportCopyClick / onExportFileClick also gain defensive try/catch. (3) serializeXml uses `<col name="...">v</col>` wrapper — column names live in an XML-escaped attribute, never as raw element tags. Minors: dead duplicate `targetRow < 0` removed; ExportFileMessage.format reuses ExportFormat type; writeFile rejection surfaces via showErrorMessage; Header checkbox remembers non-SQL preference across SQL-mode toggles.
TEST_PLAN_FOLLOWED: task §Test Cases (1-11) — Test Plan updated inline for R1 portable literals (tests 5/6/7/8) + new R1 cases (sqlLiteral portability 5 cases, sql-updates degradation 2 cases, XML sanitization 4 cases, webview sql-updates click 1 case).
FILES_CHANGED:
  - src/ui/resultsGridModel.ts: sqlLiteral drops backslash / \n / \r / \t escape; serializeXml wraps cells in `<col name="...">v</col>`; serializeSqlUpdates removes throw on empty PK and degrades to all-cols WHERE (also handles every-column-is-PK → SET empty); applyPasteToDirty removes dead duplicate `targetRow < 0` check.
  - webview/main.ts: readExportInput now passes pkColumns: [] (still no source until TASK-503); onExportCopyClick / onExportFileClick wrap serializeExport in defensive try/catch with console.error fallback; updateExportHeaderState remembers non-SQL header preference across SQL-mode toggles.
  - src/ui/messages.ts: ExportFileMessage.format reuses ExportFormat type (no inline 8-value union).
  - src/ui/resultsPanel.ts: handleExportFile wraps workspace.fs.writeFile in try/catch → showErrorMessage on failure.
  - src/ui/__tests__/resultsGridModelExport.test.ts: tests 5/6/7/8 expected strings updated for portable literals (newline embedded raw); test 3 updated to expect `<col name="...">v</col>` form; test 7b rewritten to assert no-throw + all-cols WHERE; new describe blocks: sqlLiteral portability (5 cases), serializeSqlUpdates empty-PK degradation (2 cases), serializeXml tag-name sanitization (4 cases).
  - src/ui/__tests__/webviewExport.test.ts: new test R1.7 — sql-updates click with no PK does not throw and posts exportFile with degraded output.
TESTS_ADDED:
  - src/ui/__tests__/resultsGridModelExport.test.ts: 11 new R1 tests (sqlLiteral portability 5 + sql-updates degradation 2 + XML sanitization 4).
  - src/ui/__tests__/webviewExport.test.ts: 1 new test (R1.7 sql-updates click no-throw).
VERIFICATION:
  command: npm run compile
  result: esbuild OK (dist/webview.js 2.2mb, dist/extension.js 4.6mb)
  command: npx vitest run src/ui/__tests__/resultsGridModelExport.test.ts src/ui/__tests__/webviewExport.test.ts
  result: 38 pass / 0 fail (31 + 7)
  output_excerpt: |
    ✓ src/ui/__tests__/resultsGridModelExport.test.ts  (31 tests) 4ms
    ✓ src/ui/__tests__/webviewExport.test.ts  (7 tests) 556ms
    Test Files  2 passed (2)
    Tests  38 passed (38)
  command: npm run typecheck
  result: exit 0
  command: npx vitest run
  result: 25 files / 301 tests pass (no regression — was 289 pre-R1; +12 from R1 new tests)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

### RED output captured pre-implementation (real, not stub)

```
FAIL  src/ui/__tests__/resultsGridModelExport.test.ts > sqlLiteral — portable ANSI SQL (Fix R1) > R1.sqlLiteral.1: backslash is NOT escaped — passes through verbatim
AssertionError: expected '"a\\\\b"' to be "'a\\b'"
Expected: "'a\\b'"
Received: "'a\\\\b'"

FAIL  src/ui/__tests__/resultsGridModelExport.test.ts > serializeSqlUpdates > 7b. UPDATE with no PK columns → degrades to all-cols WHERE (no throw)
Error: serializeSqlUpdates: pkColumns must be non-empty (no PK → use sql-where)

FAIL  src/ui/__tests__/resultsGridModelExport.test.ts > serializeXml — sanitizes tag names (Fix R1) > R1.xml.1: aliased column with space — column NAME preserved in attribute
AssertionError: expected '<?xml version="1.0" encoding="UTF-8"?><rows><row><id>1</id><total count>42</total count></row></rows>' not to contain '<total count>'

FAIL  src/ui/__tests__/webviewExport.test.ts > webview/main.ts export toolbar (TASK-502) > R1.7. sql-updates click with no PK metadata does NOT throw — posts exportFile with degraded output
Error: serializeSqlUpdates: pkColumns must be non-empty (no PK → use sql-where)
  ❯ serializeSqlUpdates src/ui/__tests__/webviewExport.test.ts
  ❯ serializeExport src/ui/__tests__/webviewExport.test.ts
  ❯ onExportFileClick src/ui/__tests__/webviewExport.test.ts

Test Files  2 failed (2)
Tests  16 failed | 22 passed (38)
Errors  1 error (the unhandled throw from sql-updates click)
```

RED: 16 tests failed — 11 R1 new tests + 4 existing tests whose expected strings encoded the broken backslash escape + 1 unhandled throw from serializeSqlUpdates in the click handler. After implementation: 38/38 pass fresh, full suite 301/301, typecheck exit 0, compile clean.

### Design notes for R1

- **sqlLiteral portability**: only `'` is doubled (ANSI). Backslash and C-style control escapes (`\n`, `\r`, `\t`) are NOT emitted — PG (default standard_conforming_strings=on) and MSSQL treat backslash literally, so the pre-fix behavior silently corrupted `a\b` → inserted `a\\b`. MySQL interprets backslash, but a non-escaped portable literal is also valid there. Newlines / tabs / CRs are embedded raw inside the quoted string — portable across all 3 supported DBs. The .sql file is round-trippable without backslash-mangling; consumers who need escape sequences for their viewer can run a separate post-processor.
- **sql-updates degradation**: empty PK is no longer fatal. The webview's click handlers used to throw with no user feedback; now the implementation falls back to all-cols WHERE (same semantics as sql-where). When every column is in the key, SET is empty — emit `UPDATE t WHERE (all cols);` without the `SET` keyword, instead of throwing. With a real PK, the SET list distinguishes the UPDATE so plain `WHERE col=val` reads cleaner (no parens on the happy path); the fallback path wraps WHERE in parens for visual symmetry with sql-where.
- **XML tag sanitization**: column names live in the `name` attribute on a `<col>` wrapper, never as a raw element tag. The attribute value is XML-escaped like the cell value, so the only place a raw column name appears in the output is inside an escaped attribute. Aliased columns like `count(*)`, `total count`, or `2nd` no longer produce malformed XML.
- **Header checkbox preference**: tracked in a closure-local `headerPrefNonSql` variable. When switching CSV→sql-inserts, the current value is saved; switching back to CSV restores it. Independent SQL toggles do not lose the user's preference.
- **Contract preserved**: `serializeExport(format, columns, rows, opts)` signature unchanged; `ExportFormat` union unchanged; `exportFile` message unchanged (now `format: ExportFormat` reuses the type instead of inline union).
