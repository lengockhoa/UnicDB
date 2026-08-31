# TASK-AIX07-003 — Policy and audit command host integration

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX07.md` §3

## Goal

Apply the central policy to both AI Chat engine funnels and expose a narrow command-palette surface for showing effective policy, exporting a redacted trace, and clearing it. Ship the v1.28.0 manifest version without changing provider protocol or adding persistent retention.

## Target Files

- `src/ui/aiChatPanel.ts` — consume TASK-AIX07-001 policy at shared context/registry funnels on builtin and OMP/MCP paths; obtain policy admission before `resolveMentionsForTurn(...)` at lines 1469-1472 can introspect DB objects or read mention files; expose a copy-safe all-turn trace snapshot for the host while retaining `dumpTrace(turnId: string): unknown` and `clearTrace(): void`.
- `src/extension.ts` — derive effective policy from `vscode.workspace.isTrusted`, raw configured `vsdb.ai.engine` preference, and the existing `resolveEngine(...)` choice (whose valid `EngineChoice.engine` is the effective route); register `vsdb.ai.showPolicy`, `vsdb.ai.exportTrace`, and `vsdb.ai.clearTrace`; use save dialog plus `workspace.fs.writeFile` only after policy allows export.
- `package.json` — contribute the three `vsdb.ai.*` commands and set extension version to `1.28.0` without changing the `^1.75.0` VS Code engine floor.
- `src/ui/__tests__/aiChatPanelPolicy.test.ts` (new) — mocked-host TDD coverage that denied policy omits sensitive context and sensitive registrations in builtin and OMP/MCP setup, gates mention expansion before DB/file reads, and byte-scans captured webview/outbound observability for secret-shaped strings.
- `src/extension.test.ts` — command registration and trusted/untrusted export/clear/policy command wiring tests using its existing VS Code mock harness.
- `src/__tests__/extensionConfigExport.test.ts` — retain or strengthen the existing no-API-key export/config regression lock while manifest/command integration changes.
- `src/ai/__tests__/config.test.ts` — retain or strengthen stored-settings legacy/secret-storage regression coverage used by route-policy integration.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `trusted valid resolver route registers commands, reports policy, exports and clears trace` | All three commands register; show-policy reports the `EngineChoice.engine` provider/context/tool/export state; selected URI receives UTF-8 redacted envelope; clear calls panel trace clear. | Trusted mock workspace, valid configured `builtin` preference with resolver `{ engine: "omp", requiresConfig: false }`, active panel with two dumps, selected `Uri` fixture. |
| 2 | edge — resolver/default builtin | `valid configured builtin plus resolveEngine-selected OMP remains policy-admitted` | The host supplies the resolver's `omp` route to policy and sensitive capability admission remains enabled; no conflict notice/export denial occurs solely because configured preference is `builtin`. | Trusted workspace, `ai.engine` reads `builtin`, and real-shape `EngineChoice` has `engine: "omp"`. |
| 3 | edge — permission/order of operations | `denied policy gates mention expansion before DB or file content is read` | On both engine modes, policy denial occurs before `resolveMentionsForTurn(...)`: adapter factory/introspection and workspace-file-read spies have zero calls, no resolved mention block is included in captured outbound messages, and generic chat still completes. | Untrusted/denied policy, prompt with object and file mention tokens, adapter and `readFile` spies seeded with credential sentinels. |
| 4 | edge — wire privacy | `captured panel wire and observability surfaces contain no secret-shaped strings` | Aggregate every captured webview frame plus outbound builtin/OMP request or event-observability string, including denial/mention cases with distinct sentinel fixtures; it contains none of the sentinel values and does not match `/api[_-]?key|secret|password|token|authorization|cookie|bearer|basic/i`. | Panel mock harness for builtin and OMP/MCP routes, messages/events seeded with API-key, password, token, and authorization/cookie sentinels. |
| 5 | edge — invalid/migration | `invalid configured value or invalid resolver denies export before side effects` | Notice is shown and neither `showSaveDialog` nor `workspace.fs.writeFile` is called. | Trusted workspace with raw legacy engine setting; then an absent/invalid resolver choice. |
| 6 | edge — lifecycle | `export or clear without an active AI panel is a safe no-op` | A concrete VSDB notice is shown; no save/write happens and no exception escapes. | Extension activated without opening AI Chat. |
| 7 | regression | `configuration exports and stored AI settings remain secret-safe` | Existing sentinel API key remains absent from YAML/command output and `AiConfigStore` legacy/missing-engine plus SecretStorage tests stay green. | Existing `extensionConfigExport.test.ts` and `config.test.ts` fixtures. |

Write the focused integration tests first and record actual RED output before implementation. Implement only after TASK-AIX07-001 and TASK-AIX07-002 are GREEN; then re-run the complete command block.

## Test Files

- `src/ui/__tests__/aiChatPanelPolicy.test.ts` (new) — policy admission parity tests for builtin and OMP/MCP.
- `src/extension.test.ts` — modified command registration, picker/write, and no-panel command cases.
- `src/__tests__/extensionConfigExport.test.ts` — modified or reconfirmed privacy regression coverage.
- `src/ai/__tests__/config.test.ts` — modified or reconfirmed stored-settings migration/privacy regression coverage.

## Verification Commands

```bash
npm test -- src/extension.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts src/__tests__/extensionConfigExport.test.ts src/ai/__tests__/config.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`. At Wave 2 completion, also run the mandatory regression net:

```bash
npm test
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] The host derives one effective policy from the real `vscode.workspace.isTrusted`, raw configured `ai.engine` preference, and existing `resolveEngine(...)` result; a valid `EngineChoice.engine` supplies the effective route, so valid configured `builtin` plus resolver-selected OMP remains admitted; panel funnels consume it rather than duplicating per-tool filtering.
- [ ] Trusted valid resolver configuration exposes a user-invokable `vsdb.ai.showPolicy` summary and permits export/clear against the active panel trace only.
- [ ] Untrusted, unknown/migrated configured state, or absent/invalid resolver state supplies no sensitive context/tools and denies export before a picker or filesystem write.
- [ ] Policy admission gates mention expansion before `resolveMentionsForTurn(...)` can call adapter introspection or workspace-file reads; denied mention context cannot reach an outbound message.
- [ ] Aggregated captured webview frames and outbound builtin/OMP observability surfaces contain neither supplied credential sentinels nor `apiKey`, `api_key`, `secret`, `password`, token, `Authorization`, `Cookie`, bearer, or basic secret-shaped strings.
- [ ] Export uses user-selected VS Code URI plus `vscode.workspace.fs.writeFile`, writes only TASK-AIX07-002's final-redacted envelope, and does not persist trace elsewhere.
- [ ] Clear calls `AiChatPanel.clearTrace(): void`; no active panel is handled safely with a concrete notice.
- [ ] `package.json` contributes all three command IDs and has version `1.28.0`; `engines.vscode` remains `^1.75.0`.
- [ ] Focused tests plus the Wave-2 `npm test`, `npm run typecheck`, and `npm run compile` regression net pass.
- [ ] Executor report declares `EXECUTOR_MODEL: unic-code`; reviewer is `unic-smart`.

## Dependencies

- TASK-AIX07-001
- TASK-AIX07-002

## Interfaces

- Consumes: TASK-AIX07-001 `resolvePolicy(input): EffectivePolicy`; TASK-AIX07-002 `TraceRecorder.dumpAll(): readonly TraceDump[]` and its pure audit serializer; current `resolveEngine(input: { detection: OmpDetection; config: unknown | null }): EngineChoice` where `EngineChoice.engine` is the effective route (independent of the valid raw configured preference); current `AiChatPanel.dumpTrace(turnId: string): unknown`; current `AiChatPanel.clearTrace(): void`.
- Produces: contributed/registered commands `vsdb.ai.showPolicy`, `vsdb.ai.exportTrace`, and `vsdb.ai.clearTrace`; policy-gated context/tool registration and pre-read mention-expansion admission on both panel engine paths; a host-readable all-turn trace snapshot used only by the export command.

---

## Discussion

### 2026-08-31 · planner · unic-smart
Do not alter `src/ai/provider.ts`, existing provider request headers, or `resolveEngine()` fallback behavior. Policy must derive effective provider from valid `EngineChoice.engine`, not require equality with the valid configured preference: resolver-selected OMP remains admitted when configuration is the default `builtin`. Invalid/migrated configuration and absent/invalid resolver choices deny sensitive admission and export; generic chat retains established fallback behavior with its governance notice.

---
