# TASK-004 — Webview resume picker + history rendering

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.D

## Goal

Webview `aiChatPanelMain.ts`: a "Resume session" button → posts `resume_list` → renders list rows as text only → click on a row echoes `resume_pick` with the sessionId from the host (verbatim) → renders the `history` batch (user/assistant/tool + truncation notice) — respecting the existing security rules (textContent only, markdown only for assistant through the existing safe renderer).

## Target Files

- `webview/aiChatPanelMain.ts` — Resume button in the actions row; renders list + history; busy-disable; `resume_cancel` on dismiss.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit (happy) | click Resume → posts `resume_list`; receiving `resume_sessions` renders all rows | each row shows `label` + `detail` as text nodes (textContent, no innerHTML for host data); click on a row → exactly ONE `resume_pick` with sessionId verbatim | message `resume_sessions` with 3 rows |
| 2 | unit (happy) | `history` batch renders in order + kind | user bubble is plain text, assistant bubble goes through the existing markdown renderer, tool item is one line collapsed; DOM order matches item order | items: user, assistant (`**bold**`), tool |
| 3 | unit (edge-neverrender) | thought/skip never reach the webview from the host; if items contain unusual text | renders only the items received; does NOT create any element from `agent_thought_chunk` (host already filters — webview has no branch that renders thought) | replay-derived items contain only user/assistant/tool |
| 4 | unit (edge-truncation) | `history` with `truncated:true, truncatedCount:23` | exactly ONE notice line `<n> earlier items not shown` (using truncatedCount) positioned ABOVE the rendered items | items 50 + truncation flags |
| 5 | unit (edge-hostile) | label/detail contains HTML (`<img onerror>`, `<script>`) | renders literal text, NO live nodes; no script executes | row with label `<img src=x onerror=alert(1)>` |
| 6 | unit (edge-busy) | while streaming (`send` → not yet `done`) the Resume button is disabled | click does NOT post `resume_list`; after `done` it re-enables and click posts normally | send → click resume → done → click resume |
| 7 | unit (regression) | old behavior unchanged | every existing test in `aiChatPanelWebview.test.ts` + `aiChatPanelBundle.test.ts` passes untouched (send/stop/clear/permission/security/no-apiKey) | existing suites, not edited |

Fixture note: webview tests transpile `webview/aiChatPanelMain.ts` via the esbuild CLI into jsdom (the existing `aiChatPanelWebview.test.ts` pattern) — does not depend on dist. The bundle test runs AFTER `npm run compile` (loads `dist/aiChatPanel.js`). Dismiss picker → post `resume_cancel` exactly once.

## Test Files

- `src/ui/__tests__/aiChatPanelWebview.test.ts` — append cases 1–6.
- `src/ui/__tests__/aiChatPanelBundle.test.ts` — append: Resume button exists in the bundle, click posts `resume_list`, no apiKey in any postMessage.

## Verification Commands

```bash
npm run compile && npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts
```

(`compile` FIRST — the bundle test reads `dist/aiChatPanel.js`. No lint script — N/A.)

## Acceptance Criteria

- [ ] Every test in §Test Cases PASSES (RED before).
- [ ] All host-driven text renders via text node / existing safe renderer — no new innerHTML with host data.
- [ ] sessionId echoed verbatim — webview does not generate/modify ids.
- [ ] Resume button disabled while busy, re-enabled after `done`.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-003 — consumes the message shapes `resume_sessions` / `history` and sends `resume_list` / `resume_pick` / `resume_cancel` (signatures in TASK-003 §Interfaces).

## Interfaces

- Consumes: from TASK-003 — `{type:"resume_sessions", sessions:[{sessionId,label,detail}]}`, `{type:"history", items:[{kind,text}], truncated, truncatedCount}`.
- Produces: (none — webview is a leaf; no downstream task consumes).

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
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
