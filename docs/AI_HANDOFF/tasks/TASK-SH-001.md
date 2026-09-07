# TASK-SH-001 — Manifest: `UnicDB.runShellSelection` command + Cmd/Ctrl+Enter shellscript keybindings

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §4 (manifest table), §7

## Goal

Contribute the new command `UnicDB.runShellSelection` in `package.json` (command entry,
activation event, keybindings) and lock the manifest shape with tests in
`src/scaffold.test.ts`. Mirrors the existing `UnicDB.runQuery` Cmd+Enter rows
(`when: editorTextFocus && resourceLangId == sql`) but scoped to `shellscript`.

## Target Files

- `package.json` — add to `contributes.commands`: `{ "command": "UnicDB.runShellSelection", "title": "UnicDB: Run Selection in Script Terminal", "category": "UnicDB", "icon": "$(play)" }` (same shape as the `UnicDB.runScript` entry); add `"onCommand:UnicDB.runShellSelection"` to `activationEvents` (repo convention: every command lists one — see existing list); add 2 rows to `contributes.keybindings` (below).
- `src/scaffold.test.ts` — extend the existing manifest test (or add a sibling describe, style of lines 102-110 / 178-205): assert the new keybindings + command + activation event.

Keybinding rows (exact):

```json
{ "command": "UnicDB.runShellSelection", "key": "cmd+enter", "mac": "cmd+enter",
  "when": "editorTextFocus && resourceLangId == shellscript" }
{ "command": "UnicDB.runShellSelection", "key": "ctrl+enter", "win": "ctrl+enter",
  "linux": "ctrl+enter", "when": "editorTextFocus && resourceLangId == shellscript" }
```

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | keybindings contain `UnicDB.runShellSelection` with mac `cmd+enter` | a row exists where `command==="UnicDB.runShellSelection"`, `mac==="cmd+enter"`, `when==="editorTextFocus && resourceLangId == shellscript"` | read `package.json` as `src/scaffold.test.ts:73` already does |
| 2 | unit | command + activation event contributed | `contributes.commands` has the command with `title` starting `"UnicDB: Run Selection"` and `activationEvents` contains `"onCommand:UnicDB.runShellSelection"` and `"onLanguage:shellscript"` | same manifest fixture |
| 3 | edge (platform variant) | win/linux `ctrl+enter` variant exists | a row with `win==="ctrl+enter"` and `linux==="ctrl+enter"`, same `when` | same manifest fixture |
| 4 | edge (negative) | new shellscript binding does not clobber SQL rows | every `UnicDB.runQuery` keybinding row still has `when` matching `/resourceLangId == sql/`; every `UnicDB.runShellSelection` row matches `/shellscript/` | same manifest fixture |
| 5 | regression | existing TASK-605 + runQuery manifest assertions still pass | all pre-existing tests in `src/scaffold.test.ts` green unchanged | current file at base 86b034e |

## Test Files

- `src/scaffold.test.ts` — contains tests #1-#5 above (modify existing file; match its
  read-package.json + `expect(...)` style).

## Verification Commands

```bash
npx vitest run src/scaffold.test.ts
npm run typecheck
# Project has NO lint script (checked package.json scripts) — typecheck is the static gate.
# Wave-boundary regression net after BOTH SH tasks pass (run once):
npm test
```

## Acceptance Criteria

- [ ] All 5 test cases above pass (write test first, capture RED, then implement).
- [ ] `npm run typecheck` exits 0.
- [ ] No other manifest keys changed (no menus, no new views, no version bump).
- [ ] Existing `src/scaffold.test.ts` assertions unchanged and green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — manifest-only change; `src/scaffold.test.ts` reads `package.json` directly and
  never imports `src/extension.ts`, so it passes before TASK-SH-002 lands.

## Interfaces

- Consumes: (none)
- Produces: command id literal `UnicDB.runShellSelection` in `contributes.commands` +
  `activationEvents` + 2 keybinding rows with `when: editorTextFocus && resourceLangId == shellscript`.
  TASK-SH-002 registers a handler for this exact id in `src/extension.ts`.

---

## Discussion

### 2026-09-07 · planner · unic-smart
- Command palette entry is a deliberate byproduct of `contributes.commands` (matches
  `UnicDB.runQuery`/`UnicDB.runScript`); no editor/title menu this cycle per PLAN §2.
- No `selection`/code changes allowed here — TASK-SH-002 owns `src/extension.ts`.
