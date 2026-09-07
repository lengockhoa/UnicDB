# TASK-002 — Claude Code binary detection (mirror omp/detect.ts)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3(1), §7

## Goal

Add `detectClaudeCode()` for the `claude` CLI (Anthropic Claude Code): locate binary, parse `--version`, gate on a minimum version — same contract and test style as `detectOmp()`.

## Target Files

- `src/ai/claudeCode/detect.ts` (new) — detection module.
- `src/ai/claudeCode/__tests__/detect.test.ts` (new) — unit tests (dir is new; mirrors `src/ai/omp/__tests__/detect.test.ts` structure).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | detects a healthy install | `detectClaudeCode(fakeExec)` → `{ available: true, ok: true, path: "/usr/local/bin/claude", version: "2.0.1" }` | execFn: `which claude` → path; `claude --version` → `"2.0.1 (Claude Code)"` |
| 2 | edge (not installed) | ENOENT on locator | `{ available: false, ok: false, reason: "not-installed" }`; never throws | execFn rejects on `which claude` |
| 3 | edge (boundary, exactly MIN) | version == MIN_CLAUDE_CODE_VERSION | `ok: true`; one patch lower (`0.9.x` vs floor) → `ok: false, reason: "version-too-old"` | parametrized version strings |
| 4 | edge (malformed output) | unparseable `--version` output | `{ available: true, ok: false, reason: "version-unknown" }` | `"garbage-output"` |
| 5 | edge (win32) | locator is `where claude` on win32, first line wins | locator string asserted; multi-line `where` output → first non-empty path | stub `process.platform`, multi-line stdout |

## Test Files

- `src/ai/claudeCode/__tests__/detect.test.ts` — all tests above.

## Verification Commands

```bash
npx vitest run src/ai/claudeCode/__tests__/detect.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] `detectClaudeCode(execFn?)` never throws for any execFn rejection (all failure paths return a reason).
- [ ] `MIN_CLAUDE_CODE_VERSION = "1.0.0"`, `CLAUDE_CODE_INSTALL_HINT = "npm install -g @anthropic-ai/claude-code"` exported.
- [ ] `compareVersions` is imported and REUSED from `../omp/detect` (no duplicate implementation).
- [ ] Windows uses `where claude`; paths with spaces are shell-quoted for the `--version` probe (mirror `quoteForShell`, detect.ts:73-76).

## Dependencies

- (none)

## Interfaces

- Consumes: `compareVersions` from `src/ai/omp/detect.ts:24` (existing export).
- Produces:
  - `export interface ClaudeCodeDetection { available: boolean; ok: boolean; path?: string; version?: string; reason?: string }` (same shape as `OmpDetection`)
  - `export type ExecFn = (cmd: string) => Promise<string>`
  - `export async function detectClaudeCode(execFn?: ExecFn): Promise<ClaudeCodeDetection>`
  - `MIN_CLAUDE_CODE_VERSION`, `CLAUDE_CODE_INSTALL_HINT`
  — consumed by TASK-005 (spawn path), TASK-007 (resolution), TASK-012 (host wiring).

---

## Discussion

### 2026-09-07 · planner · unic-smart
Version parse target: `claude --version` prints e.g. `2.0.1 (Claude Code)` — parse the first `/\d+(?:\.\d+)+/` token. The 1.0.0 floor is a planner-chosen constant; if you have evidence a lower/higher floor is correct, note it here and adjust the constant only.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
