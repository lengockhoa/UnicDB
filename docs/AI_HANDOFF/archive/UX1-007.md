# TASK-UX1-007 — Settings hub gear on the schema-tree title bar (R8b)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 3), §3 (UX1-007)

## Goal

Add a gear icon to the `vsdb.schemaTree` view title bar that opens VS Code's Settings UI
pre-filtered to the VSDB extension's settings — the future hub for all
`contributes.configuration` entries.

## Target Files

- `package.json` — command `vsdb.openSettings` (title `VSDB: Open Settings`,
  icon `$(settings-gear)` — distinct from `vsdb.openAiSettings`'s `$(gear)`); one
  `view/title` entry `when: view == vsdb.schemaTree`, `group: navigation`;
  `onCommand:vsdb.openSettings` activation line (guard filter from UX1-006).
- `src/extension.ts` — handler: `vscode.commands.executeCommand(
  "workbench.action.openSettings", "@ext:lengockhoa.vsdb")`; register the command.
- `src/extension.test.ts` — new tests in this task's describe block.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | command opens settings filtered to the extension | `vsdb.openSettings` invoked → `executeCommand` called with `workbench.action.openSettings` and `"@ext:lengockhoa.vsdb"` | stubbed vscode.commands recording calls |
| 2 | edge A — settings UI unavailable | executeCommand rejects → caught, toast, no throw | stubbed executeCommand throwing → error toast shown; activate/deactivate unaffected | executeCommand stub rejecting |
| 3 | edge B — structural wiring | package.json declares command + title entry | commands array contains `vsdb.openSettings` with `$(settings-gear)`; `view/title` has the entry with exact `when: view == vsdb.schemaTree` and `group: navigation` | module-level `pkgJson` in extension.test.ts |
| 4 | edge C — distinct icon namespace | no icon collision with AI settings entry | `vsdb.openAiSettings` keeps `$(gear)`; `vsdb.openSettings` uses `$(settings-gear)` — assert both in one test so a future icon swap can't silently collide | same |
| 5 | regression | command registration smoke | `extension.activate` registers `vsdb.openSettings` (follows the "register đủ command" pattern, extension.test.ts:356) | existing activate harness |

## Test Files

- `src/extension.test.ts` — all cases (one new describe block).

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Cases 1–5 pass.
- [ ] bq04SurfaceGuard 4/4 green (UX1-006 filter extension precedes this).
- [ ] Title bar renders gear without displacing existing navigation icons (structural
      case 3 pins the same `navigation` group).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-UX1-002 (extension.ts + extension.test.ts exclusivity: this task's extension.ts
  edit lands after UX1-002's. UX1-011 in turn depends on THIS task, so the runner orders
  the lane strictly `UX1-002 → UX1-007 → UX1-011` and can never race 007 against 011 on
  the same files).

## Interfaces

- Consumes: `vscode.commands.executeCommand("workbench.action.openSettings", <query>)`
  VS Code built-in; publisher/name from package.json (`lengockhoa.vsdb`).
- Produces: `vsdb.openSettings` command id — UX1-004's user guide references it as the
  settings entry point; future setting contributions appear under the `vsdb.*`
  configuration scope this opens.

---

## Discussion

### 2026-09-04 · planner · unic-smart
No runtime opening of `vsdb.*` keys beyond the `@ext:` filter — `@ext:lengockhoa.vsdb`
shows exactly the extension's contributed settings, which is the "hub" the user asked for
("có rồi sau này sẽ có nhiều setting được đưa vô đó"). Filter-string form (second
argument) is the supported shape of `workbench.action.openSettings`; if the executor's VS
Code version ignores the argument, fall back to `"workbench.action.openSettingsApi"`-free
plain open + info toast — record which shape worked in Discussion.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (reported confirmed in worktree — extension.test.ts UX1-007 showed 6 failing tests for the new vsdb.openSettingsHub command + view/title menu entry)
Verification Output: extension.test.ts 145/145 after merge; +6 net tests vs baseline (3412 vs 3406 — worktree baseline); full suite 3495|2 (baseline 3484|2, +6 net from UX1-007; pre-existing webview file ENOENT failures are baseline, not regressions); typecheck + compile clean
Status: PASS
Note: Schema tree is a NATIVE TreeView (no webview bridge), so no webview/main.ts or styles.css edits needed. view/title entry appended at index 6 to preserve scaffold.test.ts positional pins.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/extension.test.ts src/adapters/__tests__/bq04SurfaceGuard.test.ts
  result: 153 pass / 0 fail (extension 145/145, bq04SurfaceGuard 8/8); typecheck clean; esbuild compile clean
TEST_PLAN_COVERAGE: all-followed — cases 1-5 implemented 1:1 + activationEvents pin (6 tests); RED corroborated on disk (/private/tmp/ux1-007-red.log: same 6 tests failing pre-impl with real assertion messages)
FINDINGS:
  critical: none
  important: none
  minor:
    - file: src/extension.ts:1416-1423 — commandOpenSettingsHub inserted between the two halves of commandOpenAiSettings's JSDoc; doc lines 1416-1420 ("Reveals existing panel...") now render attached to the wrong function. Cosmetic only.
NEXT_STATUS_FOR_INDEX: approved
NOTES: view/title entry correctly appended at index 6 — scaffold.test.ts positional pins (0-5) intact; icon $(settings-gear) distinct from AI's $(gear) and UX1-004's $(notebook)/$(book); @ext:lengockhoa.vsdb matches package.json publisher.name. Full-suite residual = 2 flaky webview bundle tests, pass in isolation and pre-exist in executor-era logs (different case numbers across runs) — not a UX1-007 regression.
