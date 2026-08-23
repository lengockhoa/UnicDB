# TASK-001 — ACP client + safe protocol probe

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal
Add an injected ACP JSON-RPC/NDJSON client that routes server requests and writes correlated results, plus a gated no-prompt lifecycle/cwd probe. This is the proof-first gate for all later ACP envelopes.

## Target Files
- `src/ai/omp/acp.ts` (new) — injected client, server-request handler, and correlated result/error writer.
- `src/ai/omp/__tests__/acp.test.ts` (new) — pure request-routing coverage.
- `src/ai/omp/__tests__/acpLiveSmoke.test.ts` (new) — env-gated lifecycle/cwd evidence.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
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
(pending)

## Reviewer Verdict
(pending)
