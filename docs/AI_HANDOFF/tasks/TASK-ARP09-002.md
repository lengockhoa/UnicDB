# TASK-ARP09-002 — Release-confidence profiles (named fast/release)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (09.2) — wave 1

## Goal

Add two NAMED release-confidence profiles to `package.json` scripts that reference ONLY real existing commands — `profile:fast` and `profile:release` — and pin them (plus the untouched baseline/verify scripts) in `src/__tests__/releaseHygiene.test.ts`. The roadmap's gap is "no named profile keys at all"; the pinned `verify:fast`/`verify:release` strings MUST NOT change, so the new profiles are NEW keys. Note: `profile:fast` being byte-identical in effect to the existing `verify:fast` is INTENDED — the deliverable is the named profile key itself (roadmap "named profiles"), a naming namespace over the same stage sets as `verify:*`, deliberately kept in lockstep; there is no third implementation.

## Target Files

- `package.json` — scripts section: ADD `"profile:fast": "npm run typecheck && npm run compile"` and `"profile:release": "npm run verify:release"`. Do NOT touch `test`/`typecheck`/`compile`/`test:integration`/`verify:fast`/`verify:release`/`package`/`watch`/`vscode:prepublish`, and do NOT touch contributes/configuration (003 owns those in wave 2).
- `src/__tests__/releaseHygiene.test.ts` — append a new `describe("release profiles (ARP-09)", ...)` block with the pins below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 10 | happy | `profile:fast` exists | equals exactly `"npm run typecheck && npm run compile"` | read package.json from disk |
| 11 | happy | `profile:release` exists | equals exactly `"npm run verify:release"` | read package.json from disk |
| 12 | edge (reference integrity) | every `npm run <key>` fragment across `profile:*` values | resolves to a real key in `pkg.scripts` | split on `&&`, trim, match `/^npm run (.+)$/` |
| 13 | edge (shell-injection) | `profile:*` values | contain no `` ` ``, `$(`, `;`, `|`, `>`, `<` | value scan (mirrors releaseVerify style) |
| 14 | regression | baseline + verify pins preserved | `test`/`typecheck`/`compile`/`test:integration` AND `verify:fast`/`verify:release` byte-identical to today's strings | assert against literals |
| 15 | edge (config untouched) | package.json `contributes.configuration.properties` | does NOT contain `vsdb.diagnostics.verbosity` (documents the YAGNI rejection — the setting was deliberately not added this cycle) | scan keys |
| 16 | regression | `releaseVerify.test.ts` stays green | run it unchanged (its `verify:*` + baseline + runner pins all pass) | existing file, no modification |

## Test Files

- `src/__tests__/releaseHygiene.test.ts` — new profile-pin describe appended (existing 3 tests untouched).
- `src/__tests__/releaseVerify.test.ts` — NOT modified; must stay green (cross-file constraint).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/__tests__/releaseHygiene.test.ts src/__tests__/releaseVerify.test.ts
node -e 'const p=require("./package.json"); const assert=(c,m)=>{if(!c)throw new Error(m)}; assert(p.scripts["profile:fast"]==="npm run typecheck && npm run compile","profile:fast"); assert(p.scripts["profile:release"]==="npm run verify:release","profile:release"); console.log("profiles ok")'
```

## Acceptance Criteria

- [ ] `package.json` gains exactly the two `profile:*` keys with the exact values above; every other script byte-identical.
- [ ] `releaseHygiene.test.ts` new pins pass; the existing 3 hygiene tests pass; `releaseVerify.test.ts` (unchanged) passes.
- [ ] `profile:*` values reference only real existing artifacts and have no shell-injection surface.
- [ ] No `vsdb.diagnostics.verbosity` configuration key added (rejection documented in PLAN §3).
- [ ] `npm run typecheck` and both focused vitest runs exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — wave 1, parallel with TASK-ARP09-001 (disjoint files). `package.json` scripts edit is completed in this wave; 003 edits the commands/activationEvents sections in wave 2 (serialized across waves, different sections).

## Interfaces

- Consumes: existing `package.json` scripts `typecheck` (`tsc --noEmit`), `compile` (`node esbuild.js`), `verify:release` (`npm test && npm run typecheck && npm run compile`); the four pinned baseline scripts; `scripts/verify-release.sh` (existing runner, unchanged).
- Produces: new npm scripts `profile:fast` and `profile:release`; new releaseHygiene pins. 005 (runner gate, wave 3) verifies `profile:release` references a real portable gate.

---

## Discussion

(no comments yet)

- [executor, 2026-09-02] Ambiguity: task file §Target Files names the describe block `release profiles (ARP-09)`; the executor dispatch names it `release confidence profiles (ARP-09)`. Chose the dispatch's string (more specific instruction; task file names the tests, dispatch names the describe). Also included task-file Test Case 15 (`vsdb.diagnostics.verbosity` YAGNI guard), which the dispatch's test list omitted — task file is the contract. Task file Test Case 16 (releaseVerify stays green) satisfied by running the file unchanged (19/19 combined).

---

## Executor Report

- Status: DONE
- Executor tool: claude-code
- Executor model: unic-code
- Executor subagent: -

### RED (step 2)

Command: `npx vitest run src/__tests__/releaseHygiene.test.ts`

```
 FAIL  src/__tests__/releaseHygiene.test.ts > release confidence profiles (ARP-09) > profile:fast exists and equals the pinned fast-profile string
AssertionError: expected undefined to be 'npm run typecheck && npm run compile'

 FAIL  src/__tests__/releaseHygiene.test.ts > release confidence profiles (ARP-09) > profile:release exists and delegates to the pinned verify:release
AssertionError: expected undefined to be 'npm run verify:release'

 FAIL  src/__tests__/releaseHygiene.test.ts > release confidence profiles (ARP-09) > profile:* keys are exactly the two named profiles (no extras)
AssertionError: expected [ Array(0) ] to deeply equal [ 'profile:fast', 'profile:release' ]

 FAIL  src/__tests__/releaseHygiene.test.ts > release confidence profiles (ARP-09) > profile:* values reference ONLY real existing script keys
AssertionError: profile:* keys phải tồn tại để pin này có ý nghĩa: expected 0 to be greater than 0

 FAIL  src/__tests__/releaseHygiene.test.ts > release confidence profiles (ARP-09) > profile:* values have no shell-injection surface
AssertionError: profile:* keys phải tồn tại để pin này có ý nghĩa: expected 0 to be greater than 0

 Test Files  1 failed (1)
      Tests  5 failed | 5 passed (10)
```

All 5 failures are the new profile pins failing because `profile:*` keys do not exist (pre-state); the 3 pre-existing hygiene tests + the baseline-pins guard + the YAGNI config guard pass pre-change. RED for the expected reason.

### Implementation (step 3)

- `package.json`: added exactly two script keys after `verify:release` — `"profile:fast": "npm run typecheck && npm run compile"` and `"profile:release": "npm run verify:release"`. No other byte changed (git diff --stat: package.json | 2 +).
- `src/__tests__/releaseHygiene.test.ts`: appended `describe("release confidence profiles (ARP-09)")` with 7 tests (pins for both keys, exact key-set, reference integrity, shell-injection scan, baseline regression guard, YAGNI config guard). Existing 3 tests untouched.

### GREEN + Verification (step 5, fresh in this turn)

1. `npm run typecheck` → exit 0 (`tsc --noEmit`, no output).
2. `npx vitest run src/__tests__/releaseHygiene.test.ts src/__tests__/releaseVerify.test.ts`:

```
 ✓ src/__tests__/releaseHygiene.test.ts  (10 tests) 7ms
 ✓ src/__tests__/releaseVerify.test.ts  (9 tests) 677ms

 Test Files  2 passed (2)
      Tests  19 passed (19)
```

3. Task-file node assertion → `profiles ok`.

`git status --porcelain`: only `M package.json`, `M src/__tests__/releaseHygiene.test.ts` (task file edited after this check, per handoff contract). No git add/commit/push performed.

### Acceptance Criteria

- [x] `package.json` gains exactly the two `profile:*` keys with exact values; every other script byte-identical (pinned by test).
- [x] New hygiene pins pass; existing 3 hygiene tests pass; `releaseVerify.test.ts` (unchanged) passes.
- [x] `profile:*` values reference only real keys (`typecheck`, `compile`, `verify:release`) and have no shell-injection surface.
- [x] No `vsdb.diagnostics.verbosity` configuration key added (guard test pins the rejection).
- [x] `npm run typecheck` and both focused vitest runs exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/__tests__/releaseHygiene.test.ts src/__tests__/releaseVerify.test.ts && npm run typecheck
  result: 20 pass / 0 fail (hygiene 10 + releaseVerify 10); tsc --noEmit exit 0 (fresh re-run at HEAD, clean tree)
TEST_PLAN_COVERAGE: all-followed — cases 10-16 implemented; describe-name ambiguity (task file vs dispatch) resolved and documented in Discussion; baseline scripts verified byte-identical between 1c07da6 and HEAD
FINDINGS:
  critical:
    - (none)
  important:
    - (none)
  minor:
    - src/__tests__/releaseVerify.test.ts:155-168 — wave-3 task 005 added a duplicate profile:release pin in this range; harmless belt-and-braces, informational only (002's own wave-1 commit left releaseVerify untouched — verified empty diff).
NEXT_STATUS_FOR_INDEX: approved
NOTES: Pins use hardcoded literals, not package.json's own values (not tautological); the case-15 YAGNI guard is non-vacuous (configuration.properties has 9 real keys, vsdb.diagnostics.verbosity absent); releaseVerify's injection/reference scans iterate ONLY verify:* (releaseVerify.test.ts:172,208) so profile:* keys are unconstrained there — the plan claim holds. R4.5 (817315f) audited for the orchestrator: package.json icons + extension.ts comment are clean; one comment-satisfiable regex weakness in the rewritten trace.test.ts:401 appendLine pin is reported separately (file owned by 004/R4.5, not this task).
