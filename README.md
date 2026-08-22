# VSDB — Run SQL from VS Code

Một extension VS Code nhỏ gọn để chạy truy vấn SQL trực tiếp từ editor, không cần
nhảy sang client ngoài. Hỗ trợ **PostgreSQL**, **MySQL / MariaDB** và **SQL Server**.

![screenshot](media/icon.png)

> Mở file `.sql` → chọn connection → bôi đen câu lệnh → **Cmd+Enter** (macOS)
> hoặc **Ctrl+Enter** (Windows / Linux) → xem kết quả ngay trong panel.

---

## Cài đặt

**1 lệnh duy nhất** (cài mới lẫn update — chỉ cần VS Code đã mở qua ít nhất 1 lần):

```bash
curl -fsSL https://raw.githubusercontent.com/lengockhoa/VSDB/main/scripts/install-vsdb.sh | bash
```

Script sẽ tự:

1. Tìm `code` CLI trên `PATH` (fallback: `/Applications/Visual Studio Code.app/.../bin/code` trên macOS).
2. Tải `.vsix` mới nhất từ GitHub Releases của repo `lengockhoa/VSDB`.
3. Gọi `code --install-extension <vsix> --force`.
4. In version đã cài. **Idempotent** — chạy lại = update.

Khi có version mới, team chỉ cần chạy lại đúng lệnh trên là tự lên bản mới.

### Cài thủ công bằng file `.vsix` (không cần mạng / không qua GitHub)

Tải `vsdb-<version>.vsix` từ [Releases](https://github.com/lengockhoa/VSDB/releases)
(hoặc lấy file do maintainer build bằng `scripts/build.sh`), rồi:

```bash
bash scripts/install-vsdb.sh --local /đường/dẫn/tới/vsdb-<version>.vsix
# hoặc cài thẳng bằng VS Code CLI:
code --install-extension vsdb-<version>.vsix
```

---

## Bắt đầu nhanh

| Bước | Thao tác |
| ---- | -------- |
| 1    | Mở VS Code, mở panel **VSDB** ở activity bar (icon bên trái). |
| 2    | Click biểu tượng `+` góc trên panel → **VSDB: Add Connection** → điền host/port/user/password → chọn driver (postgres / mysql / mssql) → lưu. |
| 3    | Mở file `.sql`, chọn connection muốn dùng (click tên connection ở status bar hoặc gõ `VSDB: Select Active Connection` trong Command Palette). |
| 4    | Đặt con trỏ / bôi đen một câu lệnh SQL → bấm **Cmd+Enter** (macOS) / **Ctrl+Enter** (Win/Linux). |
| 5    | Kết quả hiện trong panel **VSDB Results** ngay dưới editor. |

### Các cách chạy query khác

- **Nút ▶ trên editor** (title bar): chạy query đang được focus.
- **CodeLens ▶ Run** ngay phía trên mỗi statement trong file `.sql` (bật/tắt qua setting `vsdb.showRunLens`).
- **Schema Explorer**: bấm vào table/view → menu chuột phải → **Generate SELECT** để chèn câu `SELECT * FROM ...` vào editor.
- **Cancel query**: nút ■ trên title bar, hoặc `VSDB: Cancel Query` trong palette.

### Phím tắt

| Phím | Lệnh |
| ---- | ---- |
| `Cmd+Enter` (macOS) / `Ctrl+Enter` (Win/Linux) | Chạy câu lệnh đang chọn |
| Khi `editorTextFocus && resourceLangId == sql` | (chỉ kích hoạt trong file `.sql`) |

---

## Tính năng chính

- **3 driver**: PostgreSQL (pg), MySQL/MariaDB (mysql2), SQL Server (tedious).
- **Schema Explorer** cây: connection → schema → Tables / Views / Routines (có số lượng) → table / view / column / routine.
  - Hiển thị **mọi schema** bạn truy cập được, không chỉ schema mặc định (`public` / `dbo` / database đang connect).
  - Setting `vsdb.hideSystemSchemas` (default `true`): ẩn schema hệ thống (`pg_catalog`, `information_schema`, `mysql`, `sys`...); tắt nếu muốn xem hết.
  - Click phải table/view → `Generate SELECT`, `Copy Qualified Name` (dùng đúng `schema.table`, kể cả schema khác mặc định).
  - **Row count badge**: mỗi table hiện ước tính số dòng (từ planner statistics — nhanh, không scan bảng lớn; bảng chưa analyze hiển thị schema name).
  - **Tree filter**: nút filter trên title bar panel **VSDB** → gõ text lọc schemas/tables/views/routines/columns theo tên (không phân biệt hoa thường); nút ✕ hiện khi filter đang bật để xóa.
- **Refresh metadata**: nút refresh trên title bar của panel **VSDB** (chạy `VSDB: Refresh Schema`) reload lại schema cache từ server — dùng sau khi bạn tạo/xoá table ở bên ngoài VS Code mà không muốn tạo connection mới.

- **Results grid (AG Grid Community)**: xem kết quả trong panel **VSDB Results** — theme tự theo VS Code (dark/light); sort; **filter per-column kiểu Excel** (Text/Number Filters: Contains / Equals / Starts With…, kết hợp AND/OR tối đa 2 điều kiện) + quick search; multi-row selection + copy (Ctrl+C); row count ở footer.

---
## Khắc phục sự cố (Troubleshooting)

### `code` CLI không tìm thấy khi cài

Script in hướng dẫn, nhưng tóm tắt:

- macOS: mở VS Code → `Cmd+Shift+P` → **Shell Command: Install 'code' command in PATH** → chạy lại installer.
- Linux: cài extension từ Marketplace bằng tay, hoặc thêm VS Code bin vào `PATH`.
- Windows (git-bash): đảm bảo `~/AppData/Local/Programs/Microsoft VS Code/bin` có trong `PATH`.

Bạn cũng có thể set `VSDB_CODE_PATH=/đường/dẫn/tới/code` rồi chạy lại script.

### Conflict với Copilot / extension khác

Một số extension (vd. Copilot, Codeium) cũng đăng ký `Cmd+Enter` / `Ctrl+Enter`.
Vào **File → Preferences → Keyboard Shortcuts**, tìm `vsdb.runQuery` và đổi
sang tổ hợp khác (vd. `Cmd+Shift+Enter`), hoặc unbind phím của extension kia.

### Password / connection lưu ở đâu?

`SecretStorage` của VS Code — mã hóa qua:

- macOS: Keychain
- Linux: libsecret / kwallet
- Windows: Windows Credential Vault

Xóa: `Code → Settings → Clear Secret Storage** (hoặc gỡ extension sẽ xóa luôn).

### Gỡ cài đặt

```bash
code --uninstall-extension lengockhoa.vsdb
```

---

## Cho maintainer

Build và đóng gói:

```bash
bash scripts/build.sh
# → sinh ra dist/vsdb-<version>.vsix
```

Release (orchestrator tự làm sau khi review xong):

1. Tạo Git tag `v<version>`.
2. Push tag lên `origin/main`.
3. GitHub Actions / orchestrator publish GitHub Release với file `.vsix` đính kèm.
4. Team chạy lại one-liner cài đặt → tự động lấy bản mới nhất.

---

## Phát triển

```bash
git clone https://github.com/lengockhoa/VSDB
cd VSDB
npm ci
npm run watch                # build incremental trong src/ + webview/
# Trong VS Code: F5 → Extension Development Host
```

### Tests

```bash
npm test                     # unit (vitest)
npm run test:integration     # cần Docker (Postgres / MySQL / MSSQL)
```

---

## Giấy phép

MIT — xem [LICENSE](LICENSE).
