# TASK-003 — Chat reliability: Clear dead-state + not-configured error surface

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D2/D3, §4 T3

## Goal

Fix 2 defect "chat không ra kết quả": (1) sau khi bấm Clear, panel không chat lại được (user report "Sau khi bấm clear tôi không thể bắt đầu chat được"); (2) khi AI config rỗng giữa session, error phải hiện rõ trong thread thay vì state treo.

## Target Files

- `src/ui/aiChatPanel.ts` — CHỈ region `handleSend`/`runBuiltinTurn` error path (`AI is not configured` message) + `handleClear` (line ~738-741) + `handleReady`. KHÔNG đụng buildMessages/imports (TASK-002 region, đã land trước task này).
- `webview/aiChatPanelMain.ts` — `applyInit` (line ~337-339) force `setBusy(false)` + `deStreamOpenBubble()`; comment update clearBtn handler.
- `src/ui/aiChatPanelMessages.ts` — comment/doc cho `AiChatPanelInit` (no shape change cần thiết nếu dùng init; nếu executor thêm field `type:"cleared"` thì PHẢI ghi rõ trong Interfaces).
- `src/ui/__tests__/aiChatPanel.test.ts` — append describe "Clear recovery" (#1, #2, #3).
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — append describe "init re-enable" (#4, #5).
- `src/ui/__tests__/aiChatPanelMessages.test.ts` — append (#6 nếu đổi protocol; else skip).

## Spec

```ts
// src/ui/aiChatPanel.ts — handleClear MỚI (thay 738-741):
private handleClear(): void {
  // Full turn reset: Clear giữa turn đang stream phải hủy turn + trả UI
  // về idle. Không reset token/currentAbort → webview busy mãi (D2).
  this.token = null;
  this.currentAbort?.abort();      // hủy SSE đang đọc (builtin)
  this.currentAbort = null;
  this.turnDonePosted = false;
  this.cancelAllPending();          // ACP pending → cancelled (giữ pattern stop)
  this.history = [];
  this.post({ type: "init", hasHistory: false });
  this.post({ type: "done" });      // belt: webview busy flag về false
}

// runBuiltinTurn catch (giữ nguyên abort branch) — surface message chuẩn:
// err.message === "AI is not configured" → post error bubble:
//   "AI is not configured — open VSDB: Open AI Settings to configure baseUrl/model/API key"
// (message gốc vẫn là prefix; không đổi runAgent throw — chỉ enrich ở panel.)

// webview/aiChatPanelMain.ts — applyInit MỚI:
function applyInit(msg: InitMsg): void {
  state.hasHistory = msg.hasHistory;
  // init{hasHistory:false} đến sau khi panel từng busy (Clear path) →
  // chắc chắn re-enable input + đóng streaming bubble. Host cũng post
  // done, nhưng done một mình không de-stream nếu panel replay init.
  if (!msg.hasHistory) {
    deStreamOpenBubble();
    setBusy(false);
  }
}
```

Lý do 2 lớp (host `done` + webview init-guard): host side `post({type:"done"})` đã là un-busy chuẩn; webview init-guard là defense-in-depth cho trường hợp message order đổi (init đến sau done) và cho jsdom test path. Cả hai idempotent.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | Clear giữa turn streaming → chat lại được ngay (user report) | seq: send msg (deps.complete pending promise) → clear → send msg 2 (deps.complete resolve text) → posted messages chứa init{hasHistory:false}, done, và assistant bubble của turn 2; KHÔNG còn pending abort block (RED trên code hiện tại: turn 2 không chạy vì token/webview state) | harness pattern aiChatPanel.test.ts: controllable deps.complete deferred |
| 2 | edge | Clear khi idle | history=[] ; init{hasHistory:false} + done posted đúng 1 lần mỗi loại; turn sau vẫn chạy bình thường (assistant posted) | send→resolve→clear→send→resolve |
| 3 | edge | not-configured mid-session | loadConfig resolves null → error bubble chứa "AI is not configured" VÀ "Open AI Settings"; done posted; KHÔNG unhandled rejection; send kế (config quay lại) vẫn chạy | deps.loadConfig null lần 1, cfg lần 2 |
| 4 | unit(webview) | init{hasHistory:false} re-enable input | sau setBusy(true), receive init{hasHistory:false} → prompt.disabled===false, sendBtn.disabled===false | jsdom render aiChatPanelMain (pattern aiChatPanelWebview.test.ts hiện có) |
| 5 | unit(webview) | init khi idle không double-fire lỗi | init hai lần liên tiếp không throw, banner/thread DOM ổn | jsdom double init |
| 6 | regression | Clear không phá ACP pending (nếu có session) | cancelAllPending được gọi cho từng pending requestId (spy respond cancelled) — chỉ khi acpSession tồn tại; builtin mode: no-op không throw | panel builtin (không acp) + panel acp fake |

## Test Files

- `src/ui/__tests__/aiChatPanel.test.ts` — #1, #2, #3, #6.
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — #4, #5.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS; #1 RED trên code hiện tại (reproduce user report) → GREEN sau fix.
- [ ] Clear giữa turn: input enabled lại, turn cũ aborted, turn mới chat được.
- [ ] Not-configured: error bubble có hướng dẫn settings; panel không treo.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 (cùng file src/ui/aiChatPanel.ts, region khác — serial để tránh edit conflict).

## Interfaces

- Consumes: `AiChatPanelInit { type:"init"; hasHistory: boolean }`, `setBusy(busy: boolean): void`, `deStreamOpenBubble(): void` (webview hiện có); panel privates `token/currentAbort/turnDonePosted/history` + `cancelAllPending()`/`post()`.
- Produces: contract mới — "mọi `init{hasHistory:false}` từ host ⇒ webview idle + de-streamed" (webview+host lockstep, jsdom test khóa); error msg chuẩn `"AI is not configured — open VSDB: Open AI Settings to configure baseUrl/model/API key"`. Không đổi wire protocol shape (init/done giữ nguyên) — TASK-002/004 không phụ thuộc.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
User report verbatim: "Sau khi bấm clear toi không thể bắt đầu chat được". Root-cause hypothesis (code-read): handleClear không reset token/currentAbort → nếu Clear rơi giữa turn, abort/done flow không hoàn tất; webview setBusy(false) chỉ đến từ done — không có done nào sau init của clear. Executor: nếu RED reproduce ra nguyên nhân khác (vd. engine=null path), ghi vào Executor Report + fix đúng nguyên nhân thật, giữ test contract (chat lại được sau Clear).

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
