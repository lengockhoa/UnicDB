# VSDB — VS Code Database Extension: Design Document

**Ngày:** 2026-08-21
**Trạng thái:** Đã duyệt qua brainstorming
**Người quyết định:** Owner (người dùng), Claude (thiết kế)

---

## 1. Tổng quan & Mục tiêu

VSDB là VS Code extension cho phép chạy SQL trực tiếp từ editor với trải nghiệm gần nhất với DataGrip.

**Vấn đề đang có:** Kết nối DB từ VS Code khó khăn; phải dùng tool ngoài (DataGrip) song song với VS Code.

**Mục tiêu:**
- Mở file `.sql` → bôi đen SQL → **Cmd+Enter** → chạy lên DB, xem kết quả ngay trong VS Code
- Trải nghiệm quen thuộc với người dùng DataGrip (statement tại con trỏ, grid kết quả, schema explorer)
- Hỗ trợ **PostgreSQL, MySQL/MariaDB, SQL Server** (mở rộng adapter sau này)
- Cài 1 lần dùng cho mọi project (extension cài global theo user)
- Phân phối nội bộ qua script tự update (giai đoạn đầu), publish Marketplace sau này

**Không làm (YAGNI):**
- Không pagination server-side phức tạp — Load More là đủ
- Không export CSV/Excel (để sau)
- Không edit data trực tiếp trong grid (để sau)
- Không ER diagram (để sau)
- Không sync connection giữa các máy (mỗi máy tự quản lý)

---

## 2. Kiến trúc & Công nghệ

**Ngôn ngữ:** TypeScript. Bundle bằng esbuild (chuẩn hiện nay cho VS Code extension).

**Cấu trúc project:**

```
vsdb/
├── src/
│   ├── extension.ts              # Entry point: đăng ký commands, keybinding, activity bar
│   ├── config/
│   │   └── types.ts              # Types: ConnectionConfig, DriverType
│   ├── adapters/
│   │   ├── types.ts              # Interface chung DbAdapter
│   │   ├── postgres.ts           # Driver: pg (server-side cursor)
│   │   ├── mysql.ts              # Driver: mysql2 (streaming)
│   │   ├── mssql.ts              # Driver: tedious (streaming)
│   │   └── factory.ts            # Tạo adapter theo driver type
│   ├── core/
│   │   ├── connectionManager.ts  # Connection active, lazy connect, idle disconnect
│   │   ├── queryRunner.ts        # Thực thi, batch fetch 500 rows, cancel
│   │   └── statementParser.ts    # Split statements; statement tại con trỏ
│   └── ui/
│       ├── resultsPanel.ts       # Webview panel kết quả
│       ├── statusBar.ts          # Nút connection active
│       └── schemaTree.ts         # TreeDataProvider cho Schema Explorer
├── webview/                      # Grid UI: HTML/CSS/JS thuần, virtual scroll
│   ├── main.ts
│   ├── grid.ts                   # Virtual-scroll table
│   └── styles.css
├── media/
│   └── icon.png                  # 128×128 extension icon
├── scripts/
│   ├── build.sh                  # vsce package → .vsix (cho maintainer)
│   └── install-vsdb.sh           # download vsix + install/update (cho team)
├── package.json                  # Manifest: commands, keybinding, views
└── esbuild.js
```

**Adapter pattern (điểm mấu chốt):**

```typescript
interface DbAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  runQuery(sql: string): AsyncIterable<QueryResult>;   // nhiều result set
  listTables(schema?: string): Promise<TableInfo[]>;
  listViews(schema?: string): Promise<ViewInfo[]>;
  listRoutines(schema?: string): Promise<RoutineInfo[]>;
  listColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
}
```

3 driver đều pure JS (`pg`, `mysql2`, `tedious`) — không native compile, bundle sạch với esbuild. Thêm DB mới sau này = thêm 1 adapter + 1 case trong factory, không đụng core.

---

## 3. Quản lý Connection (local theo máy)

**Không có file config nào trong repo.** Mọi dữ liệu connection lưu nội bộ theo máy:

| Dữ liệu | Nơi lưu | Bảo vệ |
|---|---|---|
| Danh sách connection (name, driver, host, port, user, database) | VS Code Workspace State | Theo máy + theo workspace, không nằm trong repo |
| Password | **VS Code SecretStorage** | Mã hóa bằng macOS Keychain — không plaintext trên đĩa |

**Lưu ý quan trọng về Workspace State:** connection lưu theo workspace. Mỗi project (workspace) có danh sách connection riêng — đúng yêu cầu "mỗi cá nhân tự quản, không share". Mở workspace khác = connection riêng. (VS Code secrets API theo workspace, khớp nhu cầu.)

**Flow thêm connection** — command `VSDB: Add Connection`:
1. QuickPick chọn driver: PostgreSQL / MySQL / SQL Server
2. InputBox lần lượt: name → host → port (default theo driver: 5432/3306/1433) → user → password → database
3. **Test connect trước khi lưu** — fail thì báo lỗi ngay, không lưu connection hỏng
4. Lưu: password → SecretStorage, phần còn lại → workspace state
5. Status bar + schema tree cập nhật

**Quản lý:** `VSDB: Add / Edit / Delete Connection` qua Command Palette. Edit cho phép sửa mọi trường, password mới ghi đè SecretStorage. Xóa connection cũng xóa secret + đóng socket nếu đang mở.

**Connection active:** nhớ theo workspace (workspace state). Mở lại project → tự chọn lại DB cũ. Status bar `$(database) work_db [postgres]` — click → QuickPick đổi. Chỉ 1 connection active tại một thời điểm (nhưng nhiều connection có thể tồn tại trong danh sách; đổi active là đóng connection cũ).

**Connection lifecycle:**
- Lazy connect — chỉ mở socket khi query đầu tiên (hoặc refresh schema tree)
- Idle timeout 10 phút → tự đóng
- Lỗi connect → hiện lỗi rõ ràng trong notification kèm hướng dẫn

---

## 4. Chạy Query: Cmd+Enter + Statement Parser

**Keybinding** trong `package.json`:

```json
{
  "key": "cmd+enter",
  "command": "vsdb.runQuery",
  "when": "editorTextFocus && resourceLangId == sql"
}
```

Chỉ active khi focus editor `.sql` — không cướp phím extension khác. Conflict với Copilot Chat nếu có → user remap trong Keyboard Shortcuts, hoặc dùng Command Palette / nút ▶.

**Logic chọn SQL để chạy** (`statementParser.ts`) — ưu tiên:

1. **Có selection** → chạy nguyên vùng bôi đen, không cắt không tách
2. **Không selection** → tìm statement chứa con trỏ:
   - Quét file tìm ranh giới `;` — bỏ qua `;` trong string literal (`'...'`), dollar-quoted (`$$...$$` Postgres), comment (`--`, `/* */`)
   - Khối `BEGIN...END` (PL/pgSQL, T-SQL) = 1 statement nguyên khối
   - Từ ranh giới trên/dưới gần nhất → statement chứa vị trí con trỏ
3. Statement đầu tiên nếu con trỏ đứng trước mọi thứ; file rỗng → thông báo

**Tách statement khi chạy:** selection chứa nhiều statement → chạy tuần tự, mỗi statement 1 result tab. Statement lỗi → dừng tại đó, các tab trước giữ kết quả, hiện rõ statement thứ mấy lỗi.

**3 đường vào, 1 logic** — đều gọi `vsdb.runQuery`:
- **Cmd+Enter** (keyboard)
- **Nút ▶ trên title bar editor** (`menu.editor/title`, hiện khi `.sql`)
- **CodeLens "▶ Run"** trên mỗi statement (setting `vsdb.showRunLens`, mặc định bật)

**Cancel:** đang chạy lâu → nút Cancel trong grid header + Progress notification. Adapter hỗ trợ cancel qua driver API (pg_cancel_backend, query.kill cho MySQL/MSSQL).

---

## 5. Grid Kết quả (Webview Panel)

**Panel webview** mở bên dưới editor (giống DataGrip Services panel), tái sử dụng qua các lần chạy — query mới thay thế kết quả cũ.

**Bố cục:**

```
┌──────────────────────────────────────────────────┐
│ work_db [postgres]  ✅ 2 statements · 134ms  [✕] │  header: connection + timing + cancel
├──────────────────────────────────────────────────┤
│ [Result 1] [Result 2] [Messages]                 │  tabs: 1 tab/statement
├──────────────────────────────────────────────────┤
│ id │ name  │ email          │ created_at         │
│ 1  │ An    │ an@mail.com    │ 2026-01-15         │  grid: virtual scroll, sticky header
│ 2  │ Binh  │ binh@mail.com  │ 2026-01-16         │
├──────────────────────────────────────────────────┤
│ 500 rows (of 12,340)  [Load 500 more]  ⏱ 45ms   │  footer
└──────────────────────────────────────────────────┘
```

**Virtual scroll:** chỉ render ~30 rows đang thấy — 100k+ rows vẫn cuộn mượt.

**Load More (xử lý query >1tr rows):**
- Fetch batch đầu 500 rows từ driver cursor → grid hiện ngay
- **Load 500 more** → driver cursor lấy tiếp 500, append vào grid
- Server-side cursor (Postgres) / streaming (MySQL, MSSQL) — không load 1tr rows vào RAM
- **Load all** có cảnh báo khi >100k rows
- Đang fetch → nút "Loading..."

**Tabs:** mỗi statement 1 tab kết quả. Tab **Messages** gộp: timing từng statement, `INSERT 0 5`, `UPDATE 3`, warnings. Tab lỗi → đỏ, chạy dừng ở đó.

**Copy:** chọn cells/rows → Cmd+C copy (tab-separated, dán Excel được). Nút copy-all.

**Format:** NULL xám, số căn phải, timestamp ISO. Theo VS Code theme (dark/light tự động qua CSS variables).

---

## 6. Schema Explorer (Sidebar)

**Activity Bar** icon VSDB (trụ database + mũi tên xanh) → panel tree:

```
🗄️ VSDB
├── ● work_db [postgres]          ← active, chấm xanh
│   ├── 📁 Tables
│   │   ├── 📄 users
│   │   │   ├── 🔑 id · int4
│   │   │   ├── ✉ email · varchar
│   │   │   └── created_at · timestamptz
│   │   └── 📄 orders
│   ├── 📁 Views
│   │   └── 📄 v_active_users
│   └── ⚙ Routines
│       ├── fn_calc_total (function)
│       └── sp_sync (procedure)
├── ○ reporting_db [mysql]
└── ＋ Add Connection
```

**Lazy load:** node fetch metadata khi expand. Metadata cache 60s; nút 🔄 refresh từng nhánh.

**Query metadata:**
- Postgres: `information_schema.tables/columns`, `pg_proc` cho routines
- MySQL: `information_schema.*`
- SQL Server: `sys.tables`, `sys.columns`, `sys.objects` + `sys.sql_modules`

**Context menu trên table/view:**
- **Generate SELECT** → chèn `SELECT * FROM users LIMIT 100;` tại con trỏ
- **Copy qualified name** → `workdb.public.users`
- **Refresh**

Click connection → đổi active. Connection chưa kết nối hiện node con "Connect" — click connect.

---

## 7. Phân phối & Update

**Giai đoạn 1 (ngay):** build `.vsix`, share qua script.

- Maintainer: `scripts/build.sh` → `vsce package` → `vsdb-<version>.vsix` → push lên GitHub Releases / shared drive
- Team: 1 lệnh duy nhất:

```
curl -fsSL https://.../install-vsdb.sh | bash
```

Script: đọc version mới nhất → download vsix → `code --install-extension vsdb-<version>.vsix` (cài đè = update). Tự detect đã cài version cũ → thông báo update.

**Giai đoạn 2 (khi ổn định):** publish VS Code Marketplace → auto-update ngầm, zero-effort. Code không đổi, chỉ thêm bước release.

**Icon extension:** trụ database + mũi tên chạy xanh lá, SVG → PNG 128×128 (generate khi setup).

---

## 8. Error Handling

| Tình huống | Xử lý |
|---|---|
| Không có connection nào | Cmd+Enter → QuickPick gợi ý "Add Connection" |
| Sai password / không reach host | Notification lỗi rõ + mở form edit connection |
| Query timeout / chạy lâu | Nút Cancel (kill query phía server) |
| Statement lỗi giữa batch | Dừng tại đó, tab lỗi đỏ, giữ kết quả các statement trước |
| File `.sql` không focus | Nút ▶ ẩn, Cmd+Enter không trigger (when clause) |
| SecretStorage lỗi | Fallback: hỏi password mỗi lần connect (không lưu) |
| Workspace không mở (single file) | Connection lưu vào global state thay vì workspace state |

---

## 9. Testing

- **Unit tests** (mocha/vitest): `statementParser` (cases: string chứa `;`, dollar-quote, BEGIN...END, con trỏ đầu/cuối file, selection nhiều statement), config types
- **Integration tests** với Docker DB thật (docker compose: postgres + mysql + mssql): add connection → connect → chạy query → nhận kết quả → Load More → cancel
- **Manual test checklist** trong `docs/testing-checklist.md`: 3 DB × các luồng chính (Cmd+Enter, nút ▶, CodeLens, schema tree, load more >100k rows)

---

## 10. Checklist chốt design (đã duyệt)

- [x] DB: PostgreSQL, MySQL/MariaDB, SQL Server (adapter pattern, mở rộng sau)
- [x] Connection: local theo máy, không commit repo — password qua SecretStorage
- [x] Active connection nhớ theo workspace, status bar + schema tree đổi nhanh
- [x] Cmd+Enter: selection > statement tại con trỏ; parser xử lý `;`, string, dollar-quote, BEGIN...END
- [x] Nút ▶ title bar + CodeLens ▶ Run — 3 đường vào 1 logic
- [x] Grid webview: virtual scroll, tabs/statement, Load More 500, cancel
- [x] Schema Explorer: Activity Bar tree, lazy load, context menu Generate SELECT
- [x] Phân phối: vsix + install script giai đoạn 1, Marketplace sau
- [x] Ưu tiên xuyên suốt: trực quan nhất, gần DataGrip nhất
