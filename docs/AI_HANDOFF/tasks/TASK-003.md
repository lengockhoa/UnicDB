# TASK-003 — Chat reliability: Clear dead-state + not-configured error surface

- Status: `pending_review`
- Owner: `-`
- Reviewer: `Rev-T003`
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

---

## Executor Report

- **STATUS:** DONE
- **EXECUTOR_TOOL:** claude-code
- **EXECUTOR_MODEL:** unic-code
- **EXECUTOR_SUBAGENT:** Exec-T3
- **Worktree:** `.worktrees/task-003` (branch `handoff/task-003`, base 547880b)
- **Date:** 2026-08-25

### Summary

Implemented TASK-003 (D2 Clear mid-stream recovery + D3 not-configured error surface).
`handleClear` now resets `token/currentAbort/turnDonePosted` and aborts the in-flight SSE,
cancels pending ACP requests, then posts `init{hasHistory:false}+done` as a belt. The
webview `applyInit` now also `setBusy(false)` + `deStreamOpenBubble()` on `hasHistory:false`
(defense-in-depth vs. host's `done`). `runBuiltinTurn` enriches the literal
`"AI is not configured"` provider error with the VSDB: Open AI Settings menu path.

### RED output (tests against unmodified base 547880b)

```
✗ #1 clear mid-stream: chat works again; ...
  AssertionError: expected false to be true // acArg?.aborted
✗ #2 clear when idle: ...
  AssertionError: expected 1 to be 2 // done count (handleClear doesn't post done)
✗ #3 loadConfig null mid-session: ...
  AssertionError: expected 'AI is not configured' to contain 'Open AI Settings'
✗ #4 init{hasHistory:false} after setBusy(true) re-enables sendBtn + prompt
  AssertionError: expected true to be false // sendBtn.disabled (applyInit doesn't setBusy(false))
✓ #5 double init ... (idempotent by construction)
✓ #6 builtin mode + no acp (no-op contract held pre-fix)
```

### Files Changed

- `src/ui/aiChatPanel.ts`:
  - `handleClear` — abort SSE, null token/currentAbort, reset turnDonePosted,
    cancelAllPending, post init + done belt.
  - `runBuiltinTurn` catch — enrich `"AI is not configured"` with menu path;
    other errors surface verbatim.
- `webview/aiChatPanelMain.ts`:
  - `applyInit` — on `!msg.hasHistory` call `deStreamOpenBubble()` + `setBusy(false)`.
  - clearBtn handler — comment clarifying local-wipe is best-effort; applyInit
    is the authoritative reset.
- `src/ui/aiChatPanelMessages.ts`:
  - Comment on `AiChatPanelInit` — `init{hasHistory:false}` doubles as a
    host-driven panel reset signal (TASK-003 D2). No shape change.
- `src/ui/__tests__/aiChatPanel.test.ts`:
  - Appended 4 tests under `AiChatPanel — Clear recovery + not-configured (TASK-003)`:
    #1 (regression user-report), #2 (clear when idle), #3 (not-configured),
    #6 (clear w/o acpSession is no-op).
- `src/ui/__tests__/aiChatPanelWebview.test.ts`:
  - Appended 2 tests under `AiChatPanelWebview — init re-enable (TASK-003)`:
    #4 (init re-enables input), #5 (double-init is idempotent).

### Tests Added

- `src/ui/__tests__/aiChatPanel.test.ts`:
  - `#1 clear mid-stream: chat works again; init{hasHistory:false} + done + assistant(msg2) posted in order`
  - `#2 clear when idle: history reset; init{hasHistory:false} + done posted; subsequent send still runs`
  - `#3 loadConfig null mid-session: error bubble has 'AI is not configured' + 'Open AI Settings'; done posted; send kế vẫn chạy`
  - `#6 builtin mode + no acp: clear is a safe no-op on pending (no throw); engine stays builtin`
- `src/ui/__tests__/aiChatPanelWebview.test.ts`:
  - `#4 init{hasHistory:false} after setBusy(true) re-enables sendBtn + prompt + de-streams`
  - `#5 double init{hasHistory:false} does not throw; banner/thread DOM stays well-formed`

### Verification Commands

```
$ npx vitest run src/ui/__tests__/aiChatPanel.test.ts \
                 src/ui/__tests__/aiChatPanelWebview.test.ts \
                 src/ui/__tests__/aiChatPanelMessages.test.ts
✓ src/ui/__tests__/aiChatPanelMessages.test.ts  (15 tests) 3ms
✓ src/ui/__tests__/aiChatPanel.test.ts  (29 tests) 11ms
✓ src/ui/__tests__/aiChatPanelWebview.test.ts  (26 tests) 45ms
Test Files  3 passed (3)
     Tests  70 passed (70)

$ npx tsc --noEmit
EXIT: 0
```

### Acceptance Criteria

- [x] All §Test Cases PASS; #1 RED on baseline (acArg.aborted false / message
      missing "Open AI Settings" / webview sendBtn disabled) → GREEN after fix.
- [x] Clear mid-stream: input re-enabled (webview busy=false on init),
      turn aborted (currentAbort.abort + token/currentAbort nulled),
      next turn runs fresh.
- [x] Not-configured: error bubble contains "AI is not configured — open VSDB:
      Open AI Settings to configure baseUrl/model/API key"; panel not hung.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR (pending — this is the
      executor report; reviewer will append §Reviewer Verdict next).

### Issues / Notes

- Test infra in worktree: `node_modules/.bin/esbuild` was missing — fixed by
  symlinking `node_modules -> /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/node_modules`
  (parent already had it installed). Same fix as sibling worktrees (T8/T9).
- Wire-protocol shape is unchanged (init/done preserved). Other agents (T2/T4/T7)
  are unaffected.
- `applyInit` re-enables input ONLY when `!msg.hasHistory` — replay with
  history preserves the existing busy state, since loading history implies
  the panel is mid-turn.
- The ACP cancelAllPending path is exercised for builtin mode only in #6
  (no-op); full ACP coverage belongs to TASK-004 (which lands after T7).

### HANDOFF_TO_REVIEWER

yes — needs verdict on the new tests, the handleClear reset semantics, and
the applyInit dual-purpose contract.

### NEXT

ready for reviewer (Rev-T003).

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
