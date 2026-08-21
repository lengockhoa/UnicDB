# Handoff Rules

## Token Budget (MANDATORY)

- **Combined handoff reads must stay under 200 lines per request.**
- Read order: `ACTIVE.md` (if needed) → `INDEX.md` (scan tasks) → single `tasks/TASK-xxx.md` (implement one task).
- Do NOT read `RULES.md` every request — only when you need flow clarification.
- Do NOT read multiple task files in one request.
- If ACTIVE.md + INDEX.md + task file would exceed budget, read only the task file.
- Auto-compact: if any **state file** (`ACTIVE.md`, `INDEX.md`, or any single `tasks/TASK-xxx.md`) exceeds 80 lines, trigger `clear handoff` / split task. `PLAN.md` and `RULES.md` are reference/spec — exempt.

## How Human Submits Ideas

- Natural language is enough: `ukit:handoff`, `gom ý tưởng`, `chia task`, `đưa vào handoff`.
- If request is already a concrete task (clear file/logic/output, small enough to do now), bypass handoff and execute directly.
- If request is broad/ambiguous/multi-step, use handoff.

## Hard rule — All work stays in `docs/AI_HANDOFF/`

Mọi giao tiếp giữa các AI trong handoff CHỈ qua file dưới `docs/AI_HANDOFF/`:

- `PLAN.md` — brainstorm + Test Plan tổng (Phase 1).
- `INDEX.md` — bảng task + status (mọi phase đọc/ghi).
- `tasks/TASK-xxx.md` — nơi sống của từng task: Goal + Test Cases + Verification + Executor Report + Reviewer Verdict + **Discussion thread**.
- `ACTIVE.md` — snapshot cycle hiện tại.
- `archive/` — cycle cũ.

**Cấm**: AI gửi câu hỏi/comment qua chat tool khác, qua commit message, hay qua file ngoài thư mục này. Lý do: cross-tool/cross-subagent chỉ đồng bộ được qua file. AI nào không đọc folder này = không tham gia handoff.

### Discussion thread (AI-to-AI comments)

Khi cần hỏi-lại / push-back / gợi ý cho phase khác, AI ghi vào `## Discussion` của task file (template ở `tasks/_TEMPLATE.md`). Format:

```
### <YYYY-MM-DD> · <role: planner|executor|reviewer> · <tool/model>
<nội dung — gửi @planner / @executor / @reviewer nếu có người nhận>
```

Phase kế tiếp PHẢI đọc Discussion trước khi tiếp tục — coi như inbox.

## Autonomy Model — hỏi một lần, chạy tới hết

Handoff được thiết kế để chạy **không cần người ngồi canh**. Config: `.ukit/storage/config.json` → `handoff.autonomy`.

**Cửa sổ hỏi duy nhất là lúc plan.** `/ukit:handoff-create` (và bước P0 của `/ukit:handoff-fullstack`) gom mọi câu hỏi vào **một** lần `AskUserQuestion` rồi đóng cửa sổ. Câu trả lời ghi nguyên văn vào `PLAN.md §1` — các phase sau coi đó là lời của người dùng và không hỏi lại.

Từ sau đó, mọi ngã ba đều có cách giải quyết tự động:

| Tình huống | Xử lý tự động |
|-----------|---------------|
| Scope nhiều subsystem | tách module, plan module 1, queue phần còn lại vào `INDEX.md` |
| Plan review còn `Issues Found` sau 2 vòng | planner áp findings rồi đi tiếp, ghi vào Plan Review Log |
| 2 task cùng wave đụng 1 file | đẩy task sau xuống wave kế (thêm dependency) |
| Working tree bẩn | commit checkpoint rồi chạy tiếp |
| Reviewer trả `changes_requested`/`critical_block` | vào vòng auto-fix, tối đa 2 vòng |
| Task vẫn fail sau 2 vòng fix | để `blocked`, **các task khác vẫn đi tiếp tới push** |

Chỉ escalate cho người khi: blocker nằm ngoài repo (thiếu credential, service chết), hoặc task còn fail sau cả 2 vòng fix. Kể cả vậy vẫn phải làm xong mọi task khác trước rồi mới báo.

**Quality gate không bị nới.** Bỏ chỗ *hỏi người*, không bỏ chỗ *kiểm tra*: TDD RED→GREEN vẫn bắt buộc, reviewer vẫn phải khác model executor, vẫn re-run Verification Commands, vẫn cấm claim DONE khi chưa có PASS tươi.

### Run cursor — `RUN.md`

Mỗi command ghi lại `docs/AI_HANDOFF/RUN.md` sau **mỗi bước**:

```
Command: <handoff-fullstack|handoff-implement|handoff-review>
Goal: <1 câu>
Base: <branch>
Phase: <phase hiện tại | done>
Cursor: wave <N> batch <M> — <vừa xong cái gì>
Next: <bước kế tiếp chính xác>
```

`Phase:` khác `done` = có run đang dở. Command được gọi lại sẽ **chạy tiếp từ cursor**, không plan lại, không hỏi. Hook `SessionStart` (`handoff-resume.sh`) đọc file này và tự inject lệnh chạy tiếp — nên compact hay mất session giữa chừng đều không làm mất run.

### Context: không bao giờ dừng giữa nhiệm vụ

- Subagent ghi **full log vào task file trên đĩa**, chỉ trả về orchestrator ≤10 dòng (executor) / ≤6 dòng (reviewer). Paste log ngược lại orchestrator là nguyên nhân số 1 làm run chết vì hết context.
- Hết mỗi wave: commit, ghi cursor, **collapse** wave đó còn 1 dòng/task trong bộ nhớ làm việc, rồi chạy tiếp.
- Yêu cầu `/compact` **chỉ** được đặt ở cuối command, giữa 2 cycle. Giữa cycle thì tuyệt đối không — state đã nằm hết ở git + `INDEX.md` + `RUN.md` nên compact ở ranh giới cycle không mất gì.
- Vượt `compact.hardCapTokens` (mặc định 220k, cỡ cho context window 256k) mà `RUN.md` còn run dở: `context-hardcap-gate` cho thêm `compact.hardCapGraceCalls` (mặc định 10) tool call rồi mới chặn cứng. **Grace đó chỉ để hạ cánh** — hoàn tất edit đang dở, commit, ghi cursor, push. Không mở task mới, không đọc thêm file, không spawn agent. Hết grace là chặn thật; budget chỉ reset khi ước lượng token thực sự giảm (có compact thật), không reset theo wave.
- Không hook nào gọi được `/compact` — đó là lệnh client-only. Nhưng từ 2.1.3, settings mặc định đặt `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = 180000` < `hardCapTokens` (220k), nên **client tự auto-compact trước khi gate chặn**. Đường thường: auto-compact chạy → `handoff-resume.sh` replay cursor → chạy tiếp, không cần người gõ gì. Grace window ở trên chỉ còn là lưới an toàn.
- Sửa một trong hai số đó thì phải giữ `autoCompactWindow < hardCapTokens`. Đảo thứ tự là deadlock: gate chặn tool trước → transcript ngừng lớn → ngưỡng auto-compact không bao giờ tới. `tests/core/autoCompactWindow.test.js` khóa bất biến này.

### Git

- `handoff-implement`: **1 commit / wave**, không push. Mỗi wave revert độc lập được.
- `handoff-review` / `handoff-fullstack`: commit thêm mỗi vòng auto-fix, rồi **push 1 lần** ở cuối. Push không hỏi (`Bash(git push:*)` nằm trong `allow`); force-push vẫn bị `deny`.

## Handoff Flow (tool-agnostic, file-based state machine)

UKit handoff hoạt động qua **file state**. Anh tự chọn tool nào cho từng phase — Claude Code / Kilo Code / Codex / OpenCode / tool mới sau này — đều được. UKit chỉ care về **role của model**, không care tool.

3 phase × 3 role model:

- **Plan** — model mạnh nhất anh có (reasoning model). Có thể chạy ở bất kỳ tool nào hỗ trợ planning tốt.
- **Execute** — model rẻ-mà-vẫn-thông-minh (code model). Có thể là subagent code của Kilo, hay agent build của OpenCode, hay feature-implementer của Claude Code.
- **Review** — **MODEL KHÁC executor** (reasoning model thường tốt hơn). Có thể là tool khác, hoặc cùng tool nhưng subagent khác model (ví dụ Kilo có subagent code và subagent review riêng).

Hai mô hình triển khai đều hợp lệ:
- **Cross-tool**: ví dụ Claude (plan) → Kilo (execute) → Claude (review). Bridge qua file.
- **Same-tool different-subagent**: ví dụ Kilo:plan → Kilo:code → Kilo:review, miễn 3 subagent dùng MODEL khác nhau ở role tương ứng.

Mỗi tool/subagent đọc cùng `INDEX.md` + `tasks/TASK-xxx.md` → chọn task theo `status` → cập nhật status khi xong.

> **Quan trọng — UKit không enforce model:** `handoff.executor.cheapSmartModelHint` và `handoff.reviewer.model` trong `.ukit/storage/config.json` chỉ là **nhãn** để anh biết MUỐN dùng gì. Tool nào dùng model nào là do anh chọn trong settings của tool đó. UKit enforce contract bằng cách bắt executor TỰ KHAI `EXECUTOR_MODEL` trong Executor Report; reviewer so với chính nó và refuse nếu trùng. Vì vậy nếu trong Kilo anh để cả code-subagent và review-subagent đều dùng cùng model → reviewer sẽ tự refuse, không silent-pass.

### Status state machine

```
brainstorm ──[plan approved]──▶ ready ──[executor pick]──▶ in_progress
                                                              ├─[PASS]──▶ pending_review
                                                              └─[FAIL]──▶ blocked
pending_review ──[reviewer]──▶ approved | approved_minor ──▶ done
                            ├▶ changes_requested ──[fix]──▶ in_progress
                            └▶ critical_block      ──[fix]──▶ in_progress
```

### 4 Phases

**Phase 1 — Idea + Plan** (smart/reasoning model)
- Human submit ideas (natural language).
- AI ghi vào `PLAN.md`: §1 Intent, §2 Scope, §3 Approach, **§4 Test Plan (bắt buộc TDD-style)**, §5 Verification Commands, §6 Acceptance Criteria.
- Đây là **cửa sổ hỏi duy nhất** của cả pipeline: gom mọi câu hỏi vào 1 lần `AskUserQuestion` trước khi viết, ghi câu trả lời vào §1.
- Output: PLAN.md đầy đủ + Planner Self-Audit. Chạy standalone (`/ukit:handoff-create`) thì dừng ở đây chờ human xem; chạy trong `/ukit:handoff-fullstack` thì đi thẳng tiếp sang Phase 2 — plan review độc lập là gate thay cho human.

**Phase 2 — Create Tasks (TDD-embedded, MANDATORY)** (smart/reasoning model, thường cùng phase 1)
- Human approve plan → AI split `PLAN.md §7` sang nhiều `tasks/TASK-xxx.md`.
- **Mỗi TASK file BẮT BUỘC có Test Plan của riêng nó**, không chỉ trỏ về PLAN.md. Cụ thể:
  - `§ Test Cases`: bảng test (loại, tên test, expected) cho phần task này — happy + ≥2 edge case KHÁC loại nhau (vd null/empty + boundary/concurrent, không tính 2 case gần giống nhau) + regression (nếu fix bug).
  - `§ Test Files`: đường dẫn cụ thể file test sẽ tạo/sửa (ví dụ `tests/auth/login.test.js`).
  - `§ Verification Commands`: lệnh executor sẽ chạy để xác nhận PASS. Nếu project có sẵn lint/typecheck script → BẮT BUỘC liệt kê ở đây, không chỉ lệnh test. Project không có thì ghi rõ N/A, không được bỏ qua im lặng.
  - `§ Acceptance Criteria`: checklist.

#### Test selection (which tests the Verification Commands run)

Resolution order — exactly three steps, in this order. A task's Verification Commands MUST NOT default to the full suite:

1. Target File under `src/` or `scripts/` → read `.cache/index/tests-map.json` and take the `tests` array for that `sourceFile`.
2. Target File under `templates/.claude/**` or `.claude/**` → `tests-map.json` has no coverage of these paths, so use the path convention: hooks → `tests/hooks/` + `tests/handoff/cycle*/`; manifest/settings → `tests/manifest/`; runtime `.mjs` mirrors → `tests/core/*Parity*` + `tests/index/`.
3. **Mandatory non-empty floor** — if steps 1–2 resolve to fewer than one test file, the task MUST fall back to `yarn test:release-core`. An empty selection is never permitted. This floor is a fallback for a single task's narrowed selection, not a default — most tasks resolve via steps 1–2 and never reach it.

**Wave/cycle boundary regression net** — the three steps above narrow one task's Verification Commands only; they are not a substitute for full-suite coverage. A full `yarn test` run at each wave/cycle boundary MUST happen and is the regression net for every per-task narrowed selection made under this policy. `code-reviewer.md`'s "wave-boundary full `yarn test` ... is the regression net" sentence refers to this paragraph.

- Nếu split mà task nào không kèm được Test Cases + Test Files cụ thể → task đó chưa đủ `ready`, đánh `needs_breakdown`.
- Update `INDEX.md`: thêm row mỗi task với status `ready`.
- Đây là **điểm cắt cuối trước khi code chạy**: phase này xong, executor được phép pick. Trong `/ukit:handoff-fullstack`, gate ở đây là plan review độc lập (model mạnh, context riêng) chứ không phải human — vì người dùng đã chủ động chọn chạy one-shot.
- Mục tiêu: executor (cheap-smart model) đọc task file là biết NGAY test gì cần viết trước, KHÔNG phải tự suy diễn.

**Phase 3 — Implement + Test** (cheap-smart/code model)
- User: "execute next task" / "làm TASK-001" / "implement task 1".
- Executor đọc `INDEX.md` → pick `ready` task → đổi `in_progress` → **viết test trước → RED (paste output failing thật, không chỉ khai đã confirm) → implement → GREEN** → chạy Verification Commands fresh trong turn → append `## Executor Report` (gồm `EXECUTOR_TOOL`/`EXECUTOR_MODEL`/`EXECUTOR_SUBAGENT`/`RED_OUTPUT` + verification output) vào cuối task file → đổi status `pending_review`.
- KHÔNG được claim DONE nếu chưa có PASS fresh.

**Phase 4 — Review + Test** (reviewer model — KHÁC model executor)
- User: "review pending tasks" / "review TASK-001".
- Reviewer đọc INDEX → pick `pending_review` → đọc task file + diff → **so model với `EXECUTOR_MODEL`, refuse nếu trùng/unknown** → **re-run Verification Commands fresh** (không tin executor) → áp `code-review` skill → append `## Reviewer Verdict` vào task file (verdict + findings + reviewer model dùng) → đổi status:
  - `approved` / `approved_minor` → cho phép `done`.
  - `changes_requested` → executor phải fix Important → lặp Phase 3-4.
  - `critical_block` → executor PHẢI fix → lặp Phase 3-4.

Nếu `handoff.reviewer.enabled=false`, Phase 4 skip nhưng phải log lý do vào task — bỏ Phase 4 là bỏ lưới an toàn cuối.

## Task Gate

A task is `ready` only when it has:
- Clear target files
- Clear action
- Dependencies stated
- **Interfaces** — Consumes/Produces với chữ ký thật (function/endpoint/type), không placeholder;
  `(none)` hợp lệ nếu task không có input/output liên task
- **Test Plan** (PLAN.md §4) — happy path + ≥2 edge case khác loại (+ regression test nếu fix bug); hoặc `N/A` kèm lý do
- Verification command (lệnh executor sẽ chạy) — PHẢI gồm lint/typecheck nếu project có sẵn
- Acceptance criteria

Missing any → `needs_breakdown`, `blocked`, or `needs_human`.


## Clear Handoff

1. Archive current cycle → `archive/cycle-NNN.md`.
2. If archive > 3 files → delete oldest, append 1-line summary to `HISTORY.md`.
3. Reset `ACTIVE.md` to empty template.
4. Clear `INDEX.md`.
5. Delete all files in `tasks/`.
6. Clear `PLAN.md`.

## Docs Sync

After cycle, update affected docs only: `WORKLOG.md`, `PROJECT.md`, `CODE_MAP.md`, `CHANGELOG.md`.
