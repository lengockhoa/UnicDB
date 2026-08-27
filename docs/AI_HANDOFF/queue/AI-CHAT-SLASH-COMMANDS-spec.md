# Queue spec — AI Chat slash commands + session UX (next cycle)

Source: user request 2026-08-24, verbatim:

> I think we should mimic omp — a few of omp's commands are really nice to use. We should
> also be able to resume a session

Merged with spec AI-CHAT-INPUT-UX-spec.md in the same repo (Enter/Shift+Enter/attach/paste).

## Requirements

1. **Slash commands** in the AI Chat input box — mimic the UX of omp commands:
   - Type `/` → dropdown autocomplete listing commands.
   - Candidates: `/clear` (new chat), `/resume` (open picker of prior sessions — Resume-session
     picker from cycle O already exists, reuse it), `/engine` (switch omp/builtin), `/context`
     (view attached DB context), `/export` (export transcript), `/model` (switch work/smart).
   - Commands run locally and MUST NOT be uploaded to the model; Enter on a command → execute, NOT send message.
2. **Resume session**: alias of the existing Resume-session picker (cycle O) + `/resume`; list
   prior omp sessions, replay into chat, continue prompting on the loaded session.
3. The Clear button MUST always return to a chat-ready state (this bug is fixed in cycle R, NOT queued).

## Notes for planner

- Main file: `webview/aiChatPanelMain.ts` (input handling + dropdown UI), host command
  router in `src/ui/*` or `src/ai/*` per command.
- `/resume` reuses the cycle O picker — find "Resume-session picker" in src/ai or src/ui.
- Slash-command parser MUST be a pure, testable function (input → {command, args} | null).
