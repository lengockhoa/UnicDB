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

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
