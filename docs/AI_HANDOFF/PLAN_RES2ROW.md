# PLAN — Cycle RES2ROW: split the Results toolbar into exactly 2 rows

## §1 Intent

**Problem (user, verbatim):** "Chia đôi cho tôi menu này. Từ Where là đưa xuống dòng dưới.
TÔi cần 2 dòng" ("Split this menu in half for me. From WHERE onwards, put it on the line
below. I need 2 lines.")

**Context:** the results webview toolbar is currently a single clipped row (post
v1.53.38 / TASK-COLLAPSE-001): 18 controls, no truncation, but crowded. The user wants a
deterministic 2-row split at the WHERE input.

**Split point (vision-analyst verified against the live toolbar):** after the `tsv`
dropdown, before the `WHERE …` input. Row 1 = the 8 icon buttons (cancel, refresh,
add-row, delete-row, undo, redo, commit, csv-toggle) + 2 separators + `tsv` select.
Row 2 = `WHERE …` input, `ORDER BY …` input, ▶ Re-Run, ✕ Clear, ☐ header checkbox, Copy,
Export-file, `$(symbol-namespace)` schema chip, `Search…` input — 9 controls, balanced
against row 1.

**Success looks like:** the toolbar always renders EXACTLY 2 rows at every viewport width —
no third line ever appears (narrow widths clip within a row instead of reflowing), no
horizontal scrollbar, and every existing behavior (requery Enter, export, quick filter,
commit, transaction controls) keeps working. Typecheck + compile + targeted tests + full
suite green.

**Supersession:** this cycle REVERSES the RES-BAR / TASK-COLLAPSE-001 single-row contract
(`.UnicDB-toolbar { flex-wrap: nowrap }` + `overflow: hidden` + requery inputs
`flex: 1 1 140px; min-width: 80px`). The pins live in 3 test files and MUST be flipped, not
silently deleted: `src/ui/__tests__/webviewToolbar.test.ts` (test #4 nowrap regex + the
px-basis assertions, AND test #3's flat-children census — a fourth flip discovered during
planner grounding), `tests/webviewRequeryAlignment.test.ts` (2 `it()` bodies), and
`src/ui/__tests__/aiChatPanelCloneCss.test.ts` (line 119).

## §2 Scope

**In scope (single task — TASK-COLLAPSE-002 — all edits share 2 source files):**
- `webview/styles.css`: `.UnicDB-toolbar` becomes `display: flex; flex-direction: column;
  gap: 4px; min-width: 0; overflow: hidden; margin-bottom: 8px;` (drop `flex-wrap: nowrap`);
  new `.UnicDB-toolbar-row` rule `display: flex; flex-wrap: nowrap; align-items: center;
  gap: 4px; min-width: 0; overflow: hidden;`; `.UnicDB-requery-where/-order` become
  `flex: 1 1 100%; min-width: 0` (inside a nowrap row this means "split the leftover space",
  NOT "own a full line"); update the stale TASK-COLLAPSE-001 comment block.
- `webview/main.ts` `buildPersistentDom()` (lines ~932-1210): wrap toolbar children in two
  `.UnicDB-toolbar-row` divs. Row 1 appends: cancelBtn, refreshBtn, sep, addRowBtn,
  deleteRowBtn, undoBtn, redoBtn, commitBtn, csvToggleBtn, sep, exportFormat. Row 2 appends:
  requeryWhere, requeryOrderBy, requeryRunBtn, requeryClearBtn, exportHeader, exportCopyBtn,
  exportFileBtn, schemaChip, searchInput (still last child of row 2).
- `webview/main.ts` line 817-820 (`render()`): `dom.toolbar.insertBefore(
  dom.transactionControls, dom.csvToggleBtn)` THROWS under the wrapper strategy (ref node's
  parent is row 1, not toolbar). Add `toolbarRow1: HTMLDivElement` to the `PersistentDom`
  interface and re-target to `dom.toolbarRow1.insertBefore(...)`.
- Flip/rewrite the pinned tests: `webviewToolbar.test.ts` (EXPECTED_ORDER split into
  per-row constants; test #3 becomes a two-row census; test #4 nowrap→column flip),
  `webviewRequeryAlignment.test.ts` (2 `it()` bodies + stale comments), 
  `aiChatPanelCloneCss.test.ts` (line 119 assertion).

**Out of scope:**
- Any change to what the controls DO (handlers, messages, requery pipeline, export) —
  layout only.
- The `data-tooltip` pseudo-element block (`webview/styles.css:98-123`) — off-limits.
- Any third row, responsive collapse, or media query — user demanded exactly 2.
- Version bump / release (maintainer folds into next release).
- The AI-chat panel's own toolbar (aiChatPanelCloneCss.test.ts only READS styles.css as a
  regression mirror; no chat CSS changes).
- No version bump inside any task this cycle. The patch bump (v1.53.39) + Marketplace
  publish happens at pipeline R5 per the RUN.md USER OVERRIDE (`must finish including version
  bump`); executor / reviewer never bump versions. This supersedes the prior
  "maintainer folds into next release" default.

**Same-wave file rule:** one task, wave 1 — no collision possible. (A draft split
"CSS task + main.ts task" was rejected: both would touch `webview/styles.css` AND the bundle
tests eval `dist/webview.js` built from both, so no reviewer could approve one while
rejecting the other.)

## §3 Approach

**Option A (chosen): fixed two-row wrappers.** `.UnicDB-toolbar` → `flex-direction: column`
containing exactly two `.UnicDB-toolbar-row` children; each row is `flex-wrap: nowrap` +
`overflow: hidden`. Row membership is decided in `buildPersistentDom()` by which wrapper an
element is appended to, so the split is structural (DOM), not emergent (CSS width math).

- Why it guarantees "exactly 2 rows": a nowrap row can never gain a line; at narrow widths
  its `overflow: hidden` clips tail content instead of spawning a third line or scrollbar —
  the same clip-don't-jerk behavior users accepted in TASK-COLLAPSE-001, now per row.
- The flexible elements absorb the squeeze in row 2: WHERE + ORDER BY at
  `flex: 1 1 100%; min-width: 0` shrink first (buttons/chip/select all keep
  `flex-shrink: 0`), so clipping bites the two inputs' widths before any button hides.
- `transactionControls` re-parenting: `toolbarRow1` is exposed on `PersistentDom` and the
  render-time `insertBefore` targets it; the guard `!dom.transactionControls.parentElement`
  keeps working. Without this fix the manual-transaction path throws `NotFoundError` on
  first transaction open — grounding found this at `webview/main.ts:818`.

**Option B (rejected): single container, `flex-wrap: wrap` + WHERE `flex: 1 1 100%`.**
Row 2's 9 items are emergent: if they exceed the row width the container wraps to a THIRD
line — exactly what the user forbade ("TÔi cần 2 dòng" is emphatic). The caller's §4 sketch
(`flex-wrap: wrap` happy pin) is this option; grounded refinement: under Option A the
container pin is `flex-direction: column`, and `wrap` appears nowhere in the toolbar.

**Option C (rejected): WHERE and ORDER BY both `flex: 1 1 100%` in a wrapping container.**
Reproduces the original 4-row layout TASK-COLLAPSE-001 collapsed.

**Trade-off accepted:** Option A can clip row-2 tail content (Search input) at very narrow
widths (< ~600px) instead of wrapping. This is strictly better than the alternatives (3rd
line, scrollbar, or the pre-COLLAPSE reflow jitter) and matches the established
clip-don't-jerk contract; `min-width: 0` on the two requery inputs keeps the clip point as
far right as possible.

## §4 Test Plan

Fixtures: bundle tests eval `dist/webview.js` into jsdom (stubbed `acquireVsCodeApi`) —
pattern of `webviewToolbar.test.ts`; CSS assertions are source-regex on `webview/styles.css`
(jsdom does not layout). Bundle tests REQUIRE `npm run compile` first; silent self-skips are
NOT green.

| Type | Test Name | Expected |
|------|-----------|----------|
| happy (css) | `.UnicDB-toolbar` rule pins the 2-row column contract | source regex: `/\.UnicDB-toolbar\s*\{[^}]*flex-direction:\s*column/` matches; `/flex-wrap:\s*nowrap/` does NOT match inside the `.UnicDB-toolbar` block |
| happy (css) | `.UnicDB-toolbar-row` rule exists and locks its line | regex: `/\.UnicDB-toolbar-row\s*\{[^}]*flex-wrap:\s*nowrap/` matches AND same block contains `overflow:\s*hidden` |
| happy (webview, bundle) | toolbar renders exactly 2 rows with the agreed split | `toolbar.children.length === 2`, both `.UnicDB-toolbar-row`; row 1 order = `[btn-danger, btn, sep, btn, btn, btn, btn, commit, btn, sep, export-format]`; row 2 order = `[requery-where, requery-order, btn(Re-Run), btn(Clear), export-header, export-copy, export-file, schema-chip, search-input]`, search LAST |
| edge (structural split point) | `.UnicDB-requery-where` is the FIRST child of row 2 | `row2.firstElementChild.classList.contains("UnicDB-requery-where")` — the break is where the user pointed: "Từ Where" |
| edge (overflow/boundary, css) | rows clip instead of scrolling; inputs absorb the squeeze | `.UnicDB-requery-where/-order` bodies match `flex:\s*1\s+1\s+100\s*%` + `min-width:\s*0` and do NOT match `140px`/`80px`; `.UnicDB-toolbar` + `.UnicDB-toolbar-row` both pin `overflow: hidden` (no horizontal scrollbar at any width) |
| edge (state/re-parenting, bundle) | manual transaction open → controls insert into ROW 1 | dispatch a transaction-open state; render completes WITHOUT throwing; `.UnicDB-transaction-controls.parentElement` is the row-1 `.UnicDB-toolbar-row` wrapper AND `transactionControls.nextElementSibling === csvToggleBtn` (insertBefore anchor preserved) |
| regression (webview, bundle) | requery behavior unchanged | Enter in WHERE posts exactly 1 `{type:"requery", index, where, orderBy}`; Clear empties both inputs; existing `webviewToolbar.test.ts` test #5 + `webviewRequeryAlignment` bundle cases stay GREEN untouched |
| regression (webview, bundle) | toolbar census + tooltip contract survive the re-parenting | `.UnicDB-toolbar .UnicDB-btn` button count still 12 (descendant selector crosses row wrappers), each with svg + aria-label; `aiChatPanelCloneCss` non-chat-selector checks (`.UnicDB-btn`, `.UnicDB-tab`, `.UnicDB-grid-host`) stay GREEN |
| regression (css) | RES-BAR hover polish intact | `.UnicDB-btn` block still has `transition: background-color …, box-shadow …`; `data-tooltip` pseudo block (`styles.css:98-123`) byte-untouched — no edit may appear between those lines |

No bugfix regression-against-today is possible for the layout itself (today's code is the
single-row state this cycle deliberately reverses — the "RED before GREEN" step is the
flipped pins failing against the new CSS/TS before they are updated). The
transaction-insert edge case DOES fail against today's `webview/main.ts:818` (toolbar-level
insertBefore), so it doubles as the RED proof for the re-target.

## §5 Verification

```bash
npm run typecheck      # tsc --noEmit — MUST exit 0
npm run compile        # REQUIRED before any bundle (webview*) test — they eval dist/webview.js
npx vitest run src/ui/__tests__/webviewToolbar.test.ts tests/webviewRequeryAlignment.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
npm test               # full-suite final gate (expect ≥ 4104 passed | 0 failed)
```

`npm run lint` does NOT exist in this repo (package.json scripts: compile, watch, test,
test:integration, typecheck, package, publish:*, verify:fast, verify:release, profile:*).
`npm run typecheck` is the lint-equivalent gate and is mandatory. Bundle-eval tests
self-skip when `dist/webview.js` is missing — an executor that skips them without
`npm run compile` has NOT verified anything. Re-run `npm run compile` after ANY
`webview/main.ts` / `webview/styles.css` edit before re-running the targeted tests.

## §6 Acceptance

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` clean; bundle tests actually evaluated (no `skipped` counted).
- [ ] Targeted run GREEN: `npx vitest run src/ui/__tests__/webviewToolbar.test.ts tests/webviewRequeryAlignment.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts` — with the NEW assertions.
- [ ] Full `npm test` GREEN (baseline ≥ 4104 passed | 0 failed at base 7e29d2e).
- [ ] Toolbar renders exactly 2 rows: row 1 = icons + tsv, row 2 = WHERE…Search (bundle census).
- [ ] No horizontal scrollbar; narrow widths clip within a row (overflow: hidden pinned on both toolbar and rows).
- [ ] Manual smoke (executor, dev host): run a SELECT → 2-row toolbar; open a manual transaction → commit/rollback icons appear in ROW 1 without error; Enter in WHERE/ORDER BY still re-runs; hover tooltips instant.
- [ ] The 5 pin assertions across 3 test sites are REWRITTEN with updated comments, not silently deleted (webviewToolbar #3+#4, requeryAlignment ×2, cloneCss ×1).
- [ ] No file outside TASK-COLLAPSE-002's Target Files modified.

## §7 Global Constraints

- Preserve class names: `.UnicDB-requery-where`, `.UnicDB-requery-order`,
  `.UnicDB-requery-run`, `.UnicDB-requery-clear`, `.UnicDB-toolbar`, `.UnicDB-search-input`,
  `.UnicDB-export-*`, `.UnicDB-schema-chip` (tests + postMessage tests select them). NEW
  class allowed: `.UnicDB-toolbar-row` (exactly this name).
- Do NOT touch the `data-tooltip` pseudo-element block (`webview/styles.css:98-134`,
  covers both ::after tooltip body 98-122 and ::before arrow 124-134).
- NEVER `transition: all`; the RES-BAR `.UnicDB-btn` transition stays as-is.
- No version bump inside any task; orchestrator (R5) bumps to v1.53.39 + publishes to
  Marketplace per the RUN.md USER OVERRIDE.
- No new npm dependencies; no new webview→extension message types.
- Placeholders stay exactly `WHERE …` / `ORDER BY …` (U+2026) and `Search…`.
- Bundle tests require `npm run compile`; treat self-skips as failures in review.
- Toolbar height may grow by one row (that IS the feature); row heights must stay stable
  (24-26px controls, `gap: 4px` between rows).

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 1, 2026-09-09)

## Planner Self-Audit
Checklist: 12/12 pass.
1 §6 criteria → tasks: all 9 map to TASK-COLLAPSE-002's Acceptance Criteria (1:1). 2 every
task traces to §1: single task, entire §2 in-scope list. 3 delivers §1 fully: exactly-2-rows
guarantee + all behaviors kept + 5 pin assertions across 3 test sites flipped. 4 unhappy path planned: narrow-width
clipping (edge overflow), transaction re-parent throw (edge state), stale-dist self-skip
guard. 5 all Target Files verified by open/read this session (styles.css rules at :27-49,
:1350-1371; main.ts buildPersistentDom :932-1210, insertBefore :818; all 3 test files read
at the exact pin lines). 6 all commands verified against package.json scripts. 7 single
task → no same-wave collision. 8 no dependency on un-created symbols — `toolbarRow1` is
produced by this same task. 9 edge kinds genuinely different: structural (split point) +
overflow/boundary (clip contract) + state/re-parenting (transaction insert). 10 every
Expected is a concrete regex/DOM assertion or exact message payload. 11 n/a (not a bugfix;
RED step = flipped pins failing pre-flip, stated in §4). 12 no test passes against an empty
impl — the two-row census and column/nowrap regexes all fail on today's single-row code.
Fixed during audit: added the 4th pin flip (webviewToolbar test #3 flat-children census +
EXPECTED_ORDER split) — the caller's brief listed only 3 flips; grounding showed the
wrapper strategy breaks test #3's `toolbar.children` walk and `search is last` assertion.
Also added the `PersistentDom.toolbarRow1` interface change + insertBefore re-target after
finding main.ts:818, and replaced the caller's Option-B `flex-wrap: wrap` happy pin with
the Option-A `flex-direction: column` pin (rationale in §3).
Known gaps: no pixel-level jsdom layout assertion (jsdom does not layout — the 2-row
guarantee is asserted structurally via DOM census + CSS regexes; manual smoke in §6 covers
the visual). Row-2 clipping at < ~600px viewport is accepted behavior (§3 trade-off),
asserted only as "overflow: hidden present", not as a pixel clip point.

## Plan Review Log

### Round 1 — 2026-09-09 · unic-smart
Status: Approved-with-minor
REVIEWER_MODEL: unic-smart (matches config handoff.reviewer.model)
MODEL_ISOLATION FLAG: PLANNER_MODEL (unic-smart) == reviewer model name. This P2.5
review IS a separate invocation with separate context, and config binds both the plan
hint (claude-opus-5) and reviewer to the smart tier, so no different model was
available without a host rebind. Flagged explicitly per the P2.5 hard constraint;
orchestrator may re-plan under a different model if stricter isolation is wanted.
COMPLETENESS: pass — §1-§7 present and substantive. 9 tests: 3 happy / 3 edge
(structural split point, overflow/boundary clip, state re-parenting — genuinely
different kinds) / 3 regression; exceeds minTestsEdgeCase=2. §5 includes typecheck
and correctly documents that npm run lint does not exist (verified vs package.json).
CONSISTENCY: pass with 1 flag — cycle RES2ROW, base 7e29d2e (v1.53.38), 1 task,
wave 1, no deps, and the 5-file list agree across PLAN / TASK-002 / INDEX / ACTIVE /
RUN; row composition identical everywhere. FLAG: PLAN §2 (line 62) + §7 (line 165)
say "no version bump / release this cycle (maintainer folds into next release)" while
RUN.md line 6 records the user override "patch v1.53.39 + publish at R5".
CLARITY: pass — user quote verbatim; every cited line number verified against source
(main.ts:818 insertBefore, buildPersistentDom 932-1203 order matches the row lists
exactly, styles.css:41-49 + 1350-1371, webviewToolbar EXPECTED_ORDER 181-216 + tests
#3/#4 at 321-400, requeryAlignment 188-206, cloneCss:119); every Expected is a
concrete regex / DOM census / message payload; commands verified vs package.json.
SCOPE: pass — single task, single wave, no file collision; layout-only boundary
explicit (no handler/message changes); 2-task split rejection documented.
YAGNI: pass — Option A is the minimal structure that guarantees the hard "exactly 2
rows" constraint. Option B rejection is technically correct: overflow:hidden clips
but does NOT prevent flex-wrap line breaks, so a wrap-based row 2 can still spawn a
3rd line. No media queries, no JS layout measurement, no new deps. Both planner
finds are real (verified): test #3 flat census breaks structurally under wrappers
(toolbar.children becomes [row1,row2]; last-child + EXPECTED_ORDER walk fail), and
main.ts:818 dom.toolbar.insertBefore(transactionControls, csvToggleBtn) throws
NotFoundError once csvToggleBtn lives in row 1.
FINDINGS:
  critical: none
  important:
    - PLAN.md §2 (line 62) + §7 (line 165) vs RUN.md line 6 — version bump/release
      wording contradicts the RUN.md USER OVERRIDE (v1.53.39 + publish at R5).
      Executor instructions are unaffected (no task bumps a version either way), but
      a literal read of PLAN §7 could cancel the user-requested R5 publish. Fix:
      one-line reword — "no version bump inside any task this cycle; the v1.53.39
      patch + publish happens at pipeline R5 per the RUN.md override". Does not gate P3.
  minor:
    - TASK-COLLAPSE-002 "Test Files": case #2 (.UnicDB-toolbar-row rule pin) is not
      assigned to any file in the per-file list (webviewToolbar line says "cases 3,
      4, 6, 7, 8"); its assertions live only in the test-#4 rewrite prose. Add case 2.
    - "4 flipped pins" label vs the enumeration webviewToolbar #3+#4 +
      requeryAlignment ×2 + cloneCss ×1 = 5 assertion sites. Identical in all 5 docs
      so no executor confusion; suggest "5 pin assertions across 4 test sites".
    - TASK case #6 fixture: name the exact message — dispatchState({ type:
      "transactionStatus", open: true }) (webview/main.ts:4424-4427). Also note its
      RED mode vs today is an assertion failure (parentElement is .UnicDB-toolbar),
      not the NotFoundError throw (that only occurs post-wrapper without the
      re-target) — PLAN §3 already words this correctly.
    - data-tooltip do-not-touch range cited as styles.css:98-123, but the
      pseudo-tooltip pattern extends through line 134 (the ::before arrow block,
      124-134). Widen the cited range to 98-134.
    - PersistentDom.toolbarRow2 is unconsumed (only toolbarRow1 feeds the
      insertBefore re-target; bundle tests query the DOM, not the interface). Keep
      for contract symmetry or drop; keep §Interfaces in sync with the choice.
OVERALL: Approved-with-minor
NOTES: All planner grounding claims re-verified against source and accurate,
including the two finds the P1 brief missed. The one important finding is
doc-wording only (PLAN vs RUN release note) and does not affect the executor or
test plan.
