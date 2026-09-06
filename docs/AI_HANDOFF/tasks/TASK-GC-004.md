# TASK-GC-004 — Manifest: sparkle command + scm/title menu contribution

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1/§2

## Goal

Declare `UnicDB.generateCommitMessage` in `package.json` with the `$(sparkle)` codicon and
contribute it to the Source Control title bar (`scm/title`, `navigation` group), enabled only
when the git provider has pending changes — the Kilo-style button placement, per the vision
spec.

## Target Files

- `package.json` — in `contributes.commands` add
  `{ "command": "UnicDB.generateCommitMessage", "title": "Generate Commit Message", "category": "UnicDB", "icon": "$(sparkle)" }`
  (matches the existing entry shape — see `UnicDB.openAiSettings`). Add a NEW
  `contributes.menus["scm/title"]` array (the key does not exist yet) with
  `{ "command": "UnicDB.generateCommitMessage", "group": "navigation", "when": "scmProvider == git && scmProviderHasChanges" }`.
- `src/ui/__tests__/commitGenManifest.test.ts` (new) — reads `package.json` from
  `process.cwd()` (pattern: `src/ui/__tests__/resultsPanelViewManifest.test.ts`) and asserts
  the frozen strings below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | command declared with icon + category | `contributes.commands` contains entry exactly `{command:"UnicDB.generateCommitMessage", title:"Generate Commit Message", category:"UnicDB", icon:"$(sparkle)"}` | parsed package.json |
| 2 | happy | scm/title menu entry | `menus["scm/title"]` has entry with command id, `group === "navigation"`, `when === "scmProvider == git && scmProviderHasChanges"` | parsed package.json |
| 3 | edge (absent before impl) | RED gate | test file #1–#2 fail BEFORE the manifest edit (TDD RED), pass after | checkout state |
| 4 | edge (malformed) | no duplicate command ids | `contributes.commands` has exactly one `UnicDB.generateCommitMessage` entry; the set of pre-existing command ids (54 today) is still fully present — assert superset over the pre-GC id list, not a frozen total, so unrelated command churn can't false-fail | parsed package.json |
| 5 | edge (consistency) | every scm/title command exists | every `command` referenced in any `menus` block resolves to a declared command id | parsed package.json |

## Test Files

- `src/ui/__tests__/commitGenManifest.test.ts` (new) — contains tests #1–#5.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/commitGenManifest.test.ts
```

(No lint script exists in this project — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] All tests #1–#5 green; `npm run typecheck` clean; `npm test` still passes for
      `src/ui/__tests__/resultsPanelViewManifest.test.ts` (sibling manifest test unbroken).
- [ ] Command palette shows "UnicDB: Generate Commit Message" (follows from the declared
      entry — no extra `commandPalette` contribution needed).
- [ ] No other manifest sections modified (commands/menus only; configuration untouched —
      settings live in globalState/SecretStorage, not `contributes.configuration`).

## Dependencies

- (none)

## Interfaces

- Consumes: (none) — pure manifest work.
- Produces: the command id `UnicDB.generateCommitMessage` that GC-007 registers in
  `src/extension.ts`; the `scm/title` `when` clause `scmProvider == git &&
  scmProviderHasChanges` that the GC-008 integration scan asserts.

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: builtin git contributes `git.commit` AND `git.refresh` to a bare `navigation`
group with no `@order` (verified in the local VS Code app bundle git/package.json). VS Code's
tie-break order for unordered items is not verifiable offline — if manual QA in the
Extension Development Host shows the sparkle to the RIGHT of Refresh, change this entry's
group to `"navigation@2"` (single-string fix, nothing else). The automatable contract is
tests #1–#5; visual placement is the documented fallback. Do NOT add a keybinding for this
command (vision spec: matches Kilo).

(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: |
  > UnicDB@1.51.7 test
  > vitest run src/ui/__tests__/commitGenManifest.test.ts

   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-004

   ❯ src/ui/__tests__/commitGenManifest.test.ts  (4 tests | 3 failed) 33ms
     ❯ ...case 1: command declared with icon + category (exact shape)
       → expected undefined not to be undefined
     ❯ ...case 2: scm/title menu entry has command, group navigation, and the frozen when clause
       → expected false to be true // Object.is equality
     ❯ ...case 4: no duplicate command ids and the pre-existing 54 ids remain (superset)
       → expected +0 to be 1 // Object.is equality

   Test Files  1 failed (1)
        Tests  3 failed | 1 passed (4)

  Failing-for-the-right-reason gate:
    - case 1: command entry `UnicDB.generateCommitMessage` not in `contributes.commands` (undefined).
    - case 2: `contributes.menus["scm/title"]` key absent (Array.isArray → false).
    - case 4: 0 occurrences of NEW_COMMAND_ID in `contributes.commands`.
  Case 5 (menu→command consistency) already passes against the pre-existing manifest.
Verification Output: |
  1) npm run typecheck
     > UnicDB@1.51.7 typecheck
     > tsc --noEmit
     (no diagnostics — clean)

  2) npx vitest run src/ui/__tests__/commitGenManifest.test.ts
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-004
     ✓ src/ui/__tests__/commitGenManifest.test.ts  (4 tests) 4ms
     Test Files  1 passed (1)
          Tests  4 passed (4)

  3) Sibling sanity — npx vitest run src/ui/__tests__/resultsPanelViewManifest.test.ts
     ✓ src/ui/__tests__/resultsPanelViewManifest.test.ts  (4 tests) 2ms
     Test Files  1 passed (1)
          Tests  4 passed (4)

  4) Full suite — npm test
     Test Files  245 passed | 1 skipped (246)
          Tests  3623 passed | 2 skipped (3625)
     Duration  18.07s
Status: PASS
Note: New command + scm/title menu contribution landed as specified. `node_modules` and `dist` were symlinked from the main checkout into the worktree (per handoff instructions). No git add/commit/push performed (per handoff instructions).
