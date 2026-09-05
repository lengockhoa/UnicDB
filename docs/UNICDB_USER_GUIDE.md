# Hướng dẫn sử dụng UnicDB

> Hướng dẫn toàn bộ các dùng bộ UnicDB — VS Code extension cho PostgreSQL /
> MySQL / MSSQL / BigQuery.

## Cài đặt

Cài đặt UnicDB vào VS Code:

```bash
code --install-extension UnicDB-<version>.vsix
```

Sau khi cài, extension tự động kích hoạt khi mở workspace có file SQL.
Không cần cấu hình thêm — kết nối đầu tiên sẽ được tạo từ form khi bạn
bấm "Add Connection" trên thanh Schema Explorer.

## Kết nối

UnicDB hỗ trợ 4 driver:

- **PostgreSQL** — host, port, user, password, database
- **MySQL** — host, port, user, password, database
- **MSSQL** — host, port, user, password, database (hỗ trợ bracket-quoted
  identifier)
- **BigQuery** — ADC (Application Default Credentials), billing project,
  location

Mỗi kết nối được lưu vào `UnicDB.connections` globalState. Bạn có thể có
nhiều connection cùng lúc; "active connection" là connection đang hiển
thị trong Schema Explorer.

## Schema Explorer

Cây schema bên trái hiển thị:

- Schemas → Tables / Views / Routines / Types
- Mỗi table có các column (PK/UQ/FK marker)
- Mỗi view có column list
- Routine có parameter list

### Filter & Search

- Thanh filter phía trên cây schema — gõ để lọc theo tên bảng
- Dropdown "Select All" / "Deselect All" cho multi-select (khi áp dụng
  filter nâng cao)
- Hide system schemas — tùy chọn ẩn `pg_catalog`, `information_schema`

### Refresh

- Nút refresh thủ công trên title bar — invalidate toàn bộ schema
  cache + autocomplete + tree
- Tự động refresh sau khi chạy query (xem phần Results bên dưới)

## SQL Console

Mỗi connection có một console panel riêng (singleton) với:

- **Tabs** — mỗi tab là một buffer SQL độc lập
- **History** — lưu các lệnh đã chạy (10 cái gần nhất)
- **Drafts** — workspaceState lưu draft giữa các session
- **Open for Object** — chuột phải table/view/function → "Open Console for
  Object" mở tab mới với DDL pre-fill

### SQL Generator (R3+R4)

Chuột phải view hoặc routine → "SQL Generator" → mở console mới với
`CREATE VIEW ...` hoặc `CREATE FUNCTION ...` DDL pre-filled. DDL được
lấy qua `pg_get_viewdef()` / `pg_get_functiondef()` (PostgreSQL).

### Insert Sample Data (R1)

Chuột phải table → "Insert Sample Data…" → mở console mới với
`INSERT INTO schema.table ...` template (3 dòng mẫu + comment
`-- Edit values, then run`). User tự sửa values rồi Run (không tự
execute).

## Results

Kết quả trả về hiển thị trong grid. Tùy chỉnh placement:

- `UnicDB.resultsPlacement` — `below` (mặc định) / `beside` / `top`
- Đổi bằng cách mở Settings (Ctrl+,) → search "UnicDB.resultsPlacement"

### DDL/DML status card (R12)

Khi chạy `CREATE TABLE` / `DROP VIEW` / `INSERT ...` thành công, grid
không hiển thị bảng rỗng — thay vào đó hiển thị thẻ:

- ✅ Success — DDL/DML ran successfully: `<thông tin>`
- ❌ Failure — kèm error message

BigQuery path: vẫn giữ hành vi cũ (`kind === undefined`).

### Export

- CSV / JSON / TSV — copy header + rows
- Copy an toàn — paste vào spreadsheet hoặc JSON viewer

## AI Chat

Panel chat bên phải hỗ trợ nhiều engine (Claude / OpenAI / Ollama /
tùy chỉnh). Tính năng:

- **Thinking row** (R11) — khi user gửi message, một dòng "AI is
  thinking…" hiện dưới bubble user, có spinner. Tự ẩn khi có delta
  đầu tiên hoặc lỗi.
- **Code blocks** — fenced code block trong response render thành
  `<pre><code>` với nút copy (góc trên-phải). Click để copy raw code
  vào clipboard.
- **Inline code** — `<code>` với hover copy.
- **Truncation fix** (R9+R10) — bubble chat không tràn cột phải.

## Settings hub (R8b)

Bấm icon ⚙️ (settings gear) trên title bar của Schema Explorer để mở
VS Code Settings filtered to UnicDB. Các setting UnicDB hiện có:

- `UnicDB.resultsPlacement` — `below` / `beside` / `top`
- `UnicDB.aiChatEngine` — chọn engine
- `UnicDB.aiChatModel` — model cụ thể
- (các setting khác xuất hiện khi extension thêm)

## User Guide (R2)

Bấm icon 📖 (book) trên title bar của Schema Explorer để mở file
này (`docs/UnicDB_USER_GUIDE.md`) trong Markdown preview.

## Schema Refresh (R13)

Sau khi chạy query thành công, Schema Explorer tự động refresh để
phản ánh trạng thái mới — không cần bấm refresh thủ công:

- **DDL** (CREATE / ALTER / DROP / COMMENT ON …) — full refresh:
  drop completion cache + autocomplete context cache + tree.
- **DML** (INSERT / UPDATE / DELETE / TRUNCATE / MERGE) — tree-only
  refresh (row count changed, không cần bust cache).
- **SELECT** — không refresh (chỉ đọc, schema không đổi).
- **Empty / failed batch** — không refresh.

Khi user chạy nhiều query liên tiếp, các refresh được coalesce qua
200ms trailing debouncer — bùng nổ 5 query DML liên tiếp chỉ tốn 1
tree refresh.

## Phím tắt

- **Run statement** — F5 hoặc Ctrl+Enter trong editor
- **Run all** — Ctrl+F5
- **Cancel** — Esc khi đang chạy
- **New tab** — Ctrl+Alt+T
- **Close tab** — Ctrl+W
- **Toggle Schema Explorer** — Ctrl+Alt+S
- **Open AI Chat** — Ctrl+Alt+A

## Troubleshooting

- **Connection refused** — kiểm tra host/port/firewall
- **Schema tree rỗng** — bấm refresh (hoặc chạy 1 query DDL/DML)
- **Console không mở** — bấm chuột phải vào table bất kỳ → Open Console
  for Object
- **AI Chat không phản hồi** — kiểm tra `UnicDB.aiChatEngine` +
  credentials của provider

## Thông tin thêm

- [README](../README.md) — overview + key features
- [CHANGELOG](../CHANGELOG.md) — lịch sử release
- [AI_HANDOFF](../AI_HANDOFF/INDEX.md) — task pipeline history
