# TASK-003 — AI Chat panel webview + host wiring

## Goal
Webview chat panel (house pattern như newTableForm/aiSettingsForm): bubbles user/assistant/tool, markdown final text, Stop button, gửi qua runAgent với registry từ T1+T2.

## Target Files
- `src/ui/aiChatPanelMessages.ts` (mới), `src/ui/aiChatPanel.ts` (mới), `webview/aiChatPanelMain.ts` (mới)
- `esbuild.js` (thêm entry), `package.json` (command `vsdb.aiChat` + menu)
- Tests: `src/ui/__tests__/aiChatPanel.test.ts`, `src/ui/__tests__/aiChatPanelBundle.test.ts`

## Spec (frozen)
```ts
// aiChatPanelMessages.ts — contract 2 chiều
export type ToPanel = { type: "init"; hasHistory: boolean } | { type: "assistant"; text: string; markdown: boolean } | { type: "step"; label: string } | { type: "error"; message: string } | { type: "done" };
export type FromPanel = { type: "ready" } | { type: "send"; text: string } | { type: "stop" } | { type: "clear" };
// aiChatPanel.ts
export interface ChatAbortToken { aborted: boolean }
export class AiChatPanel {
  constructor(ctx: vscode.ExtensionContext, deps: AgentDeps, adapterFactory: AdapterFactory, style?: { createWebviewPanel?; asWebviewUri? })
  show(): void; dispose(): void;  // reveal nếu đang mở (pattern newTableForm)
}
```
- Host flow `send`: guard text rỗng; build messages = system prompt (chứa schema context qua `formatSchemaContext` từ `(await adapterFactory())?.listTables()` + `listTableDetail` cho ≤30 bảng đầu; catch lỗi introspection → context rỗng, không crash; factory null → context rỗng) + history panel nội bộ + user msg. Gọi `runAgent({ messages, tools: createDbTools(adapterFactory) }, deps, callbacks)` — **tools nằm trên AgentInput, không phải tham số thứ ba** (agent.ts:100-103; callbacks là tham số thứ ba).
- **Stop (F4 — thiết kế token, KHÔNG AbortController vì runAgent không nhận signal)**: host giữ `ChatAbortToken{aborted}` mỗi lượt send. Khi `stop` tới: token.aborted=true. onStep callback: nếu token.aborted → không post step mới. Khi runAgent promise settle: nếu token.aborted → KHÔNG post assistant final (chỉ post `{type:"done"}`); else post assistant+done. Promise reject do hủy → nuốt (đã có error path riêng).
- Clear: reset history nội bộ + `{type:"init", hasHistory:false}`.
- Panel lifecycle: dispose parity với newTableForm (onDidDispose, retainContextWhenHidden=false, enableScripts=true, CSP như aiSettingsForm). `error` message KHÔNG BAO GIỜ chứa apiKey (deps errors đã scrub ở provider — chỉ pass message).
- Webview `aiChatPanelMain.ts`: bubbles, input + Send/Stop/Clear, markdown render (same minimal renderer style as existing webviews — không CDN).
- `package.json`: command `vsdb.aiChat` title "VSDB: AI Chat".

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | send → runAgent gọi với tools registry thật, finalText post assistant+done | postMessages theo thứ tự step?/assistant/done |
| 2 | happy | ready → init message | `{type:"init"}` posted |
| 3 | edge (no connection) | adapterFactory resolve null → system prompt không crash, context rỗng | runAgent vẫn gọi; không throw |
| 4 | edge (stop) | send rồi stop trước khi promise settle | token.aborted; assistant final KHÔNG post; done posted |
| 5 | edge (error) | runAgent reject | error bubble với message, done posted, panel còn sống |
| 6 | lifecycle | show 2 lần → reveal panel cũ, không tạo panel mới | createWebviewPanel gọi 1 lần |
| 7 | bundle | webview/aiChatPanelMain.ts build có trong out/ | file tồn tại sau `npm run compile` |

## Test Files
`src/ui/__tests__/aiChatPanel.test.ts`, `src/ui/__tests__/aiChatPanelBundle.test.ts`

## Verification Commands
```
npm run compile && npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 7 test PASS RED→GREEN (output thật paste)
- [ ] Không sửa src/ai/* (chỉ consume); esbuild entry + package.json đúng
- [ ] CSP + dispose parity với aiSettingsForm; không apiKey vào webview
- [ ] Stop đúng token semantics (không AbortController)

## Interfaces
- Consumes: `runAgent({messages, tools}, deps, callbacks)` (frozen — tools trên AgentInput), `createDbTools`/`AdapterFactory` async (T1+src/ai/tools/types.ts), `createSqlTool`/`formatSchemaContext` (T2).
- Produces: `AiChatPanel`, `ChatAbortToken`, message contract trên (T4 wiring consume).
