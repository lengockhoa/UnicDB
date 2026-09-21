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

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Tests written first in src/ui/__tests__/aiChatPanelMessagesV2.test.ts while both
  V2 modules were absent. Verbatim RED (module-not-found — the genuine TDD red for
  a specification-first protocol test):

    $ npx vitest run src/ui/__tests__/aiChatPanelMessagesV2.test.ts
     ❯ src/ui/__tests__/aiChatPanelMessagesV2.test.ts  (0 test)
    ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
     FAIL  src/ui/__tests__/aiChatPanelMessagesV2.test.ts
    Error: Failed to load url ../aiChatPanelV1Adapter (resolved id:
      ../aiChatPanelV1Adapter) in .../aiChatPanelMessagesV2.test.ts.
      Does the file exist?
     Test Files  1 failed (1)
          Tests  no tests

  A second, non-trivial RED was surfaced by the existing security pin
  src/ui/__tests__/aiChatPanelAttachments.test.ts #j, which greps the source of
  aiChatPanelMessages.ts and forbids the literal `apiKey` in code lines:

    FAIL src/ui/__tests__/aiChatPanelAttachments.test.ts > ... #j
    expect(stripped).not.toMatch(/apiKey/);
    AssertionError: expected '...' not to match /apiKey/

  Resolution: the forbidden-field scanner (spec §Security shape tests) is a
  TEST-side shape check, not a produced interface, so it was moved into
  aiChatPanelMessagesV2.test.ts rather than weakening the shipped-module pin.
  After the move the attachment suite is green (17/17).

Verification Output: |
  $ npm test -- --run src/ui/__tests__/aiChatPanelMessagesV2.test.ts \
        src/ui/__tests__/aiChatPanelMessages.test.ts \
        src/ui/__tests__/aiChatPanelMessagesClone.test.ts \
        src/ui/__tests__/aiChatPanelSessionState.test.ts
   ✓ src/ui/__tests__/aiChatPanelMessagesClone.test.ts  (8 tests)
   ✓ src/ui/__tests__/aiChatPanelMessages.test.ts  (20 tests)
   ✓ src/ui/__tests__/aiChatPanelMessagesV2.test.ts  (16 tests)
   ✓ src/ui/__tests__/aiChatPanelSessionState.test.ts  (3 tests)
  Test Files  4 passed (4)
       Tests  50 passed (50)
  EXIT=0

  $ npm run typecheck
  > tsc --noEmit
  EXIT=0

  $ npm run compile
  ⚡ Done in 147ms
  dist/extension.js  6.5mb
  esbuild: build complete
  EXIT=0

  Wider regression sweep (informational, outside the task's command list):
  $ npx vitest run
  Tests  4140 passed | 1 failed | 5 skipped
  The single failing test is src/__tests__/vsixSecretsExclusion.test.ts and the
  5 unloadable webview suites fail with ENOENT on
  .worktrees/task-chatv2-003/node_modules/.bin/{vsce,esbuild} — the worktree has
  no local node_modules/.bin (only the main repo does). These are pre-existing
  environment gaps, unrelated to this change; every aiChat/panel suite passes.

Status: PASS
Note: Two spec decisions recorded (Handoff mode, unattended — no user available):
  1. `translateV1HostMessage` returns null for a legacy kind with no V2 semantic
     form (e.g. V1 `engine_state`) rather than throwing — the task says unknown/
     malformed input must never be thrown into the extension host. `engine` →
     `capabilities` requires the resolved snapshot in the translation context;
     without one the frame is null (dropped) rather than fabricating a snapshot.
  2. V2 `sessionId` uses Math.random+Date for the panel-lifetime id; the panel's
     ordered POST path (`nextV2Envelope`) itself is pure with no clock/random,
     satisfying CTX-04 for the deterministic frame bytes (004's pure reducer
     consumes the envelope, not the id generator).
  Scope note: the panel router keeps V1 `handleMessage` as the fallback path —
  the task requires preserving host transport through one temporary V1→V2
  adapter until CHATV2-017. V2 capability/session_hydrated/phase/turn_started/
  mention_results frames are emitted on the new `postV2` seam; the full V2
  frame set is produced for 004–017 to consume.
