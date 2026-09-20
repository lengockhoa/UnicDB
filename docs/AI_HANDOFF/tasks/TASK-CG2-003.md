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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
RED_OUTPUT: |
  FAIL src/ai/__tests__/commitGenCommand.test.ts > guard flow (SPEC §8.4/§8.5) > builtin: retries once with the corrective prompt and injects attempt 2
  AssertionError: expected "spy" to be called 2 times, but got 1 times
  FAIL ... > omp: retries once through the same engine and injects attempt 2
  AssertionError: expected "generate" to be called 2 times, but got 1 times
  FAIL ... > claude-code fallback: retries once and emits the hint toast only once
  AssertionError: expected "spy" to be called 2 times, but got 1 times
  FAIL ... > builtin: garbage twice blocks with the frozen toast and never injects
  AssertionError: expected "spy" to be called 2 times, but got 1 times
  FAIL ... > builtin: an over-100-word message fails twice with message-too-long
  AssertionError: expected "spy" to be called 2 times, but got 1 times
  FAIL ... > builtin: garbage then empty on attempt 2 falls into the empty diagnostic (no third call)
  AssertionError: expected "spy" to be called 2 times, but got 1 times
  FAIL ... > builtin: a throw on attempt 2 is mapped by the existing provider-error catch
  AssertionError: expected "spy" to be called 2 times, but got 1 times
  Test Files  1 failed (1)
       Tests  7 failed | 13 passed (20)

Verification Output: |
  ### npm run typecheck
  > tsc --noEmit                (0 errors)
  ### npx vitest run src/ai/__tests__/commitGenCommand.test.ts
  ✓ src/ai/__tests__/commitGenCommand.test.ts  (20 tests) 10ms
  Test Files  1 passed (1) — Tests 20 passed (20)
  ### npx vitest run src/ui/__tests__/userGuideContent.test.ts
  ✓ src/ui/__tests__/userGuideContent.test.ts  (26 tests) 3ms
  Test Files  1 passed (1) — Tests 26 passed (26)
  ### npx vitest run src/ai/__tests__/commitMessageGuard.test.ts src/ai/__tests__/commitMessage.test.ts
  ✓ commitMessage.test.ts (23 tests) ✓ commitMessageGuard.test.ts (18 tests)
  Test Files  2 passed (2) — Tests 41 passed (41)
  ### npm run compile
  esbuild: build complete
  ### npm test
  Test Files  6 failed | 308 passed | 2 skipped (316)
  Tests  1 failed | 4669 passed | 5 skipped (4675)
  NOTE: the 6 failing files / 1 failing test are PRE-EXISTING at the wave-1 base commit
  (verified by stashing my changes and re-running: identical result set, empty diff of
  `FAIL` lines). Root cause is worktree environment only — `node_modules/.bin/esbuild`
  and `node_modules/.bin/vsce` are absent in `.worktrees/task-cg2-003` (spawnSync ENOENT
  in the aiChatPanel*Webview / webviewServerFilter bundle tests and the vsix round-trip).
  Unrelated to this task; no delta introduced.

Status: PASS
Note: |
  Deviation from Target Files (1 extra file): `src/ui/__tests__/commitGenIntegration.test.ts`
  was also updated. Its Test #2 / #5 fakes were clean-English commit strings
  ("feat(db): add index", "feat(api): route through omp|builtin"). The guard correctly
  rejects clean English (`not-vietnamese`), so after wiring those integration tests failed
  `builtinComplete called 1 time, got 2` — the intended new contract. Fix was the same
  EN→VN fake swap the task prescribes for #1/#2/#10; every structural assertion was kept.
  Kept out of scope otherwise (no shape/port/provider.ts/sanitize changes).
  Test row #5 fixture note: a single-line 150-word string cannot reach >100 words because
  `sanitizeCommitMessage` clamps the subject to 72 chars first; used a multiline fixture
  (short VN subject + 120-word body) so `message-too-long` genuinely fires.
  row #8 (userGuideContent) required no test edit — passed unmodified.


## Progress

- 2026-09-21T00:28:29+0700 · milestone: guard-wired-green · last-green: typecheck + commitGenCommand(20) + userGuideContent(26) + guard/message(41) + compile · files: src/ai/commitGenCommand.ts, src/ai/__tests__/commitGenCommand.test.ts, src/ui/__tests__/commitGenIntegration.test.ts, docs/UNICDB_USER_GUIDE.md, docs/AI_HANDOFF/tasks/TASK-CG2-003.md · drift: src/ui/__tests__/commitGenIntegration.test.ts (EN->VN fakes required by guard rewiring; same pattern as Tests #1/#2/#10)
