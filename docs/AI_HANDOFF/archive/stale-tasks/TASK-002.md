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

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-002
   ❯ src/ai/claudeCode/__tests__/detect.test.ts  (0 test)
   FAIL  src/ai/claudeCode/__tests__/detect.test.ts [ src/ai/claudeCode/__tests__/detect.test.ts ]
  Error: Failed to load url ../detect (resolved id: ../detect) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-002/src/ai/claudeCode/__tests__/detect.test.ts. Does the file exist?
   Test Files  1 failed (1)
        Tests  no tests
VERIFICATION_OUTPUT: |
  > npx vitest run src/ai/claudeCode/__tests__/detect.test.ts
   ✓ src/ai/claudeCode/__tests__/detect.test.ts  (11 tests) 3ms
     Tests  11 passed (11)
  > npm run typecheck
   > UnicDB@1.53.23 typecheck
   > tsc --noEmit
   (exit 0, no errors)
STATUS: PASS
NOTE: compareVersions is imported and reused from src/ai/omp/detect.ts. MIN_CLAUDE_CODE_VERSION = "1.0.0" and CLAUDE_CODE_INSTALL_HINT = "npm install -g @anthropic-ai/claude-code" exported. Win32 uses `where claude`; multi-line output → first non-empty path. quoteForShell applied for paths with spaces.

---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-5
VERIFICATION_RERUN:
  command: npx vitest run src/ai/claudeCode/__tests__/detect.test.ts && npm run typecheck
  result: 11 pass / 0 fail; tsc --noEmit exit 0 (both re-run fresh by reviewer, PASS)
TEST_PLAN_COVERAGE: all-followed — table cases 1-5 all present (happy test.ts:12, not-installed :31, boundary :46-69 with exact-MIN 1.0.0 ok + 0.9.9/0.9.0 too-old, malformed :72, win32 :100) plus extras (non-win32 :118, quoted path :133, constants :152). RED_OUTPUT is a genuine pre-implementation module-load failure (non-zero exit), not a bare claim.
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ai/claudeCode/detect.ts:111 + src/ai/claudeCode/__tests__/detect.test.ts:161 — files end without a trailing newline; omp mirrors (omp/detect.ts, omp/__tests__/detect.test.ts) both end with \n. Add newline on next touch.
    - src/ai/claudeCode/detect.ts:82-89 — spawn-failed branch (--version probe rejects) has no test; parity gap inherited from src/ai/omp/__tests__/detect.test.ts (same gap there). Suggest one probe-rejection test in a follow-up; TASK-003 reviewer should check codex for the same gap.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Contract verified: detectClaudeCode mirrors omp/detect.ts reason taxonomy exactly (not-installed :75, spawn-failed :87, version-unknown :96, version-too-old :106); compareVersions reused from ../omp/detect (detect.ts:5, no duplicate); win32 `where claude` (:41) + quoteForShell (:51-54) byte-identical to omp detect.ts:73-76; no codex/ or TASK-005 imports. Exported constant names follow the task file's Acceptance Criteria (MIN_CLAUDE_CODE_VERSION / CLAUDE_CODE_INSTALL_HINT); the orchestrator prompt's shorthand MIN_CLAUDE_VERSION / CLAUDE_INSTALL_HINT is not the contract.
