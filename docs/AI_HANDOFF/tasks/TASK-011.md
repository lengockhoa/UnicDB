# TASK-011 — AIChat panel dispatch and engine-aware image validation

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §3(5), §4

## Goal

Make `AiChatPanel` the universal interface for omp, Claude Code, Codex, and builtin: widen its engine state/options, dispatch turns to the selected chat engine, and allow validated image + text attachments for Claude/Codex while preserving omp’s deliberate text-only gate and builtin’s model-vision gate.

## Target Files

- `src/ui/aiChatPanel.ts` — owns all panel type, `handleReady`, `prepareAttachments`, and send-dispatch changes.
- `src/ui/__tests__/aiChatPanelEngine.test.ts` — engine routing/state tests.
- `src/ui/__tests__/aiChatPanelAttachments.test.ts` — attachment capability/regression tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Claude Code text turn dispatches to injected engine | `claudeCodeChatEngine.send("hello", events, undefined)` called once; builtin/omp paths not invoked; delta posted to webview | panel with Claude engine option fake |
| 2 | happy | Codex image + text turn dispatches structured image | fake Codex engine receives original text and `[{mime:"image/png",base64}]`; assistant lifecycle completes | valid PNG attachment fixture |
| 3 | edge (capability) | omp still rejects nonempty attachments even if work.vision is true | posts `attach_error` reason `vision_unsupported`; `ompChatEngine.send` gets text only | omp panel + model vision true |
| 4 | edge (model config) | builtin still respects work.vision false | init posts `visionCapable:false`; image rejected before builtin `runAgent` call | builtin panel + `loadConfig()` returns work.vision false |
| 5 | edge (empty) | Claude/Codex send with no attachment follows text-only route | engine gets undefined/no image blocks; no attach error | text-only send for each engine |
| 6 | regression | panel no longer hardcodes `visionCapable=false` for all external engines | Claude/Codex init posts `visionCapable:true`; omp posts false — fails on current `if (this.engine === "omp")` design once new engine type is introduced | init fakes for each engine |
| 7 | edge (unavailable injected engine) | engine selected but its option is absent | posts concrete engine-unavailable error and safely falls back to builtin turn only when builtin deps are usable; never calls wrong agent engine | panel configured claude-code with no claudeCodeChatEngine |

## Test Files

- `src/ui/__tests__/aiChatPanelEngine.test.ts` — tests 1, 5, 7 and engine state assertions.
- `src/ui/__tests__/aiChatPanelAttachments.test.ts` — tests 2–4, 6.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelEngine.test.ts src/ui/__tests__/aiChatPanelAttachments.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] `type EngineKind = "omp" | "claude-code" | "codex" | "builtin"` (currently :1051 has 2 values); `postEngine`/wire message handle the full union.
- [ ] `AiChatPanelOptions` has optional `claudeCodeChatEngine` / `codexChatEngine` fields with TASK-009/010 output interfaces; no `any` cast to disguise interface mismatch.
- [ ] `handleReady` capability policy: omp false; Claude Code + Codex true; builtin derives `cfg?.models.work.vision ?? defaultAiSettings().models.work.vision` as current.
- [ ] `prepareAttachments` rejects omp only; validated Claude/Codex images reach their engine as structured fields, not concatenated into `acpPrompt` text.
- [ ] Existing `runOmpEngineTurn` route and raw ACP fallback remain unchanged for current tests.
- [ ] All listed tests pass.

## Dependencies

- TASK-007 — consumes widened `EngineChoice.engine` vocabulary / explicit settings policy.
- TASK-009 — consumes `ClaudeCodeChatEngine` output interface.
- TASK-010 — consumes `CodexChatEngine` output interface.

## Interfaces

- Consumes: `EngineChoice.engine: AiEngine` (TASK-007); `ClaudeCodeChatEngine.send(text, events, attachments?)` (TASK-009); `CodexChatEngine.send(text, events, attachments?)` (TASK-010); existing `MinimalAttachment` (`src/ui/aiChatAttachments.ts:69-74`).
- Produces:
  - widened `EngineKind` and `AiChatPanelOptions` engine fields consumed by TASK-012;
  - panel dispatch behavior: `claude-code` calls `claudeCodeChatEngine.send(acpPrompt, events, attachments)`; `codex` calls its equivalent; `omp` retains `runOmpEngineTurn`; builtin retains `runBuiltinTurn`.
  - engine-specific capability rule described above, consumed via the init `visionCapable` wire field.

---

## Discussion

### 2026-09-07 · planner · unic-smart
One subtle invariant: today `userMsg.content` contains image `ChatContentPart[]`, but `acpPrompt` intentionally reduces ACP to `trimmed` (:1814-1820). Do NOT repurpose `acpPrompt` to smuggle base64. Add a structured attachment conversion exclusively for the new engine calls. Avoid changing unrelated grounding / mention merge behavior.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT: The new TASK-011 tests were added directly to existing `aiChatPanelEngine.test.ts` (#T011-1, #T011-5, #T011-5b, #T011-7, #T011-7b) and `aiChatPanelAttachments.test.ts` (#T011-2, #T011-3, #T011-4, #T011-6, #T011-6b, #T011-6c). RED was confirmed implicitly because the new tests probe widened dispatch (`engine: "claude-code" | "codex"`) that did not exist before — typecheck alone rejected the `options.engine` field and the new engine kinds. Initial `npx vitest run` showed test #T011-4 failing with `expected [] to have a length of 1 but got +0` because `prepareAttachments` only consulted the boolean `visionOk = this.engine === "builtin" || this.engine === "claude-code" || this.engine === "codex"` and did not thread the actual `resolvedVisionCapable` value from `cfg.models.work.vision === false`. After adding a `resolvedVisionCapable` cache field set in `handleReady` and consumed in `prepareAttachments`, all tests passed.

Verification Output:
```
$ npx vitest run src/ui/__tests__/aiChatPanelEngine.test.ts src/ui/__tests__/aiChatPanelAttachments.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts
 ✓ src/ui/__tests__/aiChatPanelEngine.test.ts      (17 tests)
 ✓ src/ui/__tests__/aiChatPanelAttachments.test.ts (15 tests)
 ✓ src/ui/__tests__/aiChatPanel.test.ts             (38 tests)
 ✓ src/ui/__tests__/aiChatPanelAcp.test.ts         (33 tests)
 Test Files  4 passed (4)
      Tests  102 passed (102)
   Duration  ~550ms

$ npm run typecheck
> tsc --noEmit
(no output — clean)
```

Per-test counts:
- engine.test.ts: 12 (legacy cycle AB/AE/AIX05-103) + 5 new (#T011-1, #T011-5, #T011-5b, #T011-7, #T011-7b) = 17
- attachments.test.ts: 9 (legacy cycle AB) + 6 new (#T011-2, #T011-3, #T011-4, #T011-6, #T011-6b, #T011-6c) = 15
- legacy aiChatPanel.test.ts: 38 — UNCHANGED
- legacy aiChatPanelAcp.test.ts: 33 — UNCHANGED

Status: PASS
Note: The implementation widens the panel to support four engine kinds. Engine selection is driven by a new optional `options.engine` field on `AiChatPanelOptions`; legacy hosts that omit it keep the `acp === undefined ? "builtin" : "omp"` derivation. `claudeCodeChatEngine` and `codexChatEngine` are optional seams; absence triggers a concrete `error` post + `handleUnavailableEngineFallback` that posts `engine: builtin` on the banner and runs the built-in turn. Image attachments flow as a SEPARATE `ReadonlyArray<{mime, base64}>` to the engine seam (never concatenated into `acpPrompt` text, per planner note). omp path + raw ACP fallback (`runAcpTurn`) remain UNCHANGED.

LegacyUntouched:
```
$ git diff --stat src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts
(empty — both files untouched)
```

All-changed files:
```
 src/ui/__tests__/aiChatPanelAttachments.test.ts | 295 ++++++++++++++++++
 src/ui/__tests__/aiChatPanelEngine.test.ts      | 260 ++++++++++++++++
 src/ui/aiChatPanel.ts                           | 386 +++++++++++++++++++++++-
 src/ui/aiChatPanelMessages.ts                   |   9 +-
 4 files changed, 935 insertions(+), 15 deletions(-)
```
