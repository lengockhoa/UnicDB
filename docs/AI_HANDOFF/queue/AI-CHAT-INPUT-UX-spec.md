# Queue spec — AI Chat input UX (next cycle)

Source: user request 2026-08-24, verbatim:

> Ở chỗ AI chat, Khi mà enter thì coi như send. Nếu mà xuống dòng thì phải gõ shift enter
> là xuống dòng. Cho phép attach hình vào nữa. Có thể paste từ clipboard vào nữa

## Requirements

1. **Enter = send** trong ô input AI Chat (webview/aiChatPanelMain.ts).
2. **Shift+Enter = xuống dòng** (Enter thường không bao giờ chèn newline).
3. **Attach hình**: nút attach + chọn file ảnh → preview thumbnail → gửi kèm message.
4. **Paste ảnh từ clipboard**: Ctrl/Cmd+V ảnh trong ô input → attach như (3).
5. Images đi vào AI qua vision-capable model path nếu provider hỗ trợ (work model có
   `vision: true` flag trong settings — xem src/ai/config.ts); nếu model không hỗ trợ,
   hiển thị cảnh báo rõ ràng thay vì fail im lặng.

## Notes for planner

- Executor sau cycle R nên có AI stack đã được audit/fix — cycle này chỉ đụng input UX.
- File chính: `webview/aiChatPanelMain.ts` + host message contract (`src/ai/*` nếu cần
  image parts trong message) + `webview/aiChatPanel.css` nếu có.
- Post Message giữa webview và host cần extension cho image attachments (base64 hoặc
  workspace URI).
- Cuối cycle: patch release theo đúng pattern 1.6.x (CHANGELOG + lockfile sync +
  releaseHygiene test tự bắt).
