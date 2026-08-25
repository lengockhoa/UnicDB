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

(chua co comment)
