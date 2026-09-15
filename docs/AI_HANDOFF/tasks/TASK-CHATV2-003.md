# TASK-CHATV2-003 — Versioned V2 host/webview protocol

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§2,4,6

## Goal
Introduce a typed, ordered V2 protocol with session/turn/request correlation while preserving the current host transport through one temporary compatibility adapter.

## Target Files
- `src/ui/aiChatPanelMessages.ts` — V2 envelopes, frame/intent unions and type guards.
- `src/ui/aiChatPanelV1Adapter.ts` — new temporary V1→V2 compatibility translation.
- `src/ui/aiChatPanel.ts` — monotonic sequence/post wrapper and V2 intent dispatch.
- `src/ui/__tests__/aiChatPanelMessagesV2.test.ts` — new protocol/order/security tests.
- `src/ui/__tests__/aiChatPanelMessages.test.ts` — update additive compatibility assertions.

## Required Work / Exact Spec
Use `protocolVersion: 2`, `sessionId: string`, `sequence: number`; turn frames also carry `turnId`. Never reuse a V1 discriminator with incompatible meaning. Define host frame kinds: capabilities, session_hydrated, turn_started, phase, text_delta, reasoning_delta, tool_started, tool_finished, permission_requested, warning, error, turn_finished, mention_results, context_status, models, schema, export_completed, export_failed, sessions, title_updated, toast.

Define webview intents: ready_v2, submit_turn, stop_turn, set_engine, set_model, search_context, resolve_context, remove_context, permission_response, set_permission_policy, list_sessions, resume_saved_session, create_session, rename_session, clear_session, export_session, pick_active_schema, open_settings. Each mutating intent carries `clientRequestId`; submit carries immutable draft text, structured context refs and validated minimal attachments.

Host sequence is monotonic per panel/session and begins at 1 after hydration. Reducer may reject wrong session or `sequence <= lastSequence`. Mention responses echo `requestId`, `draftRevision`, query and result items. Host never accepts client sequence as authority. Add runtime narrow guards for webview input; unknown/malformed intents are ignored or answered with safe error, never thrown into extension host.

Compatibility adapter translates current init/engine/session_state/delta/thought/step/tool_result/assistant/error/done/models/schema/grounding/permission/history frames during migration. It is one module, tagged for deletion in 017; no V1 translation logic may spread into components.

Security shape tests recursively reject field names/payloads matching apiKey, password, connectionString, rawStderr, rawTrace, base64, permissionToken. Error exposes safeMessage + diagnosticId, optional safeDetail only.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | unit | ordered turn frames | version/session/sequence/turn fields are mandatory and monotonic |
| 2 | edge | unknown/malformed intent | safe reject/ignore; host remains alive |
| 3 | race | stale/wrong-session frame | downstream reducer can deterministically ignore it |
| 4 | race | mention correlation | response echoes requestId + draftRevision exactly |
| 5 | security | forbidden fields | serialization fixtures contain none of the forbidden data |
| 6 | regression | V1 compatibility | each legacy frame maps once to semantic V2 form |

## Test Files
- `src/ui/__tests__/aiChatPanelMessagesV2.test.ts`
- `src/ui/__tests__/aiChatPanelMessages.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatPanelMessagesV2.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelMessagesClone.test.ts src/ui/__tests__/aiChatPanelSessionState.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Host/webview unions are exhaustive and correlation fields mandatory.
- [ ] Compatibility is isolated and scheduled for deletion.
- [ ] No raw provider/secret/base64 payload is representable in host frames.
- [ ] All existing engine events have one semantic V2 mapping.

## Dependencies
- TASK-CHATV2-002

## Interfaces
- Consumes: `EngineCapabilitySnapshot`, command/model/context descriptors from 002.
- Produces: `AiChatHostFrameV2`, `AiChatWebviewIntentV2`, `translateV1HostMessage`, ordered `postV2` seam for 004–017.

## Discussion
(no comments yet)
