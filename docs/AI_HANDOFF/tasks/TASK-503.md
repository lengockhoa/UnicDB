# TASK-503 — Save edits (PK/ctid) + Commit flow + warning banner

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Cmd/Ctrl+Enter / nút Commit gửi 1 message `saveEdits` chứa mọi dirty cells (batch). Host build statements per adapter (UPDATE theo PK; PostgreSQL no-PK → ctid; MySQL/MSSQL no-PK → từ chối với warning). Webview hiện warning banner khi không save được; grid refresh sau commit.

## Target Files

- `src/ui/messages.ts` — thêm `saveEdits` message type.
- `webview/main.ts` — Cmd/Ctrl+Enter listener + Commit button → `postToHost({type:'saveEdits', index, edits, tableName, pkColumns})`; warning banner div; clear edit state sau ack.
- `src/ui/resultsPanel.ts` — handle `saveEdits` → gọi `runner`/adapter buildSaveStatements → run → trả state mới + `saveResult` (ok/errors).
- `src/core/queryRunner.ts` hoặc `src/adapters/*` — `buildSaveStatements(adapter, table, pkColumns, edits)`; postgres thêm `ctid` fallback query (SELECT ctid cần thiết — nếu result rows không có ctid, host query `SELECT ctid FROM t WHERE pk…` trước, hoặc webview nhận tableName+pkColumns từ metadata câu query gốc).
- `src/extension.ts` — pass table/pk metadata khi render results (parse từ query nếu có `FROM <table>`).
- `src/adapters/__tests__/` + `src/ui/__tests__/` — tests mới.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | buildSaveStatements PK present | `UPDATE t SET b=$1 WHERE a=$2` (postgres) / quoted mysql / mssql TOP syntax đúng dialect | edits 2 cells |
| 2 | unit | postgres no-PK → ctid | WHERE ctid = '(0,1)' syntax, warning flag set | no pkColumns |
| 3 | edge | mysql/mssql no-PK | trả `{ ok: false, reason: 'no_pk' }`, không build statement | no pkColumns |
| 4 | unit | commit-no-edits | KHÔNG post saveEdits (no-op) | dirtyCount=0 |
| 5 | unit | commit batch nhiều dòng | 1 message chứa tất cả edits (2 rows, 3 cells) | dirty 3 cells |
| 6 | integration | saveEdits → host ack → edit state clear + banner ẩn | state reset | jsdom |
| 7 | edge | save fail (SQL error) | banner hiện lỗi từ host, edit state GIỮ (không clear) để retry | ack error |
| 8 | regression | theme/filters vẫn hoạt động sau commit + re-render | 232 test cũ pass | full suite |

## Test Files

- `src/adapters/__tests__/saveStatements.test.ts`
- `src/ui/__tests__/webviewSaveEdits.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/adapters/__tests__/saveStatements.test.ts src/ui/__tests__/webviewSaveEdits.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Tests PASS.
- [ ] Browser smoke: edit cell → Cmd+Enter → đúng 1 postMessage.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-501 (EditState.snapshot)

## Interfaces

- Consumes: `EditState.snapshot()` (TASK-501), `sqlLiteral` (TASK-502).
- Produces: message `{ type:'saveEdits'; index: number; edits: Array<{ rowId: number; colIndex: number; value: unknown }>; tableName: string | null; pkColumns: string[] }`; host ack `{ type:'saveResult'; index: number; ok: boolean; errors?: string[] }`.

---

## Discussion

(chưa có comment)

