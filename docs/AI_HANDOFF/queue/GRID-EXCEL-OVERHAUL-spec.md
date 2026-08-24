# Queue spec — Grid Excel overhaul (cycle S candidate)

Consolidates ALL grid-related user requests from 2026-08-24 (supersedes GRID-EDIT-HIGHLIGHT-spec.md,
which is removed). Source quotes:

1. "Trên table result... khi edit thì phải đánh dấu lại cái field đã edit phải đổi màu...
   bấm Command Enter hoặc bấm nút icon check (commit) thì save lại luôn"
2. "[banner] Cannot save: postgres no-PK + ctid lookup failed for every dirty row — Tạo mới
   hình như chưa có ctid nên không có lưu được. Fix bug này... Tôi muốn cái Grid này như excel...
   thêm xóa sửa thoải mái như excel và command enter là lưu lại... hoặc bấm commit là lưu lại luôn.
   Nút undo cũng phải làm sao cho giống như excel... sau khi sửa xong undo lại thì lui lại bước trước"
3. "Chỗ dòng này [WHERE/ORDER BY bar] không có thẳng hàng... textfield và button phải đều đẹp
   và nằm chung 1 hàng"
4. "ở mỗi column, chỗ filter khi bung ra thì select all và từng chi tiết nằm không align đều
   bên trái, nhìn xấu quá"

## Bug root-cause notes (orchestrator investigation)

- `src/ui/resultsPanel.ts:699-748` `fetchPostgresCtids()` matches rows by VALUE comparison:
  `SELECT ctid FROM t WHERE col IS NOT DISTINCT FROM <literal>` for EVERY column, requiring
  `rows.length === 1`. Banner "all_failed" = every row returned 0 matches.
- Fragile: type round-trips (timestamp/Date, numeric, boolean) through `sqlLiteral(v)` can
  produce literals that don't match; duplicates → ambiguous; schema-qualified names; NULL-heavy
  new tables.
- **Recommended fix**: for postgres no-PK tables, include `ctid` in the initial result SELECT
  as a hidden column (host-side, `src/ui/resultsPanel.ts` requery/original query path) → exact
  row addressing, no value matching at all. Keep value-match only as fallback when ctid column
  absent (e.g. hand-written query on no-PK table). Investigate why current match fails on a
  freshly created table (likely Date/numeric literal round-trip in `sqlLiteral`).

## Requirements

### A. Fix no-PK save bug (P0 of cycle S)
- No-PK postgres table (freshly created via New Table form) → edit cell → commit saves
  successfully via ctid addressing (hidden-column approach above).
- Ambiguous/unsafe cases still refuse with clear message.

### B. Excel-like editing
- **Cell edit**: existing AG Grid editing; edited cells highlight (cellStyle/CSS class) vs
  original data until commit/revert. Dirty set keyed (rowKey, colId).
- **Add row**: insert new row (grid bottom "new row" affordance), highlight as added, saved
  as INSERT on commit. Values typed per column type.
- **Delete row**: row selection (existing checkboxes) + delete action (toolbar icon or Del
  key) → marked deleted (strikethrough/row highlight), saved as DELETE on commit.
- **Commit**: Cmd+Enter / Ctrl+Enter inside grid webview + toolbar check icon → runs all
  pending changes as one transaction batch (UPDATE/INSERT/DELETE), reports per-row errors,
  refreshes/syncs grid with DB, clears highlights (new baseline).

### C. Undo/redo (Excel-style)
- Undo stack steps back through: cell edits, row adds, row deletes (reverse order).
- AG Grid built-in `enableUndoRedo` covers cell edits only — add/remove need custom stack;
  prefer ONE unified stack driving grid state, Ctrl/Cmd+Z + Shift+Z (toolbar icons undo/redo).
- Undo after commit = out of scope round 1 (DB already written) — document, don't implement.

### D. Requery bar alignment (visual)
- WHERE label + input, ORDER BY label + input, run + clear buttons on ONE baseline row:
  flexbox `align-items: center`, equal heights (inputs/buttons same height, e.g. 26px),
  consistent gaps. Styles currently NOT in `webview/styles.css` (grep: no `vsdb-requery`
  rules — check how bar is styled today; likely missing → add proper rules).

### E. Set filter popup alignment (visual)
- Column filter dropdown: "Select All" and each item left-aligned on the same column edge
  (checkbox + label consistent indent). AG Grid JS Theming API (themeQuartz) — investigate
  `setFilterListItem` theme params / CSS overrides in `webview/main.ts` theme definition.

## Files (expected)
- `webview/main.ts` (grid opts, keybindings, toolbar, theme params, requery bar)
- `webview/styles.css` (highlight classes, requery bar rules)
- `src/ui/resultsPanel.ts` (ctid hidden column, save flow → INSERT/DELETE, messages)
- `src/core/saveStatements.ts` (build INSERT/DELETE + UPDATE batch)
- `src/ui/resultsGridModel.ts` / host-side dirty+undo model (if exists; else new)

## Verification notes
- Unit: saveStatements builder for insert/delete; ctid map from hidden column; undo stack
  transitions. Integration (docker PG): no-PK table edit→commit round-trip.
- Visual (D/E): needs human check or screenshot in extension — note in task acceptance.
