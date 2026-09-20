# TASK-CG2-001 — Pure guard module `commitMessageGuard.ts` (8 reason codes, frozen thresholds)

**Status:** ready
**Owner:** (unassigned — dispatch theo INDEX.md)
**Reviewer:** (gán lúc dispatch — PHẢI khác model executor)
**Parent plan:** docs/AI_HANDOFF/PLAN.md

## Goal

**Spec references:** SPEC.md §5 FR-001, FR-002, FR-003, FR-004; §7 (detection rules) + §7.1 (VN word markers); §8.3 (signatures); §11 (test matrix hàng 1); §12 AC-1, AC-2.

Tạo pure module kiểm tra tính hợp lệ của candidate commit message — lớp check còn thiếu
gây ra bug "chuỗi hash 72 ký tự" với reasoning models. Module zero-import, deterministic,
đủ 8 reason codes với threshold frozen (SPEC §7) để task CG2-003 wiring dùng.

## Target Files

- `src/ai/commitMessageGuard.ts` (NEW — zero import, KHÔNG import `vscode`)
- `src/ai/__tests__/commitMessageGuard.test.ts` (NEW — vitest, style giống
  `src/ai/__tests__/commitMessage.test.ts`: `import { describe, it, expect } from "vitest"`)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | Happy | VN có dấu + VN không dấu pass, pure khi gọi lại | `"feat(db): thêm chỉ mục cho bảng users"` → `{ ok: true, reasons: [] }`; `"feat(db): cap nhat ket qua truy van"` → ok (markers "cap nhat"/"ket qua"); gọi lại cả hai lần nữa → kết quả giống hệt (no cache/state) | Message chuẩn locked decision #1; markers SPEC §7.1 |
| 2 | Edge (empty) | rỗng / whitespace-only | `checkCommitMessage("")` và `checkCommitMessage("   \n  ")` → `reasons` exactly `["empty"]`, không reason khác | Short-circuit — không xét rule 2..8 |
| 3 | Edge (boundary) | token 39 vs 40 chars | `"a".repeat(39)` → KHÔNG có `unbroken-blob`; `"a".repeat(40)` → CÓ `unbroken-blob` | Ranh giới `GUARD_BLOB_TOKEN_MIN_CHARS = 40`, so sánh `>=` |
| 4 | Edge (hash) | hex token 36 chars | `"3f9a2c".repeat(6)` → CÓ `hash-like`, KHÔNG có `unbroken-blob` (36 < 40) | Regex `/^[0-9a-f]{32,}$/i` per token |
| 5 | Edge (ratio + marker) | symbol-heavy + reasoning markers | `"feat: {{{[[[()]]]}}}"` → CÓ `symbol-heavy`; `"We need to add an index to speed up lookups"` → CÓ `reasoning-marker`; text chứa `"```"` → CÓ; `"okay"` ×2 → CÓ | Ratio > 0.5 (§7 #4); frozen phrase list + fence + repeated interjection (§7 #5) |
| 6 | Edge (language) | English sạch bị flag, prefix English không phải lỗi | `"feat(db): add index to the users table"` → CÓ `not-vietnamese`; `"feat(ui): sửa lỗi hiển thị"` → `ok: true` | Chỉ FAIL khi VỪA không dấu VỪA không marker; prefix không tính |
| 7 | Edge (boundary words) | subject 12/13 từ, tổng 100/101 từ | Subject 13 từ → CÓ `subject-too-long`; subject 12 từ (vd `"feat(db): sua loi nang cap"` = 5 từ) → không; tổng = subject 5 từ + body 95×`"sua"` = 100 → ok (marker `sua` giữ `not-vietnamese` không fire — R1: KHÔNG dùng "them"/"bang", đã loại khỏi §7.1); +1 từ → CÓ `message-too-long` và KHÔNG có `subject-too-long` | `COMMIT_SUBJECT_MAX_WORDS = 12`, `COMMIT_MESSAGE_MAX_WORDS = 100`, so sánh `>` |
| 8 | Regression (bug signature) | blob hash 72-char sau clamp (bug report hôm nay) | Candidate 72-char hex token → `reasons` exactly `["unbroken-blob", "hash-like", "not-vietnamese"]` (exact array — pin thứ tự thu §7) | Fixture: 72 hex chars, single token |

## Test Files

- `src/ai/__tests__/commitMessageGuard.test.ts` (NEW)

## Verification Commands

```
npm run typecheck
npx vitest run src/ai/__tests__/commitMessageGuard.test.ts
npm run compile
```

## Acceptance Criteria

- [ ] `src/ai/commitMessageGuard.ts` tồn tại, KHÔNG có dòng nào chứa `vscode`
      (`grep -c vscode src/ai/commitMessageGuard.ts` → 0), không import nào.
- [ ] Export đúng: `checkCommitMessage`, `CommitMessageIssue` (8 literal union),
      `CommitMessageGuardResult`, `COMMIT_SUBJECT_MAX_WORDS=12`,
      `COMMIT_MESSAGE_MAX_WORDS=100`, `GUARD_BLOB_TOKEN_MIN_CHARS=40`,
      `GUARD_SYMBOL_RATIO_MAX=0.5`.
- [ ] 8 test case trên PASS (≥1 happy + ≥6 edge thuộc ≥5 loại khác nhau: empty,
      boundary, ratio, marker, language, multi-reason).
- [ ] `npm run typecheck` 0 error; `npm run compile` OK.
- [ ] Không đụng file nào ngoài 2 Target Files.

## Dependencies

none — làm song song TASK-CG2-002 (wave 1).

## Interfaces

### Consumes

none — module không import gì cả (pure, dependency-free).

### Produces

```ts
export type CommitMessageIssue =
  | "empty" | "unbroken-blob" | "hash-like" | "symbol-heavy"
  | "reasoning-marker" | "not-vietnamese" | "subject-too-long" | "message-too-long";

export interface CommitMessageGuardResult {
  ok: boolean;
  reasons: readonly CommitMessageIssue[];
}

export function checkCommitMessage(candidate: string): CommitMessageGuardResult;

export const COMMIT_SUBJECT_MAX_WORDS: 12;
export const COMMIT_MESSAGE_MAX_WORDS: 100;
export const GUARD_BLOB_TOKEN_MIN_CHARS: 40;
export const GUARD_SYMBOL_RATIO_MAX: 0.5;
```

Frozen semantics + frozen VN word-marker list: SPEC §7 / §7.1. `ok === (reasons.length === 0)`.

## Discussion

- Reason codes là string literal union — CG2-003/CG2-002 dùng `readonly string[]` ở
  signature rộng hơn, structural-compatible, không cần import chéo.
- Test #11 pin exact array để bắt regress thứ tự thu reasons; nếu executor thêm rule mới
  phải cập nhật SPEC §7 trước.
- Conservative theo hướng false-ACCEPT: KHÔNG thêm marker dễ trúng tiếng Anh vào §7.1
  (vd bỏ "cho", "va") — English sạch PHẢI bị flag `not-vietnamese` (đó là thiết kế).
