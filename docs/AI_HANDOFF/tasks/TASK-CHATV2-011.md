# TASK-CHATV2-011 — Structured mentions, search races and context chips

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4

## Goal
Turn `@` references into correlated, structured context identities with a professional search/listbox, safe preview and explicit changed/missing resolution. No mention may silently disappear from a request.

## Target Files
- `src/ui/aiChatContext.ts` — new `ContextRef`, search/resolution/status/preview services.
- `src/ui/aiChatPanelMessages.ts` — correlated context intents/frames finalized.
- `src/ui/aiChatPanel.ts` — handle search/resolve and build structured turn context.
- `webview/aiChat/mentions.ts` — token parser, debounce and result acceptance.
- `webview/aiChat/autocomplete.ts` — grouped mention rows/loading/error/retry.
- `webview/aiChat/contextChips.ts` — chips, preview and resolution dialog callbacks.
- `src/ui/__tests__/aiChatContext.test.ts`, `webview/aiChat/__tests__/mentions.test.ts`.

## Required Work / Exact Spec
`ContextRef` fields: id, kind (`file|selection|table|view|routine|schema`), label, detail, displayToken, source identity (URI or connection/schema/object signature), revision/snapshot metadata, status (`ready|changed|missing|forbidden`), safe preview capability. Never put file content/raw rows/base64 in DOM attributes or identity labels.

Eligibility parser runs on input, selection change, paste and pointer caret change. `@` must be at eligible boundary; exclude email-like word, escaped `\@`, inline/fenced code. Empty `@` groups Files/Selection/Database. Query search debounces 150ms; spinner appears only after 200ms. Intent includes requestId, draftRevision, query, kind filter/scope. Apply response only if requestId/revision/open token match; Escape/removal increments close generation so late results cannot reopen.

Rows are 44px, 16px semantic icon, 13px primary, 11px single-line secondary. Duplicate filenames/database objects always show full distinguishing path or connection.schema. Kinds display: file `@index.vue`; selection `@selection(index.vue:22–48)`; table/view/routine/schema per professional spec. Empty row `No matching context`; error row `Could not search context` + Retry; spinner/error/empty are nonselectable.

Acceptance replaces only active token range, preserves all preceding/following text and caret, then adds structured ref chip. Outbound submit carries IDs/snapshots separately from visible text. Chip min 28px, 16px icon, ellipsized label, status and 28px remove target; title/aria includes full detail. Click requests safe preview without model call. Search/preview never invokes an AI engine.

At send, changed ref opens Resolve: Refresh, Keep snapshot when policy permits, Remove. Missing/forbidden: Remove or `Send without it`; no ambiguous auto-drop. Host validates again and returns status. Database mentions provide schema metadata only; data rows require governed tool call/permission. Remove affects one ID only even if labels duplicate.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | parser | eligible/excluded contexts | correct range for line start/prose; excludes email/code/escaped |
| 2 | race | old request/revision/late Escape | stale result ignored, popover stays correct/closed |
| 3 | interaction | accept in middle | only token replaced; surrounding text/caret preserved |
| 4 | identity | duplicate labels | distinct IDs/details; removal affects selected ID only |
| 5 | edge | empty/loading/error | exact nonselectable rows; Retry reuses current query/new ID |
| 6 | resolution | changed/missing/forbidden | send blocked until explicit valid choice |
| 7 | security | hostile labels/paths | text-only, no raw content in data attributes |
| 8 | regression | no model search | engine send count remains zero for search/preview |

## Test Files
- `src/ui/__tests__/aiChatContext.test.ts`
- `webview/aiChat/__tests__/mentions.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatContext.test.ts webview/aiChat/__tests__/mentions.test.ts src/ui/__tests__/aiChatPanelMentions.test.ts webview/aiChat/__tests__/keyboard.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] MENTION-01 through MENTION-10 pass.
- [ ] Context identity/status survives from selection through host validation/send.
- [ ] Every changed/unavailable ref requires explicit resolution.
- [ ] Search/preview are race-safe, accessible and model-free.

## Dependencies
- TASK-CHATV2-003, TASK-CHATV2-004, TASK-CHATV2-009

## Interfaces
- Consumes: shared autocomplete, controller/store, V2 correlated frames.
- Produces: `ContextRef`, `searchContext()`, `resolveContext()`, mention/chip views for 013/015.

## Discussion
(no comments yet)
