# INDEX (cycle AB)

Cycle AB — **AI CHAT IMAGE ATTACH + CLIPBOARD PASTE**: attach button + Cmd/Ctrl+V image in composer; 5 MB / 4 images caps; vision-capable model routing; clear warning when current model lacks vision; image bytes reach model only as `ChatContentPart[]` for the user message — never mixed with DB auto-context. Four tasks, one wave-1 of three parallel + one dependent consumer wave.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-001 | Host message contract + buildMessages image-parts path (host side) | done | none | unic-smart |
| TASK-002 | Webview image attach + clipboard paste UX | done | TASK-001 | unic-smart |
| TASK-003 | CSS for attachments strip + attach button + warning | done | none | unic-smart |
| TASK-005 | Pure helpers: validateImageAttachment / log redaction / dataURL | done | none | unic-smart |

Graph: TASK-001 → TASK-002; TASK-003 independent; TASK-005 independent.

- Wave 1 (3): TASK-001, TASK-003, TASK-005
- Wave 2 (1): TASK-002

No same-wave file overlap: TASK-001 owns `src/ui/aiChatPanelMessages.ts` + `src/ui/aiChatPanel.ts` + new test file; TASK-002 owns `webview/aiChatPanelMain.ts` + new test; TASK-003 owns `webview/styles.css` + (regression in) `src/ui/__tests__/chatLayoutCss.test.ts`; TASK-005 owns new `src/ui/aiChatAttachments.ts` + new test only.

Plan reference: `docs/AI_HANDOFF/PLAN_AB.md`.
Spec reference: `docs/AI_HANDOFF/queue/AI-CHAT-INPUT-UX-spec.md` (reqs 3-5; reqs 1-2 shipped in cycle AA).
