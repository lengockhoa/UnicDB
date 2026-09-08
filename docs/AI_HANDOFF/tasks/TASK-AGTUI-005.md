# TASK-AGTUI-005 — Thread rendering module: bubbles, thinking blocks, tool cards, mentions

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §4

## Goal

Extract the chat-thread DOM builders from `webview/aiChatPanelMain.ts` (lines ~982-1560: `appendUser`, `appendThinking`, `appendStep`, `appendToolResult`, `appendChangePlan`, error/notice bubbles, usage chip, `renderMarkdown`) into a new pure module with the SAME class names + security invariants (textContent-only for wire strings). Main will consume it in TASK-AGTUI-007.

## Target Files

- `webview/aiChatPanelThread.ts` (new) — exports the builder functions (moved logic, clone class names added alongside existing ones).
- `webview/__tests__/aiChatPanelThread.test.ts` (new) — jsdom unit tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | bubble set renders | `appendUserBubble(t,"hi")` → `.UnicDB-chat-msg-user` with exact text; `appendAssistantBubble(t,"**md**",true)` → `.UnicDB-chat-msg-assistant` containing rendered `<strong>md</strong>`; thinking/step/tool-card/error/usage helpers each produce their §TASK-AGTUI-001 class | fresh thread element |
| 2 | edge (malformed/XSS) | hostile wire strings inert | user text `<img src=x onerror=alert(1)>`, tool name/summary with HTML → rendered via textContent/createTextNode; `document.querySelectorAll("img[src=x],onerror")` finds nothing; markdown path escapes before render (same escaping as current `escapeHtml`) | hostile fixtures |
| 3 | edge (duplicate) | plan card fires once | `appendChangePlanCard` approve button: click → `onApprove` called exactly once, buttons disabled after first click; reject likewise; unknown `status` on `appendToolCard` → card renders with base class, no crash | double-click dispatch |
| 4 | edge (empty) | empty strings render cleanly | `appendAssistantBubble(t,"",true)` → empty bubble node, no `undefined`/`NaN` text; `appendToolCard(t,"sql","denied","")` → `.UnicDB-chat-tool-denied` card with empty body, no throw | empty fixtures |
| 5 | edge (boundary) | usage chip unknown tokens | usage `{inputTokens:0,outputTokens:0,unknown:true,sessionTokens:{inputTokens:9,outputTokens:1},policyNotice:"n"}` → chip shows session totals, renders "unknown" marker NOT "0"; `unknown:false` → shows per-turn numbers (mirrors current TASK-ARP06-005 contract) | two fixtures |

## Test Files

- `webview/__tests__/aiChatPanelThread.test.ts` (new)

## Verification Commands

```bash
npx vitest run webview/__tests__/aiChatPanelThread.test.ts
npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts   # parity reference: still green (main unchanged at this point)
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; module webview-safe (no `vscode` import); logic is MOVED not rewritten — same ids/classes the existing webview tests pin (`UnicDB-chat-queued`, spinner row contract, plan card structure).
- [ ] No edits to `webview/aiChatPanelMain.ts` (extraction only; deletion of the originals happens in TASK-AGTUI-007).

## Dependencies

- none

## Interfaces

- Consumes: CSS classes from TASK-AGTUI-001 (`.UnicDB-chat-msg-*`, `.UnicDB-chat-thought`, `.UnicDB-chat-tool*`, `.UnicDB-chat-plan`, `.UnicDB-chat-error`, `.UnicDB-chat-usage`).
- Produces (exact signatures — consumed by TASK-AGTUI-007):
```ts
export function renderMarkdown(text: string): string;             // moved from main
export function appendUserBubble(thread: HTMLElement, text: string): HTMLElement;
export function appendAssistantBubble(thread: HTMLElement, text: string, markdown: boolean): HTMLElement;
export function appendThinkingRow(thread: HTMLElement): HTMLElement;        // returns row for removal
export function removeThinkingRow(thread: HTMLElement, row: HTMLElement): void;
export function appendStepRow(thread: HTMLElement, label: string): HTMLElement;
export function appendToolCard(thread: HTMLElement, tool: string, status: "ok"|"failed"|"denied", summary: string): HTMLElement;
export function appendChangePlanCard(thread: HTMLElement, plan: {intent:string; statements:Array<{sql:string;tier:string;dangerNote:string}>; drift:string[]; drifted:boolean}, handlers: {onApprove(): void; onReject(): void}): HTMLElement;
export function appendErrorBubble(thread: HTMLElement, message: string): HTMLElement;
export function appendNoticeBubble(thread: HTMLElement, message: string): HTMLElement;
export function renderUsageChip(container: HTMLElement, usage: {inputTokens:number; outputTokens:number; unknown:boolean; sessionTokens:{inputTokens:number; outputTokens:number}; policyNotice:string}): void;
```

### 2026-09-08 · planner · unic-smart
`sqlHighlight` import used by markdown/code paths may come along — keep the import relative (`./sqlHighlight`) so esbuild bundling in the harness still resolves.

## Executor Report

(appended below by executor)

---

## Reviewer Verdict

(appended below by reviewer)
