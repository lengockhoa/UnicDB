# PLAN — Cycle SH: Multi-selection Cmd+Enter for shellscript (run highlighted lines in "UnicDB Script" terminal)

## §1 Intent

When a user highlights text in a `.sh` file (any VS Code `shellscript` file) and presses
Cmd+Enter, run ONLY the highlighted lines (or the cursor line when there is no selection)
in the reused "UnicDB Script" terminal — mirroring the SQL multi-selection Cmd+Enter
pattern shipped in v1.53.18 (commit 3e33f0a, `runQueryFromEditor` at `src/extension.ts:2495`).

P0 answers (USER-CONFIRMED, verbatim — later phases do not re-ask):

1. Output destination: **reused "UnicDB Script" terminal** (the same terminal the existing
   `UnicDB.runScript` command already uses — `runScriptTerminal` global at `src/extension.ts:126`).
2. Empty-selection behavior: **run just that line** (the line containing the cursor —
   equivalent to SQL's "statement at cursor").
3. Language scope: **shellscript language only** (matches the existing runScript `when`
   clause + activation event `onLanguage:shellscript`). Covers .sh/.bash/.zsh/.ksh because
   VS Code labels them all `shellscript`.

Success = pressing Cmd+Enter in a shellscript editor sends exactly the selected text (or
cursor line) to the reused "UnicDB Script" terminal; whole-file `UnicDB.runScript` and SQL
`UnicDB.runQuery` behavior are unchanged.

## §2 Scope

In-scope:
- New command `UnicDB.runShellSelection` in `src/extension.ts` (`commandRunShellSelection`)
  + registration in `activate()` near the existing `UnicDB.runScript` registration
  (`src/extension.ts:898-900`).
- Manifest: `package.json` → `contributes.commands` entry, `activationEvents` `onCommand`
  entry, `contributes.keybindings` Cmd+Enter (mac) + Ctrl+Enter (win/linux) with
  `when: editorTextFocus && resourceLangId == shellscript`.
- Tests: extend `src/scaffold.test.ts` (manifest shape) and `src/extension.test.ts`
  (command behavior + regression net).

Out-of-scope:
- `commandRunScript` (`src/extension.ts:3215`) keeps its whole-file behavior — it backs the
  title-bar "UnicDB: Run Script" button (TASK-505). Do not change it.
- No changes to any SQL path (`runQueryFromEditor`, `splitStatements`, connections,
  `executeAll`).
- No editor/title menu entry, no user-guide/CHANGELOG update (not requested this cycle).
- CONSTRAINT: no two same-wave tasks share a file — satisfied (see split below).

## §3 Approach

Follow the rails suggested by P0 (already validated against the codebase):

1. `commandRunShellSelection()` in `src/extension.ts` (near `commandRunScript`, ~line 3215):
   - Early return if no active editor or `editor.document.languageId !== "shellscript"`
     (silent no-op — this is a keybinding command, no warning; contrast `commandRunScript`
     which warns because it is palette-invocable).
   - Iterate `editor.selections` (plural) with the same compat fallback the SQL path uses
     (`selections && selections.length > 0 ? selections : [editor.selection]`).
   - Non-empty selection → range text (same `offsetAt` substring technique as
     `runQueryFromEditor:2540-2545`). Empty selection →
     `editor.document.lineAt(sel.active.line).text` with trailing `\r` stripped.
   - Skip empty/whitespace-only pieces.
   - For each remaining piece, in selection order: reuse/create `runScriptTerminal`
     (same guard as `commandRunScript:3226` — recreate when disposed) and
     `sendText(piece + "\n")` per piece. `show()` once after the loop, only if ≥1 piece sent.
   - Per-piece `sendText` (not one joined blob) matches the confirmed test expectations:
     N disjoint selections → N sends; a multi-line selection is 1 piece → 1 send.
2. Register `UnicDB.runShellSelection` in `activate()` next to `UnicDB.runScript`
   (`src/extension.ts:898-900`), pushed into `disposables`.
3. `package.json`: command entry (category "UnicDB", icon `$(play)` — same shape as
   `UnicDB.runScript`), `activationEvents` `onCommand:UnicDB.runShellSelection`
   (repo convention: every command lists one explicitly), 2 keybinding rows.
4. No `when`-clause conflict: the new binding is scoped to `shellscript`, the existing
   `UnicDB.runQuery` bindings to `sql` (`package.json` `contributes.keybindings`).

Trade-offs / alternatives rejected:
- Reusing `commandRunScript` with a flag: rejected — it must keep warning + whole-file
  semantics for the title-bar button; a separate function keeps both behaviors reviewable.
- Extending `src/extension.test.ts` instead of a new
  `src/extension.runShellSelection.test.ts`: chosen — the file already owns the selections-aware
  editor stub factory (~line 2271, built for SQL multi-selection) and the TASK-505 terminal
  stubs (~line 68); a new file would duplicate the ~300-line `vi.mock("vscode")`.

## §4 Test Plan (TDD — mandatory)

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | 3 disjoint single-line selections → Cmd+Enter | exactly 3 `sendText` calls, texts = the 3 selected lines, in selection order, each + `"\n"` |
| happy | cursor-only (no selection) on line N | exactly 1 `sendText` with line N text + `"\n"` |
| happy | one selection spanning 3 consecutive lines | exactly 1 `sendText` with the 3-line joined text + `"\n"` |
| edge (empty/whitespace) | whitespace-only selection + blank cursor line | 0 `sendText` calls, no terminal created |
| edge (guard) | active editor `languageId !== "shellscript"` (e.g. `sql`) | command returns early, 0 `sendText` even with selections present |
| edge (null) | no active editor (`activeTextEditor === undefined`) | silent no-op — no `sendText`, no `showWarningMessage`/`showErrorMessage` |
| edge (boundary) | previous terminal has `exitStatus !== undefined` | a NEW terminal is created (dead terminal not reused), text goes to the new one |
| regression | `UnicDB.runScript` full-file behavior (TASK-505 tests) | existing `src/extension.test.ts` describe "TASK-505 — runScript command + terminal reuse" stays green (full `document.getText()` still sent) |
| regression | `UnicDB.runQuery` SQL Cmd+Enter multi-selection | existing multi-selection describe (~`src/extension.test.ts:2204`) stays green |

Manifest-level tests (TASK-SH-001, in `src/scaffold.test.ts` style):

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | keybindings contain `UnicDB.runShellSelection` mac `cmd+enter` | `when` === `editorTextFocus && resourceLangId == shellscript` |
| happy | commands + activationEvents entry | `contributes.commands` has the command (title/category) and `activationEvents` contains `onCommand:UnicDB.runShellSelection` |
| edge (platform variant) | win/linux `ctrl+enter` row exists | `win` and `linux` keys present with same `when` |
| edge (negative) | new binding does not clobber SQL | runQuery rows still `resourceLangId == sql`; new rows match `/shellscript/` |
| regression | existing runScript/runQuery manifest assertions | current `src/scaffold.test.ts` assertions stay green |

## §5 Verification

Project scripts (`package.json`): `test` = `vitest run`, `typecheck` = `tsc --noEmit`,
`compile` = esbuild. **No lint script exists** (stated explicitly; `typecheck` is the
static gate).

Per-task (narrowed, never the full suite by default):

```bash
npx vitest run src/scaffold.test.ts      # TASK-SH-001
npx vitest run src/extension.test.ts     # TASK-SH-002
npm run typecheck                        # both tasks
```

Wave-boundary regression net (RULES.md — after BOTH tasks pass, run once):

```bash
npm test
```

Baseline: working tree clean at `main @ 86b034e` (release 1.53.18); no stale in-flight work
(P1 confirmed CYCLE_STATE=fresh).

## §6 Acceptance Criteria

- [ ] Cmd+Enter in a shellscript editor sends only the selected line(s) / cursor line to the
      reused "UnicDB Script" terminal (TASK-SH-002).
- [ ] Multi-selection, cursor-only, and multi-line-selection behaviors per §4 rows 1-3
      (TASK-SH-002).
- [ ] Whitespace-only, wrong-language, no-editor, dead-terminal edge cases per §4 rows 4-7
      (TASK-SH-002).
- [ ] `package.json` carries command + activationEvents + Cmd/Ctrl+Enter keybindings scoped
      to shellscript, asserted by tests (TASK-SH-001).
- [ ] `commandRunScript` whole-file behavior and SQL `runQuery` Cmd+Enter unchanged
      (regression rows, TASK-SH-001 + TASK-SH-002).
- [ ] `npm run typecheck` exits 0 (both tasks).
- [ ] Wave-boundary full `npm test` exits 0 (cycle gate).

## §7 Global Constraints

- New command id is exactly `UnicDB.runShellSelection` (both tasks must use this literal string).
- New function name is exactly `commandRunShellSelection`; module-level terminal stays
  `runScriptTerminal` (shared with `commandRunScript` — reuse, do not add a second terminal).
- Shellscript language scope only; `when` clause literally
  `editorTextFocus && resourceLangId == shellscript`.
- Do not modify `commandRunScript`, `runQueryFromEditor`, or any SQL path.
- Do not add editor/title menu entries, docs, or CHANGELOG in this cycle.
- Keybinding pattern mirrors existing runQuery rows: `{ command, key, mac, when }` +
  `{ command, key, win, linux, when }`.
- No new dependencies; no new test runner; vitest + existing `vi.mock("vscode")` pattern only.
- Title: `UnicDB: Run Selection in Script Terminal`, category `UnicDB`, icon `$(play)`.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 1, 2026-09-07)

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) chose extend-`src/extension.test.ts` over a new test file — the
selections-aware editor stub factory (~line 2271) and TASK-505 terminal stubs (~line 68)
already live there; a new file would duplicate the vscode mock. (2) added the dead-terminal
edge case (§4 row 7) — the reuse guard at `src/extension.ts:3226` has no test coverage for
the new command otherwise. (3) reconciled caller's per-piece vs joined sendText expectation:
per-piece `sendText(piece + "\n")` satisfies both rows 1 and 3.
Known gaps: user-guide/CHANGELOG updates intentionally out of scope (not in P0 rails);
`onCommand` activation events are auto-generated by modern VS Code anyway — the explicit
entry is repo-convention consistency, asserted by TASK-SH-001.

## Plan Review Log

### Round 1 — Approved (2026-09-07)
VERDICT: Approved
REVIEWER_MODEL: unic-smart
FINDINGS:
  critical: none
  important: none
  minor:
    - PLAN.md §3 step 1 + TASK-SH-002 contract item 3 — line citation drift: the `offsetAt`
      substring technique for non-empty selections is at `src/extension.ts:2537-2539`
      (selections fallback at 2530-2533); the cited `runQueryFromEditor:2540-2545` is the
      empty-selection `statementAtCursor` branch. Similarly the runScript registration block
      is `src/extension.ts:899-901` (898 is the comment), not 898-900. Prose is unambiguous;
      fix citations only, no behavior change.
    - PLAN.md §4 row 3 + TASK-SH-002 row 3 — multi-line-selection expectation is
      fixture-dependent: a selection ending at col 0 of the line AFTER the last selected line
      yields a piece already ending in `\n`, so `sendText(piece + "\n")` sends a doubled
      trailing newline (harmless blank prompt, but the exact expected string in the test is
      ambiguous). Fix: pin the fixture (selection ends at end-of-line of the last selected
      line) or specify stripping one trailing `\n` from the piece before appending.
NOTES: All source anchors verified against the tree at main @ 86b034e (`runScriptTerminal`
:126, `runQueryFromEditor` :2495, `commandRunScript` :3215, reuse guard :3226, deactivate
disposal :1601-1607, test stubs :68/:672/:687/:395-401/:2204/:2271, scaffold :73/:102-110/
:178-205; `lineAt` genuinely absent from the test factory as TASK-SH-002 anticipates).
P0 rails recorded verbatim in §1; task file ownership disjoint; PLAN §4 rows map 1:1 to both
tasks' test tables (3 happy + 4 edge + 2 regression behavior; 2 happy + 2 edge + 1 regression
manifest — exceeds handoff.plan minimums); verification includes typecheck + narrowed vitest
runs + wave-boundary `npm test`, and the "no lint script" claim is confirmed against
package.json scripts. Transparency note: planner and reviewer share the `unic-smart` alias
this round; `handoff.reviewer.mustDifferFromExecutor` binds the P3 executor, not the planner.
