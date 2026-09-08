# TASK-AGTUI-006 — Host wiring: `models` frame, `model_select`, bypass-permissions flag

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3

## Goal

Host side of the clone protocol in `src/ui/aiChatPanel.ts`: post `models` on ready + after role switches, handle `model_select` (full `AiModelRole` set, not just `work|smart`), and honor `bypass_permissions` as a panel-session flag that auto-answers ACP permission requests (allow-first, deny fallback). AGT engine dispatch (TASK-011/012) is UNTOUCHED.

## Target Files

- `src/ui/aiChatPanel.ts` — ready path, new webview-message cases, private `bypassPermissions` flag; NO changes to `resolveEngineKind` / `runXEngineTurn` / adapters.
- `src/ui/__tests__/aiChatPanelCloneHost.test.ts` (new) — host tests using the existing panel test harness pattern (mock webview + `AiConfigStore` fixtures as in `aiChatPanelAgentEngines.test.ts`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | ready posts one models frame | panel ready → exactly one `{type:"models", active:"work", roles:[…]}` where roles = the 4 `AiModelRole`s filtered to non-empty `modelId`, each carrying `vision` from settings | settings fixture: work+smart configured, autocomplete+lite empty |
| 2 | edge (unknown value) | invalid model_select rejected | `{type:"model_select", role:"turbo"}` (cast) OR valid role with empty modelId in settings → `error` bubble posted, `activeRole` unchanged (next `models` frame still shows old active) | hostile/empty fixtures |
| 3 | happy | valid model_select switches role | `{type:"model_select", role:"smart"}` → `activeRole === "smart"` (observable: subsequent turn uses smart role) + fresh `models` frame with `active:"smart"`; NO assistant echo bubble (chip path is silent — PLAN §3) | configured smart model |
| 4 | edge (permission) | bypass ON auto-answers allow-kind | bypass `enabled:true` posted; permission request with an allow-kind option → webview receives NO `permission_request`; the ACP request resolves with that allow optionId. Fixture mirrors the ACP option shape read from `src/ai/omp/` (see Discussion) | in-flight request fixture |
| 5 | edge (fallback deny) | bypass ON, no allow-kind option | request whose options contain no allow-kind entry → resolved as DENY (deny path, no `optionId`) — default-deny posture preserved on ambiguity | deny-only fixture |
| 6 | edge (default + reset) | bypass OFF default; OFF flow unchanged | flag defaults false; with OFF, `permission_request` reaches the webview exactly as today (parity assertion vs current behavior) and `bypass_permissions{enabled:false}` resets a prior ON | toggle sequence ON→OFF |
| 7 | regression | engine dispatch untouched | `aiChatPanelAgentEngines.test.ts`, `aiChatPanelEngine.test.ts`, `aiChatPanelAcp.test.ts` pass unmodified | full existing suites |

## Test Files

- `src/ui/__tests__/aiChatPanelCloneHost.test.ts` (new)

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelCloneHost.test.ts
npx vitest run src/ui/__tests__/aiChatPanelAgentEngines.test.ts src/ui/__tests__/aiChatPanelEngine.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; `git diff` on `src/ui/aiChatPanel.ts` shows no edits inside engine-dispatch methods (`resolveEngineKind`, `runOmpEngineTurn`/`runClaudeCodeEngineTurn`/`runCodexEngineTurn` call sites).
- [ ] Bypass flag is never persisted (no `context.globalState`/workspace writes; panel-session lifetime only).
- [ ] `models` frame carries NO apiKey/model-secret material — only role names + modelId + vision booleans.

## Dependencies

- TASK-AGTUI-002 (frame types must exist)

## Interfaces

- Consumes: `AiChatPanelModels` / `AiChatPanelModelSelect` / `AiChatPanelBypassPermissions` from TASK-AGTUI-002; `deps.loadConfig(): Promise<AiConfig>` → `cfg.models: Record<AiModelRole, AiModelConfig>` (host reads config via `this.options.deps.loadConfig()` — `src/ui/aiChatPanel.ts:1752`; `AiModelRole` type from `src/ai/settings.ts`, which exports `defaultAiSettings()` and has no `loadSettings`).
- Produces: host posts `models` frames (shape per TASK-AGTUI-002) on ready and after each accepted `model_select`; accept `model_select` + `bypass_permissions` webview messages; private `bypassPermissions: boolean` (default false).

### 2026-09-08 · planner · unic-smart
OPEN ITEM for executor: the "allow-kind" predicate must be derived from the REAL ACP permission-option shape in `src/ai/omp/` (option kind/ids as the existing permission flow already classifies them) — do not invent a label regex if a kind field exists. State the chosen predicate + file:line in your Executor Report. If no kind field exists, fall back to first-option-allow ONLY when the existing flow labels an option allow/always; otherwise deny. Deny fallback is mandatory.

## Executor Report

```
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: feature-implementer

## Open Item Resolution — allow-kind predicate
The "allow-kind" predicate is `optionId === "allow-once" || optionId === "allow-session"`.
Derived from `optionIdGrants(optionId)` at `src/ai/omp/hostMcp.ts:122-124`. The option
set used by the existing HostMcp gate is the closed `[allow-once, allow-session, deny]`
defined at `src/ai/omp/hostMcp.ts:113-120`. The new host-side helper is
`isAllowKindOptionId(optionId)` at `src/ui/aiChatPanel.ts` (private module helper,
mirrors the existing predicate byte-for-byte so a bypass answer writes a result the
rest of the host treats identically to a webview-picked optionId).

## RED — 8 tests failed (all in the new file)
Command: `npx vitest run src/ui/__tests__/aiChatPanelCloneHost.test.ts`
All 8 new tests failed with `Error: until: condition not met` — the panel's ready
path did not post the new `models` frame (the chip path had no host wiring yet).
Each test observed an empty `postedMessages` for the new wire shape.

## Implementation Summary
1. `src/ui/aiChatPanel.ts`
   - Added module-level helpers: `AI_MODEL_ROLES`, `isAiModelRole`, `isAllowKindOptionId`.
   - Added `private bypassPermissions: boolean = false` panel-session flag
     (no persistence — verified: no `globalState` / workspace writes).
   - Added `case "model_select"` and `case "bypass_permissions"` to the
     webview message switch.
   - Added `private buildModelsFrame(cfg)` — filters roles to non-empty
     `modelId`, carries ONLY role literal + modelId + vision flag (no
     apiKey / baseUrl / method / engine — verified via JSON-string regex).
   - Added `private async handleModelSelect(role)` — closed-set guard +
     settings-driven "feature disabled" rejection; on success flips
     `activeRole` and re-posts `models`. Silent on both success and
     rejection (PLAN §3 chip path: no assistant echo).
   - Modified `handleReady()` — loads config ONCE, reuses for both the
     legacy `visionCapable` decision and the new `models` frame. Posts
     `models` BEFORE `init` so any test snapshotting postedMessages at
     the moment init arrives observes every frame this method produces
     (no late surprise). Load failure is non-fatal (empty `roles[]`).
   - Modified `handleAcpServerRequest()` — when `bypassPermissions` is
     ON, picks the first allow-kind option from the request's options
     and writes `{outcome:"selected", optionId:<allow-kind>}`; when no
     allow-kind option exists writes `{outcome:"cancelled"}` (deny
     fallback). Webview receives NO `permission_request` frame. Best-
     effort writes (mirrors `cancelPending`'s error-tolerance).
   - Modified `requestHostPermission()` (HostMcp gate) — same bypass
     behavior for parity: allow-first / deny fallback, no webview frame.
   - NO edits to engine-dispatch methods (`resolveEngineKind`,
     `runOmpEngineTurn`, `runClaudeCodeTurn`, `runCodexTurn`,
     `runImageCapableEngineTurn`). Verified via `git diff`.

## Verification Output
Command: `npx vitest run src/ui/__tests__/aiChatPanelCloneHost.test.ts`
→ `Tests  8 passed (8)` ✓

Command: `npx vitest run src/ui/__tests__/aiChatPanelAgentEngines.test.ts src/ui/__tests__/aiChatPanelEngine.test.ts`
→ `Tests  25 passed (25)` ✓

Command: `npm run typecheck`
→ exit 0 (no errors)

Command: full chat-webview regression union (TASK-AGTUI-007 verification set):
  npx vitest run \
    src/ui/__tests__/aiChatPanel.test.ts \
    src/ui/__tests__/aiChatPanelAcp.test.ts \
    src/ui/__tests__/aiChatPanelAgentEngines.test.ts \
    src/ui/__tests__/aiChatPanelAttachments.test.ts \
    src/ui/__tests__/aiChatPanelBundle.test.ts \
    src/ui/__tests__/aiChatPanelCloneCss.test.ts \
    src/ui/__tests__/aiChatPanelCloneHost.test.ts \
    src/ui/__tests__/aiChatPanelCommands.test.ts \
    src/ui/__tests__/aiChatPanelDbAware.test.ts \
    src/ui/__tests__/aiChatPanelDbAwareWebview.test.ts \
    src/ui/__tests__/aiChatPanelEngine.test.ts \
    src/ui/__tests__/aiChatPanelMentions.test.ts \
    src/ui/__tests__/aiChatPanelMessages.test.ts \
    src/ui/__tests__/aiChatPanelMessagesClone.test.ts \
    src/ui/__tests__/aiChatPanelPlan.test.ts \
    src/ui/__tests__/aiChatPanelPlanWebview.test.ts \
    src/ui/__tests__/aiChatPanelPolicy.test.ts \
    src/ui/__tests__/aiChatPanelResume.test.ts \
    src/ui/__tests__/aiChatPanelSessionState.test.ts \
    src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts \
    src/ui/__tests__/aiChatPanelThoughtRegen.test.ts \
    src/ui/__tests__/aiChatPanelToolParity.test.ts \
    src/ui/__tests__/aiChatPanelWebview.test.ts \
    src/ui/__tests__/aiChatPanelWebviewTask002.test.ts \
    src/ui/__tests__/aiChatPanelWebviewTask005.test.ts \
    src/ui/__tests__/aiChatPanelPrivacy.test.ts
→ `Test Files  25 passed | 1 skipped (26)`
→ `Tests  392 passed | 30 skipped (422)` ✓

## Acceptance Criteria
- [x] All §Test Cases pass; `git diff` on `src/ui/aiChatPanel.ts` shows no edits
      inside engine-dispatch methods (`resolveEngineKind`, `runOmpEngineTurn`/
      `runClaudeCodeTurn`/`runCodexTurn` call sites).
- [x] Bypass flag is never persisted (no `context.globalState`/workspace writes;
      panel-session lifetime only — class field, no persistence seam).
- [x] `models` frame carries NO apiKey/model-secret material — only role names
      + modelId + vision booleans. Verified via regex sweep of the JSON-serialized
      frame in test #1 (`apiKey`, `sk-…`, `fixture-not-loaded` all negative).

Status: PASS
Note: none
```

---

## Reviewer Report
REVIEWER_MODEL: unic-smart (claude-opus-4-6 via UNIC gateway)
Verdict: APPROVED-WITH-MINOR

Verification rerun (fresh, this review):
- `npx vitest run src/ui/__tests__/aiChatPanelCloneHost.test.ts` → 8 passed (8)
- `npx vitest run src/ui/__tests__/aiChatPanelAgentEngines.test.ts src/ui/__tests__/aiChatPanelEngine.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanel.test.ts` → 93 passed (unmodified, backward compat holds)
- Full panel family (28 files, 441 tests) → 438 passed / 3 failed — all 3 failures are in `aiChatPanelClonePolish.test.ts` (wave-3 TASK-AGTUI-008 suite, added at 6324c43, does not exist at review base b9470dc; fails in isolation too — NOT a 006 regression, but see cross-task note)
- `npm run typecheck` → exit 0

Scope findings:
- Completeness: all four host behaviors present and correct — `models` frame posted from `deps.loadConfig()` on ready before `init` (aiChatPanel.ts:1836-1843); `case "model_select"` (aiChatPanel.ts:1693) with closed-set guard + empty-modelId rejection + silent flip + fresh `models` frame; `case "bypass_permissions"` (aiChatPanel.ts:1702) on a panel-session field default false, zero persistence writes; public API purely additive.
- Element-id contract (PLAN §3): untouched — host diff contains no DOM/id changes (ids live webview-side).
- Wire protocol: `AiChatPanelModels` in host→webview union (aiChatPanelMessages.ts:231,283); `AiChatPanelModelSelect`/`AiChatPanelBypassPermissions` in webview→host union (aiChatPanelMessages.ts:420,431,447-448). Engine dispatch untouched — full diff read; no hunk falls inside `resolveEngineKind` (:1941), `runOmpEngineTurn` (:2504), `runClaudeCodeTurn` (:2669), `runCodexTurn` (:2690), `runImageCapableEngineTurn` (:2721).
- Open item: executor's `isAllowKindOptionId` verified byte-for-byte against `optionIdGrants` at src/ai/omp/hostMcp.ts:122-124; closed option set [allow-once, allow-session, deny] confirmed at hostMcp.ts:113-120. Bypass ACP branch writes exactly one result per call and only allow-kind ids already listed in the request (no unlisted-id injection); deny fallback = `cancelled`, matching `handlePermissionResponse`'s settle contract (aiChatPanel.ts:3557-3587).
- TDD: all 7 planned cases implemented with real `expect` assertions; bypass tests exercise the real ACP transport path, not mocks of the unit under test. RED evidence is a paraphrase ("until: condition not met") rather than raw pasted output — acceptable: the signature matches the actual `until()` helper (test line 126) and this review's fresh re-run is green.

Findings:
- minor: src/ui/aiChatPanel.ts:1905 (`handleModelSelect`) — indexes `cfg.models[role]` without the `cfg.models !== undefined` guard its sibling `buildModelsFrame` has; a hypothetically malformed loadConfig result would throw inside the webview-message handler instead of posting the error bubble. Low likelihood (loadConfig is typed `Promise<AiConfig>` with non-optional models); add the same guard for symmetry.
- minor: docs/AI_HANDOFF/tasks/TASK-AGTUI-006.md:75-79 (Executor Report RED section) — RED output paraphrased, not pasted verbatim. For future tasks paste the raw vitest failure block per the handoff contract.
- cross-task note (non-blocking for 006): `src/ui/__tests__/aiChatPanelClonePolish.test.ts` fails 3/8 at HEAD (caret lifecycle #1, tool card #2, stop pulse #5), also in isolation — TASK-AGTUI-008 is still `pending_review`; its reviewer must treat this as a blocking verification failure for 008.

Cross-checks passed: models frame carries no apiKey/baseUrl/method (regex-asserted in test #1 and confirmed by reading `buildModelsFrame`); fail-closed posture preserved when bypass is ON but webview is gone (`requestHostPermission` resolves deny); Stop/cancel paths unaffected (bypass branch never registers pending entries).

