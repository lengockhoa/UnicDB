# TASK-003 — ACP permission message protocol + webview

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal
Define the host/webview ACP permission wire shape and render requests safely as text so the panel coordinator can accept only host-generated opaque IDs and explicit user choices later.

## Target Files
- `src/ui/aiChatPanelMessages.ts` (existing) — permission request/response types with opaque request and option IDs.
- `webview/aiChatPanelMain.ts` (existing) — text-only request rendering and one response action.
- `src/ui/__tests__/aiChatPanelMessages.test.ts` (new) — message contract tests.
- `src/ui/__tests__/aiChatPanelWebview.test.ts` (new) — webview safe-rendering tests.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | host permission message exposes opaque request ID, tool/details, and option IDs | required fields are typed and present without API-key fields | fake host message |
| 2 | unit | webview posts one `permission_response` with supplied opaque request ID and selected option | one response message is posted after Allow/Deny action | fake DOM |
| 3 | edge | tool/detail/option labels containing markup render as literal text | no `innerHTML`/markdown interpretation or executable nodes result | fake DOM with hostile labels |
| 4 | edge | duplicate, unknown, or disposed request interaction posts no second/new response | only one response is emitted for a rendered request | fake DOM |

## Test Files
- `src/ui/__tests__/aiChatPanelMessages.test.ts`
- `src/ui/__tests__/aiChatPanelWebview.test.ts`

## Verification Commands
```bash
npx vitest run src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts && npm run typecheck
```

## Acceptance Criteria
- [ ] message protocol is explicit and backward-compatible with existing chat messages.
- [ ] webview renders tool/detail/option labels as text only, never `innerHTML` or markdown.
- [ ] webview returns only the host-provided opaque request ID plus a user-selected option/deny; duplicate interaction posts once.
- [ ] reviewer verdict APPROVED.

## Dependencies
- (none)

## Interfaces
- Consumes: `AiChatPanelHostMessage` / `AiChatPanelWebviewMessage` union shape and existing panel message conventions.
- Produces: permission request/response message kinds for TASK-004 coordinator.

## Discussion
(queued)

---
## Executor Report
(pending)

## Reviewer Verdict
(pending)
