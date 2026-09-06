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
