# TASK-RP-002 — User guide: remove resultsPlacement, document forced bottom-panel placement

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §6 AC6

## Goal

Update the user guide so it no longer documents the (now removed) `UnicDB.resultsPlacement`
setting, and instead documents that SQL results ALWAYS open in the bottom panel area as a tab
next to Terminal — never beside/below the SQL editor, never in the right sidebar.

## Target Files

- `docs/UNICDB_USER_GUIDE.md` — rewrite the placement bullets at lines ~82-83 (Settings section) and ~119 (results section): delete the `UnicDB.resultsPlacement` setting explanation and replace with the fixed bottom-panel behavior (Vietnamese, matching the file's voice).
- `src/ui/__tests__/userGuideContent.test.ts` — flip test `#4` (lines 47-49) from `expect(content).toContain("UnicDB.resultsPlacement")` to `expect(content).not.toContain("UnicDB.resultsPlacement")`; add a positive assertion that the guide documents the bottom-panel placement (e.g. contains `panel` or `Terminal` in the results section context).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (flipped) | `#4 does NOT mention the removed UnicDB.resultsPlacement setting` | `expect(content).not.toContain("UnicDB.resultsPlacement")` passes; RED against current guide (lines 82, 119 contain it) | `readFileSync(docs/UNICDB_USER_GUIDE.md)` |
| 2 | edge (negative, whole-token scan) | `#4b no stale placement option words remain in a settings context` | Guide does NOT contain `"resultsPlacement"` in ANY casing (`toLowerCase()` scan) and does NOT contain `"beside"` / `"top"` in the results-placement bullet context (assert `"moveEditorToBelowGroup"` absent too) | same file content |
| 3 | edge (positive coverage) | `#4c guide documents the fixed bottom-panel placement` | Guide contains the string `Terminal` within 3 lines of a `Results` mention (contextual regex `/Results[\s\S]{0,400}?Terminal|Terminal[\s\S]{0,400}?Results/i` matches), asserting the new behavior is actually documented, not just the old text deleted | same file content |
| 4 | regression (suite) | existing `#1`–`#3`, `#5` still pass | File exists, >200 chars, all 10 section keywords present, book icon mention present — untouched by the edit | unchanged test code |

## Test Files

- `src/ui/__tests__/userGuideContent.test.ts` — cases 1–4 (file already loaded via `readFileSync` at the top of the suite).

## Verification Commands

```bash
npm test src/ui/__tests__/userGuideContent.test.ts
npm run typecheck
npm run compile
```

(No lint script exists in this repo — `typecheck` + `compile` are the static gates.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (case 1 is RED before the guide edit).
- [ ] `docs/UNICDB_USER_GUIDE.md` contains zero occurrences of `resultsPlacement`.
- [ ] The new placement text states results open in the bottom panel next to Terminal and that this is not configurable.
- [ ] No other guide sections changed (diff limited to the two placement bullets).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: documentation contract consumed by TASK-RP-004's optional docs assertion — the guide must NOT contain `resultsPlacement` after this task.

---

## Discussion

### 2026-09-06 · planner · unic-smart
- The test file comment warns the guide path case must stay `docs/UNICDB_USER_GUIDE.md` exactly (vsce `.vscodeignore` case sensitivity) — do not rename anything.
- Keep the guide's existing Vietnamese tone; suggested replacement bullet: "Kết quả SQL luôn mở ở panel dưới màn hình (cạnh tab Terminal) — không thể đổi vị trí, không còn setting `resultsPlacement`."
- This task is intentionally independent of the code tasks (wave 1 parallel) — it only touches the guide and its content test.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
