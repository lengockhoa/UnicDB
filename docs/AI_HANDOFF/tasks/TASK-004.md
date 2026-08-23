# TASK-004 — ACP permission coordinator + panel session wiring

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal
Wire the panel lifecycle so a prompt creates one ACP session, streams assistant message chunks, shows permission requests as plain text only, maps each server request to a single host-opaque ID, and resolves exactly one allowed or cancelled ACP result per request using only pending opaque IDs and listed option IDs. Default-deny every pending request on timeout, stop, disposal, replacement, and process exit; ignore late/duplicate responses. Fall back to builtin when ACP or process state fails. This task also performs legacy caller migration and removes `rpc.ts`/`process.ts` only after all imports/tests are migrated.

## Target Files
- `src/ui/aiChatPanel.ts` (existing) — ACP session lifecycle, plain-text permission UI, default-deny coordinator, legacy RPC cleanup, and fallback integration.
- `src/extension.ts` (existing) — remove Cycle L OMP RPC/process wiring once panel is migrated.
- `src/ui/__tests__/aiChatPanel.test.ts` (existing) — permission routing, plain-text safety, ordering, and default-deny coverage.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `session/update` assistant text posts delta only; permission request posts exactly one opaque pending request | host posts plain-text `permission_request` with opaque ID, tool, and options; `agent_thought_chunk` is ignored | fake panel + fake ACP |
| 2 | unit | Allow posts one ACP result for its matching opaque ID using only a listed option | only the matching pending request settles and host writes the selected option outcome | fake panel + fake ACP |
| 3 | unit | Deny posts one ACP cancelled result for its matching opaque ID | only the matching pending request settles with cancelled outcome | fake panel + fake ACP |
| 4 | edge | duplicate/disposed/out-of-scope/late webview response is ignored | host posts only one ACP result per server request | fake panel + fake ACP |
| 5 | edge | stop/dispose/exit/replacement/timeout settle every pending request | all outstanding requests get one cancelled ACP result and no late duplicate writes occur | fake panel + fake ACP |
| 6 | regression | builtin fallback path still posts final assistant + done; legacy RPC/process code removed | existing builtin behavior unchanged and Cycle L bridge is deleted after caller migration | fake vscode + agent mock |

## Test Files
- `src/ui/__tests__/aiChatPanel.test.ts`

## Verification Commands
```bash
npx vitest run src/ui/__tests__/aiChatPanel.test.ts && npm run compile && npm run typecheck
```
## Acceptance Criteria

- [ ] permission requests always resolve; no open request survives stop, dispose, timeout, or session replacement.
- [ ] duplicate/late/disposed responses are ignored; only the first response per server request writes an ACP result.
- [ ] default-deny is mandatory; no response retains existing deny.
- [ ] ACP path ignores `agent_thought_chunk`.
- [ ] Cycle L `rpc.ts`/`process.ts` and their callers are removed only after clean typecheck.

## Dependencies
- TASK-001
- TASK-002
- TASK-003

## Interfaces
- Consumes: `AcpClient` APIs and lifecycle/cwd evidence from TASK-001/TASK-002; permission message kinds from TASK-003.
- Produces: end-to-end ACP chat behavior inside `AiChatPanel` plus removal of Cycle L RPC/process callers.

## Discussion
(queued)

---
## Executor Report
(pending)

## Reviewer Verdict
(pending)
