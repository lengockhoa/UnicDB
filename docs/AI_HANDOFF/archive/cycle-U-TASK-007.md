# TASK-007 -- Per-table result tabs (tab naming + panel state)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.7

## Goal

Make per-statement result tabs show meaningful table names (e.g. "public.users") instead of generic "Statement N" labels. When browsing table data via schema tree, the tab name shows the table name truncated at 40 chars. Add an optional `label` field to `StatementResult` so the extension can set tab names.

## Target Files

- `webview/main.ts` (existing) -- modify `rebuildTabs()` to read `r.label` and render as tab title (truncated at 40 chars with ellipsis); fallback to `"Statement N"` when label absent
- `webview/styles.css` (existing) -- ensure tab styling handles longer labels with text-overflow ellipsis

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | bundle | `tab shows label when r.label is set` | Tab button text matches label | StatementResult with label="public.users" |
| 2 | bundle | `tab falls back to "Statement N" when no label` | Tab text is "Statement 1" | StatementResult without label |
| 3 | bundle | `long label truncated at 40 chars with ellipsis` | Tab text is 40 chars + "..." | label of 50 chars |
| 4 | bundle | `multiple tables open separate tabs` | Two tabs with different labels | Two StatementResults with different labels |
| 5 | edge | `empty label string falls back to Statement N` | Tab text is "Statement 1" | label="" |
| 6 | edge | `label with special characters renders correctly` | Tab text matches escaped label | label="<script>alert(1)</script>" |

## Test Files

- `src/ui/__tests__/webviewPerTableTabs.test.ts` (new) -- tests for tab label rendering

## Verification Commands

```bash
npm test src/ui/__tests__/webviewPerTableTabs.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] Tab buttons show table name from `r.label` when present
- [ ] Fallback to "Statement N" when label is absent or empty
- [ ] Long labels truncated at 40 chars with ellipsis
- [ ] Multiple tables open in separate tabs with correct labels
- [ ] Special characters in labels are escaped (no XSS)
- [ ] Tab switching still works correctly with labeled tabs
- [ ] `npm run typecheck` clean

## Dependencies

- TASK-006 (both touch webview/main.ts and resultsPanel.ts -- TASK-007 depends on TASK-006 to avoid same-wave collision)

## Interfaces

- Consumes: `StatementResult.label?: string` (optional field to be added), existing `rebuildTabs()` in webview/main.ts
- Produces: Updated `rebuildTabs()` using label for tab text; CSS text-overflow for tab buttons

---

## Discussion

- **Executor scope note (cycle U):** task Target Files list only names `webview/main.ts` + `webview/styles.css`, but the Goal mandates adding `label?: string` to `StatementResult` — whose canonical definition lives in `src/core/queryRunner.ts` (not `messages.ts`). Per PLAN.md §3.7 ("Modify `StatementResult` to carry an optional `label?: string` field" + "The panel should extract the table name from this header"), I added the field in `src/core/queryRunner.ts` (one optional-property addition, no behavior change) and derived the label host-side in `src/ui/resultsPanel.ts` from the browse header (`Browse <schema>.<table> at <ISO>`) inside `postMessage()` so loadMore/requery/save-refresh/ready state posts all keep the label. `src/ui/messages.ts` needed no change (it imports `StatementResult` — the field rides along). Decision order: task file → PLAN.md → existing code patterns.
- **RED note:** bundle-eval tests need `dist/webview.js`, so `npm run compile` was run once BEFORE the tests to compile the pre-implementation bundle (worktree had no `dist/`). Tests 2 + 5 (fallback cases) passed pre-change by design — they guard the pre-existing "Statement N" fallback; tests 1, 3, 4, 6 drove the RED.
- **Test harness fix during GREEN:** test 4's switch assertion initially held stale element references (`rebuildTabs()` recreates buttons each render); fixed by re-querying tabs after the click. Implementation was not changed.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet (claude-sonnet-4.5 class, Claude Code CLI)
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
$ npm test src/ui/__tests__/webviewPerTableTabs.test.ts   # against pre-implementation dist/webview.js
 FAIL  src/ui/__tests__/webviewPerTableTabs.test.ts > ... > 1. tab shows label when r.label is set
       (startsWith("public.users") was false — tab text is "Statement 1 ✓")
 FAIL  src/ui/__tests__/webviewPerTableTabs.test.ts > ... > 3. long label truncated at 40 chars with ellipsis
       (startsWith(long.slice(0,40) + "...") was false)
 FAIL  src/ui/__tests__/webviewPerTableTabs.test.ts > ... > 4. multiple tables open separate tabs (+ switching works)
       AssertionError: expected false to be true   ❯ webviewPerTableTabs.test.ts:204
       204|     expect(t0.textContent!.startsWith("public.users")).toBe(true);
 FAIL  src/ui/__tests__/webviewPerTableTabs.test.ts > ... > 6. label with special characters renders correctly (no XSS)
       AssertionError: expected 'Statement 1 ✓' to contain '<script>alert(1)</script>'

 Test Files  1 failed (1)
      Tests  4 failed | 2 passed (6)
```
Verification Output:
```
$ npm run compile
⚡ Done in 198ms
esbuild: build complete

$ npm test
 Test Files  94 passed | 1 skipped (95)
      Tests  1319 passed | 2 skipped (1321)      # baseline 1313 passed + 6 new; 0 failed
 Start at  19:26:44
 Duration  10.27s
   (includes ✓ src/ui/__tests__/webviewPerTableTabs.test.ts (6 tests) — all green;
    known-flake resultsGridModelNull.test.ts did NOT fail this run)

$ npm run typecheck
> UnicDB@1.6.3 typecheck
> tsc --noEmit
(clean, exit 0)
```
Status: PASS
Note: none — beyond the scope decision recorded in Discussion (queryRunner.ts field addition per PLAN.md §3.7). Pre-existing errors in the dormant `tsconfig.webview.json` (no npm script runs it; esbuild does not typecheck) were verified untouched: all 14 main.ts errors sit outside the edited regions.

## Reviewer Verdict (R1 — grid/webview group)
VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
FINDINGS: no Critical/Important defects; minor notes only, non-blocking. The observed resultsGridModelNull flake (TASK-004) was not reproduced by the reviewer across two full-suite runs — treated as environment flake, not a code defect.
SOURCE: R1 review round outcome recorded in RUN.md cursor (grid/webview group).
