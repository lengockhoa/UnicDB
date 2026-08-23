# TASK-702 — capDetail cắt an toàn code point

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.2

## Goal

`capDetail` (extension.ts) dùng `String.slice(0, cap)` — cắt theo UTF-16 code unit, có thể đứt giữa surrogate pair (emoji trong SQL comment/identifier tiếng Việt có dấu hoàn toàn có thể) → modal hiện ký tự hỏng `�`. Trích helper slice theo code point.

## Target Files

- `src/core/text.ts` — NEW: `truncateAtBoundary(s: string, cap: number): string`.
- `src/extension.ts` — `capDetail` dùng helper (2 dòng).
- `src/core/__tests__/text.test.ts` — NEW.

## Interfaces

- Produces: `truncateAtBoundary(s: string, cap: number): string` — hành vi giống slice+`…` suffix hiện tại nhưng không bao giờ kết thúc bằng半个 surrogate pair; nếu cắt xảy ra ngay trước high surrogate thì lùi 1.
- Consumes: `capDetail(texts: string[], cap: number)` trong extension.ts gọi helper.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | ASCII dưới cap | nguyên vẹn không `…` | `"DELETE FROM t"`, cap 2000 |
| 2 | unit | ASCII vượt cap | `s.slice(0,cap) + "…"` | `"a".repeat(3000)`, cap 100 |
| 3 | edge | emoji tại biên | chuỗi kết quả KHÔNG chứa lone surrogate; `[...result].pop()` là `…` hoặc full code point | `"x".repeat(99) + "🔥" + "y".repeat(50)`, cap 100 |
| 4 | edge | cap = 0 | `""` hoặc `…` không crash | bất kỳ |

## Test Files

- `src/core/__tests__/text.test.ts`

## Verification Commands

```bash
npm run compile && npx vitest run src/core/__tests__/text.test.ts src/core/__tests__/dangerousStatement.test.ts
npm run typecheck
```

(dangerousStatement chạy kèm để bắt regression nếu gãy chung module core.)

## Acceptance Criteria

- [ ] Helper export + dùng trong capDetail
- [ ] Test 3 RED với code cũ (dùng raw slice), GREEN với helper
- [ ] extension.ts chỉ đổi 2 dòng (import + gọi)

## Executor Report

(chưa có)

## Reviewer Verdict

(chưa có)
