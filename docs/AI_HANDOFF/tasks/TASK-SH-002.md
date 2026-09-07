# TASK-SH-002 — `commandRunShellSelection`: run highlighted lines in the reused "UnicDB Script" terminal

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (behavior table), §7

## Goal

Add `commandRunShellSelection()` to `src/extension.ts`: on Cmd+Enter in a `shellscript`
editor, send ONLY the selected line(s) (or cursor line when no selection) to the reused
`runScriptTerminal` ("UnicDB Script") — mirroring the SQL multi-selection pattern in
`runQueryFromEditor` (`src/extension.ts:2495`) without touching any SQL path.

## Target Files

- `src/extension.ts` — add `async function commandRunShellSelection(): Promise<void>` near
  `commandRunScript` (~line 3215), and register it in `activate()` right after the
  `UnicDB.runScript` registration block (lines 898-900):
  `disposables.push(vscode.commands.registerCommand("UnicDB.runShellSelection", () => commandRunShellSelection()));`
- `src/extension.test.ts` — new describe block for the command (pattern: TASK-505 describe at
  line 672 + selections-aware editor factory at ~line 2271). Extend the editor stub factory
  with `lineAt(line: number): { text: string }` if missing.

Implementation contract (exact behavior):

1. `const editor = vscode.window.activeTextEditor;` — if `!editor` OR
   `editor.document.languageId !== "shellscript"` → silent return (NO warning — keybinding
   command; `commandRunScript` warns only because it is palette-invocable).
2. `const allSelections = editor.selections && editor.selections.length > 0 ? editor.selections : [editor.selection];`
   (same compat fallback as `runQueryFromEditor`).
3. Per selection, in order: non-empty → range text via `offsetAt` substring (same technique
   as `runQueryFromEditor:2540-2545`); empty →
   `editor.document.lineAt(sel.active.line).text.replace(/\r$/, "")`.
4. Skip pieces that are empty after `trim()`. If none remain → return without creating a terminal.
5. Reuse guard identical to `commandRunScript:3226`:
   `if (!runScriptTerminal || runScriptTerminal.exitStatus !== undefined) { runScriptTerminal = vscode.window.createTerminal({ name: "UnicDB Script" }); }`
6. For each remaining piece: `runScriptTerminal.sendText(piece + "\n")`. After the loop:
   `runScriptTerminal.show();` once.
7. Do NOT modify `commandRunScript`, `runQueryFromEditor`, `statementAtCursor`, or deactivation
   disposal (lines 1601-1607 already dispose the shared terminal).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | 3 disjoint single-line selections | `createTerminal` called once with `{ name: "UnicDB Script" }`; exactly 3 `sendText` calls: `lineA\n`, `lineB\n`, `lineC\n` in selection order; `show` called | editor stub, `languageId: "shellscript"`, 3 selections via the factory at ~2271 |
| 2 | happy | cursor-only on line N | exactly 1 `sendText("line N text\n")` | shellscript editor, one empty selection at line N |
| 3 | happy | one selection spanning 3 consecutive lines | exactly 1 `sendText` with the 3-line text + `"\n"` | shellscript editor, single non-empty selection |
| 4 | edge (empty/whitespace) | whitespace-only selection + blank cursor line | 0 `sendText` calls; `createTerminal` NOT called; `show` NOT called | shellscript editor, selection = `"   "`, other cursor on empty line |
| 5 | edge (guard) | wrong language | command returns early — 0 `sendText` even with non-empty selections | editor with `languageId: "sql"` |
| 6 | edge (null) | no active editor | silent no-op: no `sendText`, AND `showWarningMessage`/`showErrorMessage` never called | `state.activeEditor = undefined` |
| 7 | edge (boundary) | dead terminal | when stub terminal has `exitStatus !== undefined`, a NEW terminal is created and text is sent to it | pre-set disposed terminal in the mock state (mirror TASK-505 reuse test) |
| 8 | regression | `UnicDB.runScript` still whole-file | existing describe "TASK-505 — runScript command + terminal reuse" (line 672) green unchanged | base file |
| 9 | regression | SQL `UnicDB.runQuery` multi-selection unchanged | existing multi-selection describe (~line 2204) green unchanged | base file |

## Test Files

- `src/extension.test.ts` — tests #1-#7 in a new describe block; #8-#9 are the existing
  blocks that must stay green when the whole file runs. Use `vi.resetModules()` between tests
  that touch the terminal (TASK-505 pattern, line ~686) so the module-level
  `runScriptTerminal` does not leak.

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npm run typecheck
# Project has NO lint script (checked package.json scripts) — typecheck is the static gate.
# Wave-boundary regression net after BOTH SH tasks pass (run once):
npm test
```

## Acceptance Criteria

- [ ] All 9 test rows pass (test first → RED output pasted in Executor Report → implement → GREEN).
- [ ] `npm run typecheck` exits 0.
- [ ] Only `commandRunShellSelection` + its registration added to `src/extension.ts`; no SQL
      or `commandRunScript` lines changed.
- [ ] Command id registered is exactly `UnicDB.runShellSelection` (matches TASK-SH-001 manifest).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — behavior tests use the mocked `vscode` module (`vi.mock("vscode")`), so they run
  without TASK-SH-001's manifest entries. Same-wave file ownership is disjoint:
  this task owns `src/extension.ts` + `src/extension.test.ts`.

## Interfaces

- Consumes: module-level `runScriptTerminal: vscode.Terminal | null` (`src/extension.ts:126`)
  with the reuse guard pattern at line 3226; mock seam `state.registeredCommands` /
  terminal stubs in `src/extension.test.ts` (lines 68, 395-401).
- Produces: registered command `"UnicDB.runShellSelection"` (handler
  `commandRunShellSelection(): Promise<void>`) — the manifest side is owned by TASK-SH-001
  and must reference this exact id.

---

## Discussion

### 2026-09-07 · planner · unic-smart
- Per-piece `sendText(piece + "\n")` (not one joined blob): N disjoint selections → N sends;
  a multi-line selection is one piece → one send. This is what test rows 1 and 3 pin down.
- The selections-aware editor factory (~line 2271) was built for SQL multi-selection; its
  document stub may lack `lineAt` — add it to the factory (small mock extension), do not fork
  a second factory.
- `onLanguage:shellscript` activation already exists in `package.json` (verified), so no
  activation-event work is needed on this side.
