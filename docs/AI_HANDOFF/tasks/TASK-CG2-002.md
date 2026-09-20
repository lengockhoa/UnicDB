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
