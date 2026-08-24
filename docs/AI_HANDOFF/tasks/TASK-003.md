# TASK-003 — Panel resume coordinator + webview message protocol

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.C

## Goal

`AiChatPanel` hỗ trợ resume: xử lý `resume_list` (list sessions theo cwd, sort updatedAt
desc, cap 20, title fallback) và `resume_pick` (session/load → derive history items từ
replay có thứ tự → re-base active sessionId → post batch `history`), với guards builtin/
streaming, lỗi → inline notice không crash panel. Thêm message types tương ứng vào
`aiChatPanelMessages.ts`.

## Target Files

- `src/ui/aiChatPanelMessages.ts` — thêm 6 message shapes (frozen ở §Interfaces); KHÔNG
  sửa shape nào hiện có.
- `src/ui/aiChatPanel.ts` — `AcpSession` thêm field `sessionId: string`; handler
  `resume_list` / `resume_pick` / `resume_cancel`; pure helper derive history từ replay
  (xuất riêng để test); `runAcpTurn` prompt theo `session.sessionId`.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `resume_list` → list đúng filter/sort/cap/label | post `resume_sessions` với ≤20 entries: chỉ entries `cwd === workspace`; LOẠI session hiện tại của chính panel (`entry.sessionId !== session.sessionId` — F3); thứ tự `updatedAt` desc (so sánh `Date.parse`, fallback so sánh string thô khi `NaN` — F2); label `title` còn hạn, `"(untitled)"` khi title null; detail chứa `messageCount` | 25 fake entries (đúng cwd + khác cwd lẫn lộn, updatedAt xáo trộn ISO-8601, VÀ 1 entry chính là sessionId hiện tại của session; vài title null/`"<function>"`) |
| 2 | unit (happy) | `resume_pick` → load + history batch + re-base | post `history` items đúng thứ tự replay (user/assistant/tool); `AcpSession.sessionId` đổi thành id đã load; `session/prompt` tiếp theo gửi `sessionId` MỚI | fake `sessionLoad` resolve replay: user chunks → agent chunks → tool_call; spy request |
| 3 | unit (edge-neverrender) | replay chứa `agent_thought_chunk` | KHÔNG item nào trong `history` chứa nội dung thought; các items khác vẫn đủ | replay lẫn thought chunks giữa message chunks |
| 4 | unit (edge-cap) | replay dài (60 items) | chỉ 50 item cuối được post; `truncated === true`; `truncatedCount === 10` | derive helper với input 60 items |
| 5 | unit (edge-malformed) | replay có entries dị dạng (update thiếu field, tool_call rỗng, method lạ) | derive KHÔNG throw; item tool fallback label `"tool"`; entries lạ bị skip; items hợp lệ xung quanh vẫn render đúng | input gồm: `user_message_chunk` thiếu `content`, `tool_call` `{}`, method `"session/whatever"` |
| 6 | unit (error) | `sessionLoad` reject (`-32603` not found) | post `{type:"error", message}` inline; panel sống: send tiếp bình thường; sessionId KHÔNG đổi | fake sessionLoad reject `ACP session not found` |
| 7 | unit (guard) | `resume_list` khi đang streaming / khi engine builtin | đang stream: KHÔNG post `resume_sessions`, không gọi sessionList; builtin: post error `"Resume requires the omp engine"`, không spawn | token streaming active; engine builtin |
| 8 | unit (edge-dropguard, F1 belt) | `session/update` của loading sessionId leak tới handler giữa load-settle và prompt kế | KHÔNG post `delta`/bubble nào từ replay frame; guard tự clear khi `session/prompt` kế được ghi (frame đó cũng là write đóng replay window ở client) — sau đó `agent_message_chunk` của turn live stream `delta` bình thường | load settle xong; feed trực tiếp 1 `session/update` (sessionId đã load, `agent_message_chunk`) vào handler; rồi send prompt; feed `agent_message_chunk` live |
| 9 | unit (regression) | Cycle M semantics không đổi | mọi test hiện có `aiChatPanelAcp.test.ts` + `aiChatPanel.test.ts` pass nguyên (stop/dispose/permission/default-deny/streaming) | existing suites, không sửa |

Lưu ý fixture: derive history là pure function — test riêng trực tiếp (cases 3,4,5) + qua
panel (cases 1,2,8). `cwd` dùng đúng giá trị panel đã tính (`workspaceFolders[0]` →
fallback `process.cwd()`). Replay envelopes theo evidence: `user_message_chunk`
`{update:{content:{type:"text",text}, messageId}}`, `agent_message_chunk`
`{update:{delta}}`, `tool_call` defensive (title/name/toolCallId → `"tool"`). Derive đọc
`replay.notifications` (buffer object — TASK-001), KHÔNG chờ `replay.closed`. Panel-side
drop-guard (F1 belt): flag bật ngay khi load settle thành công, tắt ngay trước khi
`runAcpTurn` ghi frame `session/prompt` — giữa 2 thời điểm đó, `session/update` cho
sessionId đang load bị DROP (không render live, không post `delta`).

## Test Files

- `src/ui/__tests__/aiChatPanelResume.test.ts` (new) — cases 1–8, theo pattern fake
  ACP-shaped deps của `aiChatPanelAcp.test.ts` (FakeAcpTransport + real `AcpClient`, mock
  vscode).
- `src/ui/__tests__/aiChatPanelMessages.test.ts` — append type-discriminator asserts cho 6
  message mới.

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelResume.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanel.test.ts
```

(Không có lint script — N/A.)

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước).
- [ ] `aiChatPanelMessages.ts` không breaking change với shapes cũ (suite messages cũ pass).
- [ ] Stop/dispose/permission/default-deny giữ nguyên semantics Cycle M (case 9).
- [ ] Không `vscode` import mới ngoài những gì panel đã dùng; helper derive là pure.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-001, TASK-002 — cần `sessionList()`/`sessionLoad()` trên client của handle thật.

## Interfaces

- Consumes: từ TASK-001/002 — `sessionList(): Promise<AcpSessionListItem[]>`,
  `sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult>` với
  `AcpSessionListItem { sessionId, cwd, title: string|null, updatedAt, messageCount, size }`,
  `AcpSessionLoadResult { configOptions, modes, replay: AcpReplayBuffer }` — buffer LIVE
  (`replay.notifications`, `replay.closed`; cửa sổ đóng khi request kế — TASK-001
  §Interfaces; derive không chờ `closed`).
- Produces (TASK-004 tiêu thụ — CHÍNH XÁC):
  ```ts
  // webview → host
  { type: "resume_list" }
  { type: "resume_pick"; sessionId: string }
  { type: "resume_cancel" }
  // host → webview
  { type: "resume_sessions";
    sessions: Array<{ sessionId: string; label: string; detail: string }> }
  { type: "history";
    items: Array<{ kind: "user" | "assistant" | "tool"; text: string }>;
    truncated: boolean; truncatedCount: number }
  ```
  Render cap: `HISTORY_RENDER_CAP = 50` (export const từ `aiChatPanelMessages.ts`).

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
