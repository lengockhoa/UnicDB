# TASK-CG2-003 — Wire guard + retry-1-lần vào `runGenerateCommitMessage` (3 branch) + docs

**Status:** ready
**Owner:** (unassigned — dispatch theo INDEX.md)
**Reviewer:** (gán lúc dispatch — PHẢI khác model executor)
**Parent plan:** docs/AI_HANDOFF/PLAN.md

## Goal

**Spec references:** SPEC.md §5 FR-007, FR-008; §8.4 (GuardOutcome/generateWithGuard) + §8.5 (frozen toasts); §9 (UI behavior); §11 (test matrix hàng 3); §12 AC-4, AC-5, AC-6, AC-8.

Chạy guard sau `sanitizeCommitMessage` ở CẢ 3 engine branch (omp / builtin /
claude-code-codex fallback): PASS → inject; invalid non-empty → retry ĐÚNG 1 lần với
corrective prompt qua CÙNG port/model; vẫn invalid → frozen error toast + KHÔNG inject
(fix bug "chuỗi hash" + contract tiếng Việt ≤100 từ). Cập nhật user guide.

## Target Files

- `src/ai/commitGenCommand.ts` (SỬA — extract `generateWithGuard`, rewire 3 branch,
  thêm 2 frozen strings; KHÔNG đổi shape `CommitGenDeps`, không thêm port)
- `src/ai/__tests__/commitGenCommand.test.ts` (SỬA — update fake EN→VN ở Tests #1/#2/#10
  giữ nguyên structural asserts; bổ sung describe guard-flow)
- `docs/UNICDB_USER_GUIDE.md` (SỬA — mục "Generate Commit Message" +3 bullet, giữ keyword)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | Regression (update fakes) | happy paths #1/#2/#10 đổi fake EN→VN, mọi structural assert giữ nguyên | builtin raw `"```\nfeat(db): thêm chỉ mục cho bảng users\n```"` → `builtinComplete` times(1), req shape cũ (modelId/300/0.2/2 messages), inject đúng fake, 0 showError; omp fake VN → `generate` times(1), promptArg chứa `"You generate git commit messages"` + `"Conventional Commits"` + `"tiếng Việt"`; claude-code/codex fake VN → times(1), inject, hint toast đúng 1 lần | CHỈ đổi fake text; không bớt assert cũ nào |
| 2 | Happy (retry) | garbage lần 1 → VN lần 2 (builtin) | call#1 = 72-hex blob, call#2 = `"fix(db): sửa lỗi truy vấn chậm"` → `builtinComplete` times(2); req#2 `messages[1].content` contains `"was rejected for these reasons"`, `"unbroken-blob"`, `"Vietnamese"`; `setInputBox` với msg#2; KHÔNG guard-error toast | Fakes return lần lượt theo call index |
| 3 | Happy (retry) | omp + claude-code fallback: garbage → VN | omp: generate#1 reasoning-leak `"We need to examine the staged diff carefully"`, #2 VN → `generate` times(2), `buildOmpEngine` vẫn times(1), inject msg#2; claude-code: #1 blob #2 VN → times(2), inject, hint toast đúng 1 LẦN (không lặp attempt 2) | Retry serialize corrective prompt qua `serializeCommitPrompt` |
| 4 | Edge (terminal) + Regression (bugfix pin) | garbage ×2 = 72-hex blob ×2 → block, không inject | cả 2 call = 72-hex blob → times(2), `setInputBox` KHÔNG được gọi, `showError` 1 lần chứa `"failed validation"`, `"Retried once"`, `"unbroken-blob"`, raw preview. FAIL trên code pre-cycle (hôm nay blob được inject thẳng, 0 guard, 1 call) | Frozen toast SPEC §8.5; regression pin bug "chatgpt luna" carry NGAY TẠI test này + test #2 (cùng fixture 72-hex) — KHÔNG có test regression riêng thứ 7 |
| 5 | Edge (length) | >100 từ ×2 → block | cả 2 call = 150 từ → KHÔNG inject, error contains `"message-too-long"` | Boundary qua guard, không cần đụng cap 600 chars |
| 6 | Edge (empty family, no-retry-on-empty) | attempt 1 rỗng; attempt 2 rỗng sau garbage | (a) text `""` lần 1 → `builtinComplete` times(1) (KHÔNG retry), error cũ `"provider returned no commit message text"`, KHÔNG inject; (b) 72-hex blob lần 1 → `""` lần 2 → times(2), CÙNG error cũ + dump `commit-gen-empty` với raw lần 2, KHÔNG inject, KHÔNG guard-toast, KHÔNG call thứ 3 | Empty-diagnostic giữ nguyên cả 2 attempt (SPEC FR-007 + §10; R1 review finding 2) |
| 7 | Edge (transport) | attempt 2 throw | #1 blob, #2 throw `Error("network exploded")` → `showError` contains `"network exploded"` (error mapping branch cũ), KHÔNG inject, KHÔNG guard-toast chồng | Throw từ `call` propagate qua catch branch |
| 8 | Docs (regression) | guide keywords còn đủ sau khi sửa | `npx vitest run src/ui/__tests__/userGuideContent.test.ts` PASS không sửa test; guide có thêm bullet "tiếng Việt", "12 từ"/"100 từ", retry-1-lần-then-error | Keyword GC test: "Generate Commit Message", "Source Control", "Lite model", "Conventional Commits", "Open AI Settings" |

## Test Files

- `src/ai/__tests__/commitGenCommand.test.ts` (mở rộng — file chính)
- `src/ui/__tests__/userGuideContent.test.ts` (chỉ CHẠY, không sửa)

## Verification Commands

```
npm run typecheck
npx vitest run src/ai/__tests__/commitGenCommand.test.ts
npx vitest run src/ui/__tests__/userGuideContent.test.ts
npx vitest run src/ai/__tests__/commitMessageGuard.test.ts src/ai/__tests__/commitMessage.test.ts
npm run compile
npm test
```

## Acceptance Criteria

- [ ] `generateWithGuard` + `GuardOutcome` export đúng signature SPEC §8.4; helper pure
      (ports-only, nhận closure `call`).
- [ ] 2 frozen strings `ERROR_COMMIT_GUARD_FAILED_PREFIX` + `ERROR_COMMIT_GUARD_RETRY_NOTE`
      đúng text SPEC §8.5; terminal toast đúng format (reasons join ", " + preview 240 +
      optional debug dump `commit-gen-guard-rejected`).
- [ ] Cả 3 branch đều qua guard; retry ĐÚNG 1 lần, CÙNG engine/model/cfg
      (`buildOmpEngine` times(1), cùng modelId/maxOutputTokens 300/temperature 0.2).
- [ ] Empty path KHÔNG retry, giữ nguyên diagnostic + `commit-gen-empty` dump.
- [ ] 8 test case trên PASS; Tests #1/#2/#10 chỉ đổi fake text, không bớt assert.
- [ ] `CommitGenDeps`, `provider.ts`, `sanitizeCommitMessage`, `package.json`: không đổi.
- [ ] Guide +3 bullet đúng FR-008; userGuideContent PASS.
- [ ] `npm run typecheck` 0 error; `npm run compile` OK; full `npm test` PASS.

## Dependencies

TASK-CG2-001 (imports `checkCommitMessage` + `CommitMessageIssue` từ
`src/ai/commitMessageGuard.ts`) và TASK-CG2-002 (imports `buildRetryCommitPrompt` +
SYSTEM_PROMPT mới từ `src/ai/commitMessage.ts`) — wave 2, chạy sau khi cả hai done.

## Interfaces

### Consumes

- `checkCommitMessage(candidate: string): CommitMessageGuardResult` — từ
  `./commitMessageGuard` (CG2-001).
- `buildRetryCommitPrompt(original: readonly ChatMessage[], rejectedMessage: string,
  reasons: readonly string[]): ChatMessage[]` — từ `./commitMessage` (CG2-002).
- Ports hiện có của `CommitGenDeps` (KHÔNG thêm): `builtinComplete`, `buildOmpEngine`,
  `writeDebugArtifact?`, `setInputBox`, `showError`, …

### Produces

```ts
export type GuardOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: "empty"; raw: string }
  | { ok: false; kind: "invalid"; raw: string; message: string;
      reasons: readonly CommitMessageIssue[] };

export async function generateWithGuard(
  call: (messages: readonly ChatMessage[]) => Promise<string>,
  prompt: readonly ChatMessage[],
): Promise<GuardOutcome>;

export const ERROR_COMMIT_GUARD_FAILED_PREFIX: string;  // SPEC §8.5
export const ERROR_COMMIT_GUARD_RETRY_NOTE: string;     // SPEC §8.5
```

Flow per branch (frozen): attempt 1 ok → inject; `kind:"empty"` → empty-diagnostic cũ
(không retry); `kind:"invalid"` → `buildRetryCommitPrompt(prompt, message, reasons)` qua
cùng `call` → sanitize → guard → ok thì inject, vẫn invalid thì terminal toast + optional
debug dump + return KHÔNG `setInputBox`. `call` throw (attempt nào) → catch branch hiện có.

## Discussion

- Guide bullets (FR-008, đặt sau bullet "Nếu chưa cấu hình Lite Model…"): (1) type prefix
  tiếng Anh + subject/body tiếng Việt kèm ví dụ `feat(db): thêm chỉ mục cho bảng users`;
  (2) giới hạn subject ≤ 12 từ (≤72 ký tự), tổng ≤ 100 từ (≤600 ký tự); (3) message rác →
  tự thử lại đúng 1 lần, vẫn sai → toast lỗi và KHÔNG điền ô commit.
- Cập nhật JSDoc "Frozen flow" của `runGenerateCommitMessage` cho khớp flow mới (bước 4
  thành guard/retry/inject) — reviewer sẽ đối chiếu với SPEC §8.4.
- `writeDebugArtifact` là optional port — gọi với `?.`, thiếu port không được crash.
