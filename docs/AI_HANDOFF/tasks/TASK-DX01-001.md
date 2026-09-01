# TASK-DX01-001 — `verify:fast` and `verify:release` script entries

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_DX01.md` §3

## Goal

Add two `package.json` script entries — `verify:fast` (typecheck + compile) and `verify:release` (test + typecheck + compile) — composed strictly from existing commands. No new field, no new test file, no other `scripts` key changes.

## Target Files

- `package.json` — add the two `scripts.<name>: <command>` entries inside the existing `"scripts"` object, alphabetically next to `test`/`typecheck`/`compile` so the diff is reviewable in one hunk. Pre-existing keys (`compile`, `watch`, `test`, `test:integration`, `typecheck`, `package`, `vscode:prepublish`) MUST stay byte-identical to v1.35.0.

## Test Cases (REQUIRED — TDD)

This task adds no own test file. The contract is locked down by `TASK-DX01-003` (`src/__tests__/releaseVerify.test.ts`) which reads `package.json` and asserts:

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `verify:fast` exists, composed of typecheck + compile only | `scripts["verify:fast"]` is exactly one of the two allowed strings: `"npm run typecheck && npm run compile"` OR `"npm run compile && npm run typecheck"` (test uses set-membership, not regex) | `src/__tests__/releaseVerify.test.ts` reads `package.json` from repo root |
| 2 | unit | `verify:release` exists, exact order test→typecheck→compile | `scripts["verify:release"]` is exactly `"npm test && npm run typecheck && npm run compile"` (single pinned string, no alternation) | Same |
| 3 | edge | script strings have no shell-injection surface | Neither string contains `` ` ``, `$(`, `;`, `|`, `>`, or `<`; each matches `^npm[^`]*$` | Same |
| 4 | edge | added script values reference ONLY pre-existing script keys | Each `verify:*` value, when split on `&&`, contains only the substrings `"npm run typecheck"`, `"npm run compile"`, `"npm test"` — never a fabricated name like `npm run lint` that is not a key in `scripts` | Same |
| 5 | regression | existing four scripts unchanged vs. v1.35.0 baseline | `test`, `typecheck`, `compile`, `test:integration` byte-identical to a known fixture | `releaseVerify.test.ts` fixture string |

## Test Files

- `src/__tests__/releaseVerify.test.ts` (added by TASK-DX01-003) — cases 1–5.

## Verification Commands

```bash
node -e 'const p=require("./package.json"); for (const k of ["verify:fast","verify:release"]) { if (typeof p.scripts[k] !== "string") process.exit(1); }'
npx vitest run src/__tests__/releaseVerify.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `package.json` `scripts` contains `verify:fast` and `verify:release` keys.
- [ ] `verify:fast` value is exactly `npm run typecheck && npm run compile` (or `npm run compile && npm run typecheck` — the contract test accepts either order; the chosen order is documented in the test fixture).
- [ ] `verify:release` value is exactly `npm test && npm run typecheck && npm run compile` (exact order pinned by the contract test).
- [ ] Neither string contains a backtick, `$(`, `;`, `|`, `>`, or `<` (case 3).
- [ ] Each new script value references only the existing script keys `test`, `typecheck`, `compile` — never a fabricated name (case 4).
- [ ] `test`, `typecheck`, `compile`, `test:integration` keys remain byte-identical to v1.35.0 (case 5 regression).
- [ ] `npx vitest run src/__tests__/releaseVerify.test.ts` is green (9 cases pass — TASK-003 ships all nine contract cases including the mirrored case 4 / 9 fabricated-name edge from this task).
- [ ] `npm run typecheck` and `npm run compile` exit 0.
- [ ] `npx vitest run` shows no regression vs. the v1.35.0 baseline.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DX01-003 (the test file that asserts the contract — TDD-RED-first: 003 writes the test, expects RED, then this task's `package.json` write flips it GREEN)

## Interfaces

- Consumes: (none — pure data change to `package.json`)
- Produces: two `package.json` script keys `scripts["verify:fast"]` and `scripts["verify:release"]` consumed verbatim by `TASK-DX01-002`'s runner (`scripts/verify-release.sh`) and by `TASK-DX01-003`'s contract test. The values are referenced by name only — never by a magic string inside the runner, so a future rename of either script just requires updating the runner and the test. (Note: `TASK-DX01-002`'s runner does hardcode the three sub-command strings `npm test` / `npm run typecheck` / `npm run compile` to emit per-stage PASS lines; that is intentional and tested in TASK-002 cases 1–3 — TASK-001 owns only the `package.json` contract, while TASK-002 owns the runner's hardcoded command names.)

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

## Reviewer Verdict

(to be appended by Phase 4 reviewer)
