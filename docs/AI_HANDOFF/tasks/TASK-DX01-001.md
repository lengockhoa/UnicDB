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

This task adds no own test file. The contract is locked down by `TASK-DX01-003` (`src/__tests__/releaseHygiene.test.ts`) which reads `package.json` and asserts:

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `verify:fast` exists, composed of typecheck + compile only | `scripts["verify:fast"]` matches `/^npm run (typecheck\|compile)( && npm run (typecheck\|compile))?$/` (set membership, order-insensitive) | `src/__tests__/releaseHygiene.test.ts` reads `package.json` from repo root |
| 2 | unit | `verify:release` exists, exact order test→typecheck→compile | `scripts["verify:release"]` matches exactly `/^npm test && npm run typecheck && npm run compile$/` | Same |
| 3 | edge | script strings have no shell-injection surface | Neither string contains `` ` ``, `$(`, `;`, `\|`, `>`, or `<`; each matches `^npm[^`]*$` | Same |
| 4 | regression | existing four scripts unchanged vs. v1.35.0 baseline | `test`, `typecheck`, `compile`, `test:integration` byte-identical to a known fixture | `releaseHygiene.test.ts` fixture string |

## Test Files

- `src/__tests__/releaseHygiene.test.ts` (added by TASK-DX01-003) — cases 1–4.

## Verification Commands

```bash
node -e 'const p=require("./package.json"); for (const k of ["verify:fast","verify:release"]) { if (typeof p.scripts[k] !== "string") process.exit(1); }'
npx vitest run src/__tests__/releaseHygiene.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `package.json` `scripts` contains `verify:fast` and `verify:release` keys.
- [ ] `verify:fast` value is exactly `npm run typecheck && npm run compile` (or `npm run compile && npm run typecheck` — the contract test accepts either order; the chosen order is documented in the test fixture).
- [ ] `verify:release` value is exactly `npm test && npm run typecheck && npm run compile` (exact order pinned by the contract test).
- [ ] Neither string contains a backtick, `$(`, `;`, `|`, `>`, or `<` (case 3).
- [ ] `test`, `typecheck`, `compile`, `test:integration` keys remain byte-identical to v1.35.0 (case 4 regression).
- [ ] `npx vitest run src/__tests__/releaseHygiene.test.ts` is green (3+ cases pass; 4 if the regression test ships in this cycle's test file).
- [ ] `npm run typecheck` and `npm run compile` exit 0.
- [ ] `npx vitest run` shows no regression vs. the v1.35.0 baseline.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DX01-003 (the test file that asserts the contract)

## Interfaces

- Consumes: (none — pure data change to `package.json`)
- Produces: two `package.json` script keys `scripts["verify:fast"]` and `scripts["verify:release"]` consumed verbatim by `TASK-DX01-002`'s runner (`scripts/verify-release.sh`) and by `TASK-DX01-003`'s contract test. The values are referenced by name only — never by a magic string inside the runner, so a future rename of either script just requires updating the runner and the test.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

## Reviewer Verdict

(to be appended by Phase 4 reviewer)
