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

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Flipped test #4 to assert UnicDB.resultsPlacement is absent; added #4b (case-insensitive token scan, no 'beside', no 'moveEditorToBelowGroup') and #4c (Results<->Terminal proximity regex). Rewrote the Results section bullet and removed the settings entry in docs/UNICDB_USER_GUIDE.md so the guide documents the forced bottom-panel placement next to Terminal and contains zero occurrences of the removed setting token.
TEST_PLAN_FOLLOWED: task §4 — flipped test #4 + added #4b/#4c inline per task §Test Cases (case 1 was RED before the guide edit)
FILES_CHANGED:
  - docs/UNICDB_USER_GUIDE.md: replaced Results section placement bullet with fixed bottom-panel statement; removed UnicDB.resultsPlacement entry from Settings hub list
  - src/ui/__tests__/userGuideContent.test.ts: flipped #4 to not.toContain; added #4b case-insensitive + token scan; added #4c Results<->Terminal regex
TESTS_ADDED:
  - src/ui/__tests__/userGuideContent.test.ts: #4 (flipped), #4b (stale placement token scan), #4c (bottom-panel placement regex)
VERIFICATION:
  command: npm test src/ui/__tests__/userGuideContent.test.ts
  result: 16 pass / 0 fail / exit code 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-002
     ✓ src/ui/__tests__/userGuideContent.test.ts  (16 tests) 2ms
     Test Files  1 passed (1)
          Tests  16 passed (16)
       Duration  145ms
  command: npm run typecheck
  result: exit code 0 (tsc --noEmit, clean)
  output_excerpt: |
    > UnicDB@1.51.6 typecheck
    > tsc --noEmit
  command: npm run compile
  result: exit code 0 (esbuild build complete)
  output_excerpt: |
    dist/extension.js       6.4mb ⚠️
    dist/extension.js.map  11.3mb
    esbuild: build complete
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

### RED_OUTPUT

```
> UnicDB@1.51.6 test
> vitest run src/ui/__tests__/userGuideContent.test.ts


 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-002

 ❯ src/ui/__tests__/userGuideContent.test.ts  (16 tests | 3 failed) 5ms
   ❯ src/ui/__tests__/userGuideContent.test.ts > TASK-UX1-004 (R2) — docs/UNICDB_USER_GUIDE.md > #4 does NOT mention the removed UnicDB.resultsPlacement setting
     → expected '# Hướng dẫn sử dụng UnicDB\n\n> Hướng…' not to contain 'UnicDB.resultsPlacement'
   ❯ src/ui/__tests__/userGuideContent.test.ts > TASK-UX1-004 (R2) — docs/UNICDB_USER_GUIDE.md > #4b no stale placement option words remain in a settings context
     → expected '# hướng dẫn sử dụng unicdb\n\n> hướng…' not to contain 'resultsplacement'
   ❯ src/ui/__tests__/userGuideContent.test.ts > TASK-UX1-004 (R2) — docs/UNICDB_USER_GUIDE.md > #4c guide documents the fixed bottom-panel placement
     → expected false to be true // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 13 passed (16)
   Start at  11:05:03
   Duration  167ms (transform 16ms, setup 13ms, tests 5ms, environment 0ms, prepare 32ms)
```

### Verification Output

```
$ npm test src/ui/__tests__/userGuideContent.test.ts

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-002

 ✓ src/ui/__tests__/userGuideContent.test.ts  (16 tests) 2ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  11:05:24
   Duration  145ms (transform 17ms, setup 0ms, collect 10ms, tests 2ms, environment 0ms, prepare 41ms)

$ npm run typecheck
> UnicDB@1.51.6 typecheck
> tsc --noEmit
(exit 0, no diagnostics)

$ npm run compile
> UnicDB@1.51.6 compile
> esbuild src/extension.ts --bundle --outfile=dist/extension.js --platform=node --format=cjs --external:vscode --sourcemap && esbuild src/ui/webview/main.tsx --bundle --outfile=dist/webview.js --format=iife --sourcemap && esbuild src/ui/aiChatPanel.tsx --bundle --outfile=dist/aiChatPanel.js --format=iife --sourcemap && esbuild src/ui/webview/styles.css --bundle --outfile=dist/webview.css --loader:.css=css --sourcemap
  dist/aiChatPanel.js       55.2kb
  dist/aiChatPanel.js.map  129.7kb
  dist/webview.js        2.3mb ⚠️
  dist/webview.css      38.7kb
  dist/webview.js.map    4.1mb
  dist/webview.css.map  74.2kb
  dist/extension.js       6.4mb ⚠️
  dist/extension.js.map  11.3mb
esbuild: build complete

$ grep -c -i resultsplacement docs/UNICDB_USER_GUIDE.md
0
$ grep -c -i beside docs/UNICDB_USER_GUIDE.md
0
$ grep -n Terminal docs/UNICDB_USER_GUIDE.md
80:Kết quả SQL luôn mở ở panel dưới màn hình (cạnh tab Terminal) — không thể đổi vị trí.
```

### Status: DONE
### Note: All 16 tests pass; guide has zero occurrences of removed placement tokens; new bullet at line 80 documents bottom-panel placement next to Terminal.
