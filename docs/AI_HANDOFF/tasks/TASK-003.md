# TASK-003 — Codex binary detection (mirror omp/detect.ts)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3(1), §7

## Goal

Add `detectCodex()` for the OpenAI Codex CLI (`codex`): locate binary, parse `--version`, gate on a minimum version — same contract as `detectOmp()` / TASK-002.

## Target Files

- `src/ai/codex/detect.ts` (new) — detection module.
- `src/ai/codex/__tests__/detect.test.ts` (new) — unit tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | detects a healthy install | `detectCodex(fakeExec)` → `{ available: true, ok: true, path: ".../codex", version: "0.42.0" }` | execFn: `which codex` → path; `codex --version` → `"codex-cli 0.42.0"` |
| 2 | edge (not installed) | ENOENT on locator | `{ available: false, ok: false, reason: "not-installed" }`; never throws | execFn rejects on `which codex` |
| 3 | edge (boundary) | version exactly MIN_CODEX_VERSION ok, one minor lower not | `0.20.0` → `ok: true`; `0.19.9` → `ok: false, reason: "version-too-old"` | parametrized versions |
| 4 | edge (malformed output) | `--version` prints no numeric token | `{ available: true, ok: false, reason: "version-unknown" }` | `"codex-cli (dev build)"` |
| 5 | edge (spawn failure on probe) | locator ok but `--version` exec rejects | `{ available: false, ok: false, path, reason: "spawn-failed" }` (mirror detect.ts:104-111) | execFn rejects only on second call |

## Test Files

- `src/ai/codex/__tests__/detect.test.ts` — all tests above.

## Verification Commands

```bash
npx vitest run src/ai/codex/__tests__/detect.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] `detectCodex(execFn?)` never throws; reason taxonomy identical to omp (`not-installed | spawn-failed | version-unknown | version-too-old`).
- [ ] `MIN_CODEX_VERSION = "0.20.0"`, `CODEX_INSTALL_HINT = "npm install -g @openai/codex"` exported.
- [ ] `compareVersions` reused from `../omp/detect`; win32 `where codex` + space-quoting mirrored.
- [ ] File is standalone (no import from TASK-002's claudeCode module — parallel task).

## Dependencies

- (none)

## Interfaces

- Consumes: `compareVersions` from `src/ai/omp/detect.ts:24`.
- Produces:
  - `export interface CodexDetection { available: boolean; ok: boolean; path?: string; version?: string; reason?: string }`
  - `export type ExecFn = (cmd: string) => Promise<string>`
  - `export async function detectCodex(execFn?: ExecFn): Promise<CodexDetection>`
  - `MIN_CODEX_VERSION`, `CODEX_INSTALL_HINT`
  — consumed by TASK-006, TASK-007, TASK-012.

---

## Discussion

### 2026-09-07 · planner · unic-smart
`codex --version` prints e.g. `codex-cli 0.42.0` — parse the first numeric token. The 0.20.0 floor is planner-chosen (codex rust CLI line); adjust only with evidence, via a Discussion note.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
