# TASK-001 — AcpClient sessionList/sessionLoad + replay buffering

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.A

## Goal

Add 2 typed methods to a pure `AcpClient`: `sessionList()` (list persisted sessions) and `sessionLoad(sessionId, cwd)` (load a session + buffer the ordered replay notifications in the load window, NOT letting them fall into already-registered handlers).

## Target Files

- `src/ai/omp/acp.ts` — add `AcpSessionListItem`, `AcpReplayNotification`, `AcpSessionLoadResult`, the methods `sessionList()`, `sessionLoad()` + replay buffering inside `dispatchNotification`. Do NOT change any existing API/behavior.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit (happy) | `sessionList` sends the right frame + normalizes entries | outgoing frame `{jsonrpc,id,method:"session/list",params:{}}`; resolves an entry array with `title:"Fix schema"`, `messageCount:12` from `_meta` | fake transport: responds `{sessions:[{sessionId:"s1",cwd:"/w",title:"Fix schema",updatedAt:"2026-08-24T01:02:03Z",_meta:{messageCount:12,size:100}}]}` |
| 2 | unit (edge-junk) | title `"<function>"` / missing / non-string → `null`; missing `_meta` → 0 | entry has `title:null`, `messageCount:0`, `size:0`; entry with a non-string `sessionId` is dropped from the array (does not throw) | sessions: `[{sessionId:1,...}]` (drop), `[{sessionId:"s2",cwd:"/w",title:"<function>",updatedAt:"..."}]` (title null), `[{sessionId:"s3",cwd:"/w",updatedAt:"..."}]` |
| 3 | unit (edge-order) | replay notifications arriving BEFORE the result line (same stdout flush) still sit in the correct order inside `replay` | `replay.notifications` = 3 notifications in exactly the order they were fed; the handler registered via `onNotification` is NOT called for any notification in the window | feed: `session/update` n1 → n2 → result of session/load |
| 4 | unit (edge-multiflush, RED) | replay across MULTIPLE flushes: a frame arriving AFTER the result + AFTER 1 drain tick is still absorbed, does NOT leak | after settle, feed n2 then `await setTimeout(0)` (drain tick) then n3: both n2, n3 are appended to `replay.notifications` (in correct order), `replay.closed === false`, the handler is NOT called even once (not even for n3) — this test MUST be RED with the old semantics of "result + drain tick closes the window" | load settles with replay=[n1] |
| 5 | unit (edge-windowclose) | the window closes at the right moment: the next request/notify absorbs + closes the buffer before writing its frame | call `client.request("session/prompt", {...})` (or `notify`): the buffer is absorbed BEFORE the new frame writes out (`replay.closed === true`); then feed a regular `session/update` → the registered handler is called exactly once with the correct `{method, params}` | load settles, buffer still open |
| 6 | unit (edge-error) | `session/load` server error (sessionId does not exist) | rejects with a message containing `ACP session not found` and property `code === -32603` (preserves the raw code); the handler is not called | fake transport responds `{error:{code:-32603,message:"ACP session not found: sX"}}` |
| 7 | unit (edge-concurrent) | calling `sessionLoad` a second time while the first has not settled | the 2nd call rejects with `Error("session load already in progress")` immediately (sync, writes no new frame); the 1st call continues normally | do not respond to call 1; call call 2 |
| 8 | unit (regression) | notifications outside the load window still reach the handler as before | after the window closes (next request has already written), feed a regular `session/update` → the registered handler is called once with the correct `{method, params}`; every existing test in `acp.test.ts` still passes untouched | the full existing suite is not edited |

Fixture note: replay envelope from evidence — `params: { sessionId, update: { sessionUpdate, delta | content } }`; the test only needs method `"session/update"` of any kind, content does not matter at the client layer (client does not parse semantics). **Replay window (review F1, frozen in PLAN §3.A):** opens when `sessionLoad` writes its request frame, CLOSES when the next request/notify writes its frame (write absorbs the pending buffer FIRST, then writes its own frame) — NOT closing on "result settle + drain tick" (replay of 157 notifications / 14.9 MB spans many stdout flushes; closing early → late frames leak into the live handler → stray `delta` bubbles at `aiChatPanel.ts:512-518`). The Promise settles as soon as the result arrives; `replay` is a LIVE buffer that keeps growing until closed; the buffer only absorbs `session/update` notifications whose `params.sessionId` matches the load's sessionId; other frames / frames after close → handler as normal.

## Test Files

- `src/ai/omp/__tests__/acp.test.ts` — append the 8 cases above to the existing suite (same FakeAcpTransport pattern).

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/omp/__tests__/acp.test.ts
```

(`package.json` has no lint script — N/A.)

## Acceptance Criteria

- [ ] Every test in §Test Cases PASSES (RED before — paste output into the Executor Report).
- [ ] No existing `AcpClient` method/API changes behavior (the existing suite passes untouched).
- [ ] The file does NOT import vscode, does NOT spawn (pure/injectable stays).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — only uses the existing `AcpTransport`, `request()`, `dispatchNotification`).
- Produces (consumed by TASK-002/TASK-003 — EXACT signature):
  ```ts
  export interface AcpSessionListItem {
    sessionId: string;
    cwd: string;
    title: string | null;   // null when missing / non-string / === "<function>"
    updatedAt: string;      // non-string → ""
    messageCount: number;   // from _meta, default 0
    size: number;           // from _meta, default 0
  }
  export interface AcpReplayNotification { method: string; params: unknown }
  export interface AcpReplayBuffer {
    // in receive order; keeps growing until the window closes
    readonly notifications: readonly AcpReplayNotification[];
    readonly closed: boolean; // true after the next request/notify flush + close
  }
  export interface AcpSessionLoadResult {
    configOptions: unknown;
    modes: unknown;
    replay: AcpReplayBuffer; // LIVE object — settle carries whatever has already arrived
  }
  class AcpClient {
    sessionList(): Promise<AcpSessionListItem[]>;
    sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult>;
  }
  ```
  **Replay window semantics (frozen — review F1, PLAN §3.A):** the window opens when `sessionLoad` writes its request frame; the promise settles when the load RESULT arrives (the buffer may still grow — replay across many flushes is normal, probe showed 157 notifications / 14.9 MB). The window CLOSES when the next request/notify is sent: the write absorbs the pending buffer (marks `closed`) FIRST then writes its own frame — after that, `session/update` for the matching sessionId goes straight to the handler as a live turn. The buffer only absorbs `session/update` notifications with `params.sessionId === load sessionId`. NO drain-tick close.
  Wire envelopes (evidence-frozen): list `params: {}`; load `params: { sessionId, cwd, mcpServers: [] }`.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecO-T001
SUMMARY: Added `sessionList()` + `sessionLoad()` + LIVE replay buffer to `AcpClient`. Window opens on the `session/load` request write, absorbs `session/update` notifications for the matching sessionId (across any number of NDJSON flushes), closes on the next outgoing `request()`/`notify()` write (absorb-then-flush).
TEST_PLAN_FOLLOWED: TASK §4 (8 cases, all in `src/ai/omp/__tests__/acp.test.ts`)
FILES_CHANGED:
  - src/ai/omp/acp.ts: added AcpSessionListItem/AcpReplayNotification/AcpReplayBuffer/AcpSessionLoadResult; added `replayState` and `loadInFlight` fields; refactored `request()` to close window pre-write via `requestRaw()` helper; `sessionList()` (normalize + drop) and `sessionLoad()` (open window + buffer + concurrent guard); `dispatchNotification()` absorbs matching session/update.
  - src/ai/omp/__tests__/acp.test.ts: appended 8 new tests covering cases #1..#8 verbatim; case #3 feeds n1,n2,n3 as pinned by reviewer.
TESTS_ADDED:
  - src/ai/omp/__tests__/acp.test.ts: sessionList sends session/list frame and normalizes entries from _meta
  - src/ai/omp/__tests__/acp.test.ts: sessionList drops entries with non-string sessionId and normalizes junk title
  - src/ai/omp/__tests__/acp.test.ts: sessionLoad buffers replay notifications arriving in the same flush as the result
  - src/ai/omp/__tests__/acp.test.ts: sessionLoad keeps absorbing session/update across multiple flushes (no drain-tick close)
  - src/ai/omp/__tests__/acp.test.ts: sessionLoad window closes when next outgoing request writes its frame
  - src/ai/omp/__tests__/acp.test.ts: sessionLoad window closes when next outgoing notify writes its frame
  - src/ai/omp/__tests__/acp.test.ts: sessionLoad rejects with code -32603 and message when server returns session-not-found
  - src/ai/omp/__tests__/acp.test.ts: concurrent sessionLoad rejects synchronously and writes no extra frame
VERIFICATION:
  command: npm run typecheck && npx vitest run src/ai/omp/__tests__/acp.test.ts
  result: 14 pass / 0 fail / exit 0
  output_excerpt: |
    > vsdb@1.5.1 typecheck
    > tsc --noEmit
    ===
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
     ✓ src/ai/omp/__tests__/acp.test.ts  (14 tests) 4ms
     Test Files  1 passed (1)
          Tests  14 passed (14)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

RED evidence (pre-implementation, same command):
```
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionList sends session/list frame and normalizes entries from _meta
TypeError: client.sessionList is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionList drops entries with non-string sessionId and normalizes junk title
TypeError: client.sessionList is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionLoad buffers replay notifications arriving in the same flush as the result
TypeError: client.sessionLoad is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionLoad keeps absorbing session/update across multiple flushes (no drain-tick close)
TypeError: client.sessionLoad is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionLoad window closes when next outgoing request writes its frame
TypeError: client.sessionLoad is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionLoad window closes when next outgoing notify writes its frame
TypeError: client.sessionLoad is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > sessionLoad rejects with code -32603 and message when server returns session-not-found
TypeError: client.sessionLoad is not a function
 FAIL  src/ai/omp/__tests__/acp.test.ts > AcpClient > concurrent sessionLoad rejects synchronously and writes no extra frame
TypeError: client.sessionLoad is not a function
 Test Files  1 failed (1)
      Tests  8 failed | 6 passed (14)
```

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecO-T001
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/omp/__tests__/acp.test.ts
  result: 14 pass / 0 fail / exit 0
TEST_PLAN_COVERAGE: all-followed — 8/8 cases (#1..#8) present and real; case #3 fixture feeds n1,n2,n3 per pinned note; no lint script exists (scripts: compile,watch,test,test:integration,typecheck,package,vscode:prepublish) — N/A justified
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/omp/acp.ts:104-109 — redundant reject wrapper in requestRaw: `reject: (err) => reject(err)` is the identity; could pass `reject` directly. Style only.
    - src/ai/omp/acp.ts:226-243 — on sessionLoad rejection the replay window stays open until the next outgoing request/notify (per frozen spec, which only defines close-on-next-write). Unreachable in practice (failed load → server sends no session/update for that sessionId) but TASK-003 consumer should be aware.
NOTES: Envelopes match research doc exactly (list `params:{}`, load `params:{sessionId,cwd,mcpServers:[]}`); window semantics implemented as frozen (open on load write, absorb matching session/update across any flush count, close absorb-then-flush on next request/notify, no drain-tick); existing 6 tests pass unmodified; RED output verbatim (8 failed TypeError, methods absent).
NEXT_STATUS_FOR_INDEX: approved_minor
