# TASK-008 — Packaging vsce + install script + README + release

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (design §7)

## Goal

Đóng gói và phân phối: `vsce package` ra `.vsix`, `scripts/build.sh` cho maintainer, `scripts/install-vsdb.sh` cho team (detect latest GitHub release → download vsix → install bằng `code` CLI với fallback path macOS), README tiếng Việt với one-liner, `.gitignore` đảm bảo không ship rác.

## Target Files

- `package.json` — chỉ thêm/sửa metadata packaging: `repository: {type:'git', url:'https://github.com/lengockhoa/VSDB'}`, `license`, `categories`, `icon: media/icon.png`, kiểm tra `vscode:prepublish` = `npm run compile` (đã có từ TASK-001). KHÔNG đụng contributions.
- `scripts/build.sh` — `npm run compile && npx vsce package -o dist/` → in đường dẫn vsix; exit 1 nếu fail.
- `scripts/install-vsdb.sh` — POSIX sh, hỗ trợ `curl -fsSL <url> | bash`:
  1. Detect `code` trên PATH; không có → thử `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`; vẫn không → lỗi rõ hướng dẫn cài `code` command in PATH.
  2. `--local <file.vsix>` cài file local (dùng smoke test); không có flag → GitHub API `https://api.github.com/repos/lengockhoa/VSDB/releases/latest` lấy asset `*.vsix` (dùng `curl` + `grep`/`sed` tránh phụ thuộc `jq`).
  3. Download về tmp, `code --install-extension <vsix> --force`.
  4. So version đã cài (`code --list-extensions --show-extension-info`hoặc `--list-extensions | grep`) → in "cài mới" / "update từ x → y".
- `README.md` — tiếng Việt: giới thiệu 1 đoạn, one-liner `curl -fsSL https://raw.githubusercontent.com/lengockhoa/VSDB/main/scripts/install-vsdb.sh | bash`, hướng dẫn usage (Add Connection, Cmd+Enter, nút ▶, CodeLens, Load more, Cancel, Schema Explorer), troubleshooting (sai password, CLI không thấy, conflict keybinding Copilot), hướng dẫn maintainer build/release.
- `docs/testing-checklist.md` — manual checklist 3 DB × luồng chính (Cmd+Enter/▶/CodeLens/schema tree/load >100k rows/cancel).
- `.gitignore` — đảm bảo có `dist/`, `*.vsix` (TASK-001 đặt; chỉ verify).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (script) | install script detect CLI macOS | chạy `sh scripts/install-vsdb.sh --local <vsix> --dry-run` (hoặc biến env `VSDB_DRY_RUN=1`) → in đúng đường dẫn CLI sẽ dùng (PATH ưu tiên, fallback app path) | macOS |
| 2 | edge | Không có code CLI | PATH rỗng + fallback path không tồn tại (env override `VSDB_CODE_PATH=/nonexistent`) → exit 1 + thông báo hướng dẫn | stub |
| 3 | e2e (smoke) | Package + install thật | `npm run package` ra vsix >0 byte; `bash scripts/install-vsdb.sh --local dist/vsdb-*.vsix` exit 0; `code --list-extensions \| grep vsdb` thấy `lengockhoa.vsdb` | build xong |

## Test Files

- `scripts/install-vsdb.sh` self-test mode (`--dry-run`) — không cần file test riêng; verify qua Verification Commands.

## Verification Commands

```bash
npx tsc --noEmit
npm test                      # không regression
npm run package
bash scripts/install-vsdb.sh --local dist/vsdb-*.vsix
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --list-extensions --show-versions | grep -i vsdb
```

## Acceptance Criteria

- [ ] `npm run package` sinh `.vsix`; install `--force` thành công; extension xuất hiện trong `--list-extensions`.
- [ ] Script detect đúng CLI (PATH trước, app path sau); lỗi không-có-CLI rõ ràng exit 1.
- [ ] README có one-liner install + usage tiếng Việt + troubleshooting.
- [ ] Manual checklist `docs/testing-checklist.md` viết xong.
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-007 (extension wiring hoàn chỉnh — packaging chỉ有意义 khi code chạy được)

## Interfaces

- Consumes: toàn bộ build từ TASK-001..007 (dist/extension.js, dist/webview.js, media/icon.png, package.json contributions).
- Produces: `dist/vsdb-<version>.vsix` + `scripts/install-vsdb.sh` (đối tác `curl | bash`) + `scripts/build.sh` + `README.md`. Việc push git tag/release GitHub là bước deploy của orchestrator, không thuộc task này (script phải chạy được với `--local` độc lập với release).

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
