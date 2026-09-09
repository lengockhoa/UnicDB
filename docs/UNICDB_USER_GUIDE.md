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

Mở SQL Console từ Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) bằng lệnh
**`UnicDB: Open Console`**, hoặc bấm biểu tượng terminal trên thanh tiêu đề
Schema Explorer. Chuột phải vào connection, schema, category, table hoặc view
để dùng **Open Console for Object**; connection/schema/category mở tab SQL rỗng,
còn table/view mở tab có sẵn câu `SELECT` phù hợp với driver.

Trong Console:

- Gõ SQL vào editor rồi bấm **Run** hoặc nhấn `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux).
- Bôi đen một đoạn SQL rồi dùng **Run Selection** để chỉ chạy đoạn đã chọn.
- Dùng **+ Tab** để mở buffer SQL mới; mỗi connection giữ một console panel riêng.
- **History**, **Format**, **Explain**, **Explain Analyze** và **Save** có sẵn trên toolbar.

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

Kết quả SQL luôn mở ở panel dưới màn hình (cạnh tab Terminal) — không thể đổi vị trí.

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

- `UnicDB.aiChatEngine` — chọn engine
- `UnicDB.aiChatModel` — model cụ thể
- (các setting khác xuất hiện khi extension thêm)

## Generate Commit Message

Trên title bar của panel **Source Control** xuất hiện thêm một nút
sparkle ✨ (icon `$(sparkle)`) — bấm vào đó để UnicDB tự sinh commit
message theo chuẩn **Conventional Commits** rồi điền thẳng vào ô nhập
commit của SCM. Bạn chỉ cần review lại rồi bấm Commit.

- Nút chỉ hiện khi repository đang có thay đổi git (file staged hoặc
  unstaged).
- Nếu repo sạch, nút được disable và tooltip nhắc lý do.
- Tin nhắn được sinh bằng **Lite Model** mà bạn đã cấu hình trong AI
  Settings (mục tiếp theo). Model xử lý diff đã staged (ưu tiên) hoặc
  unstaged, có giới hạn kích thước — repo cực lớn sẽ được truncate.
- Nếu chưa cấu hình Lite Model, nút sparkle sẽ hiện toast hướng dẫn mở AI
  Settings (action `Open AI Settings`).

Trong panel **UnicDB AI Settings** có một subsection riêng tên là
"Lite model" — đây là model thứ tư trong taxonomy
`work | smart | autocomplete | lite`, dùng riêng cho nút sparkle ở
Source Control.

- **Model ID** — bắt buộc điền. Bỏ trống = tính năng của nút sparkle bị
  disable (nút sẽ báo toast khi bấm).
> Lite section không còn dropdown Engine riêng. Nút sparkle dùng **đúng
> engine global** đang chọn ở panel trên (xem mục dưới). Nếu global là
> `omp` và omp khả dụng, sparkle sẽ chạy qua omp; nếu global là
> `builtin`, sparkle sẽ gọi OpenAI-compatible provider luôn (nhanh nhất
> cho commit message ngắn).

### Engine dropdown (global)

Trên cùng panel AI Settings có một dropdown **Engine** chung cho cả
chat panel và nút sparkle:

  - `omp` (mặc định cho fresh install) — dùng omp chat engine khi omp
    CLI đã cài; nếu không sẽ tự rơi về `builtin`.
  - `builtin` — OpenAI-compatible provider (OpenAI / Groq / LM Studio /
    OpenRouter …).
  - `claude-code` / `codex` — delegate sang agent ngoài khi tương ứng
    đã cài.

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
tree refresh.

## Phím tắt

Phím tắt hiện đang được hỗ trợ (xem `package.json → contributes.keybindings`):

| Phím tắt | Lệnh | Phạm vi |
| --- | --- | --- |
| **Cmd+Enter** (macOS) / **Ctrl+Enter** (Win/Linux) | Run statement (chạy câu lệnh đang chọn / dưới con trỏ) | Trong file `.sql` |

Trên macOS, phím tắt là `Cmd+Enter`; trên Windows / Linux là `Ctrl+Enter`. VS Code tự động remap
theo nền tảng — không cần cấu hình thêm.

> **Lưu ý:** các phím tắt cho *Run all*, *Cancel*, *New tab*, *Close tab*, *Toggle Schema
> Explorer*, *Open AI Chat* đang được lên kế hoạch cho các bản phát hành tiếp theo. Hiện tại
> chúng có thể chạy qua Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) bằng tên lệnh
> (`UnicDB: Cancel Query`, `UnicDB: New Tab`, …). Xem README §Keyboard shortcuts để biết
> danh sách chính thức luôn đồng bộ với `package.json`.

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
