# TASK-004 — Webview resume picker + history rendering

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.D

## Goal

Webview `aiChatPanelMain.ts`: nút "Resume session" → post `resume_list` → render list rows
text-only → click row echo `resume_pick` với sessionId host đưa (verbatim) → render batch
`history` (user/assistant/tool + truncation notice) — theo đúng security rules hiện có
(textContent only, markdown chỉ cho assistant qua renderer an toàn sẵn có).

## Target Files

- `webview/aiChatPanelMain.ts` — nút Resume trong actions row; render list + history;
  busy-disable; `resume_cancel` khi dismiss.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | click Resume → post `resume_list`; nhận `resume_sessions` render đủ rows | mỗi row hiện `label` + `detail` là text node (textContent, không innerHTML cho data host); click row → đúng MỘT `resume_pick` với sessionId verbatim | message `resume_sessions` 3 rows |
| 2 | unit (happy) | `history` batch render đúng thứ tự + kind | user bubble plain text, assistant bubble qua markdown renderer hiện có, tool item one-line collapsed; thứ tự DOM đúng thứ tự items | items: user, assistant (`**bold**`), tool |
| 3 | unit (edge-neverrender) | thought/skip không bao giờ tới webview từ host; nếu items chứa text dị | chỉ render đúng items nhận được; KHÔNG tạo element nào từ `agent_thought_chunk` (host đã lọc — webview không có branch nào render thought) | replay-derived items chỉ user/assistant/tool |
| 4 | unit (edge-truncation) | `history` với `truncated:true, truncatedCount:23` | đúng MỘT dòng notice `<n> earlier items not shown` (dùng truncatedCount) nằm TRÊN các item render | items 50 + truncated flags |
| 5 | unit (edge-hostile) | label/detail chứa HTML (`<img onerror>`, `<script>`) | render literal text, KHÔNG node sống; không script nào execute | row với label `<img src=x onerror=alert(1)>` |
| 6 | unit (edge-busy) | đang streaming (`send` → chưa `done`) nút Resume disabled | click không post `resume_list`; sau `done` re-enable và click post bình thường | send → click resume → done → click resume |
| 7 | unit (regression) | hành vi cũ không đổi | mọi test hiện có của `aiChatPanelWebview.test.ts` + `aiChatPanelBundle.test.ts` pass nguyên (send/stop/clear/permission/security/no-apiKey) | existing suites, không sửa |

Lưu ý fixture: webview tests transpile `webview/aiChatPanelMain.ts` qua esbuild CLI vào
jsdom (pattern hiện có của `aiChatPanelWebview.test.ts`) — không phụ thuộc dist. Bundle
test chạy SAU `npm run compile` (loads `dist/aiChatPanel.js`). Dismiss picker → post
`resume_cancel` đúng 1 lần.

## Test Files

- `src/ui/__tests__/aiChatPanelWebview.test.ts` — append cases 1–6.
- `src/ui/__tests__/aiChatPanelBundle.test.ts` — append: nút Resume tồn tại trong bundle,
  click post `resume_list`, không apiKey trong bất kỳ postMessage nào.

## Verification Commands

```bash
npm run compile && npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts
```

(`compile` TRƯỚC — bundle test đọc `dist/aiChatPanel.js`. Không có lint script — N/A.)

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước).
- [ ] Mọi text host-driven render qua text node / renderer an toàn hiện có — không innerHTML mới với dữ liệu host.
- [ ] sessionId echo verbatim — webview không tự sinh/sửa id.
- [ ] Nút Resume disable khi busy, re-enable sau `done`.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-003 — tiêu thụ message shapes `resume_sessions` / `history` + gửi
  `resume_list`/`resume_pick`/`resume_cancel` (chữ ký ở TASK-003 §Interfaces).

## Interfaces

- Consumes: từ TASK-003 — `{type:"resume_sessions", sessions:[{sessionId,label,detail}]}`,
  `{type:"history", items:[{kind,text}], truncated, truncatedCount}`.
- Produces: (none — webview là leaf; không task sau tiêu thụ).

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecO-T004
SUMMARY: webview/aiChatPanelMain.ts now renders a Resume button (busy-aware), a text-only session picker (verbatim sessionId echo, hostile-label safe, single resume_cancel on dismiss), and a history batch renderer (user plain / assistant via existing markdown / tool one-line) with truncation notice ABOVE items using truncatedCount. No branch renders agent_thought_chunk.
TEST_PLAN_FOLLOWED: task §Test Cases — all 7 frozen cases implemented
FILES_CHANGED:
  - webview/aiChatPanelMain.ts: +ResumeSessionsMsg / +HistoryMsg types; HostMsg union extended; +Resume button (id resumeBtn) in actions row; +setBusy wires resumeBtn.disabled; +renderResumePicker (text-only rows, pickerOpen/pickerConsumed guards so one pick = one resume_pick, cancel → resume_cancel); +disposeResumePicker; +renderHistory (truncation notice above items, kind switch user|assistant|tool — any other kind silently dropped); switch cases for resume_sessions + history.
  - src/ui/__tests__/aiChatPanelWebview.test.ts: appended cases #1, #1b, #2, #3, #4, #5, #6 — all PASS.
  - src/ui/__tests__/aiChatPanelBundle.test.ts: appended cases #9, #10, #11 inside new describe "bundle (TASK-004 Resume)" — all PASS.
TESTS_ADDED:
  - src/ui/__tests__/aiChatPanelWebview.test.ts:
    - "#1 click Resume → posts resume_list; receives resume_sessions rows; click row → exactly ONE resume_pick with verbatim sessionId"
    - "#1b dismiss picker → posts resume_cancel exactly once"
    - "#2 history renders user/assistant/tool in order; assistant via markdown renderer; tool one-line collapsed"
    - "#3 agent_thought_chunk is NEVER rendered (host-filtered; no branch in webview)"
    - "#4 truncation: single notice line ABOVE items using truncatedCount"
    - "#5 hostile label/detail in resume_sessions renders literal text (no live nodes)"
    - "#6 busy: Send in flight disables Resume; done re-enables"
  - src/ui/__tests__/aiChatPanelBundle.test.ts:
    - "#9 Resume button exists in initial render and is enabled"
    - "#10 click Resume → posts exactly one resume_list"
    - "#11 no apiKey material across resume picker exchanges"
VERIFICATION:
  command: npm run compile && npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts
  result: 32 pass / 0 fail / exit 0
  output_excerpt: |
    > vsdb@1.5.1 compile
    > node esbuild.js
    ...
    dist/aiChatPanel.js      13.4kb
    ...
    > vsdb@1.5.1 typecheck
    > tsc --noEmit
    ...
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
     ✓ src/ui/__tests__/aiChatPanelBundle.test.ts  (11 tests) 33ms
     ✓ src/ui/__tests__/aiChatPanelWebview.test.ts  (21 tests) 52ms

     Test Files  2 passed (2)
          Tests  32 passed (32)

RED evidence (verbatim, before GREEN):
  command: npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts (pre-impl)
  result: 7 failed | 14 passed (21)
  output_excerpt: |
     ❯ AiChatPanelWebview — Resume button + session picker > #1 click Resume → posts resume_list; receives resume_sessions rows; click row → exactly ONE resume_pick with verbatim sessionId
       → expected null not to be null
     ❯ ... #1b dismiss picker → posts resume_cancel exactly once → expected null not to be null
     ❯ ... #2 history renders user/assistant/tool in order ... → expected +0 to be 1 // Object.is equality
     ❯ ... #3 agent_thought_chunk is NEVER rendered ... → expected +0 to be 2 // Object.is equality
     ❯ ... #4 truncation: single notice line ABOVE items ... → expected null not to be null
     ❯ ... #5 hostile label/detail in resume_sessions ... → the given combination of arguments (undefined and string) is invalid for this assertion.
     ❯ ... #6 busy: Send in flight disables Resume ... → expected null not to be null
ISSUES: none
HANDOFF_TO_REVIEWER: yes — TASK-004 ready for review
NEXT: ready for review
-->

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecO-T004
EXECUTOR_TOOL: claude-code
MODEL_ISOLATION: executor unic-code ≠ reviewer unic-smart (matches handoff.reviewer.model) — OK
VERIFICATION_RERUN:
  command: npm run compile && npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts
  result: 32 pass / 0 fail (compile OK, tsc --noEmit clean, no lint script — N/A)
TEST_PLAN_COVERAGE: all-followed — cases #1,#1b,#2,#3,#4,#5,#6 (webview) + #9,#10,#11 (bundle) present with real assertions; RED_OUTPUT verbatim with real failures (7 failed | 14 passed, "expected null not to be null"), not a bare claim
FINDINGS:
  critical: none
  important: none
  minor:
    - webview/aiChatPanelMain.ts:565-567 — 3 lines in the message-wiring block gained a stray leading space (` window.addEventListener`, ` const msg`, ` switch`) vs surrounding one-space indent. Cosmetic only; tsc/esbuild unaffected.
SECURITY_CHECKS (re-verified by reading diff + fresh test run):
  - Picker rows render label/detail via element.textContent only — no new innerHTML with host data; hostile `<img onerror>`/`<script>` payloads render as literal text (test #5 asserts no live nodes + `__pwned` absent).
  - sessionId echoed verbatim via closure capture; exactly one resume_pick per pick (pickerConsumed guard), resume_cancel exactly once on dismiss.
  - Assistant history items go through the EXISTING escape-first renderMarkdown; user/tool items are textContent.
  - No branch renders agent_thought_chunk (only comments mention it; test #3 proves no DOM node).
  - Truncation notice is a single line using truncatedCount, placed ABOVE items (thread.children[0]).
  - apiKey absent from every posted payload (bundle test #11 JSON scan).
  - Existing suites untouched (diff is pure-append to both test files).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Clean implementation; the only finding is a whitespace artifact. Bundle test confirmed reading dist/aiChatPanel.js (rebuilt during re-run before tests).
