# Queue spec — AI Chat slash commands + session UX (next cycle)

Source: user request 2026-08-24, verbatim:

> Tôi nghĩ nên bắt chước trong omp có mấy cái lệnh của omp xài cũng sướng lắm mà. có thể
> resume lại session nữa cũng được

Gộp với spec AI-CHAT-INPUT-UX-spec.md cùng repo (Enter/Shift+Enter/attach/paste).

## Requirements

1. **Slash commands** trong ô input AI Chat — mô phỏng UX lệnh của omp:
   - Gõ `/` → dropdown autocomplete danh sách lệnh.
   - Ứng viên: `/clear` (new chat), `/resume` (mở picker session cũ — đã có Resume-session
     picker từ cycle O, tái dùng), `/engine` (đổi omp/builtin), `/context` (xem DB context
     đang gắn), `/export` (xuất transcript), `/model` (đổi work/smart).
   - Lệnh chạy local không gửi lên model; Enter trên lệnh → execute, không send message.
2. **Resume session**: alias của Resume-session picker hiện có (cycle O) + `/resume`; list
   prior omp sessions, replay vào chat, tiếp tục prompt trên session đã load.
3. Nút Clear phải luôn quay về trạng thái chat-được (bug này fix ở cycle R, không queue).

## Notes for planner

- File chính: `webview/aiChatPanelMain.ts` (input handling + dropdown UI), host command
  router ở `src/ui/*` hoặc `src/ai/*` tương ứng từng lệnh.
- `/resume` tái dùng picker cycle O — tìm "Resume-session picker" trong src/ai hoặc src/ui.
- Slash-command parser nên là pure function test được (input → {command, args} | null).
