# TASK-504 — WHERE/ORDER BY bar + requery

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Bar 2 input WHERE + ORDER BY + nút Re-Run: wrap query gốc `SELECT * FROM (<sql>) vsdb_sub WHERE … ORDER BY …` rồi chạy lại qua QueryRunner.

## Target Files

- `src/ui/resultsGridModel.ts` — `composeRequery(sql, where, orderBy)`: strip trailing `;`, escape đúng chỗ (không inject khác), empty where/orderBy bỏ clause.
- `webview/main.ts` — WHERE/ORDER BY inputs + Re-Run button trên grid panel; post `{type:'requery', index, where, orderBy}`.
- `src/ui/messages.ts` + `src/ui/resultsPanel.ts` + `src/extension.ts` — handle requery: compose → runner.run → render lại.
- `src/ui/__tests__/resultsGridModelRequery.test.ts`.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | composeRequery happy | `SELECT * FROM (SELECT a FROM t) vsdb_sub WHERE a>1 ORDER BY a DESC` | sql+where+orderBy |
| 2 | unit | chỉ where / chỉ orderBy | clause tương ứng xuất hiện, clause kia vắng | 1 input empty |
| 3 | edge | cả hai empty | trả nguyên sql (strip `;`) | `"SELECT 1;"` |
| 4 | edge | sql gốc multi-statement / có `;` giữa | dùng statement của index đang render (executor note cách lấy — lấy nguyên đoạn sql của statement) | |
| 5 | integration | Re-Run click → postMessage requery đúng | message shape | jsdom |

## Test Files

- `src/ui/__tests__/resultsGridModelRequery.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsGridModelRequery.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Tests PASS.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- (none về code, nhưng chạy sau 501 để UI panel sẵn)

## Interfaces

- Consumes: (none)
- Produces: `function composeRequery(sql: string, where: string, orderBy: string): string`; message `{ type:'requery'; index: number; where: string; orderBy: string }`.

---

## Discussion

(chưa có comment)

