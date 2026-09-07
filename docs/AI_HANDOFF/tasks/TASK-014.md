# TASK-014 — Cross-engine integration coverage and env-gated live smokes

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4–§6

## Goal

Add focused final integration coverage across settings resolution, AIChat dispatch, image behavior, manifest identifiers, and two opt-in real-CLI smoke tests. This is the final regression net after all implementation tasks and documents which omp-audit findings this cycle intentionally leaves queued.

## Target Files

- `src/__tests__/agentEnginesIntegration.test.ts` (new) — cross-module settings/resolution/panel/manifest integration matrix using fakes (no real CLI/network).
- `src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts` (new) — `UnicDB_CLAUDE_CODE_SMOKE=1` gated real Claude CLI protocol smoke, skipped otherwise.
- `src/ai/codex/__tests__/codexLiveSmoke.test.ts` (new) — `UnicDB_CODEX_SMOKE=1` gated real Codex CLI protocol smoke, skipped otherwise.
- `src/extension.test.ts` — only if final end-to-end wiring behavior cannot be exercised through exported/fake seams in the new integration test; if modified, add final cross-selection assertions without duplicating TASK-012 unit tests.
- `docs/AI_HANDOFF/tasks/TASK-004.md` — append one short `## Follow-up disposition` subsection identifying audit findings intentionally queued vs already guarded by this cycle's tests; no source edits.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | four configured-engine integration matrix | `builtin`, `omp`, `claude-code`, `codex` each resolve to the selected healthy engine; panel receives only matching engine option | detection/factory fakes, valid config |
| 2 | happy | Claude/Codex text + image integration path | valid image reaches selected fake agent as `{mime,base64}` with text unchanged; no base64 in captured trace/error callback | one PNG fixture per agent |
| 3 | edge (unavailable) | missing/too-old selected external agent | resolved builtin, concrete selected-engine install/update hint; no alternate external agent started | all reason variants |
| 4 | edge (capability) | omp vs external image distinction | omp attachment rejected `vision_unsupported`; Claude/Codex accepted; builtin follows `work.vision` flag | same valid image fixture |
| 5 | edge (gating) | live smoke env flags absent | both smoke suites use `it.skipIf(...)`/equivalent and report skipped, never invoke real binary | env vars unset |
| 6 | edge (protocol/live) | gated live CLI protocol handshake | when respective env=1 + CLI exists, command returns a parseable terminal/stream event inside bounded timeout; unavailable CLI causes an explicit test failure only when gate requested | guarded local CLI environment |
| 7 | regression | healthy omp does not override explicit builtin | integration policy result is builtin — protects P0.3 from old omp-first `resolveEngine` behavior | healthy omp detection + `engine:"builtin"` |

## Test Files

- `src/__tests__/agentEnginesIntegration.test.ts` (new) — tests 1–4, 7.
- `src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts` (new) — tests 5–6 (Claude).
- `src/ai/codex/__tests__/codexLiveSmoke.test.ts` (new) — tests 5–6 (Codex).
- `src/extension.test.ts` — optional narrow final route tests only if necessary (see Target Files).

## Verification Commands

```bash
npx vitest run src/__tests__/agentEnginesIntegration.test.ts src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts src/ai/codex/__tests__/codexLiveSmoke.test.ts
npm run typecheck
npm run compile
# Wave/cycle boundary regression net — run after all wave-6 tasks complete:
npm test
```

No lint script exists in this project — lint is N/A; typecheck is the static gate. Do NOT enable live smoke env vars in routine CI; run them only in an authenticated/installed CLI environment.

## Acceptance Criteria

- [ ] New integration test passes with no installed external CLI or network access (all engine subprocesses mocked).
- [ ] Smoke suites skip by default and name their enable env vars; `UnicDB_CLAUDE_CODE_SMOKE=1` and `UnicDB_CODEX_SMOKE=1` both use real detected binary paths, mandatory temp cwd, bounded timeout, and cleanup.
- [ ] Live smoke never invokes a model prompt that can mutate workspace/DB, never passes DB credentials/apiKey, and avoids dangerous permission bypass flags.
- [ ] TASK-004 follow-up disposition is appended; no omp source rewritten.
- [ ] Focused commands, final `npm test`, `npm run typecheck`, and `npm run compile` are green.

## Dependencies

- TASK-004 — consumes the audit report for follow-up disposition.
- TASK-011 — consumes final panel routing/capability behavior.
- TASK-012 — consumes host wiring and final engine option construction.
- TASK-013 — consumes final manifest ids.

## Interfaces

- Consumes: final `resolveEngine` explicit-selection API (TASK-007), new chat engine interfaces (TASK-009/010), panel options and attachment behavior (TASK-011), extension wiring (TASK-012), manifest ids (TASK-013), TASK-004 audit findings.
- Produces: final regression evidence and env-gated operational proof. No runtime API exported.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Use `src/ai/omp/__tests__/acpLiveSmoke.test.ts` as the proven gate/cleanup style. Local evidence: Claude 2.1.261 exists; Codex does not. A smoke that cannot establish a safe protocol handshake must fail loudly when its opt-in env var is set — never silently skip under a requested gate. The integration test should remain fully mocked and run in every normal cycle.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
