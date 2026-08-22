# TASK-502 — Export serializers + toolbar (8 format)

- Status: `ready`
- Owner: `-`
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

