# TASK-GC-008 — Integration / regression net (manifest ↔ command ↔ UX contract)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4/§6

## Goal

Bottom-of-stack net that locks the whole cycle together: the manifest really exposes the
button under the frozen `when` clause, and the real command handler produces the frozen UX
contract (success injection, disabled-Lite toast + Open Settings action, empty-diff info,
engine routing). This is the file a future refactor must keep green.

## Target Files

- `src/ui/__tests__/commitGenIntegration.test.ts` (new) — three describes:
  1. **Manifest scan** (read `package.json` via `readFileSync(resolve(process.cwd(), ...))`,
     pattern `resultsPanelViewManifest.test.ts`): command entry with `$(sparkle)`/category/
     title; `menus["scm/title"]` entry with `group === "navigation"` and
     `when === "scmProvider == git && scmProviderHasChanges"`.
  2. **UX contract via the real handler** (import `runGenerateCommitMessage` from
     `src/ai/commitGenCommand.ts` + `COMMIT_SUBJECT_MAX_CHARS` from
     `src/ai/commitMessage.ts`; ports faked): success injects sanitized message; Lite-empty
     produces the frozen toast + action; action selection calls the injected
     `openSettings` spy; empty diff → info toast and zero engine calls; builtin-vs-omp
     routing picks the right injected engine for each `models.lite.engine`.
  3. **Sanitizer guard**: a fenced 90-char-subject reply comes out ≤72-char subject and
     fence-free through the real `sanitizeCommitMessage`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | manifest ↔ command id agreement | `menus["scm/title"][n].command === "UnicDB.generateCommitMessage"` AND that id exists in `contributes.commands` | parsed package.json |
| 2 | happy | end-to-end builtin | full deps fake → `setInputBox` receives conventional message derived from the fake diff + fake reply | lite `{modelId:"m", engine:"builtin"}` |
| 3 | edge (missing config) | disabled-Lite UX contract | toast string + "Open Settings" action exactly as frozen; `openSettings` spy called when action resolved | settings without lite modelId |
| 4 | edge (empty) | empty diff cuts the chain | `collectDiff` null → info toast; neither engine port invoked; inputBox untouched | empty-repo fake |
| 5 | edge (routing) | engine switches with config | same fixtures with `engine:"omp"` vs `"builtin"` — omp fake called in one, builtin fake in the other, never both | two runs |
| 6 | regression | sanitizer boundary via real module | 90-char fenced subject → injected first line length 72, no ``` in payload | oversized fenced reply |

## Test Files

- `src/ui/__tests__/commitGenIntegration.test.ts` (new) — tests #1–#6.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/commitGenIntegration.test.ts
npm test
```

(The trailing full `npm test` is this cycle's final wave-boundary regression net per
RULES.md. No lint script exists — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] Tests #1–#6 green AND full `npm test` green (report the counts in the Executor Report).
- [ ] Only cross-cycle assertions of FROZEN strings — no re-testing of GC-006 webview DOM
      (owned by the bundle test) or GC-001 validators (owned by their own suites).
- [ ] File imports only public exports of GC-001/002/003/007 modules — no deep
      private-symbol pokes.

## Dependencies

- TASK-GC-004 (manifest contributions exist), TASK-GC-007 (`runGenerateCommitMessage` +
  registration exist; transitively GC-001/002/003)

## Interfaces

- Consumes: `runGenerateCommitMessage(deps: CommitGenDeps)` (GC-007), `collectCommitDiff`
  shape (GC-002), `sanitizeCommitMessage` (GC-003), `package.json` contributions (GC-004).
- Produces: (none) — terminal regression net.

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: this is the last task of the wave — after GREEN, the cycle gate is the full
`npm test` printed in your report. If a sibling suite fails here, file it in this thread
against the owning TASK id instead of fixing outside your Target Files.

(no comments yet)
