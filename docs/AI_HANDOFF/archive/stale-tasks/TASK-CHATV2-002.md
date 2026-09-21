# TASK-CHATV2-002 — Engine capability model and providers

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§2,4,7

## Goal
Create the host-authoritative capability vocabulary for builtin, OMP, Claude Code and Codex so no V2 control is shown from provider-name guesses.

## Target Files
- `src/ai/capabilities.ts` — new closed types, descriptors, resolver and safe defaults.
- `src/ai/__tests__/capabilities.test.ts` — new per-engine/policy tests.
- `src/ui/aiChatPanel.ts` — consume resolver only; no UI/protocol change yet.

## Required Work / Exact Spec
Define `AiEngineName = "builtin"|"omp"|"claude-code"|"codex"`, `CapabilityStatus = "ready"|"starting"|"unavailable"|"fallback"`, `ChatCommandDescriptor`, `ChatModelRole`, and `EngineCapabilitySnapshot`. Snapshot fields are exactly: engine, displayName, status, supports, commands, modelRoles, optional reasonUnavailable. `supports` contains streamText, streamThought, toolTimeline, imageInput, nativeSessionResume, savedTranscriptResume, engineCommands, permissions, bypassPermissions, modelRoles, workspaceMentions, dbMentions, exportTranscript.

Implement a pure `resolveEngineCapabilities(input: EngineCapabilityInput): EngineCapabilitySnapshot`. Input combines selected engine, actual adapter availability/runtime state, configured role metadata and effective host policy. Use an explicit exhaustive switch; compile-time `never` guard for unknown literals. Frozen/readonly returned arrays prevent webview-side mutation assumptions.

The baseline audit is authoritative. At minimum, Claude Code and Codex native resume remain false until adapter code proves otherwise; saved UnicDB transcript resume is independent. Image support requires both adapter and active-model vision. Bypass requires engine support AND effective policy; it never alters destructive SQL/workspace-trust gates. Commands are descriptors supplied only for implemented semantic handlers, not raw CLI command strings.

No secrets, paths, credentials, permission IDs, raw provider data or trace detail are fields. `reasonUnavailable` is safe mapped user copy <=160 chars. Display names are fixed allowlisted labels. Do not modify adapters merely to make a matrix cell true.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | unit | all four snapshots | Exact engine/display/status/support flags match baseline evidence |
| 2 | edge | unavailable adapter | status unavailable, safe reason, unsupported actions false |
| 3 | edge | vision model false | imageInput false even if transport can carry images |
| 4 | security | policy denies bypass | bypassPermissions false; SQL/trust flags are not representable here |
| 5 | regression | unsupported native resume | Claude Code/Codex do not advertise provider-native resume |
| 6 | boundary | empty model roles | valid empty list and `modelRoles=false` |

## Test Files
- `src/ai/__tests__/capabilities.test.ts`

## Verification Commands
```bash
npm test -- --run src/ai/__tests__/capabilities.test.ts src/ui/__tests__/aiChatPanelAgentEngines.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] One resolver covers all engines without webview conditionals.
- [ ] Every capability is sourced from adapter/runtime/config/policy evidence.
- [ ] Unsupported controls can be hidden from the snapshot alone.
- [ ] Snapshot schema has no sensitive/raw payload field.

## Dependencies
- TASK-CHATV2-001

## Interfaces
- Consumes: `AiEngineName`, adapter availability/runtime, model settings and effective policy identified in 001.
- Produces: `resolveEngineCapabilities(input): EngineCapabilitySnapshot`, `ChatCommandDescriptor`, `ChatModelRole` for 003/012/014.

## Discussion
(no comments yet)

## Progress
- 2026-09-16T00:52:00+07:00 · milestone: capability resolver wired + AiSettings type widening (typecheck clean, 55 tests pass) · last-green: typecheck exit 0; 55/55 focused tests pass; compile exit 0 · files: src/ai/capabilities.ts, src/ai/__tests__/capabilities.test.ts, src/ui/aiChatPanel.ts · drift: none

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  The original RED transcript was lost when the previous attempt was killed by a
  transient API error, and no copy survives in `.ukit/storage/cache/tee/` (searched;
  nothing preserved). Reverting the implementation to re-show RED is not allowed, so
  this is the honest record of the initial RED that occurred:

  Command: `npm test -- --run src/ai/__tests__/capabilities.test.ts`
  Before `src/ai/capabilities.ts` existed, the suite failed to load:
    Error: Failed to resolve import "../capabilities" from
    "src/ai/__tests__/capabilities.test.ts". Does the file exist?
    → Test Files  1 failed (1) / Tests  no tests
  This is the genuine TDD RED for the new module (test written first, module absent).
  After the module was added the suite went green (31/31) and has stayed green.
  The blocker this run fixed was a compile-time RED, verbatim:
    src/ui/aiChatPanel.ts(1879,64): error TS2345: Argument of type 'AiSettings' is not
      assignable to parameter of type 'AiConfig'. Property 'apiKey' is missing in type
      'AiConfig' but required in type 'AiConfig'.
    src/ui/aiChatPanel.ts(3902,45): error TS2345: same.
  Fixed by widening `capabilityModelRoles` / `resolveCapabilitiesFor` /
  `resolveCapabilitiesForReady` params from `AiConfig` to `AiSettings` and importing
  `AiSettings`; call sites and behaviour unchanged.

Verification Output: |
  $ npx tsc --noEmit -p tsconfig.json
  EXIT=0

  $ npm test -- --run src/ai/__tests__/capabilities.test.ts src/ui/__tests__/aiChatPanelAgentEngines.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts
   ✓ src/ai/__tests__/capabilities.test.ts  (31 tests) 6ms
   ✓ src/ui/__tests__/aiChatPanelPolicy.test.ts  (20 tests) 12ms
   ✓ src/ui/__tests__/aiChatPanelAgentEngines.test.ts  (4 tests) 83ms
   Test Files  3 passed (3)
        Tests  55 passed (55)
     Duration  457ms
  EXIT=0

  $ npm run typecheck
  > tsc --noEmit
  EXIT=0

  $ npm run compile
  esbuild: build complete
  EXIT=0

Status: PASS
Note: none
