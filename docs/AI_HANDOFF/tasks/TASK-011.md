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
