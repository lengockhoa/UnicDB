# PLAN — cycle 2026-08-22-D+E

## §1 Intent

User (2026-08-22, after v1.3.2 release): "chạy cho xong mấy round kia luôn cho đủ trọn gói rồi update lên version mới thôi" — làm nốt cả 2 cycle queued (D + E) trong một run fullstack, release một bản mới sau khi pass toàn bộ gates.

- **Cycle D** — Results grid edit mode + export (yêu cầu gốc 2026-08-22):
  - Inline cell edit; **Cmd/Ctrl+Enter commit 1 lần (batch)** — không auto-commit từng cell.
  - Paste từ Excel (TSV) vào vùng chọn; auto-ignore dòng/cột thừa (outside grid bounds).
  - Export toolbar: TSV / CSV / XML / JSON / **SQL Inserts** / **SQL Insert Multirow** / **SQL Updates** / **Where Clause** (SQL modes có thêm Header checkbox + To Clipboard / Export to file) + Header checkbox (include column names) + To Clipboard / Export to file.
  - Save chỉnh sửa theo PK; khi bảng **không PK**: PostgreSQL dùng `ctid` (kèm warning banner), adapters khác ref sử edit.
  - **WHERE/ORDER BY bar**: input WHERE + ORDER BY, nút Re-Run áp vào query gốc.
  - Toolbar grid: Refresh / Add Row / Delete Row / Undo / CSV toggle / Commit.
- **Cycle E** — Run `.sh` button: mở file `.sh` → nút Run chạy nội dung script như chạy full file trong terminal (Integrated Terminal).

## §2 Scope

**In:**
- `webview/main.ts` — edit model (dirty cells, add/delete row, undo), paste TSV handler, export menu (8 format + header toggle + clipboard/file), WHERE/ORDER BY bar, toolbar buttons, commit shortcut Cmd/Ctrl+Enter, PK/ctid warning banner.
- `src/ui/resultsGridModel.ts` — pure logic: edit-state reducer, TSV parse, SQL/CSV/XML/JSON serializers, WHERE/ORDER BY composer. (testable, no DOM)
- `src/ui/messages.ts` + `src/ui/resultsPanel.ts` + `src/extension.ts` — message protocol mở rộng (save edits, export file, refresh-with-clause, run-script).
- `src/adapters/types.ts` + adapters (postgres/mysql/mssql) — build UPDATE/INSERT/DELETE theo PK/ctid, hỗ trợ `runScript` cho file terminal.
- `src/ui/codeLensProvider.ts` (hoặc toolbar trong extension.ts) — Run .sh button.
- Version bump 1.3.2 → **1.4.0** (minor: feature release), README, CHANGELOG nếu có.

**Out:**
- Enterprise AG Grid (set filter, …) — Community only.
- Edit trên result của nhiều statement cùng lúc (chỉ tab active).
- Edit khi result set là aggregate/window (no PK, non-postgres) — warning, ref sử.

## §3 Approach

Paste: `paste` event trên grid host → parse TSV (split `\n` / `\t`) → tĩnh widen selection (chỉ trong bounds) → mark dirty. Excel cells thừa (ngoài grid) silently ignored; dòng thiếu cell → pad empty string.


Export: pure serializer trong `resultsGridModel.ts` (input: columns, rows, options) → trả string → webview copy (`vscodeApi.postMessage({type:'copy'…})`) hoặc host writes file (`showSaveDialog` + `writeFile`). SQL modes thêm option `includeHeader` (Header checkbox) — SQL Inserts/Multirow/Updates ignore header (structure fixed); TSV/CSV/XML/JSON dùng header khi checked.

WHERE/ORDER BY bar: 2 input + nút Re-Run → post `{type:'requery', index, where, orderBy}` → host rebuild query `SELECT * FROM (<original>) sub WHERE … ORDER BY …` → chạy lại qua QueryRunner (limit cũ) → state mới.

Run .sh: extension.ts đăng ký command `vsdb.runScript` (title "Run Script") + button (editor title) hiện khi `languageId === 'shellscript'` → `vscode.window.createTerminal({ name:'VSDB Script' })` → `terminal.sendText(fullFileContent)` → `terminal.show()`. "Như chạy full file" = gửi nguyên nội dung file vào terminal — giống paste file vào shell, không tạo tmp file, không `bash -c`.

## §4 Test Plan (TDD)

| # | Layer | Test | Expected |
|---|-------|------|----------|
| 1 | unit (resultsGridModel) | `parseTsvPaste` happy: 2x3 TSV → 2 rows 3 cells | exact arrays |
| 2 | unit | `parseTsvPaste` edge: dòng cuối `\n` rỗng, cell có quote `"a\tb"`, CRLF | strip empty trailing line; quoted tab preserved |
| 3 | unit | `parseTsvPaste` edge: row nhiều cells hơn grid columns | executor-layer clip theo grid bounds (hàm trả full, caller clip) |
| 4 | unit | `serializeTsv/Csv` header on/off, comma-in-cell quoting | CSV quote + escape `"`;
| 5 | unit | `serializeXml/Json` | well-formed, values escaped |
| 6 | unit | `serializeSqlInserts` + multirow | `INSERT INTO t (cols) VALUES (...);` single + multirow gộp |
| 7 | unit | `serializeSqlUpdates` | `UPDATE t SET c=v WHERE pk=…;` per row |
| 8 | unit | `serializeWhereClause` | `WHERE pk1=v1 AND pk2=v2` đúng loại literal (string quote, number bare, null → `IS NULL`) |
| 9 | unit | edit reducer: markDirty/undo/commit batch | dirty set đúng, undo pop stack, commit clear |
| 10 | unit | `composeRequery` | SELECT wrapper + WHERE/ORDER BY inject an toàn |
| 11 | unit | `buildSaveStatements` postgres ctid khi no PK | `UPDATE t SET … WHERE ctid='(0,1)'` + warning flag |
| 12 | unit | `buildSaveStatements` mysql/mssql no PK | trả null + reason "no_pk" (ref sử edit) |
| 13 | integration (jsdom) | webview edit flow: set cell value → dirty; Cmd+Enter → postMessage saveEdits 1 lần | posted payload đúng shape |
|  eval | integration | paste event simulate → dirty cells đúng vùng | mark correct cells |
|  eval | integration | export click → message copy/file với đúng serializer output | message shape |
| 14 | integration (extension) | runScript command + editor title button | terminal created, sendText gọi với full content |
| 15 | regression | full suite existing (232) vẫn pass | 0 fail |

Edge cases khác loại: (a) empty/quoted TSV, (b) boundary commit-with-no-edits (no-op, không post), (c) null literal SQL, (d) no-PK non-postgres.

## §5 Verification Commands

```bash
npm run compile
npx vitest run
npm run typecheck
```

Browser smoke (release gate): `.cache/webview-repro/aggrid.html` — edit 1 cell → dirty indicator, Cmd+Enter → 1 postMessage, paste TSV → dirty vùng, export CSV → clipboard message đúng, WHERE input → requery message đúng.

## §6 Acceptance Criteria

- [ ] Edit/paste/undo hoạt động trên grid thật (browser smoke).
- [ ] Cmd+Enter post đúng 1 message saveEdits chứa mọi dirty cells.
- [ ] Export 8 format + header toggle + clipboard/file đúng output serializer.
- [ ] PK/ctid save; no-PK non-postgres hiện warning + ref sử.
- [ ] WHERE/ORDER BY re-run query.
- [ ] Run .sh button chạy full file trong terminal.
- [ ] Full suite pass (232+ mới), typecheck, compile, browser smoke pass.
- [ ] Version 1.4.0, README, release v1.4.0 với VSIX.

## §7 Task split

- **TASK-501** (P0, M) — Edit model + paste TSV + undo + toolbar (add/delete/undo/CSV toggle) trong `src/ui/resultsGridModel.ts` (pure) + wire vào `webview/main.ts`.
- **TASK-502** (P0, M) — Export: serializers (8 format) trong `src/ui/resultsGridModel.ts` + export toolbar UI + clipboard/file path qua host.
- **TASK-503** (P0, L) — Save edits: message protocol + adapters buildSaveStatements (PK/ctid/no-PK) + warning banner + Commit button flow.
- **TASK-504** (P1, S) — WHERE/ORDER BY bar + requery flow.
- **TASK-505** (P1, S) — Run .sh button (extension.ts + terminal).
- **TASK-506** (P1, S, W3 boundary) — Version 1.4.0 + README + full-suite gate.

Waves (file-disjoint): W1: 501, 502, 505 (501/502 đụng resultsGridModel.ts nhưng là append-only sections khác nhau — reviewer chia shared file note; 505 chỉ extension.ts). W2: 503 (depends 501 edit state + 502 message shape). W3: 504, 506 (504 depends 501 UI harness; 506 boundary full suite).

Thật ra 501+502 cùng `resultsGridModel.ts` → move 502 xuống W2, 503 W3, 504 W4, 506 W5? Không — quá nhiều wave. Gộp: **W1: 501+505** (disjoint), **W2: 502** (resultsGridModel tiếp), **W3: 503**, **W4: 504**, **W5: 506** (boundary). 5 waves + review mỗi task. Chuẩn RULES: 1 commit/wave.

Planner self-audit: scope D+E lớn nhưng tách task sạch theo layer (pure model → UI wire → host/adapter → release); mọi test đều bite (serializer sai → diff string; reducer sai → state sai; integration giả postMessage). Kebab/dirty-map approach là cách AG Grid Community chuẩn (không Enterprise row editing). Giữ theme Theming API (không CSS legacy). Cmd+Enter commit batching khớp yêu cầu "commit 1 lần".
