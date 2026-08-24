# TASK-006 (grid A, P0) — Fix no-PK save bug: hidden ctid column

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 G1; spec `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` §A

## Goal

PG no-PK table (mới tạo qua New Table form) → edit cell → commit save thành công. Thay value-matching `fetchPostgresCtids()` (fragile: Date/numeric/boolean literal round-trip lệch → 0 match → banner "Cannot save: postgres no-PK + ctid lookup failed for every dirty row") bằng hidden `ctid` column có sẵn trong result set — địa chỉ row chính xác, không value-match. Value-match giữ làm fallback khi query không có ctid column.

## Target Files

- `src/ui/resultsPanel.ts` — save flow: đọc ctid từ row data (hidden column) trước, fallback `fetchPostgresCtids` (giữ nguyên hàm); query path thêm ctid column khi PG no-PK table browse.
- `src/ui/resultsGridModel.ts` — nếu cần helper đánh dấu hidden column (columnDefs `hide: true` cho ctid) — thêm helper thuần.
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — append describe "no-PK hidden ctid column" (#1, #2, #3, #4).
- `src/ui/__tests__/resultsGridModel.test.ts` — append (#5) nếu thêm helper hidden column.

## Spec

Root cause (orchestrator notes): `fetchPostgresCtids()` (resultsPanel.ts:699-748) build `SELECT ctid FROM t WHERE col IS NOT DISTINCT FROM <literal>` cho MỌI column — literal sai kiểu (timestamp `2024-01-01T00:00:00.000Z` vs DB format, numeric, boolean) → 0 rows → all_failed. Bảng mới tạo (NULL-heavy, không PK) dễ trúng nhất.

Fix theo spec khuyến nghị:
1. **Query path**: khi panel chạy browse-table query (PG driver, table không PK — dùng `listColumns` isPrimaryKey hoặc pkColumns đã có trong save flow), host append `, ctid` vào SELECT trước khi chạy (hoặc chạy wrapper `SELECT t.*, ctid FROM (<original>) t` khi query đơn giản không phải browse — executor chọn cách ít invasive, ghi rõ trong report). Result rows mang ctid ở index cuối.
2. **Column defs**: cột ctid `hide: true` (AG Grid) — user không thấy; export/serialize bỏ cột ctid (kiểm tra serializeTsv/Csv hiện có bỏ hidden columns chưa — nếu serialize theo columns list thì cần skip hidden).
3. **Save flow** (resultsPanel.ts saveEdits handler, vùng ~397-440): trước khi gọi `fetchPostgresCtids`, đọc ctid từ row data theo index cột ctid (nếu result set có) → build `ctidByRowId` trực tiếp; chỉ khi thiếu cột ctid mới fallback `fetchPostgresCtids` (value-match cũ, giữ nguyên).
4. ctid missing trên 1 row (query không trả) → row đó skip + warning per-row (hành vi warning hiện có giữ).
5. UPDATE WHERE: `buildSaveStatements` đã nhận `ctidByRowId` (saveStatements.ts SaveStatementsOptions) — KHÔNG đổi module này.

Lưu ý grid rows → serverRows mapping: rowId hiện là index row; ctid index = columns.indexOf("ctid") nếu có. NewRowMarker rows không có ctid (INSERT, không cần).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | result set có ctid column → ctidByRowId built từ data, KHÔNG gọi fetchPostgresCtids | save flow build map từ rows; fetchPostgresCtids không được invoke (spy); UPDATE statements dùng `WHERE ctid = '(0,1)'` | fake adapter: query trả rows có ctid cột cuối; edit 1 cell; commit |
| 2 | regression | no-PK edit→commit save thành công (user-blocking bug) | KHÔNG banner "Cannot save... all_failed"; statements thực thi (adapter.runQuery gọi với UPDATE); banner success/hidden — RED trên code hiện tại với data kiểu Date/numeric (value-match path fail) | rows chứa timestamp + numeric values, không PK, ctid column có |
| 3 | edge | query KHÔNG có ctid column → fallback value-match cũ | fetchPostgresCtids được gọi; hành vi cũ (all_failed banner khi 0 match) giữ nguyên | rows không ctid; fetchPostgresCtids mock 0 match |
| 4 | edge | 1 row thiếu ctid → per-row warning, rows còn lại save | statements cho rows có ctid; warning liệt kê row thiếu | 2 rows edit, 1 row ctid null |
| 5 | edge | ctid column hidden trong grid + không xuất hiện trong export TSV/CSV | columnDefs có `{field/colId ctid, hide:true}`; serializeTsv/serializeCsv output không chứa ctid column | resultsGridModel sync với result có ctid |
| 6 | regression | bảng CÓ PK → lưu đường PK như cũ, không thêm ctid vào query | query không append ctid; save dùng pkColumns | PG table có PK |

## Test Files

- `src/ui/__tests__/resultsPanelSaveEdits.test.ts` — #1-#4, #6.
- `src/ui/__tests__/resultsGridModel.test.ts` — #5.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsGridModel.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test §Test Cases PASS; #2 RED trên code hiện tại → GREEN (user-unblocking).
- [ ] Bảng no-PK mới tạo: edit → Cmd+Enter/check icon → save thành công qua ctid addressing.
- [ ] Fallback value-match giữ nguyên cho query không ctid; ambiguous vẫn refuse với message rõ.
- [ ] Cột ctid ẩn khỏi grid + export.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `buildSaveStatements(dialect, tableName, pkColumns, columns, edits, serverRows, options?: SaveStatementsOptions)` với `SaveStatementsOptions.ctidByRowId?: ReadonlyMap<number, string>` (src/core/saveStatements.ts — KHÔNG đổi); `EditState` snapshot; ResultsPanel saveEdits message flow; `quoteIdent(name, dialect)`.
- Produces: ResultsPanel behavior — result set chứa cột `ctid` (được thêm vào query PG no-PK browse) ⇒ ctidByRowId đọc trực tiếp từ rows, fetchPostgresCtids chỉ fallback; grid column `ctid` luôn hidden + excluded khỏi export. TASK-007 (commit flow rework) tiêu thụ contract này — giữ nguyên message shape saveEdits/saveResult.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: điểm cần quyết — cách thêm ctid vào query. Ưu tiên ít invasive: chỉ intercept ở browse-table path (panel biết table name + pk state qua save flow metadata); hand-written query không ctid → fallback cũ (đã đúng behavior #3). Nếu panel không có table metadata tại query time, dùng wrapper `SELECT t.*, ctid FROM (...) t` CHỈ khi parseFromClause xác định single simple table (saveStatements.ts:234 đã có parser) — ghi quyết định vào Executor Report.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
