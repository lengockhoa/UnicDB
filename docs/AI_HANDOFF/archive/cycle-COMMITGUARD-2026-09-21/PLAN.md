# PLAN — COMMITGUARD

Cycle: COMMITGUARD | Date: 2026-09-20 | Base: main
Spec: `docs/AI_HANDOFF/SPEC.md` | Tasks: `docs/AI_HANDOFF/tasks/TASK-CG2-00{1,2,3}.md`

## §1 Intent

Mục "Generate Commit Message" (SCM sparkle, `UnicDB.generateCommitMessage`) với model
reasoning ("chatgpt luna") sinh ra một chuỗi dài giống hash; "GLM5 turbo" chạy đúng.
Root cause (verified): parser fallback cho reasoning models trong `src/ai/provider.ts`
(`pickLongestStringField` :209, `extractAnyText` :121, gồm key `reasoning_content`) có
thể trả blob reasoning/hash, và `sanitizeCommitMessage` (`src/ai/commitMessage.ts:94`)
chỉ normalize — clamp first-line 72 chars biến blob không-space thành đúng hình "hash
72 ký tự" rồi inject. Không có lớp plausibility-check nào.

Success: sau cycle này, ô commit chỉ nhận message "trông như commit message" —
không garbage/reasoning leak, tiếng Việt, subject ≤ 12 từ, tổng ≤ 100 từ; garbage →
retry đúng 1 lần → vẫn fail thì toast lỗi rõ ràng và KHÔNG inject.

**AskUserQuestion answers (locked, verbatim — do NOT re-ask):**
1. **Language**: keep English Conventional-Commits `type` prefix, but subject + body in
   **Vietnamese**. The system prompt must instruct Vietnamese. Example:
   `feat(db): thêm chỉ mục cho bảng users`. (A "tiếng Việt" check must NOT reject the
   English type prefix.)
2. **Garbage handling**: on detecting a garbage/invalid message → **retry the model call
   exactly once** with a corrective instruction; if the retry still fails the validity
   check → show a clear error toast and do NOT inject anything into the commit box.
3. **Length**: subject ≤ 12 words, total message ≤ 100 words (and keep the existing
   72-char subject / 600-char total hard caps as secondary guards).

## §2 Scope

**In-scope**
- NEW pure guard module `src/ai/commitMessageGuard.ts` — `checkCommitMessage` +
  8 reason codes + frozen thresholds/word lists (SPEC §7/§8.3).
- `src/ai/commitMessage.ts` — SYSTEM_PROMPT mới (giữ 2 substring được assert:
  "You generate git commit messages", "Conventional Commits") + export
  `buildRetryCommitPrompt` (SPEC §8.1/§8.2).
- `src/ai/commitGenCommand.ts` — `generateWithGuard` helper + wire guard/retry/terminal
  error vào cả 3 engine branch, giữ purity + ports hiện có (SPEC §8.4/§8.5, FR-007).
- Tests: `commitMessageGuard.test.ts` (new), `commitMessage.test.ts` (bổ sung, 17 cũ
  giữ nguyên), `commitGenCommand.test.ts` (update fake EN→VN ở Tests #1/#2/#10 giữ
  structural asserts + thêm 8 guard-flow tests: retry ×3 branch, terminal block,
  length block, empty ×2 attempt, transport).
- Docs: `docs/UNICDB_USER_GUIDE.md` mục Generate Commit Message +3 bullet (giữ keyword
  mà `userGuideContent.test.ts` assert).

**Out-of-scope**
- `src/ai/provider.ts` parser fallbacks — KHÔNG đổi (SPEC §14 Q4).
- `sanitizeCommitMessage` semantics — KHÔNG đổi (72/600 caps là secondary guard).
- Thêm port mới vào `CommitGenDeps`, thêm npm dep, version bump / `package` / publish,
  `src/extension.ts`, chat flow khác.
- Marketplace publish: standing rule "cycle xong phải publish" bị cycle-constraints
  GHI ĐÈ — out-of-scope, orchestrator sẽ flag riêng cho user.
- Legacy sweep (Phase 0): INDEX.md chỉ có STOPERR 3/3 done — không item tồn; `docs/TASKS.md`
  không còn "Ready for AI"; `git status` chỉ có `docs/AI_HANDOFF/RUN.md` (run cursor của
  handoff runner, không phải product WIP) → không có việc cũ cần fold.

**CONSTRAINT (same-file rule):** mỗi task sở hữu file riêng tuyệt đối, không 2 task
cùng wave sửa chung file → CG2-001 (guard module + guard test) và CG2-002
(commitMessage.ts + commitMessage.test.ts) cùng wave 1 vì disjoint; CG2-003 một mình
wave 2 vì import cả hai và sở hữu `commitGenCommand.ts` + test + guide.

## §3 Approach

Guard thuần ở output (không đụng parser): `raw → sanitizeCommitMessage → checkCommitMessage`
trên CẢ 3 engine branch. Extract `generateWithGuard(call, prompt)` (pure ports-only) làm
point duy nhất của flow attempt: attempt 1 → ok ⇒ inject; empty ⇒ empty-diagnostic cũ
(không retry — SPEC §14 Q2); invalid ⇒ build corrective retry prompt (chỉ dẫn tiếng Việt +
limits + reasons + rejected-truncated) và gọi CÙNG port/model lần 2 (`oneShot.generate`
lại với `buildOmpEngine` times(1); `builtinComplete` lại cùng cfg/modelId/300/0.2) →
sanitize → guard → ok ⇒ inject, vẫn invalid ⇒ frozen toast + optional debug dump
`commit-gen-guard-rejected`, KHÔNG `setInputBox`. Engine throw (attempt nào) propagate
ra catch branch hiện có → error mapping cũ giữ nguyên.

Detection conservative hướng false-accept: 8 reason codes với threshold frozen —
`unbroken-blob` (token ≥ 40 chars; bắt đúng blob 72-char đã clamp = bug hôm nay),
`hash-like` (hex token ≥ 32), `symbol-heavy` (> 0.5 non-letter ratio), `reasoning-marker`
(frozen phrase list + ``` + repeated okay/wait), `not-vietnamese` (KHÔNG có dấu VN VÀ
KHÔNG có word marker → mới fail; type prefix tiếng Anh không phải lỗi),
`subject-too-long` (>12 từ), `message-too-long` (>100 từ), `empty`.

**Alternatives rejected:** (a) thu hẹp `pickLongestStringField`/`extractAnyText` —
rủi ro regression cho chat flow và các model trả text ở field lạ, trong khi guard output
đủ chặn đúng symptom; (b) validate trong UI/host sau inject — trễ, không test được pure,
và vi phạm purity `commitGenCommand.ts`; (c) retry N>1 lần — user chốt đúng 1 lần; (d)
bỏ hẳn fallback reasoning — mất khả năng đọc model reasoning-only.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| Happy (guard) | VN có dấu `feat(db): thêm chỉ mục cho bảng users` | `{ ok: true, reasons: [] }` |
| Happy (guard) | VN không dấu `feat(db): cap nhat ket qua truy van` | ok (word-marker, không cần dấu) |
| Happy (command #1 update) | builtin happy path fake VN | `builtinComplete` times(1), `setInputBox("feat(db): thêm chỉ mục cho bảng users")`, 0 error |
| Happy (command #2 update) | omp happy path fake VN | `generate` times(1), prompt chứa 2 substring frozen, inject message VN |
| Happy (retry) | garbage = 72-hex blob lần 1 → VN lần 2 (builtin) | `builtinComplete` times(2); req#2 `messages[1].content` chứa reason + "rejected"; inject msg#2; 0 guard-error |
| Happy (retry) | garbage lần 1 → VN lần 2 (omp + claude-code fallback) | `generate`/`builtinComplete` times(2); inject; hint toast claude-code vẫn đúng 1 lần |
| Edge (empty) | `""` / whitespace | `reasons === ["empty"]` (short-circuit) |
| Edge (blob) | token 72 chars không space (blob đã clamp) | `unbroken-blob` trong reasons |
| Edge (boundary) | token 39 vs 40 chars | 39 → không `unbroken-blob`; 40 → có |
| Edge (hash) | hex token 32 chars | `hash-like` |
| Edge (symbol ratio) | `feat: {{{[[[()]]]}}}` | `symbol-heavy` |
| Edge (reasoning) | "We need to add an index…" + text chứa ``` + 2× "okay" | `reasoning-marker` mỗi case |
| Edge (not-vietnamese) | `feat(db): add index` (EN sạch) | `not-vietnamese` (prefix EN vẫn không phải lỗi riêng) |
| Edge (boundary words) | subject 12 vs 13 từ; tổng 100 vs 101 từ | 12/100 → ok; 13 → `subject-too-long`; 101 → `message-too-long` |
| Edge (multi-reason) | hex blob 72 chars | reasons chứa cả `unbroken-blob` + `hash-like` theo đúng thứ tự §7 |
| Edge (retry builder) | original + rejected 300 chars + 2 reasons | mang đủ user content gốc; rejected truncate 240; reasons join ", "; thiếu user message → throw |
| Edge (terminal) | garbage ×2 = 72-hex blob ×2 (builtin) | times(2); KHÔNG `setInputBox`; error chứa "failed validation" + "Retried once" + reason + preview |
| Edge (terminal) | >100 từ ×2 (omp) | times(2); KHÔNG inject; error chứa `message-too-long` |
| Edge (no-retry empty) | lần 1 trả rỗng | `builtinComplete` times(1) (KHÔNG retry); toast cũ "provider returned no commit message text" |
| Edge (attempt-2 empty) | 72-hex blob lần 1 → rỗng lần 2 | `builtinComplete` times(2); toast cũ empty-diagnostic + dump `commit-gen-empty` raw lần 2; KHÔNG inject; KHÔNG guard-toast; KHÔNG call thứ 3 |
| Edge (transport) | builtin attempt-1 throw (`Error("network exploded")`) | `builtinComplete` times(1); KHÔNG retry — throw = transport, KHÔNG BAO GIỜ vào `buildRetryCommitPrompt`; `showError` verbatim error-mapping branch cũ ("provider error — network exploded"), KHÔNG guard-toast, KHÔNG `setInputBox` |
| Regression (bugfix) | blob hash 72-char leak end-to-end — KHÔNG phải test riêng thứ 7: pin được carry bởi chính 2 row retry/terminal phía trên với fixture 72-hex blob | Trên code hiện tại: blob được inject thẳng (không guard, không retry) → 2 test đó FAIL trên code cũ, PASS sau fix |
| Regression (docs) | guide keywords sau khi sửa | `userGuideContent.test.ts` PASS không sửa test |

## §5 Verification Commands

Đã verify script tồn tại trong `package.json` (`test`, `typecheck`, `compile`,
`verify:fast`) và targeted vitest run chạy được (baseline 29/29 PASS trên 2 file liên quan;
full suite 4686 pass / 5 skip / 0 fail theo orchestrator).

```
npm run typecheck
npx vitest run src/ai/__tests__/commitMessageGuard.test.ts
npx vitest run src/ai/__tests__/commitMessage.test.ts src/ai/__tests__/commitGenCommand.test.ts
npx vitest run src/ui/__tests__/userGuideContent.test.ts        # wave 2 (CG2-003)
npm run compile                                                  # wave boundary
npm test                                                         # wave boundary (full)
```

Lint script riêng: repo KHÔNG có `lint` — `npm run typecheck` (tsc --noEmit) là gate
static duy nhất, bắt buộc trong Verification của mọi task.

## §6 Acceptance

- [ ] AC-1: Guard module pure (`src/ai/commitMessageGuard.ts`, zero import, không `vscode`)
      với đúng 8 reason codes + thresholds frozen (SPEC §7) — CG2-001.
- [ ] AC-2: ≥10 guard unit tests PASS, gồm happy VN có dấu/không dấu + edge empty /
      boundary 39-40 chars / boundary 12-13 & 100-101 từ / hash / reasoning / EN-clean
      (SPEC §11 hàng 1) — CG2-001.
- [ ] AC-3: SYSTEM_PROMPT mới giữ nguyên substring "You generate git commit messages" +
      "Conventional Commits", dạy tiếng Việt + 12/100 từ; `buildRetryCommitPrompt` frozen
      shape + truncate 240 + throw thiếu user — CG2-002, 17 test cũ vẫn xanh.
- [ ] AC-4: `generateWithGuard` + wiring 3 branch: PASS→inject; empty→diagnostic cũ
      không retry; invalid→retry đúng 1 lần cùng port/model; vẫn invalid→frozen toast +
      KHÔNG inject; throw→error mapping cũ — CG2-003.
- [ ] AC-5: Tests #1/#2/#10 update fake EN→VN giữ structural asserts (called-once,
      inject, request shape); +8 guard-flow test mới (retry ×3 branch, terminal block,
      length block, empty ×2 attempt, transport) — bugfix-regression pin do fixture
      72-hex blob trong retry/terminal tests đảm nhiệm, KHÔNG có test regression riêng;
      `userGuideContent` vẫn PASS sau khi sửa guide — CG2-003.
- [ ] AC-6: `npm run typecheck` 0 error; `npm run compile` OK; full `npm test` PASS —
      mọi task (full suite ở wave boundary).
- [ ] AC-7: Không đổi `provider.ts` / `sanitizeCommitMessage` semantics / `CommitGenDeps`
      shape / `package.json`; không publish.
- [ ] AC-8: Guide có 3 bullet mới (VN + limits + retry-1-lần-then-error), keyword GC giữ đủ — CG2-003.

## Planner Self-Audit
Checklist: 14/14 pass
Fixed during audit: thêm field `Spec references` (SPEC §5 FR IDs) vào cả 3 task file (task gate yêu cầu); gộp bảng test CG2-001/CG2-003 từ 12 xuống 8 rows theo task-budget validator (maxTestCases=8) — không mất assertion, chỉ merge row.
Known gaps: (1) `not-vietnamese` hard-block sau 1 retry nghĩa là model chỉ trả English sạch (GLM5-style) sẽ bị chặn — accepted per locked decision #3, ghi §14 Q3; (2) heuristic guard là conservative-hướng-false-accept — garbage dạng chưa liệt kê có thể lọt, mitigation là frozen marker list có thể mở rộng ở cycle sau; (3) chạy thật với model "chatgpt luna" không thể verify tự động — chỉ pin được signature blob ở unit + command level.

## Planner Report
PLANNER_MODEL: bao-opus
Revision: R1 (2026-09-21) — fixed 4/4 review findings: §7.1 drop "them"/"bang" + sync fixtures; FR-007/§10/§11/§14 pin attempt-2 empty; §12 count 6→7; §4 regression typo + pin (no 7th test, 72-hex fixture carries pin) + AC-5 count 8.
PLAN_REVIEW: Approved (loop cap — 2 rounds; Round-2 findings applied directly)

## Plan Review Log
### Round 1 — bao-opus
VERDICT: Issues Found
FINDINGS:
  - [consistency] SPEC §7 rule 6 + §7.1: frozen Vietnamese marker list contains "them" and "bang" — both are common English words, so `\b…\b` case-insensitive matching lets clean English messages (e.g. "fix: update tests so CI can run them") pass the Vietnamese check and `not-vietnamese` never fires, contradicting §7.1's own principle "không thêm marker dễ trúng English" and weakening locked decision #1. Drop both markers before implementation (unaccented-VN recall remains via the other 20 markers) and sync §11 guard-test fixtures.
  - [clarity] SPEC FR-007 + §10: attempt-2 EMPTY response is not pinned — the terminal path only covers "Lần 2 vẫn FAIL non-empty", and whether `commit-gen-empty` is re-dumped on attempt 2 is ambiguous. State explicitly that attempt-2 empty follows the attempt-1 empty-diagnostic path (old toast + `commit-gen-empty`, no guard toast, no third engine call) and add a §11/PLAN §4 test row so executor and tests don't guess.
  - [consistency, minor] SPEC §12: acceptance says "Không có thay đổi ngoài 6 file" but the whitelist enumerates 7 product files (guard module, commitMessage.ts, commitGenCommand.ts, 3 test files, UNICDB_USER_GUIDE.md). Fix the count to 7 so the acceptance check cannot misfire.
  - [clarity, minor] PLAN §4 regression row: typo "FỚI code hiện tại" (presumably "trên code hiện tại"), and it is ambiguous whether the bugfix-regression row is a distinct 7th command-level test or the same retry/terminal tests run with a 72-char hex-blob fixture, while AC-5 pins "+6 guard-flow test mới" — pin the count (recommend: make the retry/terminal garbage fixtures a 72-char hex blob so the existing 6 tests carry the regression pin).

NOTES: Decisions, scope, test plan, and ACs line up with SPEC §7/§8 across all 3 engine branches; thresholds are frozen and testable; provider.ts correctly untouched; the hash-blob regression pin fails on old code. Blocking only because findings 1-2 live in frozen artifacts that are cheap to fix now and costly to churn after tasks implement them.

### Round 2 — bao-opus
VERDICT: Issues Found
FINDINGS:
  - [consistency] PLAN §2 ("thêm 8 guard-flow tests: retry ×3 branch, terminal block, length block, empty ×2 attempt, transport") and AC-5 count 3+1+1+2+1 = 8, but PLAN §4's command-level table enumerates only 7 new tests (retry ×3 rows lines 97-98, terminal garbage×2 line 109, length >100×2 line 110, empty attempt-1 line 111, empty attempt-2 line 112) and SPEC §11 likewise has no transport item — the counted "transport" test (FR-007 "Throw/non-string từ engine … không retry khi call throw"; §10 "Engine throw ở attempt 2 → error mapping branch hiện có, không guard-toast chồng") has no planned row anywhere, so the +8 count cannot reconcile with the test table and throw-propagation stays untested. Fix: add one transport row to PLAN §4 + SPEC §11 (e.g. builtin attempt-1 throw → builtinComplete times(1), KHÔNG retry, error mapping branch cũ; optionally attempt-2 throw → times(2), KHÔNG inject, KHÔNG guard-toast chồng).
  - [minor] SPEC.md:101 (FR-007): cross-ref "(§8.3)" for the deps.showError frozen string points at the guard-module contract; the frozen toast strings live in §8.5 — update the reference to §8.5.
NOTES: All 4 Round 1 findings verified fixed (§7.1 = 20 markers, no common English words, fixtures synced; attempt-2 empty pinned in FR-007/§10/§11/§14-Q2 + test row; §12 count 7; §4 typo + 72-hex regression pin, AC-5 count 8). No new drift in reason codes/order, boundaries 12-13/100-101/39-40, file counts, or locked decisions — only the transport-row gap above blocks.

### Round 3 — findings applied without re-review
- Finding 1 [consistency]: added exactly one transport row to PLAN §4 (builtin attempt-1 throw → `builtinComplete` times(1), KHÔNG retry, error-mapping branch cũ verbatim, no guard toast; invariant: `call` throw = transport, KHÔNG bao giờ vào `buildRetryCommitPrompt`) và một row tương ứng "Orchestration (transport)" vào SPEC §11 (gồm cả attempt-2 throw variant) — reconcile thứ đếm "+8 guard-flow tests" (retry ×3 + terminal + length + empty ×2 + transport = 8) với bảng test.
- Finding 2 [minor]: SPEC FR-007 cross-ref cho frozen `deps.showError` string sửa §8.3 → §8.5 (§8.3 là contract của guard module; frozen toast strings nằm ở §8.5).
- Task files KHÔNG đụng (TASK-CG2-003 test #7 đã carry transport case; count đã là 8). INDEX.md/ACTIVE.md giữ nguyên.
