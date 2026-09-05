# TASK-001 — ACP client + safe protocol probe

- Status: `ready`
- Owner: `-`
- Reviewer: `unic/unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal
Add an injected ACP JSON-RPC/NDJSON client that routes server requests and writes correlated results, plus a gated no-prompt lifecycle/cwd probe. This is the proof-first gate for all later ACP envelopes.

## Target Files
- `src/ai/omp/acp.ts` (new) — injected client, server-request handler, and correlated result/error writer.
- `src/ai/omp/__tests__/acp.test.ts` (new) — pure request-routing coverage.
- `src/ai/omp/__tests__/acpLiveSmoke.test.ts` (new) — env-gated lifecycle/cwd evidence.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | client request writes JSON-RPC and resolves matching response | fake transport sees numbered request and matching result resolves it | FakeAcpTransport |
| 2 | edge | malformed/unknown JSON-RPC frame is ignored | no client request or server handler settles | invalid line + unrelated frame |
| 3 | edge | two incoming `session/request_permission` calls are correlated | handler receives each server ID; `respond` writes exact corresponding JSON-RPC result ID | two server request frames |
| 4 | edge | handler error writes correlated JSON-RPC error | `respondError` uses the original server request ID once | handler rejects |
| 5 | gated | live no-prompt lifecycle/cwd proof | probe captures initialize capabilities, sends/observes initialized exchange, creates minimal session and records returned ID; child spawn `cwd` works and `--cwd` acceptance is recorded | real `omp acp` or skip |

## Test Files
- `src/ai/omp/__tests__/acp.test.ts`
- `src/ai/omp/__tests__/acpLiveSmoke.test.ts`

## Verification Commands
```bash
npx vitest run src/ai/omp/__tests__/acp.test.ts && npm run typecheck
```

## Acceptance Criteria
- [ ] client routes server requests separately from notifications and writes one correlated JSON-RPC result/error.
- [ ] timeout/cancellation ownership is absent from the client and reserved for TASK-004 panel state.
- [ ] probe records capabilities, initialized exchange, minimal newSession/session ID, child cwd, and explicit `--cwd` support without prompting/model/tool use.
- [ ] reviewer verdict APPROVED.

## Dependencies
- (none)

## Interfaces
- Consumes: ACP facts from `docs/AI_HANDOFF/queue/ACP-APPROVAL-research.md`.
- Produces: `AcpClient` request/notification/server-request APIs and recorded lifecycle/cwd proof for TASK-002/TASK-004.

## Discussion
(queued)

---
## Executor Report
- Status: DONE
- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic/unic-code
- EXECUTOR_SUBAGENT: ExecM-T001
- SUMMARY: Injected JSON-RPC 2.0 NDJSON ACP client with separate notification vs server-request dispatch, exact respond/respondError keyed by original server id, no timeout/cancellation. Live-probed omp 18.0.1 — confirmed `session/new` (not `session/create`) and `--cwd` acceptance without any prompt/model/tool use.
- TEST_PLAN_FOLLOWED: task §Test Cases #1..#5
- FILES_CHANGED:
  - src/ai/omp/acp.ts (new): AcpClient + AcpTransport + AcpServerRequest/AcpNotification contracts; client-id correlation Map, dispatchNotification/ServerRequest/Response; dispose rejects pending and clears listeners.
  - src/ai/omp/__tests__/acp.test.ts (new): 6 unit tests over FakeAcpTransport covering #1..#4 plus notification/notify edges.
  - src/ai/omp/__tests__/acpLiveSmoke.test.ts (new): env-gated (`UnicDB_OMP_SMOKE=1`) lifecycle/cwd probe against real `omp acp`; spawn child via `child_process.spawn`, no prompt/model/tool use.
- TESTS_ADDED:
  - src/ai/omp/__tests__/acp.test.ts:
    - "client request writes JSON-RPC request and resolves matching response"
    - "ignores malformed lines; pending client request stays pending"
    - "two incoming server requests each dispatch to handler with their own id"
    - "handler reject writes correlated JSON-RPC error keyed by original server id"
    - "server notification (no id) routes to onNotification, not to onServerRequest"
    - "client.notify writes JSON-RPC notification without id"
  - src/ai/omp/__tests__/acpLiveSmoke.test.ts:
    - "initialize, initialized, session/new produce real IDs; --cwd is accepted"
    - "--cwd flag is accepted by omp acp"
- VERIFICATION:
  command: `npx vitest run src/ai/omp/__tests__/acp.test.ts && npm run typecheck`
  result: 6 tests pass / 0 fail; typecheck exits 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB
     ✓ src/ai/omp/__tests__/acp.test.ts  (6 tests) 3ms
     Test Files  1 passed (1)
          Tests  6 passed (6)
    > UnicDB@1.5.1 typecheck
    > tsc --noEmit
  command (gated): `UnicDB_OMP_SMOKE=1 npx vitest run src/ai/omp/__tests__/acpLiveSmoke.test.ts`
  result (gated): 2 tests pass / 0 fail
  output_excerpt: |
    [acp-smoke] init protocolVersion= 1
    [acp-smoke] agentInfo= { name: 'oh-my-pi', title: 'Oh My Pi', version: '18.0.1' }
    [acp-smoke] sessionId= 01a02f96-beda-7564-b313-2d0e5e515a22
     ✓ src/ai/omp/__tests__/acpLiveSmoke.test.ts  (2 tests) 857ms
- ISSUES: none.
- HANDOFF_TO_REVIEWER: yes — task §Test Cases #1..#5 verified; all owned files committed as RED-then-GREEN with one full pass; live probe completed against the installed `omp 18.0.1`.
- NEXT: TASK-002 may consume AcpClient; TASK-003 and TASK-004 still gated on T002.
- RED OUTPUT (verbatim, captured before implementation):
    ❯ src/ai/omp/__tests__/acp.test.ts  (0 test)
    Failed Suites 1
    FAIL  src/ai/omp/__tests__/acp.test.ts
    Error: Failed to load url ../acp (resolved id: ../acp) in src/ai/omp/__tests__/acp.test.ts. Does the file exist?
- LIVE-PROBE EVIDENCE (2026-08-24 against installed omp 18.0.1):
  - initialize response (captured 2026-08-24): `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"oh-my-pi","title":"Oh My Pi","version":"18.0.1"},"authMethods":[{"id":"agent","name":"Use existing local credentials","description":"Authenticate via the provider keys/OAuth state already configured under ~/.omp."}],"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"list":{},"fork":{},"resume":{},"close":{}}}}}`
  - session/new response (captured 2026-08-24): `{"jsonrpc":"2.0","id":2,"result":{"sessionId":"01a02f95-1950-7252-a5a5-279b187eba31","configOptions":[{"id":"mode","name":"Mode",...}]}}`
  - Negative controls (`session/create`, `session/start`, `session/create_session`, `session/openSession`) returned `Unknown ACP ext method`. `session/new` is the canonical session-creation method; `session/load` requires `path` (matches existing schema).
  - Server-originated `session/update` notification stream (no id) observed during/after `session/new`; AcpClient dispatches these via onNotification, never through onServerRequest.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ai/omp/__tests__/acp.test.ts && npm run typecheck
  result: 6 pass / 0 fail; typecheck exit 0
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Env-gated live smoke (UnicDB_OMP_SMOKE=1) not re-run by reviewer; assertions inspected and the executor's captured sessionId (real UUID, omp 18.0.1) corroborates session/new. No prompt/model/tool use in the probe.

