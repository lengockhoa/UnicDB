# TASK-ARP09-005 — Runner gate (conditional, expected NOT-NEEDED)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (09.5) — wave 3

## Goal

Close the roadmap's ARP-09.5 "runner" requirement: decide whether a NEW runner script is needed. Expected verdict: **NOT-NEEDED** — `scripts/verify-release.sh` already exists (POSIX, staged `PASS <stage>`/first-failure `FAIL <stage>` + `FAIL verify:release`, verbatim exit-code propagation) and is pinned by `releaseVerify.test.ts`; `profile:release` (002) names a portable ordered gate (`npm run verify:release`). Record the evidence. Only if a genuine gap is found (the sole plausible one: a Windows `.cmd` wrapper — made moot because `profile:release` uses `npm run`, no `bash` dependency) design it as a new file owned by this task.

## Target Files

- (none expected) — closes NOT-NEEDED; evidence recorded in `docs/AI_HANDOFF/PLAN.md` §Planner Self-Audit `Known gaps` and/or this task's Discussion.
- Conditional only: a new runner wrapper file if a real gap is found (design then; keep it conditional and portable).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 30 | happy | `scripts/verify-release.sh` | exists, executable (mode & 0o111), POSIX shebang (`#!/bin/sh`/`#!/usr/bin/env sh`/`#!/usr/bin/env bash`) | already pinned by `releaseVerify.test.ts` — re-run confirms |
| 31 | happy | `profile:release` references a real gate | equals `npm run verify:release` → ordered chain `test → typecheck → compile`, `&&` propagates first non-zero | package.json |
| 32 | edge (portable) | npm scripts contain no `bash`/`sh` invocation | `profile:*` + `verify:*` contain no `bash`/`sh`/`.sh` token → runs on Windows/macOS/Linux npm unchanged | package.json scan |
| 33 | edge (non-zero propagation) | `releaseVerify.test.ts` FAIL-stage case | first non-zero stage aborts, later stages do NOT run, exit code propagated verbatim (runner untouched this cycle) | existing test |

## Test Files

- `src/__tests__/releaseVerify.test.ts` — consumed, NOT modified (it already pins the runner).
- `package.json` — consumed (profile pins from 002), NOT modified by this task.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/__tests__/releaseVerify.test.ts
node -e 'const p=require("./package.json"); if(p.scripts["profile:release"]!=="npm run verify:release")process.exit(1); console.log("profile:release ok")'
test -x scripts/verify-release.sh && echo "runner executable"
```

## Acceptance Criteria

- [ ] NOT-NEEDED close recorded with evidence (#30-#33 pass; `verify-release.sh` unchanged; no new script file).
- [ ] No `bash` dependency introduced into npm scripts (portability #31).
- [ ] If a real gap is found instead, it is designed, owned here, and its tests added to this task before any close.
- [ ] `npm run typecheck` and the focused vitest run exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP09-002 must complete first (its `profile:release` key is the subject of #31; wave 3).

## Interfaces

- Consumes: `scripts/verify-release.sh` (existing runner); `package.json` `profile:release`/`verify:*` (002); `releaseVerify.test.ts` pins.
- Produces: (expected) none — a recorded NOT-NEEDED verdict. (Conditional) a new runner wrapper if a gap is found.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
