# TASK-UX1-004 — User guide: book icon on the schema tree + docs/VSDB_USER_GUIDE.md (R2)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 4), §3 (UX1-004)

## Goal

A book icon on the schema-tree title bar opens `docs/VSDB_USER_GUIDE.md` as a markdown
preview — the team's how-to ("Hướng dẫn toàn bộ các dùng bộ VSDB"), authored in Vietnamese
and covering every shipped feature including this cycle's.

## Target Files

- `docs/VSDB_USER_GUIDE.md` (NEW) — Vietnamese user guide. Required sections
  (reviewer checks coverage against this list): Cài đặt & `ukit install`; Kết nối
  (postgres/mysql/mssql/bigquery); Schema Explorer (tree, filter, refresh, hide system
  schemas); SQL Console (tabs, history, drafts, open-for-object, SQL Generator cho
  View/Function, Insert Sample Data templates); Results (placement setting
  `vsdb.resultsPlacement` incl. `top`, DDL status cards, export); AI Chat (engine,
  thinking affordance, code-block copy); Settings hub (gear icon, `vsdb.*` settings);
  listed shortcuts/menus.
- `package.json` — command `vsdb.openUserGuide` (title `VSDB: Open User Guide`, icon
  `$(book)`); one `view/title` entry `when: view == vsdb.schemaTree`, `group: navigation`;
  `onCommand:vsdb.openUserGuide` activation line.
- `src/extension.ts` — handler: resolve `docs/VSDB_USER_GUIDE.md` against
  `context.extensionUri` via `vscode.Uri.joinPath(context.extensionUri, "docs",
  "VSDB_USER_GUIDE.md")` (NEVER `process.cwd()`), then
  `vscode.commands.executeCommand("markdown.showPreview", uri)`; missing file → info
  toast, no throw. Register the command.
- `src/extension.test.ts` — tests in this task's describe block.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | command opens markdown preview at the extension-relative guide path | `vsdb.openUserGuide` → `executeCommand` called with `markdown.showPreview` and a Uri whose path ends with `docs/VSDB_USER_GUIDE.md`, built from the injected extensionUri (not cwd) | stubbed vscode.commands + fs; real guide file present in repo |
| 2 | happy | guide covers every shipped feature | reading `docs/VSDB_USER_GUIDE.md` finds a heading (h1/h2/h3) matching each required section keyword list (Schema/Console/Results/AI Chat/Settings/SQL Generator/Sample Data) | file read in test from repo root |
| 3 | edge A — file missing | packaged install without docs/ → toast, no throw | Uri target absent (stub fs/existsSync false) → info toast shown; `markdown.showPreview` NOT invoked | existsSync stub |
| 4 | edge B — markdown preview unavailable | `markdown.showPreview` command missing → fallback | stubbed executeCommand throwing for `markdown.showPreview` → retry with `markdown.openDocumentation`-style fallback OR toast naming the file path; no unhandled rejection (pin ONE chosen behaviour) | executeCommand stub rejecting once |
| 5 | edge B — structural wiring | package.json declares command + entry | commands array has `vsdb.openUserGuide` with `$(book)`; `view/title` entry with exact `when: view == vsdb.schemaTree`, `group: navigation`; activation line present | module-level `pkgJson` |
| 6 | edge C — title-bar icon namespace | no icon collision | existing `vsdb.openHelpGrid` uses `$(book)` — verify and, if occupied, switch this command to `$(book)`-sibling (`$(markdown)` or `$(notebook)`); test asserts the two command ids carry DIFFERENT icons | pkgJson diff of icon fields |
| 7 | regression | activation smoke | command registered on activate (existing "register đủ command" pattern) | existing activate harness |

## Test Files

- `src/extension.test.ts` — cases 1, 3–7.
- `src/ui/__tests__/userGuideContent.test.ts` (NEW, tiny) — case 2 (content coverage;
  kept separate so guide prose edits don't churn extension.test.ts).

## Verification Commands

```bash
npx vitest run src/extension.test.ts src/ui/__tests__/userGuideContent.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Cases 1–7 pass.
- [ ] `docs/VSDB_USER_GUIDE.md` exists at repo root docs/, Vietnamese, covering every
      section of the required list (case 2 is the mechanical check; reviewer spot-checks
      accuracy against shipped behaviour — including UX1-001..011 features).
- [ ] bq04SurfaceGuard 4/4 green.
- [ ] Icon collision resolved per case 6 (note the chosen icon in Discussion).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-UX1-003 (package.json exclusivity in wave 3; last package.json consumer in the
  cycle → this task also runs the cycle-final full verification).

## Interfaces

- Consumes: `context.extensionUri` (activate's context); VS Code built-in
  `markdown.showPreview`; UX1-002 (`vsdb.generateViewDdl`/`vsdb.generateFunctionDdl`),
  UX1-003 (`Insert Sample Data…` templates), UX1-006 (`vsdb.resultsPlacement` enum
  incl. `top`), UX1-007 (`vsdb.openSettings` gear) — the guide documents all of them.
- Produces: `vsdb.openUserGuide` command id + the guide file as the canonical user
  documentation surface; future cycles append sections to `docs/VSDB_USER_GUIDE.md`
  (case 2's keyword list must be extended alongside).

---

## Discussion

### 2026-09-04 · planner · unic-smart
Placed last in the wave order for two reasons: it is the last package.json consumer (no
later task needs the file after it), and its guide content should describe the cycle's
FINAL behaviour (SQL Generator, Insert Sample Data, results placement `top`, settings
hub). Case 6 exists because `vsdb.openHelpGrid` already claims `$(book)` (package.json
commands block, verified at P2) — pick a distinct book-family icon and pin it; the
decision is the executor's, the test enforces only distinctness. Path resolution MUST use
`context.extensionUri` so the packaged VSIX resolves the bundled docs file; a `cwd`-based
path is the classic breakage this test (case 1: "not cwd") guards against.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (reported confirmed in worktree — extension.test.ts UX1-004 + userGuideContent.test.ts showed 14 failing tests for the new command + missing guide content)
Verification Output: extension.test.ts 151/151 + userGuideContent.test.ts 8/8 after rebuild; full suite 3495|2 (baseline 3484|2, +10 net from UX1-004); typecheck + compile clean
Status: PASS
Note: Icon $(markdown); vsdb.openHelpGrid keeps $(book). Worktree node_modules symlinked from repo root (gitignored). No frozen files touched.
