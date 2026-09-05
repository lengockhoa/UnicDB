# TASK-001 — browseCommands module: buildBrowseSelect + UnicDB.browseTableData

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

New module `src/ui/browseCommands.ts` exporting a pure per-dialect SELECT builder and the
`UnicDB.browseTableData` command registration that resolves a schema-tree node, aligns the active
connection, and drives the existing QueryRunner → ResultsPanel pipeline (busy → run → render).

## Target Files

- `src/ui/browseCommands.ts` **(new)** — `buildBrowseSelect`, `registerBrowseCommands`.
- `src/ui/__tests__/browseCommands.test.ts` **(new)** — TDD tests below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit happy | postgres quoting with schema | `buildBrowseSelect("postgres","public","users")` returns exactly `SELECT * FROM "public"."users"` (no trailing `;`) | plain identifiers |
| 2 | unit happy | mysql + mssql quoting | mysql → ``SELECT * FROM `mydb`.`users` ``; mssql → `SELECT * FROM [mydb].[users]` | plain identifiers |
| 3 | edge malformed | embedded quote chars | pg `ev"il`→`ev""il`; mysql ``ev`il``→`` `ev``il` ``; mssql `ev]il`→`ev]]il` — quoting cannot be escaped, output still single SELECT | identifiers containing delimiter chars |
| 4 | edge boundary | empty schema | driver-specific unqualified form: `"t"` / `` `t` `` / `[t]` | `schema: ""` |
| 5 | edge missing input | palette / no meta | `showInformationMessage` called; `runner.run` NOT called; `panel.setBusy` never true | invoke with `undefined` and with `{}` |
| 6 | happy pipeline | command drives run→render | `setActive` (when needed) → `runner.run` once with `[{ text: sql, start: 0, end: sql.length }]` → `panel.render` called twice+ (onUpdate + final) with the mocked results array; `panel.setBusy` sequence true…false | node meta `{connection, schema:"public", objectName:"users"}`, runner resolves StatementResult[] |
| 7 | edge state | active-connection alignment | node conn ≠ active → `mgr.setActive` called with node conn id BEFORE first `runner.run` call (ordering asserted); node conn === active → `setActive` NOT called | two fixtures |
| 8 | edge error propagation | setActive / runner.run rejects | `showErrorMessage` with the error message; `panel.setBusy(false)` reached in finally; `panel.render` never called with results | mocked rejection |
| 9 | edge boundary | 0-row table | runner resolves done result with `rows: []` → `panel.render` still called (empty grid, not error path) | mocked empty result |

## Test Files

- `src/ui/__tests__/browseCommands.test.ts` **(new)** — all cases above; harness copies the
  `vi.mock("vscode")` + `vi.hoisted` state pattern from `src/ui/__tests__/tableCommands.test.ts`
  (registeredCommands map, info/error message capture). ConnectionManager is a `vi.mock` class
  whose instance exposes `getActive/setActive/listConnections/getAdapter` mocks.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/browseCommands.test.ts && npm run typecheck
```

(`tests-map.json` has no entry for a new file → per RULES.md floor this resolves to the file's own
test; typecheck is the repo's static gate. No lint script exists — N/A.)

## Acceptance Criteria

- [ ] RED first: test file committed to fail against missing module, real failing output pasted.
- [ ] All 9 cases above PASS (`npx vitest run src/ui/__tests__/browseCommands.test.ts`).
- [ ] `npm run typecheck` clean.
- [ ] No changes outside the two Target Files.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `ConnectionManager` (`getActive(): ConnectionConfig \| null`, `setActive(id: string): Promise<void>`, `listConnections(): ConnectionConfig[]`), `QueryRunner.run(statements: ParsedStatement[], onUpdate: (r: StatementResult[]) => void): Promise<StatementResult[]>` (src/core/queryRunner.ts), `ResultsPanel.render(results: StatementResult[], header: string): void` / `setBusy(b: boolean): void` (src/ui/resultsPanel.ts), `type ConnectionConfig` incl. `driver: "postgres"|"mysql"|"mssql"` and `id: string`.
- Produces: `buildBrowseSelect(driver: ConnectionConfig["driver"], schema: string, table: string): string`; `registerBrowseCommands(deps: { mgr: ConnectionManager; runner: QueryRunner; panel: ResultsPanel }): void` registering command id `UnicDB.browseTableData`, invoked as `(node?: { meta?: { connection?: ConnectionConfig; schema?: string; objectName?: string } })`. TASK-002 consumes both.
- Node argument contract: the schemaTree passes the whole `UnicDBNode` (has `.meta`) as `arguments[0]`.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Design notes for executor: (1) statement must be `{ text, start: 0, end: text.length }` — ParsedStatement from src/config/types.ts; (2) do NOT add a `;` to the SQL; (3) confirmDangerousStatements is intentionally skipped — the statement is a generated SELECT, `guardTier` can never fire; (4) render header copy: `Browse ${qualified} at ${new Date().toISOString()}` (mirrors runStatements header style).

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: W1-T001
SUMMARY: Implemented `src/ui/browseCommands.ts` exporting `buildBrowseSelect` (per-dialect pg/mysql/mssql quoting, empty-schema unqualified form, no trailing `;`) and `registerBrowseCommands` wiring `UnicDB.browseTableData` (resolve node → align active conn → setBusy(true) → runner.run with `{text, start: 0, end}` ParsedStatement → render onUpdate + final → finally setBusy(false); palette fallback shows information message and never calls runner.run). 9/9 cases pass.
TEST_PLAN_FOLLOWED: task §4 (all 9 cases implemented in `src/ui/__tests__/browseCommands.test.ts`)
FILES_CHANGED:
  - src/ui/browseCommands.ts: new — buildBrowseSelect + registerBrowseCommands
  - src/ui/__tests__/browseCommands.test.ts: new — 9 cases (#1–#9) covering builder + pipeline + alignment + error + 0-row
TESTS_ADDED:
  - src/ui/__tests__/browseCommands.test.ts: buildBrowseSelect (4 cases) + registerBrowseCommands (5 cases)
VERIFICATION:
  command: `cd .worktrees/task-001 && npm ci --silent && npx vitest run src/ui/__tests__/browseCommands.test.ts && npm run typecheck`
  result: 9 pass / 0 fail; typecheck exit 0
  output_excerpt: |
    RED (test against missing module — captured before src/ui/browseCommands.ts existed):
      RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-001
       ❯ src/ui/__tests__/browseCommands.test.ts  (0 test)
       ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
       FAIL  src/ui/__tests__/browseCommands.test.ts
       Error: Failed to load url ../browseCommands (resolved id: ../browseCommands)
       in .../src/ui/__tests__/browseCommands.test.ts. Does the file exist?
       Test Files  1 failed (1) | Tests  no tests

    GREEN (after implementation):
      RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-001
       ✓ src/ui/__tests__/browseCommands.test.ts  (9 tests) 4ms
       Test Files  1 passed (1) | Tests  9 passed (9)

    typecheck:
      > UnicDB@1.6.0 typecheck
      > tsc --noEmit
      (exit 0, no output)
ISSUES: Two mid-flight deviations from initial spec reading:
  1. Initial impl quoted empty schema (`SELECT * FROM """t"`); refactored to skip schema entirely when empty (`SELECT * FROM "t"`). Per test #4 expected behavior.
  2. Initial impl used `runner.getResults()` inside onUpdate; tests provide `vi.fn` runners without `getResults`. Switched to use the `current` array passed into the onUpdate callback. Mirrors the contract `runner.run(stmts, onUpdate(r => …))`.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/browseCommands.test.ts && npm run typecheck
  result: 10 pass / 0 fail (9 TASK-001 cases + TASK-007 case #11); typecheck exit 0
TEST_PLAN_COVERAGE: all-followed — 9/9 required cases present, real expect() in each; RED_OUTPUT is genuine module-not-found failure output (matches task's defined RED form)
FINDINGS:
  critical:
    - none in TASK-001's slice. (Known regression — UnicDB.browseTableData has NO `icon` in package.json, breaking src/scaffold.test.ts:126 — is TASK-002's: wave-2 commit 5add346 added that entry; TASK-001 touched only its two Target Files. Assigned to TASK-002's verdict, not this one.)
  important:
    - none
  minor:
    - src/ui/browseCommands.ts:112 — registerBrowseCommands returns void and drops the registerCommand Disposable; repo convention (src/ui/tableCommands.ts:178) pushes to context.subscriptions, so this command is never disposed on teardown. Spec-conformant (task Interfaces specified `: void`) but the API should return the Disposable for the caller to push.
    - src/ui/browseCommands.ts:81 — resolveBrowseNode rejects falsy `meta.schema` (`!meta.schema`), making buildBrowseSelect's empty-schema unqualified branch (case #4) unreachable from the command path. Latent dead path; document or let empty schema through.
    - src/ui/browseCommands.ts:175 — file lacks trailing newline.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: T001's slice (wave-1 commit 03525eb; T007's wave-4 edits to the same file judged separately) is correct, well-tested, typecheck-clean, and within scope. Icon regression is TASK-002's to fix.
