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

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: feature-implementer
- Status: PASS
- Date: 2026-09-01

### RED_OUTPUT (actual, captured before implementation)

`npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/extension.test.ts`:

```
 FAIL  src/extension.test.ts > TASK-003 — vsdb.createSchema extension wiring > npm run compile emits dist/schemaForm.js (esbuild config wired)
 FAIL  src/extension.test.ts > TASK-AIX07-003 — vsdb.ai.showPolicy / exportTrace / clearTrace host integration > registers all three vsdb.ai.* commands on activate
 FAIL  src/extension.test.ts > TASK-AIX07-003 — ... > #1 happy — trusted + valid configured + valid resolver → ...
 FAIL  src/extension.test.ts > TASK-AIX07-003 — ... > #2 — valid configured builtin + resolver omp → still admitted (locked decision #2)
 FAIL  src/extension.test.ts > TASK-AIX07-003 — ... > #3 — denied policy (untrusted workspace) gates export BEFORE showSaveDialog and writeFile
 FAIL  src/extension.test.ts > TASK-AIX07-003 — ... > #5 — invalid configured engine (migrated value) → export denied before side effects
 FAIL  src/extension.test.ts > TASK-AIX07-003 — ... > #6 — export / clear without an active AI panel is a safe no-op + concrete notice
 FAIL  src/ui/__tests__/aiChatPanelPolicy.test.ts > ... > #1a denied policy (untrusted workspace) → builtin turn registry omits sensitive tools, generic chat still completes
 FAIL  src/ui/__tests__/aiChatPanelPolicy.test.ts > ... > #2 denied policy: object + file mention tokens do NOT call adapterFactory/listColumns, and fs.readFile is never invoked
 FAIL  src/ui/__tests__/aiChatPanelPolicy.test.ts > ... > #3 builtin path: aggregate posted webview frames + trace dump + system prompt are free of apiKey/password/token/Authorization/Cookie/bearer/basic
 FAIL  src/ui/__tests__/aiChatPanelPolicy.test.ts > ... > #3b OMP path: same byte-scan holds under the engine funnel (no apiKey/SECRET/Authorization leak)
 FAIL  src/ui/__tests__/aiChatPanelPolicy.test.ts > ... > #7 redact() scrubs secret-shaped strings the trace recorder stores

 Test Files  2 failed (2)
      Tests  12 failed | 78 passed (90)
```

Notes on the RED run: all 11 new-task tests failed for the expected reason
(unregistered commands; denied policy still registering sensitive tools;
mention expansion not gated; secret-shaped strings crossing the wire;
redact boundary). One of the 12 (#7 initial form) was a test-fixture bug of
my own that I corrected before implementation (redact() is value-scrubbing:
it preserves the literal key words "Bearer"/"apiKey", so the correct pin is
sentinel VALUES absent + `<redacted>` present — same pin as
`src/ai/__tests__/trace.test.ts`). The `dist/schemaForm.js` failure is
pre-existing in a fresh worktree (no dist bundle until `npm run compile`)
and is resolved by the verification sequence, not by task code. #3/#3b RED
also exposed two of my fixture bugs (a table literally named "secrets" and
a `@public.secrets` prompt token — my own fixtures, not leaks), fixed by
renaming the fixture table to `vault_items` before implementation.

### Implementation summary

- `src/ui/aiChatPanel.ts`: new `resolveEffectivePolicy()` consumes
  `resolvePolicy` (single source of truth) with the host policy override
  seam (`options.policy`), the trust probe, raw `configuredEngine`, and the
  route implied by `acp !== undefined` (mirrors — never re-derives —
  `resolveEngine()`). Gates: mention expansion BEFORE
  `resolveMentionsForTurn` (denied ⇒ adapterFactory/readFile never called);
  grounding reads (`context.workspace`); `registerStandardToolset(registry,
  policy)` omits dbAware/analysis/changePlan groups when `tools.database`
  is denied on BOTH builtin and OMP/MCP paths (signature stays
  parity-test-compatible with a default-admitted policy); schema context
  skipped when `context.schema` denied on builtin (`GENERIC_SYSTEM_PROMPT`)
  and raw ACP prompt paths; OMP `onDelta`/`onThought` pass through
  `redact()` as the final wire pass. New `dumpAll(): readonly TraceDump[]`
  copy-safe snapshot delegates to `TraceRecorder.dumpAll()`;
  `dumpTrace(turnId)` and `clearTrace()` retained.
- `src/extension.ts`: `deriveEffectivePolicy()` = live
  `vscode.workspace.isTrusted` + raw `vsdb.ai.engine` +
  `detectOmp()`/`loadConfig()`/`resolveEngine()` → `resolvePolicy`.
  `vsdb.ai.showPolicy` (info summary, no side effects), `vsdb.ai.exportTrace`
  (denied → notice BEFORE `showSaveDialog`/`fs.writeFile`; no panel →
  concrete notice; else save dialog + `workspace.fs.writeFile` of
  `serializeAuditExport(panel.dumpAll())` only), `vsdb.ai.clearTrace`
  (panel `clearTrace()` or concrete notice). `commandOpenAiChat` now also
  feeds the raw configured engine into the panel. provider.ts, request
  headers, and `resolveEngine()` fallback behavior untouched.
- `package.json`: three `vsdb.ai.*` commands contributed with icons
  (`$(shield)`/`$(export)`/`$(clear-all)` — scaffold test pins every
  command icon), activationEvents added, version 1.28.0, engines.vscode
  unchanged `^1.75.0`. `package-lock.json` root + packages[""] version
  synced to 1.28.0 via `npm install --package-lock-only` (only the two
  version lines changed; releaseHygiene requires the match).
- `esbuild.js`: one-line pre-existing fix — `consolePanelConfig` was wired
  for watch mode (ctx8) but missing from the non-watch build array, so
  `npm run compile` never emitted `dist/consolePanel.js` and the wave-2 net
  (`consolePanelBundle.test.ts`, ~9 tests) failed on any fresh worktree.
  Confirmed identical omission at base commit ebe8720 and in the main
  checkout; aligned build with watch-mode intent.
- Worktree environment repair (not repo code): fresh worktree
  `node_modules/.bin/` lacked the `esbuild` binary the webview-bundle
  tests spawn; symlinked to the main checkout's binary. Both bundle
  failures verified pre-existing at base before repairing.

### Verification Output

Focused block:

```
npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/extension.test.ts src/__tests__/extensionConfigExport.test.ts src/ai/__tests__/config.test.ts
 Test Files  4 passed (4)
      Tests  103 passed (103)
```

Wave-2 net (in this order):

```
npm run compile  → esbuild: build complete (dist/consolePanel.js now emitted)
npm test         → Test Files  212 passed | 1 skipped (213)
                   Tests  2770 passed | 2 skipped (2772)
npm run typecheck→ exit 0
npm run compile  → esbuild: build complete
```

### Status: PASS

### Note

- No `git add`/`commit`/`push` run — changes left as-is in worktree
  `handoff/task-aix07-003`.
- The panel consumes `resolvePolicy` at its funnels and mirrors the host
  route; the host remains the only `resolveEngine()` caller, so locked
  decision #2 (configured `builtin` + resolver-selected omp admitted) is
  pinned by both the pure policy tests (#4) and the host test (#2).
- Generic chat completes under a denied policy (asserted by #1a/#2: runAgent
  invoked, final text posted, zero sensitive registrations, zero reads).
