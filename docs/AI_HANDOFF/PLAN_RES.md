# PLAN — Cycle RES-BAR: WHERE / ORDER BY inputs in the Results toolbar (Enter = re-run)

## §1 Intent

**Problem (user, verbatim):** "Ở chỗ result này, trên table, có cái ô where và order by.
Sau khi tôi thêm thông tin vào đây. gõ enter thì phải search ra kết quả cho tôi nhé"
("In the results area, on the table, there should be WHERE and ORDER BY boxes. After I
type into them and press Enter, it should re-search and show me results.")

**Locked P0 answers (from the orchestrator's one-time question window — treat as fixed):**
1. **Execution mode:** Re-run SQL on the database (server-side). NOT client-side filtering.
2. **Input format:** Free SQL fragment. WHERE box = boolean expression body, no leading
   `WHERE` keyword. ORDER BY box = ORDER BY body (column list + directions), no leading
   `ORDER BY` keyword.
3. **Placement:** In the existing toolbar row, between the `tsv` dropdown and the existing
   `Search...` input (slot: right after `tsv ▼`, before the header checkbox). Two narrow
   text inputs with placeholders `WHERE …` and `ORDER BY …`. Toolbar height must remain
   stable.

   **Toolbar DOM order pinned (so the two shorthand wordings above resolve to one slot):**
   `[close | refresh | separator | upload | delete | undo | redo | ✓ | grid | tsv ▼ |
   WHERE … | ORDER BY … | ☐ header | copy | download | Search…]`. P0's "between tsv
   dropdown and Search..." and §2's "after `exportFormat`, before `exportHeader`" describe
   the SAME two-slot gap: WHERE input is the first child immediately after
   `.UnicDB-export-format`; ORDER BY input is the second; the empty `.UnicDB-export-header`
   checkbox is the third; `.UnicDB-search-input` remains the last.

**Success looks like:** the Results webview toolbar carries the two inputs in the P0 slot;
pressing Enter inside either one re-runs the statement's ORIGINAL SQL with the typed
fragments applied (server-side, same connection), and the grid re-renders the new rows;
full suite + typecheck + compile green.

**Planner grounding correction (verified against working tree @ accf1b5):** the
server-side re-run pipeline the caller expected to build (tasks RES-003/RES-004) **already
exists and is fully tested** — heritage of TASK-504/TASK-004/TASK-005/TASK-006:
- webview posts `{type:"requery", index, where, orderBy}` (`webview/main.ts:3294`
  `onRequeryClick`), message type declared at `webview/main.ts:171-176`.
- host `handleRequery` (`src/ui/resultsPanel.ts:1843`) validates ORDER BY with the live
  dialect (`parseOrderBy`, `src/ui/queryComposer.ts:306`), rewrites the ORIGINAL cached
  statement SQL via `composeRequery` (`src/ui/resultsGridModel.ts:1326`) /
  `composeSortQuery` / multi-term wrap / paging lane (`resultsPanel.ts:1764-1841`), routes
  through the same transaction/connection handle, posts `running → done` state so the grid
  fully re-renders, and surfaces errors (invalid ORDER BY → synthetic error statement +
  toast; missing statement → toast, `resultsPanel.ts:1853-1857`).
The real gaps vs the user request + P0 are webview-side placement/Enter (TASK-RES-001) and
one input-hardening gap (TASK-RES-002): a user typing the natural `WHERE id>5` into the box
today produces `… WHERE WHERE id>5` (or a parseOrderBy rejection for a leading `ORDER BY`)
— a confusing raw DB error. P0 answer 2 defines the fragment contract; RES-002 enforces it
defensively.

## §2 Scope

**In scope:**
- Relocate the existing WHERE / ORDER BY inputs (plus their Re-Run + Clear buttons) from
  the standalone requery bar (`webview/main.ts:1066-1104`, rendered inside `gridWrap`
  under the toolbar) into the toolbar row, slot: after `exportFormat` (`tsv` select),
  before `exportHeader` (checkbox) — exactly the P0 slot.
- Placeholders `WHERE …` / `ORDER BY …`; labels carried by placeholder + aria-label
  (toolbar has no room for text labels).
- Enter key on either input triggers the requery exactly once per keydown (debounce-free;
  IME-composition guard).
- CSS: narrow toolbar inputs matching the existing `.UnicDB-search-input` sizing pattern;
  toolbar height stable (`flex-wrap: nowrap` is pinned by a structural test — keep it).
- Remove the now-empty standalone requery bar (DOM + its CSS block).
- Update the tests that pin the old layout.
- Extension: strip one leading clause keyword at the `handleRequery` message boundary
  (pure helpers in `queryComposer.ts`) so the P0 input format is enforced defensively.
- **Fold-in (orchestrator-appended after P0 closed): user reported toolbar hover is
  non-responsive — tooltip appears slowly and icons jerk on mouseover. Root cause:
  `makeIconButton` (`webview/main.ts:680`) sets both `btn.title` (1-3s native delay)
  AND `data-tooltip` (instant CSS pseudo at `webview/styles.css:78-115`), so two
  tooltips fire per hover; background-color flash on `:hover` has no `transition`. Fix:
  drop the native `title` and add an 80ms ease transition on the background. Sequenced
  after RES-001 in wave 2 because they share `webview/main.ts` + `webview/styles.css`.**

**Out of scope:**
- Any new webview→extension message type (rejected — see §3).
- Client-side filtering, SQL parsing beyond the existing helpers, parametrized rewrites
  (composeRequery's documented injection policy is unchanged: fragments are user-intended
  SQL in a SQL client).
- The existing Re-Run button / Clear button click behavior (kept; only relocated).
- Sort-on-column-click requery, set-filter, paging lanes (already shipped; only verified
  as regressions).

**Same-wave file rule:** TASK-RES-001 and TASK-RES-002 share **no** file (webview/* vs
src/ui/{queryComposer,resultsPanel}.ts; disjoint test files). Both run in wave 1 parallel.
No demotions were necessary. (An earlier draft split the webview work into
"DOM elements" + "Enter handler" tasks, but both would modify `webview/main.ts` — merged
into TASK-RES-001 per the conflict rule.)

**Folded-in task (TASK-RES-003 — toolbar hover polish):** drops `btn.title` from
`makeIconButton` and adds a short `transition: background-color 80ms ease-out` to
`.UnicDB-btn` so the two-tooltip flicker and the instant background flash disappear.
Shares `webview/main.ts` + `webview/styles.css` with TASK-RES-001 → sequenced into
**wave 2** with `Dependencies: TASK-RES-001`. Touches only CSS rules outside RES-001's
.toolbar-context input rule and only one line of `makeIconButton` (the `btn.title` delete).

## §3 Approach

**Grounded delta, not the suggested 4-task split.** The orchestrator's suggested
TASK-RES-003 (extension SQL-rewrite handler) and TASK-RES-004 (re-render pipeline) are
pre-existing, shipped, and pinned by tests (`resultsPanelRequery.test.ts`,
`resultsPanelOrderBy.test.ts`, `resultsGridModelRequery.test.ts`, and the bundle tests in
`webviewRequery.test.ts` including the equal-row-count reset fix). Re-implementing them or
adding a new `unicdb/results/whereOrderBy` message discriminator would fork the `requery`
contract that `handleRequery` already consumes. **Rejected alternative:** new message type
+ new handler → duplicate pipeline, double the review surface, zero user value. The Enter
handler simply calls the existing `onRequeryClick()` (`webview/main.ts:3294`).

**TASK-RES-001 (webview):** move the four existing elements (`requeryWhere`,
`requeryOrderBy`, `requeryRunBtn`, `requeryClearBtn` — same class names
`.UnicDB-requery-where/-order/-run/-clear`, which `webviewPostCommit.test.ts` and
`webviewRequery.test.ts` select on) into the toolbar between `exportFormat` and
`exportHeader`; change placeholders to `WHERE …` / `ORDER BY …`; add one `keydown`
listener per input: `if (ev.key !== "Enter" || ev.isComposing) return; ev.preventDefault();
onRequeryClick();`. Delete the `UnicDB-requery-bar` wrapper + labels; restyle inputs with a
toolbar-context rule (flex `0 1 140px`, min-width `90px`, height aligned to
`.UnicDB-btn`/`.UnicDB-search-input`) so the toolbar stays one row tall. Buttons keep
`makeIconButton` (svg + title + aria-label contract, `webview/main.ts:674`).

**TASK-RES-002 (extension hardening):** new pure exported helper
`stripLeadingClauseKeyword(fragment: string, keyword: "WHERE" | "ORDER BY"): string` in
`src/ui/queryComposer.ts` — returns `fragment.trim()`, and when `fragment.trim()` starts
with the keyword case-insensitively followed by a whitespace boundary (or is exactly the
keyword), removes that ONE keyword and returns the rest trimmed. Called exactly twice, in
`handleRequery` (`resultsPanel.ts:1850-1851`) where `msg.where`/`msg.orderBy` enter the
host — the single choke point covering all four downstream composition lanes
(`composeRequery` line 1774/1786, `composeSortQuery` line 1798, multi-term wrap line 1803,
`combinedWhere` line 1779). `parseOrderBy` and `composeRequery` stay untouched (their
unit tests stay byte-identical green). **Rejected alternative:** stripping inside
`composeRequery` only → misses the dialect lanes (`composeSortQuery`, wrap, paging); the
double-strip would also be non-idempotent across lanes.

**Accepted behaviors recorded (not bugs):**
- Inputs are now visible in the empty state (toolbar is persistent; the old bar was hidden
  inside `gridWrap`). Enter with no active statement → existing host guard toasts
  "UnicDB: requery failed — no statement at index N." (`resultsPanel.ts:1853-1857`).
- Holding Enter fires repeated keydowns → repeated posts; host `requerySeq` guard
  (`resultsPanel.ts:1868-1870`) drops stale runs. Debounce-free per instruction.

**TASK-RES-003 (wave 2 — toolbar hover polish):** removes the ONLY second source of the
two-tooltip flicker — `btn.title` — so `data-tooltip` is the sole tooltip provider. Adds
`transition: background-color 80ms ease-out, box-shadow 80ms ease-out` to `.UnicDB-btn`
so the `:hover` background-color swap fades instead of cutting. Does NOT touch the
`data-tooltip` pseudo-element block (`webview/styles.css:78-115`) — that block is already
instant and correctly z-indexed (`z-index: 1000`); regex-pinned by TASK-RES-003 tests #5,#7.
**Rejected alternative:** removing `data-tooltip` and keeping `title` only → re-introduces
the 1-3s VS Code-webview tooltip delay. **Rejected alternative:** adding `transition: all`
→ would also ease layout-triggering properties (width/padding/border) and reintroduce the
very jitter this task exists to remove.

## §4 Test Plan

Existing fixtures: bundle tests eval `dist/webview.js` into jsdom with a stubbed
`acquireVsCodeApi` + `selectState()` (rows `[[1,"alpha"],[2,"beta"]]`) — pattern of
`webviewRequery.test.ts`. Host tests reuse the FakeWebview/FakeWebviewPanel + mocked
QueryRunner harness of `resultsPanelRequery.test.ts`. Bundle tests REQUIRE
`npm run compile` first (they eval `dist/webview.js` and self-skip when it is missing —
never accept a silent skip as green).

| Type | Test Name | Expected |
|------|-----------|----------|
| happy (webview) | Enter keydown on WHERE input (values `id > 1` / `id DESC`) → posts `requery` | exactly 1 message `{type:"requery", index:0, where:"id > 1", orderBy:"id DESC"}` |
| happy (webview) | Enter keydown on ORDER BY input (both boxes filled) | exactly 1 requery post carrying both values |
| happy (webview) | Toolbar placement | `.UnicDB-requery-where` and `.UnicDB-requery-order` are children of `.UnicDB-toolbar`, ordered after `.UnicDB-export-format` and before `.UnicDB-export-header`; no `[data-UnicDB-requery-bar]` element exists |
| happy (ext) | `stripLeadingClauseKeyword("WHERE id > 5", "WHERE")` | returns `"id > 5"` |
| happy (ext) | `stripLeadingClauseKeyword("ORDER BY id DESC", "ORDER BY")` then `parseOrderBy(out, dialect)` | `"id DESC"`; parse ok with 1 term, column `id` |
| happy (ext) | handler: requery msg `where:"WHERE a>1"` on fixture `SELECT a FROM t` | composed SQL sent to the runner contains `WHERE a>1` exactly once — no `WHERE WHERE` substring |
| edge (input-kind, webview) | keydown `"a"` then `"Escape"` in WHERE input | zero requery posts |
| edge (IME-kind, webview) | Enter keydown with `isComposing: true` | zero requery posts |
| edge (boundary, ext) | `"WHEREx"`, `"ORDER BYid"` (no whitespace after keyword) | returned unchanged (no strip) |
| edge (empty, ext) | `"WHERE"` alone → `""`; `"ORDER BY"` alone → `""`; `""` → `""` | all `""`; `composeRequery(sql,"","")` path returns original SQL |
| edge (case, ext) | `"where a=1"`, `"Where a=1"` | stripped (case-insensitive) |
| edge (repeat-input, ext) | `"WHERE WHERE x=1"` | `"WHERE x=1"` — exactly one strip, deterministic |
| regression (webview) | existing cases: Re-Run click posts, empty boxes post `{where:"",orderBy:""}`, Clear empties | unchanged GREEN (class names + click path preserved) |
| regression (webview) | toolbar icon-button census | `.UnicDB-toolbar .UnicDB-btn` buttons = 12 (was 10), each with svg + currentColor + title + aria-label; `flex-wrap: nowrap` structural regex still green |
| regression (webview) | old layout pins REWRITTEN: toolbar < gridWrap/gridHost document order; inputs present in empty state | updated assertions GREEN (old cases 5-7 replaced, not deleted silently) |
| regression (ext) | `resultsPanelRequery` "empty WHERE/ORDER BY emits the literal statement (no `;` corruption)" + `resultsPanelOrderBy` compose cases | unchanged GREEN — keyword-free fragments byte-identical |
| happy (RES-003 webview) | `makeIconButton` no longer sets `btn.title` | first `.UnicDB-btn` rendered in jsdom: `title` attr missing; `data-tooltip` and `aria-label` present | bundle compile, render stub |
| happy (RES-003 webview) | `.UnicDB-btn:hover:not(:disabled)` style block does not change any layout-triggering property | parse the CSS block; assert its declarations list EXCLUDES `width`, `height`, `padding`, `margin`, `border`, `top`, `left`, `right`, `bottom` (background-color + box-shadow only) | webview/styles.css |
| edge (RES-003 css) | `.UnicDB-btn` carries a `transition` rule | source regex matches `\.\s*UnicDB-btn\s*\{[^}]*transition\s*:` | webview/styles.css |
| edge (RES-003 css) | the transition contains NO layout-triggering property | parsed value excludes `width`/`height`/`top`/`left`/`margin`/`padding` | parsed CSS |
| edge (RES-003 css) | `data-tooltip` pseudo keeps `z-index: 1000` | source regex matches `\.UnicDB-btn\[data-tooltip\][^{]*\{[^}]*z-index\s*:\s*1000` | webview/styles.css |
| regression (RES-003 webview) | every toolbar button still has `data-tooltip` and `aria-label` matching its provided title text | for each rendered `.UnicDB-btn`: `getAttribute("data-tooltip")` and `getAttribute("aria-label")` both equal the original `title` arg | bundle compile |
| regression (RES-003 webview) | wave-1 toolbar icon-button census rewrites the `title` clause | the wave-1 census test (`.UnicDB-toolbar .UnicDB-btn` count = 12) keeps the `svg + currentColor + aria-label` pins but its `+ title` clause is removed in wave 2; REWRITTEN, not silently deleted (same pattern as the wave-1 layout-pin rewrites in row :169) | webviewToolbar.test.ts |
| regression (RES-003 css) | instant tooltip pseudo-element block (`UnicDB-btn[data-tooltip]:not(:disabled):hover::after`) intact | source regex finds the block and `content: attr(data-tooltip)` inside | webview/styles.css |

No bugfix against shipped behavior is claimed (the WHERE/WHERE duplication is a live UX
defect but no regression test can fail against pre-cycle code for the webview move; for
RES-002 the new edge cases DO fail against today's `handleRequery`, which passes fragments
through untouched).

## §5 Verification

```bash
npm run typecheck
npm run compile        # REQUIRED before any bundle (webview*) test — they eval dist/webview.js
# Wave 1 (TASK-RES-001 + TASK-RES-002 in parallel)
npx vitest run src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewToolbar.test.ts
npx vitest run src/ui/__tests__/requeryClauseNormalize.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts
# Wave 2 (TASK-RES-003 after RES-001)
npm run compile        # REQUIRED again — RES-003 edits webview/main.ts + webview/styles.css; a stale dist/webview.js will make the bundle tests self-skip
npx vitest run src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewToolbar.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/requeryClauseNormalize.test.ts
npm test               # full-suite final gate
```

`npm run lint` does not exist in this repo (package.json scripts: compile, watch, test,
test:integration, typecheck, package, publish:*, verify:fast, verify:release, profile:*);
`npm run typecheck` is the lint-equivalent gate and is mandatory. Bundle-eval tests
self-skip when `dist/webview.js` is missing — an executor that skips them without
`npm run compile` has NOT verified anything.

## §6 Acceptance

- [ ] `npm run typecheck` exits 0.
- [ ] `npx vitest run src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewToolbar.test.ts` — all GREEN with the NEW assertions (bundle actually evaluated: no `skipped` blocks counted as pass). Includes RES-003 hover-polish cases.
- [ ] `npx vitest run src/ui/__tests__/requeryClauseNormalize.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts` — all GREEN.
- [ ] `npm test` full suite GREEN.
- [ ] Manual smoke (executor, from VS Code dev host or documented equivalent): run a SELECT, type `id > 1` in WHERE + `id DESC` in ORDER BY, press Enter in each → grid re-renders filtered/sorted rows; invalid fragment (`WHERE (`) surfaces a DB error state, panel stays usable.
- [ ] Manual smoke (RES-003): hover each toolbar icon — ONE tooltip appears instantly (the `data-tooltip` pseudo); NO second tooltip arrives ~1.5 s later; icon background fades smoothly on mouse-in/mouse-out instead of flashing.
- [ ] Post-merge: `grep -nE 'btn\.title\s*=\s*title' webview/main.ts` returns 0 matches.
- [ ] Post-merge: `grep -nE 'transition\s*:' webview/styles.css` shows at least one match inside the `.UnicDB-btn { ... }` block.
- [ ] No file outside the Target Files lists of TASK-RES-001/002/003 modified.

## §7 Global Constraints

- No new npm dependencies; no new webview→extension message discriminator — the `requery` type (`webview/main.ts:171-176`) is the only contract.
- Placeholders exactly `WHERE …` and `ORDER BY …` (U+2026, matching the existing `Search…` style).
- Preserve class names `.UnicDB-requery-where`, `.UnicDB-requery-order`, `.UnicDB-requery-run`, `.UnicDB-requery-clear` (webviewPostCommit + webviewRequery tests select them).
- `.UnicDB-toolbar { flex-wrap: nowrap }` must remain — pinned by a structural source-regex test.
- Normalization strips exactly ONE leading clause keyword (case-insensitive, whitespace-bounded); never recursive.
- composeRequery's documented injection policy is unchanged (fragments are user-intended SQL).
- Bundle tests require `npm run compile`; treat self-skips as failures in review.
- RES-003: the `transition` added to `.UnicDB-btn` MUST list only `background-color` and `box-shadow` (composited properties — no layout trigger). NEVER `transition: all`; NEVER transition `width`/`height`/`padding`/`margin`/`top`/`left`.
- RES-003: do NOT touch the `.UnicDB-btn[data-tooltip]:not(:disabled):hover::after` pseudo-element block at `webview/styles.css:78-115`; tests #5 and #7 regex-pin it.
- No version bump / release (maintainer folds into the next release).

## Planner Report
PLANNER_MODEL: unic-smart + orchestrator-append RES-003 (unic-code)
PLAN_REVIEW: Approved by unic-smart (Round 1, 4 minor doc-fixes applied — compile-on-wave-2, property-level hover assertion, wave-1 census `title`-clause rewrite, toolbar DOM-order pin)

## Planner Self-Audit
Checklist: 12/12 pass for RES-001 + RES-002 (planner session); RES-003 added by the
orchestrator after P0 closed, with its own Task Gate fields populated, wave-structure
sequenced (wave 2 after RES-001), file-collision re-checked, and §7 constraints extended
to forbid `transition: all` / layout-triggering properties.
Fixed during audit: merged the drafted "DOM elements" + "Enter handler" webview tasks into one TASK-RES-001 (same-file collision on webview/main.ts); replaced the suggested extension handler tasks RES-003/004 with a grounded §1 correction (pipeline already shipped at accf1b5) instead of planning duplicate work; added the missing-owner test files for the toolbar button-census change (webviewToolbar.test.ts must move 10→12). For RES-003: pinned the data-tooltip pseudo-element as off-limits (tests #5 + #7), rejected `transition: all` as a re-introduction of layout jitter.
Known gaps: no automated visual/CSS assertion that the toolbar height is pixel-stable (verified structurally via nowrap pin + flex/min-width values; manual smoke in §6 covers it); empty-state Enter surfaces the existing host toast rather than a disabled input — accepted, recorded in §3; no pixel-level measure of `getBoundingClientRect()` before/after hover in jsdom (jsdom does not layout, so the test asserts property-level absence of layout-triggering transitions rather than runtime rect equality — accepted as the best achievable via the harness).

## Plan Review Log

### Round 1 — 2026-09-08 · unic-smart
REVIEWER_MODEL: unic-smart
Status: Approved

COMPLETENESS:
  - PLAN.md:193 — Wave-2 command block (and the §6 checklist item at :206) does not re-run `npm run compile` after RES-003 edits `webview/main.ts`; §4/:151 and §7/:223 make compile mandatory before any bundle test, so add the compile line to the wave-2 block to prevent a stale-`dist/webview.js` run.
  - none otherwise — intent, locked P0s, test matrix, verification, acceptance, and known gaps are all present.
CONSISTENCY:
  - PLAN.md:172 vs :237 — §4 RES-003 hover test asserts `getBoundingClientRect()` width/height equality before/after hover, but the Self-Audit says jsdom cannot measure rects and the test asserts property-level absence of layout-triggering transitions instead; align the §4 row with the property-level assertion actually planned so the implementing task copies one contract, not two.
  - PLAN.md:168 vs :171/:176 — the wave-1 census test pins `title` present on all 12 toolbar buttons while wave-2 RES-003 deletes `btn.title`; state explicitly that the census test's title clause is rewritten in wave 2 (same "REWRITTEN, not silently deleted" pattern used for the layout pins at :169).
CLARITY:
  - PLAN.md:16 vs :48 — placement is described both as "between the `tsv` dropdown and the `Search…` input" and "after `exportFormat`, before `exportHeader`"; add one sentence pinning the full toolbar DOM order so both wordings are verifiably the same slot.
SCOPE:
  - none — one focused cycle; explicit out-of-scope list; the RES-003 fold-in carries its own task, wave sequencing, and §7 constraints.
YAGNI:
  - none — new message type, duplicate requery pipeline, and `transition: all` are all explicitly rejected with reasons.

NOTES: Plan-review mode has no model-isolation gate; for awareness only, planner and reviewer both self-report unic-smart (the RES-003 orchestrator append was unic-code). All findings are one-line doc fixes; none would have led to a flawed plan.
