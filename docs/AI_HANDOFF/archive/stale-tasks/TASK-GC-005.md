# TASK-GC-005 — User guide: Generate Commit Message + Lite Model + Engine sections

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1/§2

## Goal

DOC-ONLY task: documentation plus its scanner test — no source files. Document the three
user-facing surfaces in `docs/UNICDB_USER_GUIDE.md` (Vietnamese, matching the guide's
existing tone/structure): the Source Control sparkle button, the new "Lite model" section in
AI Settings (model ID + engine, omp default), and the now-visible global Engine dropdown.
Locked strings come from PLAN §1 so the docs cannot drift from the code.

## Target Files

- `docs/UNICDB_USER_GUIDE.md` — add a "Generate Commit Message" section (button location in
  the Source Control title bar, requires git changes, fills the commit input, uses the Lite
  Model), a "Lite model" subsection under the AI Settings content (model ID optional = feature
  disabled; Engine dropdown `omp` (default) / `builtin`; when omp is unavailable the command
  says so instead of silently falling back), and a note that the global Engine dropdown
  chooses the chat engine (`builtin` default / `omp`).
- `src/ui/__tests__/userGuideContent.test.ts` — extend the existing scanner with a new
  describe block asserting the GC keywords (below). Pattern: pure `readFileSync` +
  `requiredKeywords` array, same as the existing describes.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | GC section keywords present | content contains all of: "Generate Commit Message", "Source Control", "Lite model", "Conventional Commits", "Open AI Settings" | docs/UNICDB_USER_GUIDE.md |
| 2 | happy | engine dropdown documented | content contains "Engine" and both literals "builtin" and "omp" | same file |
| 3 | edge (empty) | guide stays non-empty / structure intact | file length still > 200 chars and all pre-existing requiredKeywords still match (existing asserts unchanged) | same file |
| 4 | edge (malformed) | command title mentioned exactly once | `content.split("Generate Commit Message").length - 1 === 1` — the guide introduces the button by its title once and refers to "the sparkle button" afterwards | same file |
| 5 | regression | existing keyword scan untouched | the original `requiredKeywords` array (Cài đặt, Kết nối, …) is not weakened | test file diff |

## Test Files

- `src/ui/__tests__/userGuideContent.test.ts` — contains tests #1–#5 (new describe block).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/userGuideContent.test.ts
```

(No lint script exists in this project — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] Tests #1–#5 green; existing describes in the file still pass.
- [ ] Doc language/style matches the surrounding Vietnamese sections; no English wall-of-text.
- [ ] Documented behavior matches PLAN §1 frozen strings exactly (toast wording, engine
      default omp, optional-empty lite).

## Dependencies

- (none) — all documented strings/behaviors are planner-frozen in PLAN §1; GC-005 does not
  import code and owns its files exclusively in wave 1.

## Interfaces

- Consumes: PLAN §1 frozen-strings table (values only, no code).
- Produces: (none) — documentation only.

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: the guide historically dropped from the .vsix due to a filename case typo —
do NOT rename or re-case the file (header comment in the test file explains the
case-sensitive `.vscodeignore` hazard). Extend in place.

(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: |
   ❯ src/ui/__tests__/userGuideContent.test.ts:84:21
       82|   it("GC#2 engine dropdown documented (Engine + builtin + omp)", () =>…
       83|     expect(content).toContain("Engine");
       84|     expect(content).toContain("builtin");
         |                     ^
       85|     expect(content).toContain("omp");
       86|   });

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/7]⎯

   FAIL  src/ui/__tests__/userGuideContent.test.ts > TASK-GC-005 — docs/UNICDB_USER_GUIDE.md (Generate Commit + Lite Model + Engine) > GC#4 'Generate Commit Message' command title appears exactly once
  AssertionError: expected +0 to be 1 // Object.is equality

  - Expected
  + Received

  - 1
  + 0

   ❯ src/ui/__tests__/userGuideContent.test.ts:114:25
      112|     // to "the sparkle button" afterwards (PLANNER-FROZEN assertion).
      113|     const occurrences = content.split("Generate Commit Message").lengt…
      114|     expect(occurrences).toBe(1);
         |                         ^
      115|   });
      116| 

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/7]⎯

   Test Files  1 failed (1)
        Tests  7 failed | 19 passed (26)
     Start at  14:06:42
     Duration  150ms (transform 16ms, setup 0ms, collect 12ms, tests 6ms, environment 0ms, prepare 39ms)
Verification Output: |
   > UnicDB@1.51.7 typecheck
   > tsc --noEmit
   (no errors)

   > vitest run src/ui/__tests__/userGuideContent.test.ts
   ✓ src/ui/__tests__/userGuideContent.test.ts  (26 tests) 2ms
   Test Files  1 passed (1)
        Tests  26 passed (26)

   > npm test (full suite)
   Test Files  244 passed | 1 skipped (245)
        Tests  3629 passed | 2 skipped (3631)
     Duration  18.25s
Status: PASS
Note: DOC-ONLY task. Doc sections added under "Settings hub (R8b)" in Vietnamese
matching existing tone; "Generate Commit Message" appears exactly once as the
command title (subsequent references use "nút sparkle"). Engine dropdown
documented with both literals `builtin` + `omp`. Existing keyword scan
unchanged — added new describe block alongside original. node_modules and
dist symlinked from main checkout (per worktree instructions).
