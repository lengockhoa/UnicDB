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

## Executor Report
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 FAIL  src/scaffold.test.ts > scaffold > Test (TASK-013) — UnicDB.ai.engine description names claude-code/codex + builtin fallback; default unchanged; JSON still valid
AssertionError: description phải nhắc tới claude-code: expected 'Cycle AE — chat engine selection. "om…' to match /claude-code/

 FAIL  src/ui/__tests__/commitGenManifest.test.ts > ... > case 4: no duplicate command ids and the pre-existing 54 ids remain (superset)
AssertionError: expected [ 'UnicDB.addConnection', …(58) ] to include 'UnicDB.ai.useWithClaudeCode'

 FAIL  src/ui/__tests__/commitGenManifest.test.ts > ... > TASK-013 case 1: UnicDB.ai.engine enum exposes four values (builtin, omp, claude-code, codex) and default remains builtin
AssertionError: expected [ 'builtin', 'omp' ] to deeply equal [ 'builtin', 'omp', …(2) ]
  Array [
    "builtin",
    "omp",
-   "claude-code",
-   "codex",
  ]

 FAIL  src/ui/__tests__/commitGenManifest.test.ts > ... > TASK-013 case 2: UnicDB.ai.useWithClaudeCode & useWithCodex are contributed and activated
AssertionError: expected [ 'UnicDB.addConnection', …(58) ] to include 'UnicDB.ai.useWithClaudeCode'

 FAIL  src/ui/__tests__/commitGenManifest.test.ts > ... > TASK-013 case 3: new activation events appear exactly once; no preexisting events get duplicated
AssertionError: onCommand:UnicDB.ai.useWithClaudeCode phải xuất hiện đúng 1 lần: expected +0 to be 1

 Test Files  2 failed (2)
      Tests  5 failed | 14 passed (19)
```

Verification Output:
```
$ npx vitest run src/ui/__tests__/commitGenManifest.test.ts src/scaffold.test.ts
 ✓ src/ui/__tests__/commitGenManifest.test.ts  (7 tests) 4ms
 ✓ src/scaffold.test.ts  (12 tests) 690ms
 Test Files  2 passed (2)
      Tests  19 passed (19)

$ npm run typecheck
> UnicDB@1.53.23 typecheck
> tsc --noEmit
(no errors)

$ npm run compile
> UnicDB@1.53.23 compile
> node esbuild.js
esbuild: build complete
  dist/extension.js       6.4mb ⚠️
  dist/extension.js.map  11.5mb
  dist/webview.js        2.3mb ⚠️
  dist/webview.js.map    4.1mb
  ... (all bundles built, no errors)
```

Status: PASS
Note: All 5 failing tests RED-state-confirmed before package.json edit; GREEN after. JSON valid via `JSON.parse` + esbuild packaging-facing compile step. No version/publisher/other-contribution sections touched.
Test-4 home: (a) src/scaffold.test.ts — pattern matches its existing `UnicDB.hideSystemSchemas` test (configuration property shape: type + default + description). Keeps the AI-engine engine description check next to the other configuration-shape guard, and avoids mixing TASK-013 description-copy checks into the TASK-GC-004 file.
