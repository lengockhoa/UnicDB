# TASK-UX1-005 — Filter dropdown: Select All aligned with item checkboxes (R5)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 1), §3 (UX1-005)

## Goal

The set-filter popup's Select All checkbox sits visibly offset from the item checkboxes
below it ("nhìn ngứa mắt khi không đều"). Pin both rows to an identical flex scaffold and
identical checkbox x-indent in `webview/styles.css`, keeping the Select All divider, and
lock the contract with a CSS-source test (jsdom does not apply stylesheets).

## Target Files

- `webview/styles.css` — ONLY the `.vsdb-setfilter-selectall-row` /
  `.vsdb-setfilter-selectall-label` / `.vsdb-setfilter-entry` rule blocks (styles.css:580,
  585, 602) + the TASK-009 shared-indent rule (:1113). Wave-1 region contract (operative
  rule, P2.5 round 1): this task owns the `.vsdb-setfilter-*` selector family;
  `.vsdb-chat-*` belongs to UX1-008 and the appended `.vsdb-ddl-*` block to UX1-010 — do
  not touch either.
- `webview/main.ts` — ONLY if reproduction shows a structural cause in the SetFilter
  component DOM (rows built at :1294-1299 select-all vs :1468-1485 entries); expected
  fix is CSS-only, and any main.ts change must stay inside the SetFilterComponent class.
- `src/ui/__tests__/webviewSetFilter.test.ts` — new CSS-contract describe block.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | select-all row and entry row declare identical indent-bearing declarations | `ruleBody('.vsdb-setfilter-selectall-row')` and `ruleBody('.vsdb-setfilter-entry')` each contain a `padding: <same>px <same>px` (or `padding-left: <same>px`) declaration with the SAME value; both declare `align-items: center` | read webview/styles.css from disk (chatLayoutCss.test.ts pattern) |
| 2 | happy | select-all label matches entry row flex scaffold | `.vsdb-setfilter-selectall-label` and `.vsdb-setfilter-entry` both declare `display: flex`, `align-items: center`, `gap: <same>` | same |
| 3 | edge A — divider kept | Select All divider survives the change | `.vsdb-setfilter-selectall-row` still declares `border-bottom` | same |
| 4 | edge B — boundary | no other setfilter rule re-introduces a divergent indent | no occurrence of `vsdb-setfilter-selectall` or `vsdb-setfilter-entry` selector blocks carrying a different `padding-left` than the value pinned in case 1 | regex over whole file |
| 5 | regression | RED check pins today's offset | BEFORE the CSS edit, case 1 fails (today the rows carry `4px 8px` vs `2px 8px` block padding and the label adds its own layer with no shared scaffold); record the RED output in Discussion | current styles.css on main |
| 6 | edge C — DOM invariants preserved | runtime reproduction prerequisites still hold | existing `webviewSetFilter.test.ts` suite passes unchanged (Select All toggles visible rows only; hidden entries survive) | existing tests |

## Test Files

- `src/ui/__tests__/webviewSetFilter.test.ts` — cases 1–5 (new describe block appended).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/webviewSetFilter.test.ts
npm run typecheck && npm run compile
```

After compile, executor MUST do one manual runtime check (extension host): open a results
grid, open a column's set-filter, confirm Select All and item checkboxes share the same
x-position; note the observation in Discussion (vision evidence for this request was
unusable, so the code-derived contract is the pin, the runtime check is the confirmation).

## Acceptance Criteria

- [ ] Cases 1–6 pass; case 5 recorded RED before the CSS edit.
- [ ] Only setfilter-region CSS changed; `git diff -- webview/styles.css` shows no
      `.vsdb-chat`/`.vsdb-md`/`.vsdb-ddl` hunks.
- [ ] Runtime reproduction note present in Discussion with the observed offset before/after.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: `SetFilterComponent` DOM contract (webview/main.ts:1262-1330 — selectAllRow >
  selectAllLabel > selectAllCheckbox; entries as flat `label.vsdb-setfilter-entry` rows);
  the `ruleBody()` CSS-contract test pattern from src/ui/__tests__/chatLayoutCss.test.ts.
- Produces: stable `.vsdb-setfilter-selectall-row` / `.vsdb-setfilter-entry` flex
  scaffold + indent contract that later filter styling must not break (case 4 guards it).

---

## Discussion

### 2026-09-04 · planner · unic-smart
Vision receipts for this screenshot were UNREADABLE/unrelated, so the exact pixel offset
is unknown. Code-derived cause: the TASK-009 pin (styles.css:1113) equalises
`padding-left: 8px` on both rows, but the rows' block padding still differs (`4px 8px`
select-all vs `2px 8px` entries) and the select-all checkbox sits one extra label layer
deep with its own gap — in the popup's flex context the checkbox x-positions diverge.
The pinned contract (cases 1–2) is the observable outcome; if runtime reproduction shows
a different mechanism, fix THAT mechanism and adjust the pinned declarations accordingly —
the test asserts equality of the two rows, not specific pixel values, so it survives a
cause correction as long as equality holds.
