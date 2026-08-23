# TASK-605 — Run .sh fix (activation + guard) + CodeLens ▶ Run

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.C

## Goal

Make Run-.sh actually work for the user: fix the statically-verifiable defects that
keep `vsdb.runScript` from being runnable/visible, and add the SQL-like CodeLens
`▶ Run` on shellscript documents. User quote: "Tôi vẫn chưa thể run file này nè. file SH
này tôi muốn runable và có nút run giống SQL".

## Target Files

- `package.json` — `activationEvents`: add `"onCommand:vsdb.runScript"` AND `"onLanguage:shellscript"`; `contributes.configuration.properties`: add `vsdb.showRunLensSh` (boolean, default true); (menu entry `vsdb.runScript` in `menus.editor/title` + `$(play)` icon already exist — pin with tests, fix only if the assertions reveal a gap)
- `src/extension.ts` — register the CodeLens provider for `{ scheme: "file", language: "shellscript" }` (alongside the sql registration at lines 83-90); guard `commandRunScript` (line 573): no `activeTextEditor` OR empty document → `vscode.window.showWarningMessage("VSDB: open a .sh file to run")` and return WITHOUT creating a terminal
- `src/ui/codeLensProvider.ts` — `provideCodeLenses`: `languageId === "shellscript"` → single lens on line 0 (`new vscode.Range(new vscode.Position(0,0), new vscode.Position(0,0))`), title `"$(play) Run"`, command `"vsdb.runScript"`, no arguments; gated by `vsdb.showRunLensSh` (default true); config-subscription must ALSO listen for `vsdb.showRunLensSh` (mirror the existing `showRunLens` subscription at line 21-25)
- `src/extension.test.ts` — guard test + lens-command parity test (handler reused)
- `src/ui/__tests__/codeLensProvider.test.ts` — shellscript lens tests (fakeDoc already parametrized by languageId)
- `src/scaffold.test.ts` — manifest regression: activationEvents + editor/title menu + icon + showRunLensSh config

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (RED) | manifest: `activationEvents` contains `onCommand:vsdb.runScript` AND `onLanguage:shellscript` | both strings present — FAILS against today's `package.json` (verified missing by planner) | readFileSync package.json |
| 2 | regression | manifest: editor/title menu has `vsdb.runScript` with `when` containing `resourceLangId == shellscript` + `group` `navigation`; the command declares `icon` (`$(play)`) | all assertions pass (pins TASK-505's untested wiring); `vsdb.showRunLensSh` config property type boolean default true | same fixture |
| 3 | happy | shellscript doc → exactly 1 lens on line 0, title `"$(play) Run"`, command `vsdb.runScript`, no arguments | `lenses.length===1`; `lenses[0].range.start.line===0`; command fields exact | fakeDoc("shellscript", ["#!/bin/bash","echo hi"]) |
| 4 | edge | `vsdb.showRunLensSh=false` → `[]` for shellscript; SQL path (`showRunLens`) unaffected | `provideCodeLenses(shellscriptDoc)` → `[]`; sql doc with `showRunLens=true` still returns statements | config mock per test |
| 5 | edge | languageId neither sql nor shellscript (e.g. `"markdown"`) → `[]` | empty array | fakeDoc("markdown", …) |
| 6 | edge | guard: `vsdb.runScript` with NO active editor → `showWarningMessage` called, `createTerminal` NOT called, `sendText` NOT called | mocks asserted exactly | `state.activeEditor = undefined` |
| 7 | regression | existing TASK-505 handler suite still green (creates/reuses "VSDB Script", sendText full text + `\n`, terminal.show) | all existing tests in `describe("TASK-505 …")` pass unchanged | activateFresh pattern |

## Test Files

- `src/ui/__tests__/codeLensProvider.test.ts` — tests 3, 4, 5 (extend the vscode mock's `getConfiguration` to serve `showRunLensSh`; `fakeDoc(languageId, lines)` exists at line 66)
- `src/extension.test.ts` — tests 6, 7 (TASK-505 describe block at ~line 453 has the terminal mocks + `state.createdTerminals`/`state.activeEditor` harness)
- `src/scaffold.test.ts` — tests 1, 2 (manifest describe at line 73 already loads package.json)

## Verification Commands

```bash
npx vitest run src/extension.test.ts src/ui/__tests__/codeLensProvider.test.ts src/scaffold.test.ts
npm run typecheck
```

(No dist dependency — pure node tests. No lint script exists in this repo; typecheck is the static gate.)

## Acceptance Criteria

- [ ] Test 1 RED first (activation events missing today), then GREEN after the fix.
- [ ] `.sh` documents get one `▶ Run` lens on line 1; `vsdb.showRunLensSh=false` hides it; SQL lens behavior untouched.
- [ ] Palette/title-button invocation with no editor warns instead of sending `"\n"` to a terminal.
- [ ] Existing TASK-505 tests green (terminal reuse semantics preserved).
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none — runs in Wave 1 parallel with TASK-601; files disjoint from all 601/602/603 targets)

## Interfaces

- Consumes: `VsdbCodeLensProvider` (src/ui/codeLensProvider.ts:11) — extend `provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[]`; existing command registration `vsdb.runScript` (src/extension.ts:223) + `commandRunScript(): Promise<void>` (src/extension.ts:573).
- Produces (TASK-604 depends): `package.json` activationEvents entry + `vsdb.showRunLensSh` config; lens command id `vsdb.runScript` (stable, already in manifest); guard behavior in `commandRunScript`. New setting: `vsdb.showRunLensSh` (boolean, default `true`) — README documents it in TASK-604.
- VS Code API surface used: `vscode.languages.registerCodeLensProvider(selector, provider)`, `vscode.CodeLens(range, { title: "$(play) Run", command: "vsdb.runScript", arguments: [] })`, `vscode.workspace.onDidChangeConfiguration(affectsConfiguration)`.

---

## Discussion

### 2026-08-23 · planner · unic/unic-smart
Defect grounding (planner read the current sources): (1) `package.json`
`activationEvents` lists `onCommand:` for 10 commands but NOT `vsdb.runScript`, and has
no `onLanguage:shellscript` — the lens registration below could never activate the
extension for .sh files; on VS Code builds that don't fully honor implicit command
activation the editor-title button is dead too. (2) The handler at src/extension.ts:573
has no `activeTextEditor` guard — palette invocation with no editor silently sends
`"\n"` into a terminal (wrong-thing-happens failure, possibly the user's symptom).
(3) Manifest menu wiring exists but is pinned by zero tests. The exact runtime failure
the user saw cannot be reproduced in jsdom; this task fixes every statically-verifiable
defect and the lens gives an independent, SQL-parity affordance. If the editor-title
button still misbehaves in the user's VS Code after this, capture the developer-tools
console for a follow-up cycle.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
