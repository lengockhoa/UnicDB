# TASK-701 — EXPLAIN ANALYZE prelude trong danger guard

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.1

## Goal

`EXPLAIN [ANALYZE] DELETE/TRUNCATE/DROP/UPDATE...` hiện classify `other` → tier `none` → confirm modal bị skip, dù ANALYZE **thực thi** lệnh. Bắt `explain` (+ modifiers) như prelude để kind + hasWhere tính theo statement thật bên trong.

## Target Files

- `src/core/dangerousStatement.ts` — `analyzeStatement`: skip-past `explain` prelude.
- `src/core/__tests__/dangerousStatement.test.ts` — append cases.

## Interfaces

- Consumes: `analyzeStatement(sql: string): StatementAnalysis` (existing, unchanged signature).
- Produces: same signature; behavior mới cho input bắt đầu `explain`.
- `(none)` cho task khác — pure function, không đụng extension.ts.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | explain delete no-where | kind=delete, hasWhere=false → tier red | `EXPLAIN DELETE FROM t` |
| 2 | unit | explain analyze delete | red | `EXPLAIN ANALYZE DELETE FROM t` |
| 3 | edge | parenthesized options | red | `EXPLAIN (ANALYZE, COSTS) UPDATE t SET a=1` |
| 4 | edge | CTE sau explain | kind=delete, hasWhere=true → amber | `EXPLAIN ANALYZE WITH c AS (SELECT 1) DELETE FROM t WHERE x=1` |
| 5 | unit | harmless sau explain | tier none | `EXPLAIN ANALYZE SELECT * FROM t` |
| 6 | regression | explain+update có where | none | `EXPLAIN ANALYZE UPDATE t SET a=1 WHERE id=2` |
| 7 | regression | không explain, không đổi | red | `DELETE FROM t` (existing behavior giữ nguyên) |

## Test Files

- `src/core/__tests__/dangerousStatement.test.ts`

## Verification Commands

```bash
npm run compile && npx vitest run src/core/__tests__/dangerousStatement.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] 7 test trên RED trước (case 1-6 fail với code hiện tại), GREEN sau
- [ ] Không thay đổi behavior câu không có EXPLAIN
- [ ] hasWhere vẫn tính trên full masked text

## Executor Report

(chưa có)

## Reviewer Verdict

(chưa có)
