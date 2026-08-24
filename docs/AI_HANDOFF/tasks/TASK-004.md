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
