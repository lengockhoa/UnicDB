# TASK-CLEAN2-002 — engineChoice.ts: delete dead `_LegacyDetectionTypes` type export

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (item #7), §3

## Goal

Delete `export type _LegacyDetectionTypes = ClaudeCodeDetection | CodexDetection;` and its
"Unused export marker" comment (engineChoice.ts:206-208). Pre-change repository consumer
search finds only that definition site, while `package.json` has no `exports`, `types`, or
`typings` field (only runtime `main: "dist/extension.js"`), so the marker is not a supported
published TypeScript API. Both types remain consumed by `projectAgent()`'s signature, so the
imports stay used and the tree-shaking rationale in the comment never applied to a type-only
export (TASK-007 reviewer, verified at HEAD).

## Target Files

- `src/ai/engineChoice.ts` — remove lines 206-208 (comment + export). Nothing else.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | full `src/ai/__tests__/engineChoice.test.ts` | passes UNMODIFIED — `projectAgent(config, detections)` surface + detection matrix intact | existing suite |
| 2 | edge (consumer-check) | repository and supported-public-surface search | pre-change source search returns only `src/ai/engineChoice.ts:208` (the definition); README/project docs have 0 mentions (excluding `docs/AI_HANDOFF/`, which records this cleanup); `exports`, `types`, and `typings` are absent while `main` is runtime `dist/extension.js` | source tree, README/docs, package.json |
| 3 | edge (grep) | `grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts` | 0 (today: 1 — only the export at :208; the "Legacy detection types" comment at :206-207 uses the wording without the identifier; check still fails-before) | shell |
| 4 | edge (typecheck) | `npm run typecheck` | exit 0 — proves `ClaudeCodeDetection`/`CodexDetection` imports still resolve via the `projectAgent` signature (no orphaned import, no broken reference) | tsc |

## Test Files

- `src/ai/__tests__/engineChoice.test.ts` — regression only, MUST NOT be modified
  (tests-map.json maps `src/ai/engineChoice.ts` → this file).

## Verification Commands

```bash
# Before deleting: record supported-consumer and public-documentation evidence.
grep -rn "_LegacyDetectionTypes" --include="*.ts" --include="*.tsx" src/ webview/ tests/
grep -rn "_LegacyDetectionTypes" README.md docs/ --exclude-dir=AI_HANDOFF || true
node -p "JSON.stringify({exports: require('./package.json').exports ?? '<absent>', main: require('./package.json').main ?? '<absent>', types: require('./package.json').types ?? '<absent>', typings: require('./package.json').typings ?? '<absent>'})"
# Expected pre-change evidence: only engineChoice.ts:208; no README/public-doc results;
# package API fields: exports/types/typings absent, main = dist/extension.js.
npx vitest run src/ai/__tests__/engineChoice.test.ts
test "$(grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts || true)" -eq 0
npm run typecheck
```

## Acceptance Criteria

- [ ] Pre-change consumer/public-surface evidence is recorded: only engineChoice.ts:208;
      no README/public-doc mention and no `exports`/`types`/`typings` package entry point.
- [ ] Lines 206-208 removed; zero other diff in the file.
- [ ] engineChoice suite passes unmodified; typecheck exit 0; grep returns 0.
- [ ] lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: (none) — public surface is `projectAgent` + value exports only, now without
  the legacy marker type.

---

## Discussion

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
  # Pre-change consumer/public-surface evidence (recorded before edit)
  $ grep -rn "_LegacyDetectionTypes" --include="*.ts" --include="*.tsx" src/ webview/ tests/
  src/ai/engineChoice.ts:208:export type _LegacyDetectionTypes = ClaudeCodeDetection | CodexDetection;
  $ grep -rn "_LegacyDetectionTypes" README.md docs/ --exclude-dir=AI_HANDOFF
  (no output — 0 hits)
  $ node -p "JSON.stringify({exports: require('./package.json').exports ?? '<absent>', main: require('./package.json').main ?? '<absent>', types: require('./package.json').types ?? '<absent>', typings: require('./package.json').typings ?? '<absent>'})"
  {"exports":"<absent>","main":"dist/extension.js","types":"<absent>","typings":"<absent>"}
  $ grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts
  1   # FAILS-BEFORE (edge #3 expected to return 0 after deletion)

Diff applied (4 deletions, 0 insertions — only the marker block + trailing blank):
  --- a/src/ai/engineChoice.ts
  +++ b/src/ai/engineChoice.ts
  @@ -202,7 +202,3 @@ function resolveOmpLegacy(
       hint,
     };
   }
  -
  -// Unused export marker — keeps `ClaudeCodeDetection`/`CodexDetection` types
  -// tree-shake-correct without changing the public surface.
  -export type _LegacyDetectionTypes = ClaudeCodeDetection | CodexDetection;

Verification Output:
  $ grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts
  0
  $ grep -rn "_LegacyDetectionTypes" --include="*.ts" --include="*.tsx" src/ webview/ tests/
  (no matches)
  $ npx vitest run src/ai/__tests__/engineChoice.test.ts
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/clean2-002
   ✓ src/ai/__tests__/engineChoice.test.ts  (11 tests) 2ms
   Test Files  1 passed (1)
        Tests  11 passed (11)
   Duration  195ms
  $ npm run typecheck
  > UnicDB@1.53.25 typecheck
  > tsc --noEmit
  (exit 0, no errors)

Status: PASS
Note: Both `ClaudeCodeDetection` and `CodexDetection` remain consumed by `projectAgent()`'s signature, so no orphaned imports; typecheck exit 0 confirms. Working tree intentionally dirty (no git commit per instruction).

### 2026-09-08 · executor · unic-code
Type-only deletion → no runtime RED output is producible; edge #3 is the failing-before /
passing-after check (returns 2 today). The requested pre-change source search returned only
`engineChoice.ts:208`; README/public docs returned no mentions (excluding this handoff
record); package.json has no `exports`/`types`/`typings`, only runtime
`main: "dist/extension.js"`. If execution discovers a supported external consumer, retain
this export with `@deprecated` JSDoc rather than delete it. Verified at HEAD: both Detection
types are still referenced by `projectAgent()`'s parameters, so no import cleanup is needed
beyond the deleted block.
