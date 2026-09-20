# TASK-CG2-001 — Pure guard module `commitMessageGuard.ts` (8 reason codes, frozen thresholds)

**Status:** ready
**Owner:** (unassigned — dispatch theo INDEX.md)
**Reviewer:** bao-opus (verdict: approved_minor)
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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
RED_OUTPUT: (vitest run before `src/ai/commitMessageGuard.ts` existed)
```
 FAIL  src/ai/__tests__/commitMessageGuard.test.ts [ src/ai/__tests__/commitMessageGuard.test.ts ]
Error: Failed to load url ../commitMessageGuard (resolved id: ../commitMessageGuard) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-cg2-001/src/ai/__tests__/commitMessageGuard.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
```
Verification Output:
```
$ grep -c vscode src/ai/commitMessageGuard.ts
0

$ npm run typecheck
> UnicDB@1.54.1 typecheck
> tsc --noEmit
(exit 0, 0 errors)

$ npx vitest run src/ai/__tests__/commitMessageGuard.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-cg2-001
 ✓ src/ai/__tests__/commitMessageGuard.test.ts  (18 tests) 4ms
 Test Files  1 passed (1)
      Tests  18 passed (18)
(exit 0)

$ npm run compile
⚡ Done in 33ms / esbuild: build complete
(exit 0)
```
Status: PASS
Note: none. Milestone commits on worktree branch: 22e97ea (red-tests), d1c9afe (green-guard). Only the 2 Target Files added; no other file touched.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/__tests__/commitMessageGuard.test.ts && npm run compile && grep -c vscode src/ai/commitMessageGuard.ts
  result: typecheck 0 errors (exit 0); 18/18 tests pass; esbuild compile OK (exit 0); grep -c vscode = 0 — all re-run fresh by reviewer this turn
TEST_PLAN_COVERAGE: all-followed — 8/8 Test Cases implemented as 18 vitest tests; RED_OUTPUT holds real pre-implementation failure (module-missing load error + stack trace, non-zero exit); test #8 pins exact array ["unbroken-blob","hash-like","not-vietnamese"] via toEqual
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/commitMessageGuard.ts:100-108 — isSymbolHeavy iterates code points but divides by UTF-16 .length; astral-plane (surrogate-pair) symbols under-count the ratio (pure-emoji text measures 0.5, not 1.0). Unreachable for reasoning-leak output (BMP symbols), conservative direction, no frozen test affected — record for a future spec revision only; do NOT change frozen behavior in this cycle.
    - src/ai/commitMessageGuard.ts:116 — style nit: stray space in `start === "" )`.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Implementation matches SPEC §7/§7.1/§8.3 exactly — emission order empty→blob→hash→symbol→reasoning→not-vietnamese→subject→message with no post-empty short-circuit; `>=`40 / `/^[0-9a-f]{32,}$/i` / `>`0.5 non-ws / `>`12 / `>`100 boundaries; all 20 frozen §7.1 markers with "them"/"bang" correctly absent; frozen countWords/tokens/subject helpers replicated verbatim; zero imports, zero vscode refs. Model isolation OK: executor bao-sonnet ≠ reviewer bao-opus (config binds handoff.reviewer.model=unic-smart → claude-opus tier).
