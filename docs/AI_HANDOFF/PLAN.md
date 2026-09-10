# PLAN — Cycle CLIPGRID: results-grid clipboard copy/paste (Cmd/Ctrl+C, Cmd/Ctrl+V, Excel paste, Cmd/Ctrl+Enter save)

## §1 Intent

**Problem (user):** In the data results table the user wants spreadsheet clipboard semantics:
select one cell, a rectangular range, rows, or a column → **Cmd/Ctrl+C** copies the copied
matrix as TSV; select a destination cell → **Cmd/Ctrl+V** pastes the copied matrix starting
at that cell; **pasting content copied in Excel** (tab/newline clipboard text) must land in
the results table as edits; **Save or Cmd/Ctrl+Enter** persists the edits to the database.

**Success looks like:**
1. Any selection shape (1 cell / rectangle / row checkboxes / a column strip) + Cmd/Ctrl+C
   → exactly one `copy` message whose `text` is the TSV matrix of the selection.
2. Cmd/Ctrl+V with TSV text on the OS clipboard → cells starting at the focused cell (or the
   active range's top-left) become dirty edits, visibly highlighted, mirrored into the grid.
3. Excel-origin paste (multi-row × multi-col, CRLF line endings, trailing newline) parses and
   lands with the same semantics.
4. Cmd/Ctrl+Enter or the existing Commit (✓) button posts one `saveEdits` batch; on
   `saveResult ok` the dirty highlights clear (new baseline). Existing refusals/errors flow
   through the save banner unchanged.

**Planner grounding note (verified against working tree @ d955873, base `main`):** nearly the
whole pipeline ALREADY EXISTS — heritage of TASK-501/TASK-502/TASK-RANGE-001/TASK-503:
- Range selection: `webview/main.ts:476-558` (`cellRange`, `setCellRange`,
  `normalizeCellRange`), drag wiring at `main.ts:1254-1301`, Shift+Arrow at `main.ts:1412-1451`,
  highlight via `cellClassRules` → `UnicDB-cell-range` (`main.ts:2343-2353`, `styles.css:518`).
- Copy: `copySelectionToHost()` (`main.ts:4031`) — range takes precedence over row-checkbox
  selection over focused-row fallback; posts `{type:"copy", text}`; host writes the OS
  clipboard at `resultsPanel.ts:1033-1036` (`vscode.env.clipboard.writeText`).
- Paste: capture-phase `paste` listener (`main.ts:1401-1405`) → `onGridPaste`
  (`main.ts:3300`): `parseTsvPaste` → focused-cell anchor path or `pasteIntoRange`
  (`main.ts:3417`); pure helpers `parseTsvPaste` / `applyPasteToDirty` /
  `applyRangePasteToDirty` in `src/ui/resultsGridModel.ts:1226/1261/1387`.
- Save: Cmd/Ctrl+Enter capture listener (`main.ts:1355-1370`) → `onCommitClick()`
  (`main.ts:3782`) posts one `saveEdits` batch → `handleSaveEdits` (`resultsPanel.ts:1040`).

The real GAPS this cycle closes, each verified in source:
1. **No keyboard Cmd/Ctrl+V wiring.** The bundle handles only the `paste` ClipboardEvent;
   `gridApi.processCellFromClipboard` / a Cmd/Ctrl+V keydown path does not exist. On hosts
   where the webview never receives a trusted `paste` event on a non-editable grid, Cmd/Ctrl+V
   is a no-op. Fix: Cmd/Ctrl+V keydown (capture phase, `isFilterInput` guard) synthesizes the
   same paste dispatch after an async clipboard read.
2. **Column-strip / whole-column copy parity.** `copySelectionToHost` handles range +
   full-row checkbox selection + focused row, but a user selecting a COLUMN (drag down one
   column, no checkbox) is naturally expressed as a 1-column-wide range — that works today —
   yet a row-rectangle where the user dragged ACROSS only part of the grid relies on range
   coords; both need one bundle test suite to pin shape semantics (rows / columns / 1×1 /
   N×M) — currently only `selectionRangeToText` unit tests exist, zero bundle tests for
   copy of a range.
3. **`suppressNextCellClickClear` is set but never read** (`main.ts:479,1260` — only 2
   occurrences). The documented "clicking a non-cell area clears the range" behavior
   (comment `main.ts:469`) is not wired, so a stale rectangle survives clicks on the
   toolbar and silently redirects the next copy/paste. This is a live correctness gap for
   "select a destination cell" — if the user's last range lingers, paste goes to the OLD
   range instead of the newly focused cell. Fix: read the flag in a capture-phase
   `mousedown`/`cellClicked` clear path (only this task may touch this wiring).

Task sizing: pure-model helpers are done and tested; the work is bundle-level wiring +
pinning tests + one real defect fix (stale-range clear). No new npm deps, no schema
changes; the ONLY new host message types are the §7-sanctioned `readClipboard`
(webview→host) / `clipboardText` (host→webview) round-trip pair added by TASK-CLIP-003 —
every other discriminator (`copy`, `saveEdits`, `retryFailedRows`) is unchanged.

## §2 Scope

**In scope:**
- Cmd/Ctrl+V keydown handler on `gridWrap` (capture phase) that routes into the existing
  paste pipeline (`onGridPaste` semantics) after reading the OS clipboard; `isFilterInput`
  guard; `preventDefault`/`stopPropagation` on the handled path.
- Paste-event hardening: ignore multi-part / non-plain clipboard payloads explicitly
  (`getData("text/plain")` empty → no-op) — behavior pin, not new logic.
- Column-strip copy parity test coverage (1-col range copy through `copySelectionToHost`).
- Fix the stale-range defect: `suppressNextCellClickClear` consumed; clicking a non-cell
  area (toolbar, header, footer) clears `cellRange`/`cellRangeAnchor`; clicking a cell
  after a drag starts a new anchor (flag suppresses the spurious clear from AG Grid focus).
- Excel-paste matrix semantics pinned: CRLF, trailing newline, jagged rows padded, clip at
  grid edge, tile inside range (already implemented — tests pin them at bundle level).
- Save contract pinned at bundle level: Cmd/Ctrl+Enter + commit button post exactly one
  `saveEdits` with `edits[]` = snapshot; `saveResult ok:true` clears highlights.
- New bundle test files for the above (paths in §4 / task files).

**Out of scope:**
- Any new webview→host message discriminator EXCEPT the §7-sanctioned `readClipboard`, and
  any new host→webview discriminator EXCEPT its `clipboardText` reply (both TASK-CLIP-003
  only; `copy`, `saveEdits`, `retryFailedRows` unchanged); no host-side save-statement
  changes (`src/core/saveStatements.ts` untouched).
- Enterprise-style "copy with headers", cut, drag-fill, cross-tab clipboard history.
- Local Add-Row paste targeting (paste already stops at locally-added rows by design —
  `main.ts:3351`, pinned as-is).
- No-PK ctid save bug (tracked separately in queue spec GRID-EXCEL-OVERHAUL A).
- Console panel / AI chat clipboard (different surfaces).

**CONSTRAINT — same-wave file rule:** wave 1 = TASK-CLIP-001 (tests for pure+bundle copy
matrix shapes) ∥ TASK-CLIP-002 (paste path tests) — disjoint test files. Wave 2 =
TASK-CLIP-003 (Cmd/Ctrl+V wiring + stale-range fix, owns `webview/main.ts`) → wave 3 =
TASK-CLIP-004 (save-path pin — tests-only, does NOT edit `webview/main.ts`; consumes
CLIP-003's `debugClipboard.simulatePaste` seam). Any two tasks that would both edit
`webview/main.ts` are sequenced, never parallel.

## §3 Approach

**TASK-CLIP-001 (copy matrix shapes — tests only):** add
`src/ui/__tests__/webviewClipboardCopy.test.ts` (jsdom bundle-eval, harness pattern of
`webviewBundle.test.ts` / `webviewKeybinding.test.ts`: stub `acquireVsCodeApi`, eval
`dist/webview.js`, dispatch a 3×2 state, drive `api.forEachNode(setSelected)` / synthetic
`mousedown`+`mousemove` on `.ag-cell` elements to build ranges, dispatch Cmd/Ctrl+C
`keydown` on `.UnicDB-grid-host`, assert the posted `copy` messages). Pins: 1×1 cell; N×M
rectangle; full-row checkboxes; single column strip (drag down col `name`); hidden-column
exclusion (via `debugSetSpecs` seam `main.ts:4510`); focused-row fallback. Pure-side
`selectionRangeToText` shape cases (row-major, `\t`/`\n` joins) extend
`resultsGridModelEdit.test.ts` only where a shape lacks coverage (column-strip = 1-wide
range). **No production edits.**

**TASK-CLIP-002 (paste matrix semantics — tests only):** add
`src/ui/__tests__/webviewClipboardPaste.test.ts` (same bundle harness). Pins the EXISTING
paths so the CLIP-003 wiring cannot regress them: paste event with `clipboardData` text →
`editState.dirtyCount` grows by the in-bounds cell count; anchor at focused cell; range
present → tiling into rectangle (`parsed[r % rows][c % cols]`), over-paste clipped;
CRLF + trailing-newline normalization (via `parseTsvPaste` direct unit rows already present
in `resultsGridModelEdit.test.ts` — bundle-level asserts end-state only); locally-added row
stop (`serverIndexByRowId` miss breaks the walk); undo stack receives one `cell-edit` per
pasted cell; empty text / filter-input target → zero dirty. **No production edits.**

**TASK-CLIP-003 (webview wiring + stale-range fix — the only task editing
`webview/main.ts` this wave):**
1. Add a capture-phase `keydown` Cmd/Ctrl+V listener on `gridWrap`, modeled on the existing
   Cmd/Ctrl+C listener (`main.ts:1340-1348`): guard `isFilterInput(ev.target)`; on hit
   `ev.preventDefault(); ev.stopPropagation();` then obtain text. Webviews cannot rely on a
   trusted `paste` event arriving on a non-editable grid, and `navigator.clipboard.readText`
   requires focus/permission the webview may lack — so the handler posts a NEW
   host round-trip: `postToHost({ type: "copy", text: "" })` is WRONG (would clobber the
   clipboard); instead the host already exposes `vscode.env.clipboard`. **Chosen seam:** add
   the minimal new host→webview pull message `readClipboard` (webview→host) + reply
   `clipboardText` (host→webview) in `src/ui/messages.ts`, handled at
   `resultsPanel.ts:handleMessage` with `vscode.env.clipboard.readText()`; the webview
   dispatches a synthetic `ClipboardEvent("paste", {clipboardData})` into `onGridPaste`'s
   existing listener path. Message union grows additively; unknown-type fall-through
   (`main.ts` host switch default) keeps old bundles safe. **Rejected alternative:** making
   the keydown handler call `navigator.clipboard.readText()` directly — fails silently in
   VS Code webviews without clipboard permissions and cannot be tested in jsdom; the host
   round-trip is one `await` and matches the existing `copy` write path symmetry
   (`resultsPanel.ts:1035`).
2. Wire the stale-range clear: in the capture `mousedown` listener on `gridWrap`
   (`main.ts:1254`), when `findCellFromEvent` returns null (toolbar/header/footer click),
   call `setCellRange(null)` unless `suppressNextCellClickClear` is true; consume the flag
   (set to false) after any mousedown that read it, so the documented
   "clicking a non-cell area clears" contract (`main.ts:469`) finally holds and a lingering
   rectangle can never redirect the next paste.
3. Expose a `__UnicDB.debugClipboard` test seam (pattern: `main.ts:4523`) —
   `simulatePaste(text: string)` that funnels into the same `onGridPaste` dispatch the real
   events use, and `getCellRange(): {startRow,startCol,endRow,endCol} | null` so tests can
   assert clears without DOM poking. Both are test-only additions to the existing debug
   object.

**TASK-CLIP-004 (save persistence pin — wave 3, after CLIP-003):** add
`src/ui/__tests__/webviewClipboardSave.test.ts`: dirty cells from a paste → Cmd/Ctrl+Enter
keydown (meta AND ctrl variants) posts exactly ONE `saveEdits` whose `edits` match the
dirty snapshot and carry `serverIndexByRowId`; empty-dirty Cmd/Ctrl+Enter posts nothing
(no-op guard `main.ts:3783`); `saveResult ok:true` → `dirtyCount === 0` and no
`UnicDB-cell-dirty` cells remain; `refused:true` → banner shows reason, dirty cleared.
Bundle test file only; production untouched — this is the acceptance pin that Cmd/Ctrl+Enter
persists pasted edits end-to-end at the webview level (host side already covered by
`resultsPanelSaveEdits.test.ts`).

## §4 Test Plan

Harness: bundle tests eval `dist/webview.js` into jsdom — `npm run compile` is REQUIRED
first; a silent self-skip is NOT green. Pure-logic tests extend the existing vitest node
files.

| Type | Test Name | Expected |
|------|-----------|----------|
| happy (CLIP-001 bundle) | Cmd+C with 1×1 range (mousedown+mouseup single cell) | exactly 1 `copy` msg; `text` === the single formatted cell, no `\t`/`\n` |
| happy (CLIP-001 bundle) | Cmd+C with 2×2 drag rectangle rows [[1,alpha],[2,beta]] | 1 `copy` msg; `text` === `"1\talpha\n2\tbeta"` |
| happy (CLIP-001 bundle) | Cmd+C with rows 0-1 selected via checkboxes (no range) | 1 `copy` msg; 2 lines, both tab-joined (row-copy parity with `webviewBundle.test.ts` #3) |
| happy (CLIP-001 bundle) | column strip: drag down the single column `name`, rows 0-2 | 1 `copy` msg; `text` === `"alpha\nbeta\ngamma"` (1-wide TSV) |
| edge (CLIP-001 shape) | 2×2 range with col `id` hidden via `debugSetSpecs` | copy excludes hidden column: `text` === `"alpha\nbeta"` (no `1\t` leak) |
| edge (CLIP-001 shape) | Cmd+C with no selection AND no focused cell | zero `copy` posts (`main.ts:4065` guard) |
| edge (CLIP-001 boundary) | range extending past last row (drag below grid) | copy clipped to displayed rows (`copyCellRangeToHost` clamps `endRow`) |
| regression (CLIP-001) | existing `webviewBundle.test.ts` #3 + `webviewExport.test.ts` #3 copy cases | unchanged GREEN |
| happy (CLIP-002 bundle) | paste event, text `"10\tx\n20\ty"`, focused cell (0,0) on col `id` | dirtyCount 4; dirty snapshot exactly (0,0)=`"10"`, (0,1)=`"x"`, (1,0)=`"20"`, (1,1)=`"y"`; grid cells of rows 0-1 mirror the values after refresh |
| happy (CLIP-002 bundle) | Excel-origin paste: `"1\r\n2\r\n"` (CRLF + trailing newline) focused (0,0) | dirtyCount 2, col 0 rows 0-1 = `"1"`,`"2"` (trailing empty row dropped) |
| happy (CLIP-002 bundle) | paste into active 2×2 range with 1×1 clipboard `"z"` | all 4 range cells = `"z"` (tile) |
| edge (CLIP-002 shape) | paste 3×3 clipboard into 2×2 range | over-paste clipped — only 4 dirty cells |
| edge (CLIP-002 empty) | paste event with empty `getData("text/plain")` | zero dirty; no preventDefault side effects asserted via no `copy`/`saveEdits` posts |
| edge (CLIP-002 target) | paste event dispatched on a filter `<input>` inside gridWrap | zero dirty (user's local typing untouched) |
| edge (CLIP-002 boundary) | paste 2 rows at last displayed row (1 row left) | only 1 row dirtied (bottom-edge break `main.ts:3348`) |
| regression (CLIP-002) | existing `resultsGridModelEdit.test.ts` parse/apply cases | unchanged GREEN |
| happy (CLIP-003 bundle) | Cmd+V keydown on gridHost → webview posts `{type:"readClipboard"}`; test host stub replies `{type:"clipboardText", text:"7\tseven"}`; `debugClipboard.simulatePaste` asserted NOT called | exactly ONE paste application at the focused anchor — dirtyCount 2 ((anchor)=`"7"`, right neighbor=`"seven"`); no double-fire (keydown + native paste) |
| happy (CLIP-003 bundle) | Ctrl+V variant (windows/Linux chord) | same as Cmd+V |
| edge (CLIP-003 stale-range) | drag a range; click toolbar (non-cell); Cmd+V | range is null after the non-cell click → paste anchors at focused cell, NOT the stale rectangle |
| edge (CLIP-003 input) | Cmd+V while focus is in filter input | zero dirty; native input paste not intercepted |
| edge (CLIP-003 permission) | host replies `clipboardText` with empty string | zero dirty, no state change |
| regression (CLIP-003) | Shift+Arrow / mousemove range wiring (existing drag tests) + `aiChatPanelCloneCss.test.ts` range-CSS pin | unchanged GREEN |
| happy (CLIP-004 bundle) | paste 2 cells then Cmd+Enter | exactly 1 `saveEdits`; `edits.length === 2`; `index === 0`; `serverIndexByRowId` present |
| happy (CLIP-004 bundle) | Ctrl+Enter variant posts identically | 1 `saveEdits` per dispatch |
| edge (CLIP-004 noop) | Cmd+Enter with dirtyCount 0 | zero `saveEdits` (guard) |
| edge (CLIP-004 refused) | `saveResult {ok:true, refused:true, reason}` | banner shows reason; dirty cleared; no retry button state |
| regression (CLIP-004) | `saveResult ok:true` → `dirtyCount === 0`, no `.UnicDB-cell-dirty` in DOM | mirrors existing `webviewEditHighlight.test.ts` #5 for the paste-origin path |
| regression (CLIP-004) | existing `webviewKeybinding.test.ts` K1-K3 (input-focus guard, dirty commit) | unchanged GREEN |

## §5 Verification

```bash
npm run typecheck
npm run compile        # REQUIRED before any bundle test — they eval dist/webview.js
# Wave 1 (TASK-CLIP-001 ∥ TASK-CLIP-002)
npx vitest run src/ui/__tests__/webviewClipboardCopy.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
npx vitest run src/ui/__tests__/webviewClipboardPaste.test.ts
# Wave 2 (TASK-CLIP-003 — recompile first: webview/main.ts + messages.ts changed)
npm run typecheck && npm run compile
npx vitest run src/ui/__tests__/webviewClipboardCopy.test.ts src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/webviewKeybinding.test.ts src/ui/__tests__/webviewBundle.test.ts tests/webviewEditHighlight.test.ts
# Wave 3 (TASK-CLIP-004 — recompile first)
npm run typecheck && npm run compile
npx vitest run src/ui/__tests__/webviewClipboardSave.test.ts src/ui/__tests__/webviewKeybinding.test.ts
npm test               # full-suite final gate
```

Lint: this repo has NO `lint` script (package.json scripts: compile, watch, test,
test:integration, typecheck, package, publish:*, verify:fast, verify:release, profile:*).
`npm run typecheck` (`tsc --noEmit`) is the lint-equivalent gate and is mandatory in every
wave. Bundle tests self-skip without `dist/webview.js` — an executor that skips them has
NOT verified anything (treat self-skips as failures in review).

## §6 Acceptance

- [ ] `npm run typecheck` exits 0 after every wave.
- [ ] CLIP-001: all copy-shape cases GREEN — 1×1, N×M, row-checkbox, column strip, hidden-col exclusion, no-selection no-op.
- [ ] CLIP-002: all paste-semantics cases GREEN — anchor, range tiling/clipping, CRLF+trailing newline, empty text, filter-input, locally-added-row stop.
- [ ] CLIP-003: Cmd+V and Ctrl+V through the host round-trip apply exactly one paste; stale range cleared by non-cell click; `npm run compile` re-run before its tests.
- [ ] CLIP-004: paste → Cmd/Ctrl+Enter posts one `saveEdits` batch; `ok` clears highlights; refused shows banner.
- [ ] `npm test` full suite GREEN at closeout (wave-boundary regression net).
- [ ] No file outside the four tasks' Target Files lists modified; no new npm dependency.
- [ ] Manual smoke (executor): run a SELECT, drag a 2×2 range, Cmd+C, click another cell, Cmd+V → two cells dirty; paste a real Excel 2×3 block → lands as edits; Cmd+Enter → save banner clears highlights on success.

## §7 Global Constraints

- No new npm dependencies. Bundle tests require `npm run compile`; treat self-skips as failures.
- New message discriminators allowed ONLY: `readClipboard` (webview→host) and `clipboardText` (host→webview), additive to `WebviewMessage`/`HostMessage` unions; unknown-type fall-through must keep stale bundles safe.
- Cmd/Ctrl+C and Cmd/Ctrl+V each bind in exactly ONE capture-phase listener on `gridWrap` (A16 double-fire rule, `main.ts:2505-2509`).
- `isFilterInput` guard on every new keydown/paste entry point (filter/search typing is never a grid edit).
- Preserve existing class names: `UnicDB-cell-range`, `UnicDB-cell-dirty`, `UnicDB-grid-host`, `UnicDB-save-banner` (pinned by existing tests).
- Paste must never target locally-added rows (`serverIndexByRowId` miss = stop) — INSERT marker integrity.
- Coordinates stay in the established namespaces: display rows via `getDisplayedRowAtIndex`, cols via `currentSpecs` index (never live `getColumnDefs`).
- No version bump / release this cycle (maintainer folds into next release).

## Planner Report
PLANNER_MODEL: unic/unic-smart
PLAN_REVIEW: Approved by unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) merged a drafted "copy tests" + "hidden-column tests" task into CLIP-001 (same test-file collision); (2) the initial CLIP-003 draft called `navigator.clipboard.readText()` directly — rejected after grounding (silent permission failure in VS Code webviews, untestable in jsdom) and replaced with the minimal `readClipboard`/`clipboardText` host round-trip, recorded as the §3 rejected alternative; (3) discovered `suppressNextCellClickClear` is written but never read (2 occurrences, `main.ts:479,1260`) — promoted from "test gap" to an explicit CLIP-003 production fix with its own edge case, since a stale rectangle silently misdirects the next paste; (4) split save-pin into wave-3 CLIP-004 because it re-edits test files only but its scenarios depend on CLIP-003's seam — dependency recorded instead of a same-file race.
Known gaps: jsdom fires no trusted `paste`/`clipboard` events, so the real OS-clipboard hop is exercised only via the host round-trip stub + the manual smoke in §6; pixel-level range-highlight visuals are pinned structurally (CSS class presence + existing CSS pin in `aiChatPanelCloneCss.test.ts`), not visually. Column-header CLICK (not drag) column selection is not an AG Grid Community feature — out of scope, documented in §2.

## Plan Review Log

### Round 1 — 2026-09-10 · unic/unic-smart
Status: Issues Found

COMPLETENESS:
  - none — Test Plan §4 gives every task ≥1 happy + ≥2 edge cases; §5 mandates `npm run typecheck` as the lint-equivalent gate (repo has no lint script); §6 acceptance gates + manual smoke are concrete and testable.
CONSISTENCY:
  - §1 (Task sizing) says "No new host message types" and §2 (Out of scope) excludes "Any new webview→host message discriminator", but §3 TASK-CLIP-003 introduces two new discriminators (`readClipboard` webview→host, `clipboardText` host→webview) and §7 explicitly sanctions exactly that pair. Fix: amend §1 and §2 to "…except the §7-sanctioned `readClipboard`/`clipboardText` pair" so the P5 diff reviewer cannot false-block CLIP-003's seam as out-of-scope.
  - §2 wave rule says TASK-CLIP-004 "re-touches `webview/main.ts` after CLIP-003 lands", but §3 TASK-CLIP-004 states "production untouched — bundle test file only" and Planner Self-Audit item 4 confirms tests-only. Fix: change the §2 parenthetical to "tests-only pin, depends on CLIP-003's seam; does not edit `webview/main.ts`".
CLARITY:
  - §4 CLIP-002 row 1 expected cell ends with an ellipsis ("(1,1)=`"y"…`") — replace with the complete literal expectation ("(1,1)=`\"y\"`; dirty snapshot matches") so the executor has one unambiguous target.
  - §4 CLIP-003 first happy row phrasing "after `debugClipboard.simulatePaste` seam not used — via host round-trip" is ambiguous; rewrite as "drive Cmd+V keydown; test host stub replies `clipboardText`; assert the `simulatePaste` seam was NOT used".
SCOPE:
  - none — single surface (results-grid clipboard copy/paste + save pin), explicit out-of-scope list (headers-copy, cut, drag-fill, No-PK ctid, other panels), clean wave/file-disjointness plan.
YAGNI:
  - none — `readClipboard`/`clipboardText` is a minimal seam with a recorded rejected alternative; `debugClipboard` follows the existing `__UnicDB.debug*` seam pattern; no speculative features.

NOTES: Both consistency findings are stale §1/§2 summary text contradicting the operative §3/§7 detail — surgical one-line edits, no re-planning required. Model transparency: reviewer runs as unic/unic-smart (= config `handoff.reviewer.model`); planner self-reported the same gateway model — config `mustDifferFromExecutor` binds at P5 vs the executor (hint `unic-code`), which this plan review does not gate.

### Round 1 Revision — 2026-09-10 · planner (unic/unic-smart)
Status: all findings resolved — resubmitted for re-review

1. RESOLVED (consistency): §1 task-sizing + §2 out-of-scope now exempt exactly the
   §7-sanctioned `readClipboard` (webview→host) / `clipboardText` (host→webview) pair;
   all other discriminators (`copy`, `saveEdits`, `retryFailedRows`) remain unchanged.
2. RESOLVED (consistency): §2 wave rule corrected — TASK-CLIP-004 is tests-only and does
   NOT edit `webview/main.ts`; it consumes TASK-CLIP-003's `debugClipboard.simulatePaste`
   seam (now consistent with §3 and Self-Audit item 4).
3. RESOLVED (clarity): §4 CLIP-002 happy row rewritten as a complete literal expectation.
   Grounding note: the reviewer's sketch kept dirtyCount 2 with (1,1)=`"y"`, which is
   unreachable — with the 2-col fixture, (1,1)=`"y"` (= parsed[1][1]) requires anchor
   col 0 (`onGridPaste` anchor math, `webview/main.ts:3329-3333`; col clip in
   `applyPasteToDirty`, `src/ui/resultsGridModel.ts:1289-1292`), which yields dirtyCount 4
   — matching TASK-CLIP-002 test #1 verbatim, so §4 now states that exact expectation.
4. RESOLVED (clarity): §4 CLIP-003 happy row rewritten as a literal host round-trip:
   Cmd+V keydown → `readClipboard` post → stub replies `clipboardText "7\tseven"` →
   exactly one paste application at the focused anchor, with `simulatePaste` asserted
   NOT used (matches TASK-CLIP-003 test #1).

Task files: no edits required — TASK-CLIP-002 #1 and TASK-CLIP-003 #1 already carried the
literal expectations these findings ask for; PLAN §4 now matches them. Dependency graph,
waves, and task statuses (`ready`) untouched.
### Round 2 — 2026-09-10 · unic/unic-smart (config handoff.reviewer.model: unic-smart)
Status: Approved

COMPLETENESS:
  - none — §4 gives every task ≥1 happy + ≥2 edge cases; §5 correctly documents the no-lint-script state and mandates `npm run typecheck` per wave (verified package.json: compile/test/typecheck present, no lint); every regression file the plan cites exists (webviewBundle, webviewKeybinding, webviewExport, resultsGridModelEdit, tests/webviewEditHighlight, aiChatPanelCloneCss, resultsPanelSaveEdits); no TODO/TBD/placeholder in the document.
CONSISTENCY:
  - Round 1 finding 1 RESOLVED — §1 task-sizing and §2 out-of-scope now exempt exactly the §7-sanctioned readClipboard/clipboardText pair ("every other discriminator (copy, saveEdits, retryFailedRows) is unchanged"); the §3/§7 contradiction is gone.
  - Round 1 finding 2 RESOLVED — §2 wave rule now reads CLIP-004 "tests-only, does NOT edit webview/main.ts; consumes CLIP-003's debugClipboard.simulatePaste seam", matching §3, §5 wave-3 commands, and Self-Audit item 4.
  - none remaining — waves ↔ task ownership ↔ §5 per-wave commands ↔ §6 acceptance agree; §4 numeric expectations internally consistent (2×2 paste → dirtyCount 4; CRLF 2×1 → dirtyCount 2).
CLARITY:
  - Round 1 finding 3 RESOLVED — §4 CLIP-002 row 1 is a complete literal expectation (dirtyCount 4; (0,0)="10",(0,1)="x",(1,0)="20",(1,1)="y"); the planner's anchor-math grounding makes it consistent with the tile/clip rows.
  - Round 1 finding 4 RESOLVED — §4 CLIP-003 happy row is a literal round-trip script (keydown → readClipboard post → stub replies clipboardText → exactly one paste at focused anchor; simulatePaste asserted NOT called).
  - none remaining — residual informal phrasing ("right neighbor") is unambiguous given the stated 2-col fixture and anchor.
SCOPE:
  - none — single surface (results-grid clipboard copy/paste + save pin), explicit out-of-scope list, file-disjoint waves preserved.
YAGNI:
  - none — readClipboard/clipboardText is a minimal seam with a recorded rejected alternative; both debugClipboard accessors are consumed by named tests; no speculative features.

NOTES: Approved — proceed to implementation (wave 1 = TASK-CLIP-001 ∥ TASK-CLIP-002). Reviewer runs as unic/unic-smart = config handoff.reviewer.model; planner self-reported the same gateway model, which plan review does not gate (mustDifferFromExecutor binds at P5 vs the executor).
