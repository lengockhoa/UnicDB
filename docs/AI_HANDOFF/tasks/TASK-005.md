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
