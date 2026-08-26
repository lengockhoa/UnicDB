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
- **Atomic multi-statement batch** (khi extension gửi **một chuỗi nhiều câu lệnh** làm một batch — ví dụ lưu nhiều cell, generate sample data, helper bảng):
  - **DML (`INSERT` / `UPDATE` / `DELETE`...)** chạy trong **một transaction** — statement nào lỗi thì toàn bộ lô được rollback, không statement nào được commit dở (PostgreSQL vốn đã vậy; MySQL cũng đảm bảo từ bản này).
  - **Lưu ý MySQL**: các lệnh **DDL** (`CREATE` / `ALTER` / `DROP`...) gây **implicit commit** ngầm bên trong MySQL — phần trước lệnh DDL vẫn được commit và DDL không thể rollback, nên lô chứa DDL **không** được bảo đảm all-or-nothing.
- **Editor Run** (Cmd/Ctrl+Enter chọn vùng, hoặc cả file qua nút ▶) chạy **từng statement riêng lẻ**: mỗi câu là một `runQuery` độc lập, không bọc chung một transaction — statement trước vẫn được commit nếu statement sau lỗi.
- **Một câu `SELECT` đơn** vẫn chạy qua streaming cursor như cũ (không bọc transaction — tránh giữ luôn connection duy nhất của pool).

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

- **Results grid (AG Grid Community)**: xem kết quả trong panel **VSDB Results** — theme tự theo VS Code (dark/light); sort; **Excel-style set filter per column** (mở menu filter của 1 cột → danh sách checkbox giá trị distinct, ô tìm nhanh phía trên, hàm `(Select All)` / `(Blanks)`; dữ liệu lớn render qua AG Grid Set Filter native) + quick search; multi-row selection + copy (Ctrl+C); row count ở footer.
- **Grid edit mode (1.4.0)**: sửa cell trực tiếp trên grid, **paste từ Excel (TSV)** vào vùng chọn (tự cắt ô thừa), Add/Delete Row, Undo, toggle CSV raw view; **Cmd/Ctrl+Enter commit một lần** (batch) — UPDATE theo PK (PostgreSQL không PK dùng `ctid` kèm warning; MySQL/MSSQL không PK từ chối + banner), lỗi SQL hiện banner và giữ edit để retry.
- **Export toolbar (1.4.0)**: TSV / CSV / XML / JSON / SQL Inserts / SQL Insert Multirow / SQL Updates / Where Clause — SQL mode theo dialect; **Header checkbox** (TSV/CSV/XML/JSON); **To Clipboard** hoặc **Export to file**.
- **WHERE/ORDER BY bar (1.4.0)**: gán điều kiện WHERE / ORDER BY rồi **Re-Run** — wrap query gốc thành subquery, grid reset và load-more chạy trên cursor mới.
- **Run .sh (1.4.0)**: mở file `.sh` → nút **Run** trên editor title gửi toàn bộ nội dung file vào Integrated Terminal (như paste cả file vào shell).
- **Toolbar icons (1.5.0)**: title bar của panel **VSDB** (refresh / filter) và **VSDB Results** (copy / quick search / export / re-run) gọn trên một hàng icon-only — đỡ chiếm chiều ngang webview, label ẩn khi đủ rộng.
- **Destructive statement guard (1.5.0)**: trước khi submit, VSDB quét statement — `DELETE có WHERE` → modal confirm thường; `DELETE không WHERE` / `TRUNCATE` / `DROP` / `UPDATE không WHERE` → modal đỏ "CỰC KỲ NGUY HIỂM" hiện FULL statement, user phải bấm **Vẫn chạy (nguy hiểm)**; Cancel huỷ cả lô. Setting `vsdb.confirmDestructive` (default `true`) tắt guard khi cần.
- **Run .sh CodeLens (1.5.0)**: file `.sh` mở trong editor có CodeLens `▶ Run` ngay dòng đầu — chạy toàn bộ nội dung file vào Integrated Terminal (giống SQL CodeLens); setting `vsdb.showRunLensSh` (default `true`); fix kèm: extension giờ kích hoạt đúng khi mở file `.sh` và palette gọi `Run Script` không còn bắn `\n` vào terminal trống.
- **Table Designer (PostgreSQL)**: panel Schema Explorer → click phải table (hoặc command palette `VSDB: New Table…` / `VSDB: Modify Table…`) mở form tạo/sửa:
  - **New Table…**: form thêm cột (name/type/default/NOT NULL), PK / UNIQUE / FK / CHECK, preview SQL live, một nút Apply chạy `CREATE TABLE` qua connection đang chọn.
  - **Modify Table…**: introspect schema hiện tại → sửa → diff engine phát sinh `ALTER TABLE` (rename/add/drop column, SET/DROP NOT NULL, SET/DROP DEFAULT, ADD/DROP constraint) chạy một loạt qua `runQuery`.
  - **Copy Create Query**: introspect table rồi re-emit `CREATE TABLE` (cùng generator với form) — copy vào clipboard.
  - **Generate Sample Data…**: chèn N dòng `INSERT … VALUES` theo kiểu cột (int/varchar/date/uuid/json) — mở trong tab SQL untitled để user xem/sửa trước khi chạy.
  - **Analyze / Vacuum**: phát lệnh `ANALYZE` / `VACUUM` (PostgreSQL-only) để cập nhật planner stats / thu dọn dead tuples; nút này không hiện với MySQL/MSSQL.
- **AI Settings (1.5.x)**: chạy `VSDB: Open AI Settings…` từ Command Palette mở form cấu hình backend OpenAI-compatible (baseUrl, method `responses`/`chat/completions`, timeout, maxSteps, model id cho 2 role `work` (vision) + `smart`, apiKey). Nút **Test** smoke-fires một completion nhỏ để xác nhận endpoint thực sự sống trước khi agent dùng nó.
- **AI Chat & DB tools (1.5.x)**: chat panel `VSDB: AI Chat` từ Command Palette — multi-turn với agent loop. Agent có 3 tool: `list_tables`, `describe_table` (PostgreSQL only), và `run_sql`. **Read-only promise**: tool `run_sql` chỉ chấp nhận `SELECT` / `SHOW` / `EXPLAIN` / `WITH … SELECT` (CTE sạch). Mọi `INSERT` / `UPDATE` / `DELETE` / `DROP` / `TRUNCATE` / `MERGE` / `INTO` / writable CTE bị tool reject ngay lập tức với lý do cụ thể — `adapter.runQuery` không bao giờ nhận DML/DDL. Multi-statement cũng bị reject. Khi chưa `VSDB: Open AI Settings…` thì command `VSDB: AI Chat` hiện info "Configure AI settings first" và tự mở form settings.

---
## AI

### Privacy / Egress

- **Storage**: settings (baseUrl, method, timeout, maxSteps, model ids) lưu trong **VS Code global state** của extension (`vsdb.ai.settings`); **apiKey** lưu trong **VS Code SecretStorage** (`vsdb.ai.apiKey`) — mã hoá qua OS keystore (macOS Keychain / Linux libsecret / Windows Credential Vault), không nằm trong settings JSON, không xuất hiện trong logs, errors, telemetry, hay clipboard.
- **Egress contract**: **mọi** AI request chỉ đi tới `baseUrl` user cấu hình — không có third-party endpoint, không telemetry, không analytics, không fallback endpoint nào khác. Nếu `baseUrl` rỗng hoặc invalid thì provider fail ngay tại đầu vào — không tự ý gọi đi đâu khác.
- **Key hygiene**: apiKey được đọc từ SecretStorage theo từng request (no cache). Nó được gắn vào header `Authorization: Bearer …` của HTTPS request tới `baseUrl` và KHÔNG được include trong bất kỳ error message, response body snippet, hay log nào — provider `scrubApiKey` trước khi throw `ProviderError`.
- **Form webview**: form nhận `hasApiKey: boolean` chứ KHÔNG nhận apiKey; chỉ khi user bấm Save/Test thì giá trị ô mới được đẩy lên host (write-only). Nếu ô apiKey trống và đã có key lưu → form giữ nguyên key cũ.

### Mở form

Mở Command Palette → gõ `VSDB: Open AI Settings…` → điền các trường → bấm **Test** để smoke-fires provider → **Save** để lưu vào store.

### AI Chat & DB tools

Mở Command Palette → `VSDB: AI Chat` → panel chat mở với multi-turn agent. Agent có 3 tool:

- `list_tables` — liệt kê `(schema, table)` cho adapter active.
- `describe_table` — columns + constraints; chỉ hỗ trợ khi connection active là **PostgreSQL**.
- `run_sql` — chạy **một** statement read-only (SELECT/SHOW/EXPLAIN/WITH…SELECT sạch) qua `adapter.runQuery`; trả về ≤ 50 rows JSON.

**Guardrails (defense-in-depth)**:

- **Read-only guard** trong `run_sql`: bất kỳ `INSERT/UPDATE/DELETE/DROP/TRUNCATE/MERGE/ALTER`, multi-statement, hoặc CTE có nhánh DML đều bị reject ngay tại tool — `adapter.runQuery` không bao giờ thấy DML. Ngay cả khi model "cố tình" gọi `run_sql` với `DROP TABLE …`, tool trả về reject reason, agent loop tiếp tục, và DB thật ngoài đời không bị ảnh hưởng.
- **Adapter scope**: `run_sql` chỉ resolve qua connection active hiện tại (driver `postgres`); nếu chưa chọn connection hoặc driver không phải `postgres` → tool trả `"No active database connection."`, không throw.
- **Egress**: mọi AI completion chỉ đi tới `baseUrl` bạn đã cấu hình — không third-party endpoint, không telemetry, không fallback.
- **apiKey hygiene**: `apiKey` chỉ nằm trong **SecretStorage** (`vsdb.ai.apiKey`); được đọc theo từng request và gắn vào header `Authorization: Bearer …`. Provider `scrubApiKey` trước khi throw `ProviderError` — không bao giờ xuất hiện trong error message, response snippet, log, hay UI.
- **Unconfigured fallback**: nếu chưa lưu AI Settings thì command hiện `VSDB: Configure AI settings first.` rồi tự mở `VSDB: Open AI Settings…` — không crash, không tạo panel với config rỗng.


### AI engine: oh-my-pi (optional)

Ngoài engine built-in (`runAgent` qua OpenAI-compatible backend), VSDB chat có thể dùng **oh-my-pi** (`omp`) làm engine agent thật — spawn process, RPC JSONL, stream events, host-tool bridge.

- **Yêu cầu**: `omp >= 17.0.0`. Detect tự động ở lần đầu mở panel; nếu binary cũ / thiếu / không parse được version, panel announce `{engine:"builtin", hint: "omp install hint"}` một lần và dùng built-in như cũ.
- **Install**: `curl -fsSL https://omp.sh/install | sh` (1 lần).
- **Update**: `omp update` (để bump version khi task bump min-version).
- **VSDB tự nâng cấp**: chạy lại `install-vsdb.sh` có sẵn (`curl -fsSL https://raw.githubusercontent.com/…/install-vsdb.sh | sh`) — extension update flow không cần đụng đến omp.
- **Security note**: omp mode cho agent quyền workspace tools (read/edit/bash scoped cwd của active workspace) qua `set_host_tools` RPC. **DB access vẫn read-only** — VSDB chỉ host các tool `list_tables` / `describe_table` / `run_sql` (read-only guard trong `run_sql` giữ nguyên), omp không có tool bypass được read-only chokepoint. Agent có thể modify file SQL local ngoài workspace tool, nhưng database thật vẫn bất khả xâm phạm bởi DML/DDL.
- **Crash fallback**: nếu process omp exit giữa turn, panel post error bubble + fallback builtin cho turn tiếp theo; không tự respawn — user retry re-detect.

---


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
