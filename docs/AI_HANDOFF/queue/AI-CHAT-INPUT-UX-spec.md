# Queue spec — AI Chat input UX (next cycle)

Source: user request 2026-08-24, verbatim:

> At the AI chat, Enter should mean send. To start a new line, press Shift+Enter
> to break the line. Also allow attaching images. Pasting from the clipboard should work too

## Requirements

1. **Enter = send** in the AI Chat input box (webview/aiChatPanelMain.ts).
2. **Shift+Enter = new line** (plain Enter MUST never insert a newline).
3. **Attach image**: attach button + pick image file → preview thumbnail → send with the message.
4. **Paste image from clipboard**: Ctrl/Cmd+V an image inside the input → attach as in (3).
5. Images go into AI via the vision-capable model path if the provider supports it (the work model has a
   `vision: true` flag in settings — see src/ai/config.ts); if the model does NOT support it,
   show a clear warning instead of failing silently.

## Notes for planner

- After cycle R, the executor should have an AI stack already audited/fixed — this cycle ONLY touches input UX.
- Main file: `webview/aiChatPanelMain.ts` + host message contract (`src/ai/*` if image
  parts in the message are needed) + `webview/aiChatPanel.css` if present.
- PostMessage between webview and host needs an extension for image attachments (base64 or
  workspace URI).
- End of cycle: patch release following the 1.6.x pattern exactly (CHANGELOG + lockfile sync +
  releaseHygiene test auto-checks).
