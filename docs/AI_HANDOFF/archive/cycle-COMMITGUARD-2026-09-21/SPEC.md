# SPEC — COMMITGUARD: commit-message guard + retry for Generate Commit Message

<!--
Written by the planner at handoff-create (Step 2, before PLAN.md tasks).
Rule: executor implement không cần đoán — exact paths, signatures, reason codes,
frozen strings, thresholds, test expectations. Open questions chốt trong §14.
-->

## 1. Problem and context

"Generate Commit Message" (SCM sparkle, command `UnicDB.generateCommitMessage`) với
model reasoning (vd "chatgpt luna") sinh ra **một chuỗi dài giống hash** thay vì commit
message; model "GLM5 turbo" chạy đúng. Root cause (verified trong source):

- Parser fallback cho reasoning models trong `src/ai/provider.ts`
  (`pickLongestStringField` provider.ts:209, `extractAnyText` provider.ts:121 — gồm cả
  key `reasoning_content`/`reasoning`) có thể trả về blob reasoning/hash dài nhất trong
  payload thay vì `content` sạch.
- `sanitizeCommitMessage` (`src/ai/commitMessage.ts:94-142`) chỉ normalize (trim, strip
  fences/quotes, clamp subject 72 chars, cap 600 chars) — **không bao giờ validate** rằng
  output là một commit message hợp lệ. Clamp bước 5 cắt đúng 72 chars từ blob không có
  space → tạo ra đúng hình dạng "chuỗi hash 72 ký tự" rồi inject vào ô commit.
- Không có lớp check nào khác trong `src/ai/commitGenCommand.ts`
  (`runGenerateCommitMessage`): sanitize xong là inject nếu `length > 0`.

User yêu cầu (verbatim intent): thêm **1 lớp check message lại**, message **tầm 100 chữ
xuống**, ngắn, **TIẾNG VIỆT**. Người dùng đã chốt 3 quyết định (ghi verbatim ở
`docs/AI_HANDOFF/PLAN.md` §1): (1) type prefix Conventional Commits giữ tiếng Anh,
subject + body tiếng Việt; (2) garbage → retry đúng 1 lần với corrective instruction,
vẫn fail → toast lỗi rõ ràng và KHÔNG inject; (3) subject ≤ 12 từ, tổng ≤ 100 từ.

## 2. Goals

- Commit messageinject vào ô SCM luôn là text trông như commit message: không hash/reasoning
  blob, tiếng Việt, subject ≤ 12 từ, tổng ≤ 100 từ.
- Garbage phát hiện được bằng pure function deterministic, test được không cần vscode.
- Retry đúng 1 lần qua CÙNG engine path (omp / builtin / claude-code-codex-fallback);
  vẫn fail → error toast tiếng Việt-thân thiện, không đụng ô commit.
- Baseline 29 test của `commitMessage.test.ts` (17) + `commitGenCommand.test.ts` (12)
  vẫn xanh sau khi update fake messages sang tiếng Việt (contract đổi, structural
  assertions giữ nguyên).

## 3. Non-goals

- KHÔNG đổi parser `src/ai/provider.ts` (`pickLongestStringField`, `extractAnyText`) —
  fallback này giúp các model khác; chặn ở output-guard thay vì thu hẹp fallback.
- KHÔNG đổi semantics của `sanitizeCommitMessage` (pipeline 6 bước giữ nguyên; cap
  72/600 chars vẫn là secondary guard sau guard word-count).
- KHÔNG thêm npm dependency, KHÔNG đụng `vscode` import trong module pure
  (`commitMessage.ts`, `commitMessageGuard.ts`, `commitGenCommand.ts` giữ pure).
- KHÔNG bump version / package / publish.
- KHÔNG thêm port mới vào `CommitGenDeps` (retry tái dùng đúng các port hiện có).

## 4. User journeys

- **Happy**: user bấm sparkle → diff thu thập → engine sinh message → sanitize → guard
  PASS → message tiếng Việt (vd `feat(db): thêm chỉ mục cho bảng users`) vào ô commit.
- **Garbage một lần** (bug hôm nay): engine trả blob hash/reasoning → guard FAIL →
  UnicDB tự gọi lại đúng 1 lần kèm corrective instruction → lần 2 trả message hợp lệ →
  inject. User thấy kết quả đúng, không cần làm gì.
- **Garbage hai lần**: cả 2 lần đều fail guard → toast lỗi (frozen string, có reasons +
  raw preview + debug dump path) → ô commit KHÔNG bị ghi đè.
- **Empty response**: provider trả text rỗng/whitespace → giữ nguyên hành vi hiện tại
  (KHÔNG retry): toast "provider returned no commit message text…" + debug dump
  `commit-gen-empty`.
- **Lỗi transport/non-string** (cả attempt 1 lẫn attempt 2): giữ nguyên error mapping
  hiện tại từng branch (omp error / provider error / fallback error).

## 5. Functional requirements

- FR-001: Pure guard module `src/ai/commitMessageGuard.ts` (file mới, KHÔNG import gì cả,
  không `vscode`) export `checkCommitMessage`.
  - Given: candidate string bất kỳ (đã qua sanitize khi gọi từ command).
  - When: `checkCommitMessage(candidate)`.
  - Then: trả `{ ok, reasons }` với `ok === (reasons.length === 0)`; thu hết reasons
    (không short-circuit), riêng `empty` short-circuit.
- FR-002: Detection rules — đúng 8 reason codes, thứ tự thu frozen:
  `["empty", "unbroken-blob", "hash-like", "symbol-heavy", "reasoning-marker",
  "not-vietnamese", "subject-too-long", "message-too-long"]`. Chi tiết từng rule ở §7.
- FR-003: Vietnamese rule KHÔNG reject type prefix tiếng Anh: prefix `type(scope):`
  không được tính là lỗi; chỉ phần text con người (subject + body) cần dấu hiệu tiếng Việt.
- FR-004: Length rules — subject > 12 từ → `subject-too-long`; tổng > 100 từ →
  `message-too-long`. Cap ký tự 72/600 vẫn nằm ở `sanitizeCommitMessage` (secondary).
- FR-005: `SYSTEM_PROMPT` trong `src/ai/commitMessage.ts` được thay bằng text frozen
  (§8.1) dạy tiếng Việt + giới hạn từ; PHẢI giữ nguyên 2 substring
  `"You generate git commit messages"` và `"Conventional Commits"` (2 test đang assert).
- FR-006: `buildRetryCommitPrompt` pure builder trong `src/ai/commitMessage.ts`
  (signature + frozen shape ở §8.2) — ghép corrective instruction vào user message gốc.
- FR-007: `runGenerateCommitMessage` (src/ai/commitGenCommand.ts) — sau sanitize ở CẢ 3
  engine branch (omp / builtin / claude-code-codex-fallback) chạy guard:
  - PASS → inject như cũ.
  - FAIL + message rỗng → giữ nguyên empty-diagnostic hiện tại (không retry, không đụng
    `writeDebugArtifact` label khác, không thêm provider call).
  - FAIL + message không rỗng → retry đúng 1 lần: `buildRetryCommitPrompt(prompt,
    rejected, reasons)` qua CÙNG port/model (`buildOmpEngine` 1 lần, `oneShot.generate`
    lại; `builtinComplete` lại cùng cfg/modelId/maxOutputTokens 300/temperature 0.2) →
    sanitize → guard lần 2.
  - Lần 2 PASS → inject message lần 2. Lần 2 rỗng → rơi vào CÙNG empty-diagnostic như
    attempt 1 (toast cũ + debug dump `commit-gen-empty` với raw của lần 2), KHÔNG
    guard-toast, KHÔNG engine call thứ 3. Lần 2 vẫn FAIL non-empty → `deps.showError`
    frozen string (§8.5), KHÔNG gọi `deps.setInputBox`, kèm optional debug dump
    `commit-gen-guard-rejected`.
  - Throw/non-string từ engine (cả attempt nào) propagate ra catch hiện có của branch →
    error mapping giữ nguyên (không retry khi call throw).
  - Hint toast claude-code/codex: vẫn hiện đúng 1 lần sau engine call string đầu tiên
    thành công (thứ tự quan sát được: trước inject, giữ count === 1 như test #10 cũ).
- FR-008: `docs/UNICDB_USER_GUIDE.md` mục "Generate Commit Message" thêm 3 bullet
  (tiếng Việt + giới hạn từ + retry-1-lần rồi báo lỗi) — giữ nguyên các keyword đang bị
  `src/ui/__tests__/userGuideContent.test.ts` assert: "Generate Commit Message",
  "Source Control", "Lite model", "Conventional Commits", "Open AI Settings".

## 6. Fullstack scope

### Backend
Không có server. "Backend" = pure TS modules của extension:
- `src/ai/commitMessageGuard.ts` (NEW — pure, zero import).
- `src/ai/commitMessage.ts` (SỬA — SYSTEM_PROMPT + `buildRetryCommitPrompt`; các export
  `buildCommitPrompt`/`serializeCommitPrompt`/`sanitizeCommitMessage`/constants giữ nguyên).
- `src/ai/commitGenCommand.ts` (SỬA — extract `generateWithGuard`, wire 3 branch, frozen
  error strings, debug dump).

### Database / schema / migrations
N/A — extension VS Code, không có DB/schema.

### API contract
N/A HTTP. Module-level contract = §8.

### Frontend UI and state
N/A webview. UI surface = SCM input box + vscode toasts qua ports hiện có
(`setInputBox`/`showError`/`showInfo`/`showSettingsToast`) — không thêm port.

### Integration
`runGenerateCommitMessage` là điểm nối duy nhất; host `src/extension.ts` không đổi (deps
shape không đổi).

### Security and permissions
Giữ invariant hiện có: apiKey/credentials không bao giờ xuất hiện trong prompt, toast,
log hay debug artifact. Debug dump chỉ chứa raw model text + engine/baseUrl/method.

### Performance
Guard là O(n) trên candidate (≤ ~600 chars sau sanitize; standalone có thể dài hơn —
vẫn O(n)). Không thêm network call ngoài đúng 1 retry.

### Observability / logging
2 debug artifacts (đều qua optional port `writeDebugArtifact`, không bắt buộc):
- `commit-gen-empty` — giữ nguyên như hiện tại (empty path).
- `commit-gen-guard-rejected` (MỚI) — terminal guard failure: `body` = raw text của lần
  gọi cuối, `context` = `{ engine: selectedEngine, reasons }`.

### Deployment and rollback
N/A — không feature flag; rollback = revert commit (hành vi quay về inject-sau-sanitize).

## 7. Guard detection rules (frozen)

Helper frozen: `countWords(t) = { const s = t.trim(); return s === "" ? 0 : s.split(/\s+/).length }`;
`tokens = candidate.trim().split(/\s+/)`; `subject = candidate.trim()` cắt trước `\n` đầu.

Thứ tự thu reasons (sau `empty` short-circuit, mọi rule đều chạy, kết quả theo đúng
thứ tự dưới):

| # | Code | Rule chính xác |
|---|------|----------------|
| 1 | `empty` | `candidate.trim() === ""` → `reasons = ["empty"]`, dừng, không xét rule khác. |
| 2 | `unbroken-blob` | Tồn tại token với `token.length >= 40` (`GUARD_BLOB_TOKEN_MIN_CHARS = 40`, dùng `>=`). Bắt blob 72-char đã bị clamp. |
| 3 | `hash-like` | Tồn tại token match `/^[0-9a-f]{32,}$/i` (hex ≥ 32 chars — bắt cả blob 32-39 chars lọt rule 2). |
| 4 | `symbol-heavy` | Tỉ lệ ký tự KHÔNG phải Unicode letter/digit (`/\p{L}|\p{N}/u`) trên tổng ký tự non-whitespace `> 0.5` (`GUARD_SYMBOL_RATIO_MAX = 0.5`, dùng `>`). |
| 5 | `reasoning-marker` | Bật khi BẤT KỲ: (a) candidate chứa `"```"`; (b) có dòng (multiline, case-insensitive) bắt đầu bằng một trong: `we need to`, `let me`, `the user`, `first,`, `okay,`, `wait,`, `step 1`, `step 2`, `i will`, `i'll`, `here is`, `here's`; (c) whole-text case-insensitive chứa `thinking process` hoặc `chain of thought`; (d) tổng số lần `\b(okay|wait)\b` case-insensitive ≥ 2. |
| 6 | `not-vietnamese` | Bật khi CẢ HAI sai: (a) không có ký tự nào match `/[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i`; (b) không có marker từ vựng VN nào match case-insensitive với word-boundary `\b` ở §7.1. |
| 7 | `subject-too-long` | `countWords(subject) > 12` (`COMMIT_SUBJECT_MAX_WORDS = 12`). |
| 8 | `message-too-long` | `countWords(candidate) > 100` (`COMMIT_MESSAGE_MAX_WORDS = 100`). |

### 7.1 Frozen Vietnamese word markers (match `\b<phrase>\b`, case-insensitive)

```
"sua", "xoa", "cap nhat", "nang cap", "loi", "chuc nang",
"nguoi dung", "hien thi", "du lieu", "ket qua", "khong", "cai thien",
"bao mat", "xay dung", "chinh sua", "truy van", "co so du lieu",
"kien truc", "phan mem", "ung dung"
```

R1 review: đã loại `"them"` và `"bang"` — trùng với từ English phổ biến nên làm
`not-vietnamese` không bao giờ fire trên English sạch (vd "fix: update tests so CI can
run them"). 20 marker còn lại đều KHÔNG phải từ English thông dụng; unaccented-VN recall
vẫn đủ (fixture §11 dùng "cap nhat"/"ket qua"/"truy van").

Chủ ý conservative theo hướng false-ACCEPT (chỉ thêm dấu hiệu chấp nhận, không thêm
marker dễ trúng English) — English message sạch sẽ bị `not-vietnamese` → đúng thiết kế
(locked decision #3), nhưng unaccented Vietnamese vẫn pass.

Export thêm constants: `COMMIT_SUBJECT_MAX_WORDS`, `COMMIT_MESSAGE_MAX_WORDS`,
`GUARD_BLOB_TOKEN_MIN_CHARS`, `GUARD_SYMBOL_RATIO_MAX`.

## 8. API contract (module-level, frozen)

### 8.1 SYSTEM_PROMPT mới — `src/ai/commitMessage.ts` (thay dòng 14-15)

```ts
const SYSTEM_PROMPT =
  "You generate git commit messages. Reply with ONLY the commit message — no explanations, no code fences, no quotes, no reasoning. " +
  "Use Conventional Commits style with an English type prefix: `type(scope): subject` in imperative mood. " +
  "Write the subject and body in VIETNAMESE (tiếng Việt). Example: `feat(db): thêm chỉ mục cho bảng users`. " +
  "Limits: subject max 12 words (72 chars), whole message max 100 words (600 chars).";
```

Bắt buộc giữ substring `"You generate git commit messages"` và `"Conventional Commits"`.

### 8.2 Retry-prompt builder — export mới

```ts
export function buildRetryCommitPrompt(
  original: readonly ChatMessage[],
  rejectedMessage: string,
  reasons: readonly string[],
): ChatMessage[];
```

Trả `[original[0] (system giữ nguyên), correctiveUser]`. Nội dung correctiveUser
(frozen shape — `truncated = rejectedMessage.slice(0, 240).replace(/\s+/g, " ")`):

```
${originalUserContent}

Your previous reply was rejected for these reasons: ${reasons.join(", ")}.
Rejected text (do NOT repeat it): "${truncated}".
Reply again with ONLY a valid commit message:
- Plain text only: no code fences, no quotes, no explanations, no reasoning.
- English Conventional-Commits type prefix (feat/fix/refactor/chore/...), subject and body in Vietnamese (tiếng Việt).
- Subject: max 12 words (72 chars). Whole message: max 100 words (600 chars).
```

Throw `Error("commit-gen: retry prompt requires a user message")` nếu `original` không
có message role `"user"`.

### 8.3 Guard module — `src/ai/commitMessageGuard.ts` (NEW)

```ts
export type CommitMessageIssue =
  | "empty" | "unbroken-blob" | "hash-like" | "symbol-heavy"
  | "reasoning-marker" | "not-vietnamese" | "subject-too-long" | "message-too-long";

export interface CommitMessageGuardResult {
  ok: boolean;
  reasons: readonly CommitMessageIssue[];
}

export function checkCommitMessage(candidate: string): CommitMessageGuardResult;
```

### 8.4 Orchestration helper — export mới trong `src/ai/commitGenCommand.ts`

```ts
export type GuardOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: "empty"; raw: string }
  | { ok: false; kind: "invalid"; raw: string; message: string; reasons: readonly CommitMessageIssue[] };

export async function generateWithGuard(
  call: (messages: readonly ChatMessage[]) => Promise<string>,
  prompt: readonly ChatMessage[],
): Promise<GuardOutcome>;
```

`call` = closure per-branch (attempt N nào throw cũng propagate cho catch branch hiện có).
Không thêm port vào `CommitGenDeps`.

### 8.5 Frozen toast strings — `src/ai/commitGenCommand.ts`

```ts
export const ERROR_COMMIT_GUARD_FAILED_PREFIX =
  "UnicDB: generated commit message failed validation";
export const ERROR_COMMIT_GUARD_RETRY_NOTE =
  "Retried once and still invalid — nothing was injected into the commit box.";
```

Terminal toast (frozen format; `preview = raw.slice(0, 240).replace(/\s+/g, " ")` của
lần gọi cuối; `file` = kết quả `writeDebugArtifact?.(...)` hoặc rỗng):

```
${ERROR_COMMIT_GUARD_FAILED_PREFIX} (reasons: ${reasons.join(", ")}). ${ERROR_COMMIT_GUARD_RETRY_NOTE} Raw preview: "${preview}".${file ? ` Debug dump: ${file}` : ""}
```

## 9. UI behavior

- Ô SCM input: chỉ được ghi khi guard PASS (attempt 1 hoặc 2); giá trị = message đã
  sanitize của attempt PASS. Không state mới.
- Toasts: dùng ports hiện có. Frozen copy ở §8.5; empty-path toast giữ nguyên text cũ
  (`"UnicDB: provider returned no commit message text (raw length N). Preview: …"`).
- Không có màn hình/loading mới; retry diễn ra silently (tối đa +1 engine call).

## 10. Edge cases

- Blob 72-char sau clamp (bug hôm nay) → `unbroken-blob` (token 72 ≥ 40).
- Hex blob 32-39 chars có space giữa các token → `hash-like` vẫn bắt từng token.
- Message tiếng Việt không dấu: `feat(db): cap nhat ket qua truy van` → PASS nhờ word
  markers (KHÔNG chỉ dựa dấu).
- English sạch GLM5-style: `feat(db): add index` → `not-vietnamese` → retry 1 lần →
  vẫn English → block, không inject (hành vi accepted, §14 Q3).
- Subject đúng 12 từ / tổng đúng 100 từ → PASS (boundary `>`); 13/101 → FAIL.
- Token đúng 40 chars → `unbroken-blob` (boundary `>=`); 39 → không.
- Sanitize cắt subject 72 chars có thể sinh token dài → guard bắt SAU sanitize (thứ tự
  sanitize → guard là bắt buộc).
- Empty response → KHÔNG retry (giữ empty-diagnostic + `commit-gen-empty` dump cũ).
- Empty ở attempt 2 (garbage lần 1 → retry → lần 2 rỗng) → engine call đúng times(2),
  rơi vào cùng empty-diagnostic (toast cũ + `commit-gen-empty` dump raw lần 2), KHÔNG
  guard-toast, KHÔNG call thứ 3.
- Engine throw ở attempt 2 (network died giữa chừng) → error mapping branch hiện có,
  không inject, không guard-toast chồng.
- `buildRetryCommitPrompt` với `original` thiếu user message → structured Error
  (defence như `serializeCommitPrompt`).
- Multi-reason: blob hex 72 chars → `["unbroken-blob", "hash-like", …]` — mọi rule chạy;
  corrective prompt liệt kê đủ reasons.

## 11. Test matrix

| Area | Cases | Test file |
|------|-------|-----------|
| Guard unit (pure) | happy VN có dấu; happy VN không dấu; empty; unbroken-blob (≥40 boundary 39/40); hash-like hex 32-39; symbol-heavy ratio; reasoning-marker (line-start + ``` + repeated okay/wait); not-vietnamese (English sạch PASS-guard-fail, prefix English không lỗi); subject boundary 12/13; message boundary 100/101; multi-reason order | `src/ai/__tests__/commitMessageGuard.test.ts` (NEW) |
| Prompt/retry builder (pure) | SYSTEM_PROMPT giữ 2 substring + thêm tiếng Việt + limits; retry prompt mang user content gốc + reasons + truncated rejected + Vietnamese instruction; >240 chars truncate; throw khi thiếu user message | `src/ai/__tests__/commitMessage.test.ts` (bổ sung; 17 test cũ giữ nguyên) |
| Orchestration | #1/#2/#10 happy paths update fake tiếng Việt (giữ structural asserts: called-once, inject, request shape); garbage=72-hex blob→retry→inject (builtin + omp + claude-code fallback, assert corrective prompt ở lần 2, engine call đúng 2 lần); garbage×2→terminal toast + KHÔNG inject; >100 từ×2→block; empty attempt 1→không retry + toast cũ; empty attempt 2 (garbage rồi rỗng)→times(2) + toast cũ + KHÔNG guard-toast + KHÔNG call thứ 3; hint toast claude-code vẫn đúng 1 lần | `src/ai/__tests__/commitGenCommand.test.ts` |
| Orchestration (transport) | builtin attempt-1 throw → `builtinComplete` times(1), KHÔNG retry (throw = transport, KHÔNG bao giờ vào `buildRetryCommitPrompt`), error-mapping branch cũ verbatim, KHÔNG guard-toast, KHÔNG inject; attempt-2 throw (garbage rồi throw) → cùng mapping, KHÔNG guard-toast chồng | `src/ai/__tests__/commitGenCommand.test.ts` |
| Docs content | keyword GC vẫn đủ sau khi sửa guide | `src/ui/__tests__/userGuideContent.test.ts` (chạy lại, không sửa) |

## 12. Acceptance criteria

- [ ] `npx vitest run src/ai/__tests__/commitMessageGuard.test.ts` — ≥ 10 test mới PASS.
- [ ] `npx vitest run src/ai/__tests__/commitMessage.test.ts src/ai/__tests__/commitGenCommand.test.ts` — toàn bộ PASS (17 + 12 cũ update fake + test mới).
- [ ] `npx vitest run src/ui/__tests__/userGuideContent.test.ts` — PASS sau khi sửa guide.
- [ ] `npm run typecheck` — 0 error.
- [ ] `npm run compile` — build thành công.
- [ ] `npm test` (full suite) — PASS ở wave boundary.
- [ ] Không có thay đổi ngoài 7 file: `commitMessageGuard.ts` (new), `commitMessage.ts`,
      `commitGenCommand.ts`, 3 test file, `UNICDB_USER_GUIDE.md` (+2 handoff docs).
- [ ] `grep -n "vscode" src/ai/commitMessageGuard.ts` → 0 dòng (pure module).

## 13. Migration / upgrade steps

N/A persisted state. Behavior change có chủ đích: message tiếng Việt + chặn garbage;
user dùng model chỉ trả English sẽ thấy toast lỗi thay vì message English (§14 Q3).
Không cần bước migrate cho install hiện tại.

## 14. Open questions and chosen defaults

| Question | Chosen default | Rationale |
|----------|----------------|-----------|
| Q1: `not-vietnamese` là HARD block hay retry-then-accept? | Retry đúng 1 lần như mọi reason khác; lần 2 vẫn fail (kể cả English) → terminal block, không inject. | Uniform, đúng locked decision #2; user đã chốt "TIẾNG VIỆT" là yêu cầu cứng. Existing happy-path tests được update fake sang tiếng Việt (orchestrator đã duyệt). |
| Q2: Empty response có retry không? | KHÔNG — áp dụng cho empty ở CẢ attempt 1 lẫn attempt 2: attempt 1 → 1 engine call như cũ; attempt 2 (garbage rồi rỗng) → times(2) rồi rơi vào cùng empty-diagnostic (toast cũ + `commit-gen-empty` dump raw lần 2), không guard-toast, không call thứ 3. | Empty = vấn đề infra (SSE rỗng/config sai) — corrective prompt không sửa được; giữ diagnostics frozen cũ, zero regression risk. |
| Q3: GLM5-style English sạch bị chặn? | Chấp nhận bị chặn sau 1 retry. | Locked decision #3 (người dùng yêu cầu tiếng Việt rõ ràng). Prompt mới dạy tiếng Việt nên model compliant sẽ pass ngay lần 1. |
| Q4: Provider fallback (`pickLongestStringField`) có thu hẹp không? | Không đổi `provider.ts`. | Guard ở output đủ chặn; fallback giúp model khác; tránh regression chat flow. |
| Q5: Boundary `>=` hay `>` cho blob 40 chars? | `>=` 40 cho `unbroken-blob`; `> 0.5` cho symbol ratio; `>` 12/100 cho word limits. | Frozen tại §7 để test deterministic. |
| Q6: Retry có rebuild omp engine không? | Không — build `oneShot` 1 lần, chỉ `generate` lại. | "Cùng engine path"; giữ `buildOmpEngine` times(1) như test cũ. |

## 15. Review checklist

- [x] Mọi FR testable (Given/When/Then + command ở §12).
- [x] Mọi layer được cover hoặc N/A có lý do (không có server/DB/webview).
- [x] Không còn instruction mơ hồ — thresholds, frozen strings, frozen lists ở §7/§8.
- [x] Dependencies giữa các phần rõ (PLAN §2 CONSTRAINT + task Dependencies).
- [x] Phase 0 sweep: STOPERR 3/3 done; `docs/TASKS.md` không còn "Ready for AI";
      `git status` chỉ có `RUN.md` (run cursor của handoff runner — không phải product WIP).
