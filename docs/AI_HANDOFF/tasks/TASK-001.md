# TASK-001 — AcpClient sessionList/sessionLoad + replay buffering

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.A

## Goal

Thêm 2 typed method lên `AcpClient` thuần: `sessionList()` (list persisted sessions) và
`sessionLoad(sessionId, cwd)` (load một session + buffer có thứ tự các replay notifications
trong cửa sổ load, KHÔNG để chúng rơi vào handler đã đăng ký).

## Target Files

- `src/ai/omp/acp.ts` — thêm `AcpSessionListItem`, `AcpReplayNotification`,
  `AcpSessionLoadResult`, method `sessionList()`, `sessionLoad()` + replay buffering trong
  `dispatchNotification`. Không đổi bất kỳ API/behavior hiện có nào.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `sessionList` gửi frame đúng + normalize entries | outgoing frame `{jsonrpc,id,method:"session/list",params:{}}`; resolve mảng entry với `title:"Fix schema"`, `messageCount:12` từ `_meta` | fake transport: respond `{sessions:[{sessionId:"s1",cwd:"/w",title:"Fix schema",updatedAt:"2026-08-24T01:02:03Z",_meta:{messageCount:12,size:100}}]}` |
| 2 | unit (edge-junk) | title `"<function>"` / thiếu / non-string → `null`; `_meta` thiếu → 0 | entry có `title:null`, `messageCount:0`, `size:0`; entry với `sessionId` non-string bị drop khỏi mảng (không throw) | sessions: `[{sessionId:1,...}]` (drop), `[{sessionId:"s2",cwd:"/w",title:"<function>",updatedAt:"..."}]` (title null), `[{sessionId:"s3",cwd:"/w",updatedAt:"..."}]` |
| 3 | unit (edge-order) | replay notifications đến TRƯỚC dòng result (cùng flush stdout) vẫn nằm đúng thứ tự trong `replay` | `replay.notifications` = 3 notifications theo đúng thứ tự feed; handler đăng ký qua `onNotification` KHÔNG được gọi cho notification nào trong cửa sổ | feed: `session/update` n1 → n2 → result của session/load |
| 4 | unit (edge-multiflush, RED) | replay NHIỀU flush: frame đến SAU result + SAU 1 drain tick vẫn bị hấp thụ, KHÔNG leak | sau settle, feed tiếp n2 rồi `await setTimeout(0)` (drain tick) rồi n3: cả n2, n3 append vào `replay.notifications` (đúng thứ tự), `replay.closed === false`, handler KHÔNG được gọi lần nào (kể cả cho n3) — test này PHẢI RED với semantics cũ "result + drain tick đóng cửa sổ" | load settle với replay=[n1] |
| 5 | unit (edge-windowclose) | cửa sổ đóng đúng lúc: request/notify đi tiếp theo flush + close buffer | gọi `client.request("session/prompt", {...})` (hoặc `notify`): buffer được hấp thụ TRƯỚC khi frame mới ghi ra (`replay.closed === true`); sau đó feed `session/update` thường → registered handler được gọi 1 lần đúng `{method, params}` | load settle, buffer còn mở |
| 6 | unit (edge-error) | `session/load` lỗi server (sessionId không tồn tại) | reject với message chứa `ACP session not found` và property `code === -32603` (giữ code thô); handler không được gọi | fake transport respond `{error:{code:-32603,message:"ACP session not found: sX"}}` |
| 7 | unit (edge-concurrent) | gọi `sessionLoad` lần 2 khi lần 1 chưa settle | lời gọi thứ 2 reject `Error("session load already in progress")` ngay (sync, không viết frame mới); lần 1 tiếp tục bình thường | không respond lời 1; gọi lời 2 |
| 8 | unit (regression) | notification ngoài cửa sổ load vẫn tới handler như cũ | sau khi cửa sổ đóng (request kế tiếp đã ghi), feed `session/update` thường → registered handler được gọi 1 lần với đúng `{method, params}`; mọi test hiện có trong `acp.test.ts` vẫn pass nguyên | toàn bộ suite cũ không sửa |

Lưu ý fixture: envelope replay từ evidence — `params: { sessionId, update: { sessionUpdate,
delta | content } }`; test chỉ cần method `"session/update"` bất kỳ, nội dung không quan
trọng cho tầng client (client không parse semantic). **Cửa sổ replay (review F1, frozen
ở PLAN §3.A):** mở khi `sessionLoad` ghi frame request, ĐÓNG khi request/notify đi kế tiếp
ghi frame (write absorbs pending buffer TRƯỚC, rồi mới ghi frame của nó) — KHÔNG đóng
theo "result settle + drain tick" (replay 157 notifications / 14.9 MB trải nhiều stdout
flush; đóng sớm → late frames leak vào handler live → stray `delta` bubbles ở
`aiChatPanel.ts:512-518`). Promise settle ngay khi result về, `replay` là buffer LIVE
tiếp tục lớn lên cho đến khi đóng; buffer chỉ hấp thụ `session/update` có `params.sessionId`
trùng sessionId của load, frame khác / sau khi đóng → handler như bình thường.

## Test Files

- `src/ai/omp/__tests__/acp.test.ts` — append 8 cases trên vào suite hiện có (cùng
  FakeAcpTransport pattern).

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/omp/__tests__/acp.test.ts
```

(`package.json` không có lint script — N/A.)

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước — paste output vào Executor Report).
- [ ] Không method/API hiện có của `AcpClient` đổi hành vi (suite cũ pass nguyên vẹn).
- [ ] File không import vscode, không spawn (pure/injectable giữ nguyên).
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — chỉ dùng `AcpTransport`, `request()`, `dispatchNotification` sẵn có).
- Produces (TASK-002/TASK-003 tiêu thụ — chữ ký CHÍNH XÁC):
  ```ts
  export interface AcpSessionListItem {
    sessionId: string;
    cwd: string;
    title: string | null;   // null khi thiếu / non-string / === "<function>"
    updatedAt: string;      // non-string → ""
    messageCount: number;   // từ _meta, default 0
    size: number;           // từ _meta, default 0
  }
  export interface AcpReplayNotification { method: string; params: unknown }
  export interface AcpReplayBuffer {
    // đúng thứ tự nhận được; TIẾP TỤC lớn lên cho đến khi cửa sổ đóng
    readonly notifications: readonly AcpReplayNotification[];
    readonly closed: boolean; // true sau khi request/notify kế flush + close
  }
  export interface AcpSessionLoadResult {
    configOptions: unknown;
    modes: unknown;
    replay: AcpReplayBuffer; // object LIVE — settle mang theo những gì đã đến
  }
  class AcpClient {
    sessionList(): Promise<AcpSessionListItem[]>;
    sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult>;
  }
  ```
  **Semantics cửa sổ replay (frozen — review F1, PLAN §3.A):** cửa sổ mở khi
  `sessionLoad` ghi frame request; promise settle khi load RESULT về (buffer có thể còn
  lớn lên — replay nhiều flush là bình thường, probe 157 notifications / 14.9 MB). Cửa sổ
  ĐÓNG khi request/notify đi kế tiếp: write absorbs buffer đang treo (đánh dấu
  `closed`) TRƯỚC rồi mới ghi frame của nó — sau đó `session/update` trùng sessionId đi
  thẳng handler như live turn. Buffer chỉ hấp thụ `session/update` với
  `params.sessionId === load sessionId`. KHÔNG có drain-tick close.
  Wire envelopes (evidence-frozen): list `params: {}`; load
  `params: { sessionId, cwd, mcpServers: [] }`.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
