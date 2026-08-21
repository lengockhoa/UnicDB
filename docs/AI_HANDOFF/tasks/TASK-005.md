# TASK-005 — ConnectionManager (SecretStorage/WorkspaceState) + StatusBar

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (design §3, §8)

## Goal

ConnectionManager: CRUD connection (password → SecretStorage, phần còn lại → WorkspaceState), test-connect trước khi lưu, active connection nhớ theo workspace, lazy connect, idle timeout 10 phút tự đóng, fallback global state khi không có workspace. Cùng lúc viết StatusBar `$(database) name [driver]` click đổi active.

## Target Files

- `src/core/connectionManager.ts` — class `ConnectionManager`:
  - `constructor(ctx: vscode.ExtensionContext, adapters: (cfg: ConnectionConfig) => DbAdapter)` — inject factory để test được bằng mock.
  - `addConnection(cfg: ConnectionConfig, password: string): Promise<void>` — test-connect trước, fail thì throw không lưu.
  - `editConnection(id: string, cfg: Partial<ConnectionConfig>, password?: string): Promise<void>` — password mới ghi đè secret.
  - `deleteConnection(id: string): Promise<void>` — xoá secret + state; nếu là active → đóng adapter + clear active.
  - `listConnections(): ConnectionConfig[]` ; `getActive(): ConnectionConfig | null` ; `setActive(id: string): Promise<void>` — đổi active = đóng adapter cũ.
  - `getAdapter(): Promise<DbAdapter>` — lazy connect (mở socket ở query đầu), idle timer 10 phút → `adapter.close()`; nếu password không lấy được từ SecretStorage → throw lỗi hướng dẫn nhập lại.
- `src/ui/statusBar.ts` — hàm `createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem` — text `$(database) <name> [<driver>]`, command `vsdb.selectConnection`, cập nhật qua event `onDidChangeActive` của manager (EventEmitter).
- `src/core/__tests__/connectionManager.test.ts` — unit với mock `ExtensionContext` (Memento + SecretStorage giả).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | Add connection lưu đúng nơi | metadata vào workspace Memento key `vsdb.connections`; password vào SecretStorage key `vsdb.pass.<id>` | mock ctx |
| 2 | unit | Test-connect fail → không lưu | adapter.connect throw → addConnection throw, Memento không có id | mock adapter throw ECONNREFUSED |
| 3 | edge | Delete connection đang active | adapter.close() được gọi, active = null, secret bị xoá | active trước đó |
| 4 | edge | Edit đổi password | secret key cũ bị ghi đè giá trị mới; metadata cập nhật | connection có sẵn |
| 5 | unit | Active remembered theo workspace | setActive(id) ghi Memento `vsdb.activeConnection`; getActive đọc lại đúng | 2 connections |
| 6 | edge | SecretStorage mất password | getAdapter throw lỗi có hướng dẫn "nhập lại password" (không crash) | secret trả undefined |
| 7 | unit (fake timers) | Idle timeout 10 phút | sau 10 phút không activity, adapter.close() được gọi; query mới → reconnect lazy | vitest fake timers |

## Test Files

- `src/core/__tests__/connectionManager.test.ts`

## Verification Commands

```bash
npx tsc --noEmit
npm test -- src/core/__tests__/connectionManager.test.ts
```

## Acceptance Criteria

- [ ] 7 test trên PASS (dùng vi.mock/vitest fake timers, KHÔNG cần VS Code thật).
- [ ] Không file config nào được viết ra repo (chỉ SecretStorage/WorkspaceState).
- [ ] Không regression: `npm test` PASS.
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 (`ConnectionConfig`), TASK-003 (`DbAdapter` interface + `createAdapter` để inject; dùng mock trong unit test nên chỉ cần type)

## Interfaces

- Consumes: `ConnectionConfig` (types.ts), `DbAdapter` (adapters/types.ts), `createAdapter(cfg: ConnectionConfig): DbAdapter` (factory).
- Produces (TASK-006/007 consume):
  - `class ConnectionManager` với các method trên + `onDidChangeActive: vscode.Event<ConnectionConfig | null>`.
  - `createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem`.

---

## Notes

Fallbacks per design §8: nếu SecretStorage lỗi → hỏi password mỗi lần connect (không lưu); nếu không có workspace mở (single file) → lưu connection vào globalState thay vì workspaceState.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-6

### Files created

- `src/core/connectionManager.ts` — class `ConnectionManager` (CRUD, persistence, lazy connect, idle timeout 10 min, EventEmitter).
- `src/ui/statusBar.ts` — function `createStatusBar(mgr)` returning `vscode.StatusBarItem`.
- `src/core/__tests__/connectionManager.test.ts` — 9 unit tests (7 bắt buộc theo spec + 2 design §8 / EventEmitter).
- `src/ui/__tests__/statusBar.test.ts` — 3 unit tests cho StatusBar text/command/update.

### RED_OUTPUT (actual, pre-implementation)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-005

 ❯ src/core/__tests__/connectionManager.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/core/__tests__/connectionManager.test.ts [ src/core/__tests__/connectionManager.test.ts ]
Error: Failed to load url ../connectionManager (resolved id: ../connectionManager) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-005/src/core/__tests__/connectionManager.test.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
   Start at  14:42:48
   Duration  210ms (transform 33ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 40ms)
```

### Verification Output

#### `npx tsc --noEmit` (exit 0, no output)

```
(no output → success)
```

#### `npm test -- src/core/__tests__/connectionManager.test.ts`

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-005

 ✓ src/core/__tests__/connectionManager.test.ts  (9 tests) 5ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  14:47:32
   Duration  217ms (transform 35ms, setup 38ms, collect 38ms, tests 5ms, environment 0ms, prepare 48ms)
```

#### `npm test` (regression — full suite)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-005

 ✓ src/scaffold.test.ts  (4 tests) 11ms
 ✓ src/core/__tests__/connectionManager.test.ts  (9 tests) 6ms
 ✓ src/ui/__tests__/statusBar.test.ts  (3 tests) 3ms
 ✓ src/core/__tests__/statementParser.test.ts  (26 tests) 4ms
 ✓ src/adapters/__tests__/factory.test.ts  (4 tests) 2ms

 Test Files  5 passed (5)
      Tests  46 passed (46)
   Start at  14:47:31
   Duration  293ms (transform 198ms, setup 301ms, collect 301ms, tests 27ms, environment 1ms, prepare 323ms)
```

### Implementation Notes

- **Workspace Memento**: chọn `workspaceState` khi `vscode.workspace.workspaceFolders` truthy, fallback `globalState` (design §8).
- **SecretStorage fallback**: `tryStorePassword`/`tryGetPassword`/`tryDeletePassword` đều bọc try/catch — nếu SecretStorage lỗi, metadata vẫn lưu, password sẽ được hỏi mỗi lần connect (Task #6/007 sẽ wire).
- **Test-connect**: `addConnection` / `editConnection` chạy probe qua factory, đóng probe trong `finally` để tránh leak. Fail → throw, KHÔNG lưu.
- **Lazy connect**: `setActive` chỉ ghi Memento + đóng adapter cũ, KHÔNG eagerly cache adapter. `getAdapter` mới lazy mở socket + reset idle timer 10 phút.
- **Idle timer**: `setTimeout` 10 phút, reset trên mỗi `getAdapter`. Hết hạn → `closeCurrentAdapter()`; query mới → reconnect lazy (factory được gọi lại).
- **EventEmitter**: `onDidChangeActive` fire khi `setActive`/`deleteConnection` thay đổi active id.
- **StatusBar**: subscribe `onDidChangeActive`, render `$(database) <name> [<driver>]` hoặc ẩn khi không có active. Command `vsdb.selectConnection`.

### Status

`pending_review`

### Note

Không đụng `src/adapters/*` (TASK-004 territory), `extension.ts` chỉ là stub từ TASK-001, `package.json` đã có contributions từ TASK-001. Tests cover toàn bộ 7 test cases bắt buộc + fallback globalState + EventEmitter + 3 test cho StatusBar. Tất cả 46 tests PASS; tsc clean.
