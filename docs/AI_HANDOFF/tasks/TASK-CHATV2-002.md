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
