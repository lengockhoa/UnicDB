# TASK-CHATV2-013 — Attachments, attach-context menu and schema controls

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§4–5

## Goal
Unify plus-menu context actions, image attachment validation/paste and active-schema controls into the V2 draft model while preserving current host validation limits and future-draft semantics.

## Target Files
- `webview/aiChat/attachMenu.ts` — plus menu and action availability.
- `webview/aiChat/attachments.ts` — image ingest, thumbnails, removal and warnings.
- `webview/aiChat/schemaControl.ts` — active schema chip and host picker intent.
- `src/ui/aiChatPanel.ts` — V2 attachment/schema/context handling only.
- `src/ui/aiChatAttachments.ts` — reuse limits/validation; modify only if typed V2 seam requires it.
- `webview/aiChat/__tests__/attachments.test.ts`, `src/ui/__tests__/aiChatPanelAttachments.test.ts`.

## Required Work / Exact Spec
Plus button 32×32 opens menu left-aligned above trigger, width min 300/max 420. Rows 40px with 16px icon, 13px title, 11px detail: Current file (`@file`), Selection (`@selection`), Files…, Database object…, Image… only when capability allows. Disabled meaningful rows remain with exact explanation such as `Select text first`, `Open a workspace folder first`, `Select a database connection first`; impossible engine features are hidden. Menu is keyboard/listbox operable and non-modal.

Current file/selection/database actions create `ContextRef` through host, not guessed string. Files/Database open mention mode with kind filter. Schema chip >=36px follows active-schema frame; label `Schema: public` or safe `No active schema`; click emits existing host picker intent. During active turn new schema/context applies only to next draft; running turn immutable.

Image action opens hidden file input only when `imageInput=true`. Paste image uses same pipeline; text paste remains intact. Preserve MIME allowlist, maximum count and byte cap from existing shared constants; webview performs early warning and host revalidates MIME/magic/count/size/model/engine. Attachment state holds id/mime/base64/bytes only ephemerally; base64 never goes to session/trace/error/export/data attributes. Clear ephemeral payload only after matching submit ack or explicit remove/clear.

Thumbnail strip appears above text region, max 72px, horizontal scroll. Each thumbnail 44×44, radius 6px, image alt empty when decorative, 24×24 remove target with aria `Remove image n`. Rejections are inline amber notices with file name safely rendered and exact reason: unsupported type, too large, count limit, current model unavailable. Disabled attach button tooltip states exact cause. Busy still permits attachments for next draft.

Object URLs, if used, are revoked on remove/dispose; data URLs are never persisted. Do not log payload. Host rejection of one image does not discard valid siblings or text-only request unless policy requires it.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | DOM | menu rows/states | exact order, geometry classes and explanations |
| 2 | capability | image hidden/available | follows snapshot+model vision, not provider guess |
| 3 | validation | MIME/count/size/magic | webview warns; host independently rejects invalid |
| 4 | paste | image + text clipboard | image ingested where valid; text paste unaffected |
| 5 | regression | busy next draft | add/remove/schema works without mutating active turn |
| 6 | privacy | session/export/trace fixtures | no base64/raw image bytes appear |
| 7 | lifecycle | remove/dispose | payload cleared and object URL revoked once |
| 8 | edge | partial rejection | valid siblings/text preserved with per-item warning |

## Test Files
- `webview/aiChat/__tests__/attachments.test.ts`
- `src/ui/__tests__/aiChatPanelAttachments.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/attachments.test.ts src/ui/__tests__/aiChatPanelAttachments.test.ts src/ui/__tests__/aiChatAttachments.test.ts src/ui/__tests__/aiChatGrounding.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Every plus-menu row has exact action/unavailable behavior.
- [ ] Attachment limits/security equal or exceed current host validation.
- [ ] Busy future-draft and schema semantics are explicit and tested.
- [ ] No binary content enters persistence/trace/export/DOM attributes.

## Dependencies
- TASK-CHATV2-002, TASK-CHATV2-008, TASK-CHATV2-011

## Interfaces
- Consumes: capabilities, `ContextRef`, draft attachments, existing validators/schema command.
- Produces: attach menu/attachment/schema views and intents for 015–017.

## Discussion
(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
RED_OUTPUT: n/a for this resume run — tests were authored and committed incrementally across the 6 milestone commits listed under `git log --oneline main..HEAD`. Each milestone landed its test alongside its implementation; this run only re-ran the task's Verification Commands on the completed, committed tree (no new RED derived).
Verification Output:
```
$ npm test -- --run webview/aiChat/__tests__/attachments.test.ts src/ui/__tests__/aiChatPanelAttachments.test.ts src/ui/__tests__/aiChatAttachments.test.ts src/ui/__tests__/aiChatGrounding.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-chatv2-013
 ✓ src/ui/__tests__/aiChatAttachments.test.ts  (23 tests) 10ms
 ✓ src/ui/__tests__/aiChatGrounding.test.ts  (5 tests) 2ms
 ✓ src/ui/__tests__/aiChatPanelAttachments.test.ts  (23 tests) 17ms
 ✓ webview/aiChat/__tests__/attachments.test.ts  (26 tests) 38ms

 Test Files  4 passed (4)
      Tests  77 passed (77)
TEST_EXIT=0

$ npm run typecheck
> tsc --noEmit
TYPECHECK_EXIT=0

$ npm run compile
esbuild: build complete
COMPILE_EXIT=0
```
Status: PASS
Note: none — no fixes were required; the committed implementation passes all three Verification Commands unchanged. Working tree remained clean (`dist/` is git-ignored).
