# TASK-CG2-002 — SYSTEM_PROMPT tiếng Việt + `buildRetryCommitPrompt` trong `commitMessage.ts`

**Status:** ready
**Owner:** (unassigned — dispatch theo INDEX.md)
**Reviewer:** (gán lúc dispatch — PHẢI khác model executor)
**Parent plan:** docs/AI_HANDOFF/PLAN.md

## Goal

**Spec references:** SPEC.md §5 FR-005, FR-006; §8.1 (frozen SYSTEM_PROMPT) + §8.2 (retry-prompt builder); §11 (test matrix hàng 2); §12 AC-3.

Dạy model sinh đúng contract mới (tiếng Việt + giới hạn từ) ngay từ system prompt, và
cung cấp pure builder tạo corrective retry prompt (locked decision #2) để CG2-003 dùng
khi guard fail. Giữ nguyên toàn bộ semantics hiện có của `buildCommitPrompt`,
`serializeCommitPrompt`, `sanitizeCommitMessage` — 17 test cũ phải vẫn xanh.

## Target Files

- `src/ai/commitMessage.ts` (SỬA — chỉ thay SYSTEM_PROMPT dòng 14-15 + thêm export mới;
  KHÔNG đụng `sanitizeCommitMessage`/`serializeCommitPrompt`/constants)
- `src/ai/__tests__/commitMessage.test.ts` (SỬA — chỉ BỔ SUNG describe mới; không sửa
  test cũ nào)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | Regression | 17 test cũ vẫn xanh sau khi thay SYSTEM_PROMPT | `npx vitest run src/ai/__tests__/commitMessage.test.ts` → toàn bộ PASS; Test #1 vẫn assert `messages[0].content` contains `"Conventional Commits"` và PASS | Prompt mới PHẢI giữ 2 substring `"You generate git commit messages"` + `"Conventional Commits"` (đang bị Test #1 + commitGenCommand Test #2 assert) |
| 2 | Happy | SYSTEM_PROMPT mới dạy tiếng Việt + limits | `buildCommitPrompt({...}).messages[0].content` contains đồng thời: `"VIETNAMESE (tiếng Việt)"`, `"12 words"`, `"100 words"`, ví dụ `"feat(db): thêm chỉ mục cho bảng users"` | Prompt frozen text ở SPEC §8.1 |
| 3 | Happy | retry prompt mang đủ context gốc + reason + rejected | `buildRetryCommitPrompt([{role:"system",content:S},{role:"user",content:"Repo: X\nDiff: +a"}], "garbage text", ["hash-like"])` → length 2; `[0]` bằng system gốc; `[1].content` contains `"Repo: X"`, `"+a"`, `"hash-like"`, `"garbage text"`, `"Vietnamese"` | Signature SPEC §8.2 |
| 4 | Edge (multi-value) | nhiều reasons join ", " | reasons `["hash-like","message-too-long"]` → content contains `"hash-like, message-too-long"` | Frozen shape §8.2 |
| 5 | Edge (boundary/truncate) | rejected > 240 chars bị truncate + collapse whitespace | rejected = `"x".repeat(300)` → content chứa đúng 240 ký tự `x`, KHÔNG chứa 300; rejected đa whitespace → collapsed 1 space | `slice(0, 240).replace(/\s+/g, " ")` |
| 6 | Edge (malformed) | thiếu user message → structured throw | `buildRetryCommitPrompt([{role:"user",content:"only"}], "x", ["empty"])` → OK; `buildRetryCommitPrompt([{role:"system",content:"s"}], "x", ["empty"])` → throw `Error` match `/retry prompt requires a user message/` | Defence kiểu `serializeCommitPrompt` |
| 7 | Happy (pure) | builder không mutate input | Gọi xong, `original` array + các phần tử giống hệt trước khi gọi (deep-equal snapshot) | Pure function contract |

## Test Files

- `src/ai/__tests__/commitMessage.test.ts` (bổ sung 1-2 describe mới, ≥7 test case trên)

## Verification Commands

```
npm run typecheck
npx vitest run src/ai/__tests__/commitMessage.test.ts
npm run compile
```

## Acceptance Criteria

- [ ] SYSTEM_PROMPT đúng frozen text SPEC §8.1; `grep -c "Conventional Commits" src/ai/commitMessage.ts` ≥ 1
      và prompt chứa "tiếng Việt".
- [ ] `buildRetryCommitPrompt` export với signature SPEC §8.2, throw đúng message khi thiếu user message.
- [ ] 17 test cũ không sửa dòng nào vẫn PASS; ≥7 test mới PASS.
- [ ] `sanitizeCommitMessage`, `serializeCommitPrompt`, `buildCommitPrompt`, 2 constants: không đổi semantics.
- [ ] `npm run typecheck` 0 error; `npm run compile` OK.
- [ ] Không đụng file nào ngoài 2 Target Files.

## Dependencies

none — làm song song TASK-CG2-001 (wave 1). Reasons truyền vào builder là
`readonly string[]` — không cần chờ guard module.

## Interfaces

### Consumes

- `import type { ChatMessage } from "./provider"` (đã có trong file).

### Produces

```ts
export function buildRetryCommitPrompt(
  original: readonly ChatMessage[],
  rejectedMessage: string,
  reasons: readonly string[],
): ChatMessage[];
```

Trả `[originalSystem, correctiveUser]`; correctiveUser content frozen shape SPEC §8.2
(user content gốc + reasons join ", " + rejected truncate 240 + 4 dòng corrective:
plain-text-only / EN prefix + VN body / 12-word subject / 100-word message).
SYSTEM_PROMPT text frozen: SPEC §8.1.

## Discussion

- Có chủ đích giữ prompt dạng tiếng Anh dạy output tiếng Việt — prompt instruction không
  cần VN, output mới cần.
- Không gộp corrective vào `buildCommitPrompt` (sẽ đổi shape test #1/#1b/#1c) — builder
  riêng nhận `original` messages là tối thiểu xâm lấn.
- CG2-003 sẽ assert ở req#2 của retry (`messages[1].content` contains reason code +
  "rejected") — executor giữ đúng các cụm từ "was rejected for these reasons" và
  "Rejected text" trong shape.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: Claude:executor

RED_OUTPUT: |
```
 FAIL  src/ai/__tests__/commitMessage.test.ts > ai/commitMessage — buildRetryCommitPrompt (SPEC §8.2) > Test #4 — multiple reasons joined with ', '
TypeError: buildRetryCommitPrompt is not a function
 ❯ src/ai/__tests__/commitMessage.test.ts:210:22
 FAIL  src/ai/__tests__/commitMessage.test.ts > ai/commitMessage — buildRetryCommitPrompt (SPEC §8.2) > Test #5 — rejected text truncated to 240 chars and whitespace collapsed
TypeError: buildRetryCommitPrompt is not a function
 ❯ src/ai/__tests__/commitMessage.test.ts:219:23
 FAIL  src/ai/__tests__/commitMessage.test.ts > ai/commitMessage — buildRetryCommitPrompt (SPEC §8.2) > Test #6 — throws a structured Error when no user message is present
AssertionError: expected [Function] to not throw an error but 'TypeError: __vite_ssr_import_1__.buildRetryCommitPrompt is not a function' was thrown
 ❯ src/ai/__tests__/commitMessage.test.ts:232:11
 FAIL  src/ai/__tests__/commitMessage.test.ts > ai/commitMessage — buildRetryCommitPrompt (SPEC §8.2) > Test #7 — does not mutate the original messages array
TypeError: buildRetryCommitPrompt is not a function
 ❯ src/ai/__tests__/commitMessage.test.ts:240:5
 Test Files  1 failed (1)
      Tests  6 failed | 17 passed (23)
```
(RED reason: new import `buildRetryCommitPrompt` was not yet exported — 6 new tests fail,
all 17 pre-existing tests still pass. System-prompt Test #2 also failed pre-implementation,
counted among the 6.)

Verification Output: |
```
===== npm run typecheck =====
> UnicDB@1.54.1 typecheck
> tsc --noEmit
(exit 0, 0 errors)

===== npx vitest run src/ai/__tests__/commitMessage.test.ts =====
 RUN  v1.6.1
 ✓ src/ai/__tests__/commitMessage.test.ts  (23 tests) 4ms
 Test Files  1 passed (1)
      Tests  23 passed (23)

===== npm run compile =====
esbuild: build complete (dist/aiChatPanel.js, dist/webview.js, dist/extension.js)
(exit 0)
```
Acceptance checks: `grep -c "Conventional Commits" src/ai/commitMessage.ts` = 2;
prompt contains "tiếng Việt" (grep count 2). Only the 2 Target Files modified
(`git status --short`: M src/ai/commitMessage.ts, M src/ai/__tests__/commitMessage.test.ts).
Milestone commit: 09e9777 on branch handoff/task-cg2-002.

Status: PASS
Note: none

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/__tests__/commitMessage.test.ts && npm run compile
  result: typecheck 0 errors (exit 0); vitest 23/23 PASS (17 pre-existing untouched + 6 new); compile exit 0
TEST_PLAN_COVERAGE: all-followed — §4 rows 1-7 implemented (6 new tests + untouched 17-test regression suite); RED_OUTPUT is real failing output (6 failed / 17 passed, TypeError stacks)
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: SYSTEM_PROMPT byte-identical to SPEC §8.1 (verified programmatically); buildRetryCommitPrompt matches frozen §8.2 shape/throw exactly; sanitizeCommitMessage/serializeCommitPrompt/constants unchanged; no vscode import; milestone commit 09e9777 touched only the 2 Target Files with zero test deletions. Reviewer ran as bao-opus (differs from executor bao-sonnet — isolation satisfied); buildRetryCommitPrompt's extra typeof guard on non-string user content is a defensive superset of §8.2 that cannot fire on real call paths, not drift.
