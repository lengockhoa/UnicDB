# TASK-CLEAN2-005 — codexLiveSmoke: fail-fast spawn errors, pin gate name

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (items #10, #11 plus bounded sibling-doc extension), §3

## Goal
Apply the requested TASK-014 smoke-helper fixes to Codex's independent file: make missing
`codex` reject fast rather than wait 30 seconds and rename the tautological companion test
to pin the gate variable. Preserve Codex's `exec --json - --cd` argv and stdin `ping\n` feed
exactly.

## Target Files
- `src/ai/codex/__tests__/codexLiveSmoke.test.ts` — capture spawn errors in a closure cell;
  add file-local `startProbe(bin, args, cwd)` and preserve the current Codex argv/stdin feed
  through `startCodex`; pass a getter into `awaitFirstEvent` and reject at entry + interval
  tick for ENOENT; hoist `const GATE_ENV = "UnicDB_CODEX_SMOKE"` for `describe.skipIf` and
  its renamed companion test. No wording/code change outside caller items #10/#11.

## Test Cases (REQUIRED — TDD)
| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (regression) | existing `codexLiveSmoke` suite under default environment | passes after the clarity-only companion-test rename; the live describe is skipped by `UnicDB_CODEX_SMOKE`, non-gated helper tests pass, and no real Codex binary spawns | default environment |
| 2 | edge (RED→GREEN, missing binary) | `spawn error surfaces fast (missing binary)` — non-gated | nonexistent `unicdb-smoke-missing-binary` stores ENOENT in the closure cell and `awaitFirstEvent` rejects that error within ~30ms / <5000ms, rather than waiting 30s | today: only `timed out after 30000ms` after 30s → RED (test timeout 10s) |
| 3 | edge (timer) | `resolves the first pushed event while timeout remains pending` using `vi` fake timers | event at the 25ms poll returns the exact fixture event; do not clear the 30s timeout (separate out-of-scope finding) | fixture events |
| 4 | edge (gate semantics) | renamed companion test and default-env Vitest report | `GATE_ENV` is the non-empty string `"UnicDB_CODEX_SMOKE"`; with it unset, `npx vitest run ...codexLiveSmoke.test.ts` reports exactly `1 skipped` for the gated live test | module-local const; unset environment |
| 5 | edge (stdin preservation) | Codex argv/stdin source-contract check | file-local grep confirms unchanged `"exec", "--json", "-", "--cd", workspace` argv and `child.stdin.write("ping\n")` followed by `.end()`; existing test inputs remain unchanged | current file contract |

## Test Files

- `src/ai/codex/__tests__/codexLiveSmoke.test.ts` — own test file, extended with a
  non-gated helper-contract describe. No tests-map.json entry exists because it is itself
  the test target; direct selection is non-empty.

## Verification Commands

```bash
UnicDB_CODEX_SMOKE= npx vitest run src/ai/codex/__tests__/codexLiveSmoke.test.ts  # expect: non-gated tests pass; 1 skipped
# Source-contract checks: preserved Codex argv/stdin feed.
grep -qF '"exec",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF '"--json",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF '"-",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF '"--cd",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF 'child.stdin.write("ping\n")' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF 'child.stdin.end()' src/ai/codex/__tests__/codexLiveSmoke.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Test #2 has genuine pre-fix RED output (30s-timeout behavior) and post-fix GREEN
      output; test timeout stays ≤10 seconds.
- [ ] Renamed companion test pins non-empty `GATE_ENV === "UnicDB_CODEX_SMOKE"`; default-env
      Vitest output reports exactly 1 skipped gated live test.
- [ ] Missing-binary test is hermetic; no API key/DB credential or dangerous-bypass argument
      is added.
- [ ] File-local argv/stdin grep checks confirm `exec --json - --cd`, `ping\n`, and `.end()`
      remain exactly present; existing test inputs remain unchanged.
- [ ] typecheck exit 0. lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: file-local probe/awaitFirstEvent contract only; no exports/cross-task input.

---

## Discussion

### 2026-09-08 · planner · unic-smart
Keep this independent from TASK-CLEAN2-004 despite its intentionally parallel shape — a
shared helper would create an unnecessary dependency/same-file collision. Deliberate scope
boundaries: do NOT alter Codex's header prompt wording (caller #6 names Claude only), and
do NOT clear the 30s success timer (separate TASK-014 sub-finding), both deferred to the
next cleanup pass.
