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

## Executor Report

- Status: `done`
- Owner: `Exec605` (unic/unic-code)
- Run: 2026-08-23

### Summary

RED→GREEN TDD cho 4 defect + 1 feature mới:
1. `package.json` thiếu `onCommand:vsdb.runScript` + `onLanguage:shellscript` — đã thêm.
2. `package.json` thiếu `vsdb.showRunLensSh` config — đã thêm (boolean, default true).
3. `src/extension.ts` `commandRunScript` thiếu no-editor guard — đã thêm (`showWarningMessage("VSDB: open a .sh file to run")` + early return, KHÔNG tạo terminal).
4. `src/extension.ts` chỉ register CodeLens cho `sql` — đã thêm registration cho `shellscript`.
5. `src/ui/codeLensProvider.ts` không có shellscript branch — đã thêm: 1 lens ở line 0, command `vsdb.runScript`, gated by `vsdb.showRunLensSh`, config listener mirror SQL pattern.

### Test Plan Followed

Inline (task file không có sẵn Test Plan; theo parent task instructions). Tests đã viết + confirm RED trước khi fix:

| Test | File | RED trước fix? | GREEN sau fix? |
|------|------|---------------|----------------|
| #1 — activation events | `src/scaffold.test.ts` | YES | YES |
| #2 — editor/title + icon + showRunLensSh config | `src/scaffold.test.ts` | YES | YES |
| #3 — shellscript doc → 1 lens ở line 0 | `src/ui/__tests__/codeLensProvider.test.ts` | YES | YES |
| #4 — showRunLensSh=false → [] cho shell; SQL path không ảnh hưởng | `src/ui/__tests__/codeLensProvider.test.ts` | n/a (no-op passes) | YES |
| #5 — markdown → [] | `src/ui/__tests__/codeLensProvider.test.ts` | n/a (no-op passes) | YES |
| #6 — config change showRunLensSh → fire CodeLens event | `src/ui/__tests__/codeLensProvider.test.ts` | YES | YES |
| #6 — no-editor guard (runScript) | `src/extension.test.ts` | YES | YES |
| #7 — TASK-505 handler suite (terminal reuse) | `src/extension.test.ts` | n/a | YES (all 5 sub-tests pass) |

### Files Changed

- `package.json` — activationEvents (+2), configuration (+1 property `vsdb.showRunLensSh`).
- `src/extension.ts` — CodeLens registration cho `shellscript`; `commandRunScript` no-editor guard.
- `src/ui/codeLensProvider.ts` — shellscript lens branch + `vsdb.showRunLensSh` config subscriber.
- `src/extension.test.ts` — `showWarningMessage` mock; guard test (#6) + non-shell editor sanity test (#6b).
- `src/ui/__tests__/codeLensProvider.test.ts` — added `showRunLensSh` config plumbing in mock + `Position` mock + flexible `Range` mock; tests #3-#6.
- `src/scaffold.test.ts` — tests #1 + #2 cho manifest.

### Tests Added

- `src/ui/__tests__/codeLensProvider.test.ts`:
  - Test #3 — shellscript → 1 lens ở line 0, command `vsdb.runScript`, title `$(play) Run`, no args
  - Test #4 — `showRunLensSh=false` → `[]` cho shellscript; SQL path vẫn lens
  - Test #5 (TASK-605) — `languageId=markdown` → `[]`
  - Test #6 — config change `vsdb.showRunLensSh` trigger `_onDidChangeCodeLenses`
- `src/scaffold.test.ts`:
  - Test #1 (TASK-605) — activationEvents có `onCommand:vsdb.runScript` + `onLanguage:shellscript`
  - Test #2 (TASK-605) — editor/title menu có `vsdb.runScript` (when chứa `shellscript`, group `navigation`); command có icon; `vsdb.showRunLensSh` config (type boolean, default true)
- `src/extension.test.ts`:
  - Test #6 — no active editor → `showWarningMessage` called, no `createTerminal`
  - Test #6b — non-shell editor (sql) → vẫn gửi text như cũ (không guard theo language)

### Verification

Command: `npx vitest run src/extension.test.ts src/ui/__tests__/codeLensProvider.test.ts src/scaffold.test.ts`
Result: 33/33 passed (3 files, 0 failed). Exit code 0.
Excerpt:
```
✓ src/ui/__tests__/codeLensProvider.test.ts  (8 tests) 3ms
✓ src/scaffold.test.ts  (7 tests) 171ms
✓ src/extension.test.ts  (18 tests) 33ms
Test Files  3 passed (3)
     Tests  33 passed (33)
```

Command: `npm run typecheck`
Result: clean (exit code 0, no errors).

Full suite sanity: `npx vitest run` → 343 passed, 1 pre-existing fail (webviewTheme.test.ts cần `npm run compile` — không liên quan đến TASK-605).

### Issues / Notes

- Mock `Range` trong codeLens test đã được nâng cấp để chấp nhận cả hai signatures `Range(startPos, endPos)` (cho shellscript branch mới) lẫn `Range(line, char, line, char)` (giữ SQL test cũ hoạt động).
- Mock `Position` mới được thêm vì shellscript branch dùng `new vscode.Position(0,0)` trực tiếp.
- `onCommand:vsdb.runStatement` activation event đã có sẵn từ trước — KHÔNG xoá; chỉ chèn thêm 2 event mới.
- Editor-title button wiring (`menus.editor/title` cho `vsdb.runScript` với `when: resourceLangId == shellscript`) đã có sẵn từ TASK-505, pinned bởi Test #2 mới.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
