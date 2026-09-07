# TASK-013 — Manifest contribution: four engines and two agent commands

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §6

## Goal

Expose Claude Code and Codex in the extension manifest: valid `UnicDB.ai.engine` enum/help text, two contributed commands, matching activation events, and the existing locked command-list test.

## Target Files

- `package.json` — `contributes.configuration.properties["UnicDB.ai.engine"]` enum/description, `contributes.commands`, and `activationEvents`.
- `src/ui/__tests__/commitGenManifest.test.ts` — expected contributed command list.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | manifest engine enum exposes four exact values | parsed enum equals `["builtin","omp","claude-code","codex"]`; default remains builtin | package.json parse fixture |
| 2 | happy | new agent commands are contributed and activated | command list includes `UnicDB.ai.useWithClaudeCode`, `UnicDB.ai.useWithCodex`; activationEvents contain both `onCommand:` entries exactly once | package.json parse fixture |
| 3 | edge (duplicate) | adding events does not duplicate an existing activation event | each of the two new event strings has count 1; preexisting events keep count 1 | manifest activationEvents array |
| 4 | edge (copy/compatibility) | description names fallback semantics and both agents without claiming unsupported image behavior | description includes both engine ids and builtin fallback; JSON remains valid and default unchanged | contribution property |

## Test Files

- `src/ui/__tests__/commitGenManifest.test.ts` — tests 1–3 / locked command list update.
- `src/scaffold.test.ts` — test 4 added only if its package-shape style is a better existing neighbor; otherwise test 4 belongs in `commitGenManifest.test.ts` (do not create a redundant test).
- Executor Report MUST record which test-4 home shipped — (a) `src/scaffold.test.ts` or (b) `src/ui/__tests__/commitGenManifest.test.ts` — with a one-line rationale.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/commitGenManifest.test.ts src/scaffold.test.ts
npm run typecheck
npm run compile
```

No lint script exists in this project — lint is N/A; typecheck is the static gate. Compile catches malformed contribution JSON in packaging-facing build context.

## Acceptance Criteria

- [ ] `UnicDB.ai.engine` enum exactly contains `builtin`, `omp`, `claude-code`, `codex`; default remains `builtin`.
- [ ] Human-readable description explains P0.3: chosen unavailable agent falls back to builtin with a hint.
- [ ] Contributed command ids/titles: `UnicDB.ai.useWithClaudeCode` / `Use with Claude Code`; `UnicDB.ai.useWithCodex` / `Use with Codex`.
- [ ] Both have corresponding activation events exactly once; no unrelated contribution changes.
- [ ] Locked command list and all listed tests pass.

## Dependencies

- (none) — manifest declarations are independent; TASK-012 later implements the registered callbacks.

## Interfaces

- Consumes: user-confirmed ids/copy policy in PLAN §1 P0.3; current manifest configuration at `package.json` verified before planning.
- Produces: Manifest ids `UnicDB.ai.useWithClaudeCode`, `UnicDB.ai.useWithCodex`, configuration values `"claude-code"` / `"codex"` — TASK-012 registers matching callback strings; mismatch is a release blocker.

---

## Discussion

### 2026-09-07 · planner · unic-smart
`package.json` has no `.cache/index/tests-map.json` entry, so task test selection follows the nearest established manifest locks: `src/ui/__tests__/commitGenManifest.test.ts` contains the current expected `UnicDB.ai.useWithOmp` command at line 51, and `src/scaffold.test.ts` verifies parsed package shape. Do not alter version/publisher/other contribution sections.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
