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
- 2026-09-15 executor: Implemented the pure context-identity layer first (`src/ui/aiChatContext.ts`) with tests written before the implementation; then the mention parser/scheduler (`webview/aiChat/mentions.ts`), the grouped-row extension of the shared listbox (`webview/aiChat/autocomplete.ts`), the chip/preview/resolve strip (`webview/aiChat/contextChips.ts`), and finally the wire contract + host handlers (`aiChatPanelMessages.ts`, `aiChatPanel.ts`). Two decisions made without a human in the loop, recorded here:
  1. **Legacy ref fields kept.** `AiChatContextRefV2` still carries the pre-011 `changed`/`missing` booleans alongside the new `status`/`revision`. Removing them would break the already-merged V2 consumers (waves ≤6); the parser treats them as a derived view of `status`, so both stay consistent.
  2. **`remove_context` remains an ack-only no-op.** The task spec assigns host re-validation to `resolve_context`/`submit_turn`; wiring a third mutation path would duplicate that state. The webview owns the local strip mutation; the host never invents a ref it did not receive.

## Executor Report
- **EXECUTOR_TOOL**: claude-code
- **EXECUTOR_MODEL**: bao-sonnet (self-reported; reviewer must use a different model)
- **EXECUTOR_SUBAGENT**: -
- **RED_OUTPUT**: Tests were authored before each implementation milestone. Observed RED evidence (real failure, later fixed): `webview/aiChat/__tests__/mentions.test.ts` → `mentionEligibility("use @inde here", 10)` asserted `expected false to be true`; the caret sat one past the token (after the following space), so no token was found. Fixed by moving the caret to 9, which still tests the outside-code eligible path. Runtime RED for the wire-contract additions was confirmed by the new `aiChatPanelContext011.test.ts` positive cases failing type-wise until `kindFilter`/`generation`/`context_resolved`/`context_blocked` existed in `aiChatPanelMessages.ts`.
- **Verification Output**:
  - `npm test -- --run src/ui/__tests__/aiChatContext.test.ts webview/aiChat/__tests__/mentions.test.ts src/ui/__tests__/aiChatPanelMentions.test.ts webview/aiChat/__tests__/keyboard.test.ts`
    ```
    ✓ webview/aiChat/__tests__/keyboard.test.ts  (23 tests) 3ms
    ✓ webview/aiChat/__tests__/mentions.test.ts  (33 tests) 6ms
    ✓ src/ui/__tests__/aiChatContext.test.ts  (33 tests) 7ms
    ✓ src/ui/__tests__/aiChatPanelMentions.test.ts  (38 tests) 9ms
    Test Files  4 passed (4)
          Tests  127 passed (127)
    ```
  - `npm run typecheck` → `tsc --noEmit`, exit 0 (no output).
  - `npm run compile` → `esbuild: build complete`, exit 0.
  - Additional: `npm test -- --run src/ui/__tests__/aiChatPanelContext011.test.ts` → 10 passed (new wire-contract file). `webview/aiChat/__tests__/contextChips.test.ts` → 12 passed.
- **Status**: DONE
- **Note**: `webview/aiChat/styles.css` was APPENDED to only (group headings, row body/text/icon, status/spinner/retry, chips, preview, resolution dialog), all under `.UnicDB-ai-chat-v2-*` selectors — the orchestrator merge-applies this file. No package/version/publish change. Files changed vs base 50c506c: `src/ui/aiChatContext.ts`, `src/ui/aiChatPanel.ts`, `src/ui/aiChatPanelMessages.ts`, `webview/aiChat/mentions.ts`, `webview/aiChat/autocomplete.ts`, `webview/aiChat/contextChips.ts`, `webview/aiChat/styles.css`, and the four test files (`src/ui/__tests__/aiChatContext.test.ts`, `src/ui/__tests__/aiChatPanelContext011.test.ts`, `webview/aiChat/__tests__/mentions.test.ts`, `webview/aiChat/__tests__/contextChips.test.ts`, `webview/aiChat/__tests__/autocomplete.test.ts`).
