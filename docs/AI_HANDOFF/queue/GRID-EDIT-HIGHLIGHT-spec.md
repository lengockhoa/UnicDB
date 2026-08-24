# Queue spec — AG Grid edit highlight + commit UX (next cycle)

Source: user request 2026-08-24, verbatim:

> Trên table result. Chỗ AGGrid. Tôi thấy khi edit thì phải đánh dấu lại cái field đã edit
> phải đổi màu, để biết field đó đã sửa so với data gốc. Sau khi sửa xong ok thì bấm Command
> Enter hoặc bấm nút icon check (commit) thì save lại luôn

## Requirements

1. **Highlight ô đã sửa**: cell đã edit đổi màu (cellStyle/CSS class) so với data gốc,
   giữ highlight đến khi commit hoặc revert. So sánh với giá trị gốc (dirty tracking —
   có sẵn kết quả gốc trước edit; xem webview/main.ts + src/ui/resultsGridModel.ts).
2. **Commit/save**:
   - Nút icon check (toolbar) → save tất cả thay đổi đang dirty (path save hiện có của
     cycle B/D+E — tái dùng).
   - **Cmd+Enter / Ctrl+Enter** trong webview grid → cùng action commit.
3. Sau commit: clear highlight (data mới thành gốc), refresh/sync với DB.

## Notes for planner

- Files: `webview/main.ts` (grid options + keydown listener + toolbar nút check),
  `webview/main.css` (nếu tách), `src/ui/resultsGridModel.ts` nếu dirty-tracking nằm host-side.
- Cẩn thận xung đột keybinding: Cmd+Enter trong webview không phải editor SQL path.
- Dirty set nên keyed theo (row PK, colId) để render cellStyle function thuần, test được.
