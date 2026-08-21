# VSDB — Manual Testing Checklist (v1)

Smoke checklist cho bản release đầu tiên (v1.0.0). Chạy trên Extension Development
Host (`F5`) hoặc sau khi install từ `.vsix`. Mỗi DB test một lần; check cả
positive + negative luồng.

> In checklist này → tick thủ công từng dòng khi test. Báo cáo issue vào
> [GitHub Issues](https://github.com/lengockhoa/VSDB/issues).

---

## Chuẩn bị

- [ ] Docker chạy (Postgres / MySQL / MSSQL testcontainers).
- [ ] Sample data: bảng `users(id, name, email)` ~100k rows; bảng `orders(id, user_id, total)` ~500k rows.
- [ ] `npm run watch` đang chạy (dev) HOẶC `.vsix` đã install (release).
- [ ] `code` CLI trên `PATH`.

---

## 1. Connection management

- [ ] **Add**: `+` trên panel → điền form → test connect thành công với 3 driver (pg / mysql / mssql).
- [ ] **Edit**: click phải connection → Edit → đổi password → save → test lại OK.
- [ ] **Delete**: click phải connection → Delete → confirm → biến mất khỏi panel.
- [ ] **Select active**: status bar hiện tên connection sau khi chọn; click để đổi.
- [ ] **Persistence**: reload VS Code → connection vẫn còn.

## 2. Query execution (Cmd+Enter / Ctrl+Enter)

- [ ] **Single statement**: `SELECT 1` → chạy, kết quả hiện trong panel.
- [ ] **Statement trong script nhiều câu**: chỉ câu đang select chạy, không chạy cả file.
- [ ] **No selection**: đặt con trỏ giữa câu → chạy đúng câu đó.
- [ ] **Comment block**: `/* ... */ SELECT ...` → chạy đúng câu SQL, bỏ qua comment.
- [ ] **String literal có `;`**: `SELECT 'a;b'` → không split nhầm.
- [ ] **Quoted identifier có `(`**: `[fn(1)](2)` → không nhầm function call với identifier.
- [ ] **Keybinding đúng OS**: macOS dùng `Cmd+Enter`, Win/Linux dùng `Ctrl+Enter`.
- [ ] **Outside `.sql` file**: keybinding không kích hoạt.

## 3. Editor UI buttons

- [ ] **Nút ▶ (Run) trên title bar** khi focus trong `.sql` → chạy query.
- [ ] **Nút ■ (Cancel)** khi đang chạy → query bị cancel phía server, panel hiện "Cancelled".
- [ ] **CodeLens ▶ Run** trên mỗi statement → click chạy đúng câu.
- [ ] **Tắt CodeLens**: setting `vsdb.showRunLens = false` → CodeLens biến mất, restart vẫn tắt.

## 4. Schema Explorer

- [ ] **Tree expand**: connection → database → schema → table → column.
- [ ] **Tables + views + routines** (nếu DB có) hiển thị đúng loại.
- [ ] **Right-click table/view → Generate SELECT** → chèn `SELECT * FROM schema.table` vào editor.
- [ ] **Right-click → Copy Qualified Name** → clipboard có `schema.table` / `schema.table.column`.
- [ ] **Refresh button** trên title bar → reload metadata sau khi tạo table mới.

## 5. Result panel

- [ ] **Small result** (< 500 rows): hiện tất cả trong 1 lần.
- [ ] **Large result** (> 500 rows): hiện 500 rows + nút **Load 500 more** ở cuối → click thêm.
- [ ] **`vsdb.batchSize` = 1000**: reload extension → load 1000 mỗi lần.
- [ ] **Cancel giữa chừng**: click ■ khi đang load → dừng ngay, không load thêm.
- [ ] **Column types**: timestamp/date/bytea/blob render đúng (string / hex / base64).
- [ ] **NULL cells**: hiện `(NULL)`, không vỡ layout.

## 6. Cancel & errors

- [ ] **`SELECT pg_sleep(60)`** → click ■ trong vòng 2s → query cancel; check `pg_stat_activity` thấy `idle`.
- [ ] **`SELECT SLEEP(60)`** (MySQL) → cancel tương tự.
- [ ] **Syntax error**: `SELEC 1` → panel hiện error message rõ ràng, không crash extension.
- [ ] **Connection lost giữa chừng**: kill DB container → query báo lỗi, status bar cập nhật, không treo.

## 7. Multi-connection

- [ ] Mở 2 file `.sql` với 2 connection khác nhau (pg + mysql) → mỗi file dùng connection của nó khi chạy.
- [ ] Đổi active connection → file đang focus dùng connection mới; file kia giữ connection cũ.

## 8. Packaging / install (release smoke)

- [ ] `bash scripts/build.sh` exit 0, in path `.vsix`.
- [ ] `bash scripts/install-vsdb.sh --local dist/vsdb-*.vsix` exit 0.
- [ ] `code --list-extensions | grep vsdb` thấy `lengockhoa.vsdb`.
- [ ] Gỡ + cài lại nhiều lần (idempotency): luôn ra cùng version cuối.

---

## Pass criteria

Bản release v1.0.0 sẵn sàng khi:

- 100% dòng trên được tick (trừ driver-specific khi chỉ smoke 1 DB).
- Không có regression từ `npm test` + `npm run test:integration`.
- `.vsix` install thành công trên ≥ 1 máy macOS và ≥ 1 máy Linux.

Báo issue vào repo kèm: VS Code version, OS, DB driver, repro steps, log.
