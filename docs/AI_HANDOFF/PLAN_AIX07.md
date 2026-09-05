# PLAN_AIX07 — Trust, Privacy & Governance

Cycle: AIX-07 (Wave 5) · Base: main @ 4761043 · Release target: v1.28.0  
Reviewer: `unic-smart` — MUST differ from executor `unic-code`

## §1 Intent

Ship a deliberately narrow, local-only governance layer for AI Chat. Users must be able to inspect the effective provider, sensitive-context, and tool posture; an untrusted workspace must receive no sensitive AI context; invalid/migrated configuration or an invalid resolver result must fail closed with a notice; and a trusted user must be able to export or clear the redacted in-memory trace introduced in AIX-06.

Success is a centralized, testable policy decision rather than scattered per-tool privacy checks. No cloud account, enterprise administration service, persistence/retention store, or replay of writes is part of this release.

## §2 Scope

### In scope

- A pure `src/ai/policy.ts` (new) that resolves effective provider route, sensitive context classes, tool classes, audit-export permission, excluded workspace paths, and a user-facing notice from workspace trust, validated configured-engine vocabulary, and the actual `resolveEngine()` choice. Invalid/migrated configured values or an absent/invalid resolver choice are default-deny for sensitive capabilities; a valid configured `builtin` remains allowed when the resolver validly selects OMP.
- A pure redacted audit-export envelope and `TraceRecorder.dumpAll()` snapshot API over AIX-06's already-redacted in-memory trace.
- Three contributed commands: `UnicDB.ai.showPolicy`, `UnicDB.ai.exportTrace`, and `UnicDB.ai.clearTrace`. Export uses VS Code's save dialog and `workspace.fs.writeFile`; a policy denied by distrust, invalid/migrated configuration, or invalid resolver state blocks export before file selection or write.
- Policy integration in `AiChatPanel` for both builtin and OMP/MCP registration paths: sensitive database schema/context, mention expansion, workspace grounding/read/write, and data-bearing tool groups are allowed only through the same effective policy.
- Targeted policy, trace/audit-export, panel/command, configuration-regression, and no-secret-leak tests; package version moves from `1.27.0` to `1.28.0`.

### Out of scope for this cycle

- Cloud storage, remote audit upload, enterprise admin backend, retention scheduling, persistent trace storage, or replaying trace actions.
- New per-tool filtering rules outside the central policy module; existing user approval cards remain a second, interactive approval layer after policy admission.
- Changing provider protocol behavior in `src/ai/provider.ts`, changing `resolveEngine()` semantics, altering unrelated AI settings, or migrating unrelated settings.
- A webview policy/audit dashboard. Commands and VS Code notifications are the narrow user surface for v1.28.0.

### Same-wave file exclusion

Wave 1 contains TASK-AIX07-001 and TASK-AIX07-002. Their source and test file sets are disjoint. TASK-AIX07-003 depends on both and exclusively owns `src/ui/aiChatPanel.ts`, `src/extension.ts`, `package.json`, and its integration tests; no same-wave task modifies the same file.

## §3 Approach

1. **Central decision, fail closed without contradicting engine resolution.** Add a VS Code-free `resolvePolicy(input): EffectivePolicy` that accepts workspace trust, the raw user-configured engine value read from `vscode.workspace.getConfiguration("UnicDB").get("ai.engine", "builtin")`, and the already-resolved `EngineChoice` from `resolveEngine()`. Validate the configured value only as known preference vocabulary (`"builtin" | "omp"`); derive the effective provider exclusively from `EngineChoice.engine`. This is deliberately orthogonal because `resolveEngine()` selects OMP whenever detection succeeds, including a valid configured `builtin` default. Thus trusted `{ configuredEngine: "builtin", resolvedEngine: "omp" }` is a valid OMP posture that admits declared capabilities, not a conflict. Untrusted workspaces, unsupported/migrated configured values, or a missing/invalid resolver result deny sensitive context/tools and audit export with a concrete notice. A single path predicate denies credential/config locations such as `.env`, `.git/**`, and `.vscode/UnicDB-ai-config.yml` before workspace context is admitted.

2. **Use the policy at the current funnels, before any sensitive read, not in every tool implementation.** `AiChatPanel` already has both engine registries converge through `registerStandardToolset(registry)`, both message paths converge through `buildMessages(...)`, and `AiChatPanelOptions.isWorkspaceTrusted` already feeds the AIX-02 trust gate. Replace the duplicated trust-only admission decisions at those funnels with one panel policy accessor. In `handleSend`, obtain that effective policy before calling `resolveMentionsForTurn(...)` at `src/ui/aiChatPanel.ts:1469-1472`; only policy-permitted mention/context classes may invoke mention expansion, DB introspection, or file read. The existing `DbToolPermissionGate.wrap(...)` remains the user-consent gate for tools that policy permits; policy denial keeps sensitive tools out of the registry instead of adding independent per-tool scrubbing.

3. **Export only a second-redacted snapshot.** Extend the existing `TraceRecorder` with `dumpAll(): readonly TraceDump[]`, preserving its bounded turn order and copies. A new pure audit exporter receives that snapshot, runs the existing `redact()` defense again, and serializes an envelope with a schema/version marker and no credentials. The host command asks for a URI only after policy permits export, writes UTF-8 through `vscode.workspace.fs.writeFile`, and never uses Node `fs` or shell commands. Clear remains in-memory and delegates to `AiChatPanel.clearTrace()`.

4. **Make policy observable without a dashboard.** `UnicDB.ai.showPolicy` renders a concise effective provider/context/tool/export summary and its notice through VS Code UI. `UnicDB.ai.exportTrace` and `UnicDB.ai.clearTrace` operate only on the existing singleton panel; no live panel produces an explanatory no-op notice. Panel integration tests must capture all posted webview frames plus outbound model/OMP request observability exposed by the existing test harness, aggregate those strings like AIX-06's wire scan, and assert the aggregate has no `apiKey`, `api_key`, `secret`, `password`, token, `Authorization`, `Cookie`, or bearer/basic secret-shaped string. This matches AIX-06's existing `dumpTrace(turnId: string): unknown` and `clearTrace(): void` hooks while making a usable all-turn export available.

### Trade-offs and rejected alternatives

- Rejected independent checks in `createDbAwareTools`, `createAnalysisTools`, and `createChangePlanTools`: they would duplicate policy, drift across builtin/OMP registries, and violate the roadmap's centralized authorization requirement.
- Rejected persistent trace retention: AIX-06 deliberately made traces in-memory; adding workspace/global persistence expands privacy, migration, and deletion obligations beyond a safe v1.28.0 slice.
- Rejected exporting in untrusted mode with an ad-hoc partial filter: blocking before picker/write is simpler to prove and satisfies the required default-deny posture.
- Rejected a webview dashboard: the command palette surface proves behavior now without a new webview protocol, storage model, or UI state.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | `resolvePolicy uses the valid resolver route for trusted governed capabilities` | Trusted valid `EngineChoice.engine` supplies the effective provider, enables declared sensitive context/tool classes, permits audit export, and has no denial notice. |
| edge — resolver/default builtin | `resolvePolicy preserves valid configured builtin when resolveEngine selects OMP` | Trusted `{ configuredEngine: "builtin", resolvedEngine: "omp" }` returns effective provider `omp` and permits declared capabilities, proving `resolveEngine()`'s detection-first behavior is not default-denied. |
| edge — invalid/migration | `resolvePolicy invalid configured value or invalid resolver defaults deny with notice` | An unknown raw engine or absent/invalid resolver choice returns no sensitive capability and a stable non-empty notice rather than silently choosing a permissive route. |
| edge — path | `policy excluded path predicate blocks credential/config locations` | `.env`, `.git/config`, and `.vscode/UnicDB-ai-config.yml` are excluded; a normal workspace source path remains eligible. |
| edge — trust | `resolvePolicy untrusted workspace denies sensitive context and tools` | Untrusted input denies schema/workspace/row context, data-bearing/workspace tools, and audit export regardless of an otherwise valid provider route. |
| happy | `TraceRecorder.dumpAll and audit export preserve ordered redacted turns` | Two recorded turns produce an ordered JSON envelope with both turn IDs, trace metadata, and no mutation of recorder state. |
| edge — secret signature | `audit export defense redacts nested credential and authorization signatures` | Sentinel API key, `Authorization: Bearer`, password, and token-shaped values do not occur in serialized output; `<redacted>` occurs instead. |
| edge — empty/boundary | `audit export handles an empty recorder and trace turn cap` | Empty snapshot emits a valid envelope with `turns: []`; retained dumps still expose each turn's existing `truncated` value. |
| happy | `trusted commands show policy, save audit JSON, and clear the active panel trace` | Commands are contributed and registered; policy command shows effective state, export writes UTF-8 redacted envelope to selected URI, and clear calls the panel helper. |
| edge — authorization | `untrusted, invalid/migrated, or invalid-resolver export is denied before picker and write` | A denial notice is shown; `showSaveDialog` and `workspace.fs.writeFile` are never called. |
| edge — order of operations | `policy gates mention expansion before any sensitive read` | A denied policy prevents `resolveMentionsForTurn` from invoking adapter introspection or workspace-file reads, emits only permitted generic behavior, and never appends mention context. |
| edge — integration parity/wire scan | `untrusted policy prevents sensitive context and data-bearing tool registration on builtin and OMP/MCP without secret wire leakage` | Both panel paths omit governed sensitive tools/context while retaining generic chat behavior; aggregation of all captured webview frames and outbound model/OMP observability contains no supplied credential sentinel or `apiKey`, `api_key`, `secret`, `password`, token, `Authorization`, `Cookie`, bearer, or basic secret-shaped string. |
| regression | `extensionConfigExport and AI config privacy locks remain green` | Existing OMP YAML/command-line API-key exclusions and `AiConfigStore` secret-storage/legacy-engine behavior remain unchanged. |

TDD rule for every task: write the listed focused test(s), capture the RED failure against the pre-task implementation, then implement the smallest change to make them GREEN.

## §5 Verification

No `lint` script exists in the current `package.json`; it must not be invented. The repository defines `test`, `typecheck`, and `compile` only.

```bash
# TASK-AIX07-001 focused RED→GREEN and static/build checks
npm test -- src/ai/__tests__/policy.test.ts
npm run typecheck
npm run compile

# TASK-AIX07-002 focused RED→GREEN and static/build checks
npm test -- src/ai/__tests__/trace.test.ts src/ai/__tests__/auditExport.test.ts
npm run typecheck
npm run compile

# TASK-AIX07-003 focused integration/regression checks
npm test -- src/extension.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts src/__tests__/extensionConfigExport.test.ts src/ai/__tests__/config.test.ts
npm run typecheck
npm run compile

# Mandatory wave/cycle regression net after each completed wave and at release review
npm test
npm run typecheck
npm run compile
```

## §6 Acceptance

- [ ] TASK-AIX07-001: `resolvePolicy` is a pure central source of truth for provider route, sensitive context, tool admission, excluded paths, invalid/migration default-denial, and notices; it derives provider from a valid `resolveEngine()` choice and does not deny the valid configured-`builtin`/resolved-OMP case.
- [ ] TASK-AIX07-003: the effective policy command reports provider/context/tool/export state and its failure-closed notice to a user. 
- [ ] TASK-AIX07-003: an untrusted workspace does not supply sensitive schema/workspace/row context or sensitive tools to either builtin or OMP/MCP paths, and policy admission runs before mention expansion performs DB introspection or workspace-file reads.
- [ ] TASK-AIX07-003: invalid/migrated configured engine state or an absent/invalid resolver choice permits no sensitive capability and clearly reports its notice.
- [ ] TASK-AIX07-002 + TASK-AIX07-003: trusted export writes a redacted all-turn trace envelope to a user-selected URI; clear removes the active panel trace; denied export makes no picker/write side effect.
- [ ] TASK-AIX07-002: byte-level secret/credential/authorization sentinel tests prove no raw sentinel reaches the serialized export.
- [ ] TASK-AIX07-003: integration wire scans over captured webview frames and outbound model/OMP observability prove no raw credential sentinel or secret-shaped string leaks; existing `extensionConfigExport.test.ts` and AI config tests remain green; package release version is `1.28.0`.
- [ ] Every focused command and the wave/cycle `npm test`, `npm run typecheck`, and `npm run compile` commands pass under review by `unic-smart`.

## §7 Global Constraints

- Preserve the current VS Code extension floor: `engines.vscode` remains `^1.75.0`; use TypeScript and APIs already supported by this project.
- Add no production dependency; audit file I/O must use VS Code APIs, not Node `fs`, shell execution, or a cloud service.
- `src/ai/policy.ts` and `src/ai/auditExport.ts` are pure: no `vscode`, filesystem, network, child-process, `shell:true`, or `execSync` imports/calls.
- Default deny wins over permissive settings whenever workspace trust is false, configured engine state is unknown/migrated, the resolver choice is absent/invalid, or a path is excluded; a valid configured `builtin` plus resolver-selected OMP is permitted.
- Do not persist traces, credentials, or policy decisions; trace export is user-invoked, one-shot, UTF-8, and redacted again immediately before serialization.
- Reuse `TraceRecorder.dump(turnId: string): TraceDump`, `TraceRecorder.clear(): void`, `AiChatPanel.dumpTrace(turnId: string): unknown`, `AiChatPanel.clearTrace(): void`, `resolveEngine(...)`, and the shared `registerStandardToolset(...)` funnel; do not fork per-tool policy implementations.
- No raw API key, password, credential, token, `Authorization`, `Cookie`, or bearer/basic secret may appear in a policy notice, log, webview frame, export envelope, test fixture output, or generated configuration.
- Keep user-facing command names under `UnicDB.ai.*`; use concise English notices consistent with existing `UnicDB:` messages.
- Do not modify `docs/AI_HANDOFF/RUN.md`, `docs/STATUS.md`, `docs/WORKLOG.md`, or source files during planning; do not commit this planning change.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 2).

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: made all-turn trace export explicit because AIX-06 only exposes a single-turn dump helper; split pure policy and audit work onto disjoint Wave-1 files. Round-1 revision additionally derives the effective route from valid `resolveEngine()` output rather than equality with the configured preference, and pins mention pre-read gating plus panel wire scans.
Known gaps: no policy webview/dashboard or persistent retention is planned; both are deliberately outside the v1.28.0 narrow release.


## Plan Review Log

### Round 1 — Issues Found (reviewer model: unic-smart)
- `docs/AI_HANDOFF/PLAN_AIX07.md:35` and `docs/AI_HANDOFF/tasks/TASK-AIX07-003.md:60,76` — The required configured/resolved conflict policy is incompatible with the current `resolveEngine()` seam: it selects `omp` whenever detection succeeds, even when configured `ai.engine` is the default `builtin` (`src/ai/engineChoice.ts:49-56`). TASK-003 must specify a policy input/derivation that treats a valid configured builtin route as non-conflicting without changing `resolveEngine()` semantics, or explicitly scope and test the resolver change; otherwise ordinary trusted builtin configurations default-deny sensitive capabilities.
- `docs/AI_HANDOFF/PLAN_AIX07.md:63` and `docs/AI_HANDOFF/tasks/TASK-AIX07-003.md:28-31` — The integration-parity plan requires proving that no raw credential sentinel is posted or exported, but TASK-003 has no matching assertion. Add an explicit panel-wire assertion and name the guarded mention-resolution path (`src/ui/aiChatPanel.ts:1469-1488`), which currently reads mention file/DB context before its later workspace-trust check; the policy must be applied before that read/expansion.

### Round 1 — findings applied
- Finding 1: Policy now validates the configured value as preference vocabulary but derives effective provider from valid `EngineChoice.engine`; PLAN and TASK-AIX07-001/003 pin the valid configured-`builtin` plus resolver-selected-OMP admission case without changing `resolveEngine()`.
- Finding 2: PLAN and TASK-AIX07-003 now require policy gating before `resolveMentionsForTurn(...)` at `src/ui/aiChatPanel.ts:1469-1472`, assert zero adapter/file-read calls when denied, and byte-scan aggregated captured webview and builtin/OMP observability surfaces for supplied sentinels and secret-shaped strings.


### Round 2 — Approved (reviewer model: unic-smart)
- No blocking findings. Round-1 policy derivation is resolved: valid configured `builtin` is preference validation only, while a valid `EngineChoice.engine` supplies the effective route and preserves `resolveEngine()`'s resolver-selected OMP behavior.
- No blocking findings. TASK-AIX07-003 now byte-scans captured webview and builtin/OMP observability surfaces and pins policy admission before `resolveMentionsForTurn(...)`, with zero adapter/file-read calls under denial.
- No new blocking findings: every task has at least one happy path and two distinct edge kinds; Wave-1 target files are disjoint; `npm test`, `npm run typecheck`, and `npm run compile` exist in `package.json`.
