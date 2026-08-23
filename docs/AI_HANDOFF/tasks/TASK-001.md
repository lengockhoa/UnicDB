# TASK-001 — omp RPC client + process lifecycle (pure)

## Goal
JSONL RPC client theo giao thức THẬT của omp 18.x (đã probe live 2026-08-23, xem dưới) và OmpProcess wrapper — pure/injectable, test không cần omp thật.

## REAL protocol facts (live-probed, normative — không suy diễn)
- Server gửi trước: `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],...}`.
- Response envelope: `{"type":"response","command":"<cmd>","success":true|false,"error"?:string,"code"?:number,"data"?:...}` — **không có correlation id**; command name + FIFO order (one in-flight command tại một thời điểm) là cơ chế correlate. Client PHẢI serialize requests (queue 1-in-flight).
- Commands: `{"type":"prompt","message":"..."}`, `{"type":"abort"}`, `{"type":"set_host_tools","tools":[...]}`, `{"type":"steer",...}`.
- Events (frames không phải type=ready/response): `agent_start`, `message_start`, `message_update` (assistantMessageEvent.type: thinking_start/text_start… với partial), `message_end`, `agent_end` (messages: full history), `host_tool_call` (field `toolName`, KHÔNG phải name).

## Target Files
- `src/ai/omp/rpc.ts`, `src/ai/omp/process.ts`, `src/ai/omp/__tests__/rpc.test.ts`, `src/ai/omp/__tests__/process.test.ts`

## Spec (frozen)
```ts
// rpc.ts
export interface RpcTransport { write(line: string): void; onLine(cb: (line: string) => void): void; close(): void }
export class OmpRpcClient {
  constructor(transport: RpcTransport)
  request(cmd: { type: string } & Record<string, unknown>): Promise<Record<string, unknown>>
  // serialize 1-in-flight; resolve với response.data (hoặc {}) khi type=response && command===cmd.type && success; reject Error(error) khi success=false
  waitReady(timeoutMs?: number): Promise<Record<string, unknown>>  // resolve khi frame type=ready
  onEvent(cb: (ev: Record<string, unknown>) => void): void        // mọi frame không phải ready/response
  handleHostToolCall(handler: (call: { id: string; toolName: string; arguments: unknown }) => Promise<unknown>): void
  // frame type=host_tool_call → await handler → write {"type":"host_tool_result","id":<id>,"result":{"content":[{"type":"text","text":String(result)}]},"isError":false}
  // handler throw → isError:true với text = "Tool failed: <msg>"
  dispose(): void  // pending reject "disposed"; transport.close()
}
// process.ts
export interface OmpProcessOptions { ompPath?: string; cwd: string; extraArgs?: string[]; execFn?: (cmd: string) => Promise<string> }
export class OmpProcess {
  constructor(opts: OmpProcessOptions, spawnFn?: typeof import("child_process").spawn)
  async start(): Promise<{ rpc: OmpRpcClient; version: string }>  // spawn [ompPath||'omp','--mode','rpc','--approval-mode','yolo','--no-session','--cwd',cwd,...extra]; rpc.waitReady(); version qua execFn `${omp} --version` parse "omp/18.0.1"
  onExit(cb: (code: number | null) => void): void
  kill(): void
}
```
- Malformed line → bỏ qua. Response l到来 khi không có pending → ignore. Không import vscode; không spawn thật trong tests.

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | waitReady nhận ready frame | resolve với protocolVersion |
| 2 | happy | request prompt roundtrip: write frame đúng `{"type":"prompt","message":...}`; reply `{"type":"response","command":"prompt","success":true,"data":{}}` | resolve |
| 3 | edge (error) | response success=false error="boom" | reject Error("boom") |
| 4 | edge (serialize) | 2 request chồng nhau | frame thứ 2 chỉ write SAU response thứ 1 (1-in-flight) |
| 5 | edge (malformed) | dòng "garbage{" | ignore, request vẫn pending |
| 6 | edge (host tool) | host_tool_call {id, toolName, arguments} | handler nhận đúng shape; result frame `{"type":"host_tool_result","id":...,"result":{"content":[{"type":"text","text":...}]},"isError":false}` |
| 7 | edge (host tool throw) | handler reject | isError:true, text "Tool failed: ..." |
| 8 | unit | OmpProcess.start fake spawn | argv `--mode rpc --approval-mode yolo --no-session --cwd <cwd>`; version parse |
| 9 | edge (process) | child exit | onExit fired, rpc disposed |

## Test Files
`src/ai/omp/__tests__/rpc.test.ts`, `src/ai/omp/__tests__/process.test.ts`

## Verification Commands
```
npx vitest run src/ai/omp/__tests__/rpc.test.ts src/ai/omp/__tests__/process.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 9 test PASS RED→GREEN (output thật)
- [ ] Frame shapes khớp §REAL protocol facts từng ký tự
- [ ] 1-in-flight serialization có test (#4)
- [ ] Không import vscode; `npx tsc --noEmit` sạch

## Interfaces
- Consumes: `(none)`.
- Produces: `OmpRpcClient`, `RpcTransport`, `OmpProcess`, `OmpProcessOptions` (T2/T4 consume).
