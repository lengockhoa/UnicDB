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

