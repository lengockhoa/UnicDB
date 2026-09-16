# TASK-CHATFIX-001 — Explicit shell grid placement (composer size/pinning/crush + scroll region)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (root cause), §4 (rows 001)

## Goal

Replace auto-placement in the V2 chat root grid with explicit `grid-row` placement so a
`display:none` banner can never shift the layout. One CSS change fixes all three reported
manifestations: giant composer on fresh open, composer crushed to a sliver after several turns,
and the transcript never being a scroll region.

## Target Files

- `webview/aiChat/styles.css` — add explicit `grid-row: 1..5` to `.UnicDB-ai-chat-v2-header`,
  `-banner`, `-main`, `-composer`, `-hint`; add a `.UnicDB-ai-chat-v2-main` rule
  (`display:flex; flex-direction:column; min-width:0; min-height:0`). Keep the root
  `grid-template-rows: 40px auto minmax(0, 1fr) auto auto 20px` (lines 52-55), root
  `overflow:hidden` (line ~61), `.UnicDB-ai-chat-v2-banner[hidden]{display:none}` (lines 208-210)
  and the existing `.UnicDB-ai-chat-v2-transcript` rule (`overflow-y:auto`, lines 224-233)
  unchanged. Regions to edit: around lines 69-79 (header), 180-210 (banner), 222-238
  (transcript/main), 265-279 (composer), and wherever `-hint` is defined.
- `webview/aiChat/__tests__/shellGrid.test.ts` — (new) CSS-text contract test, node environment,
  `readFileSync(process.cwd()/webview/aiChat/styles.css)` — same pattern as
  `shell.test.ts:135-141`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | explicit grid-row on all five shell children | styles.css matches `\.UnicDB-ai-chat-v2-header\s*\{[^}]*grid-row:\s*1` and the same for banner=2, main=3, composer=4, hint=5. RED before fix — no root-level grid-row rules exist today. | current styles.css |
| 2 | regression | composer cannot be crushed by transcript growth | root rule keeps `grid-template-rows` with `minmax(0, 1fr)` as track 3 AND composer rule contains `grid-row: 4` (auto content track, never squeezed) | current styles.css |
| 3 | happy | transcript is the scroll region | `.UnicDB-ai-chat-v2-main` rule contains `display: flex`, `flex-direction: column`, `min-width: 0`, `min-height: 0`; `.UnicDB-ai-chat-v2-transcript` body still contains `overflow-y: auto` and `min-height: 0` | CSS text |
| 4 | edge (clipping) | root clips, main does not | root block contains `overflow: hidden`; the `.UnicDB-ai-chat-v2-main` block contains NO `overflow: hidden` | CSS text |
| 5 | edge (scoping) | new rules stay V2-scoped | every selector added contains `.UnicDB-ai-chat-v2`; balanced braces in the file | CSS text |
| 6 | edge (structural) | hidden banner keeps its track | `.UnicDB-ai-chat-v2-banner[hidden] { display: none }` still present AND banner rule has `grid-row: 2` (coexist) | CSS text |

## Test Files

- `webview/aiChat/__tests__/shellGrid.test.ts` — (new) contains tests 1-6 above.

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/shellGrid.test.ts webview/aiChat/__tests__/shell.test.ts
npm run typecheck
npm run compile
```

(shell.test.ts re-runs the global V2 scoping guard after the edit; typecheck is this repo's
static gate — there is no lint script.)

## Acceptance Criteria

- [ ] All six tests in §Test Cases pass (RED→GREEN for 1-2 verified with pasted output).
- [ ] No other rules in styles.css changed beyond the placement/main additions.
- [ ] `npm test` full suite green at the wave boundary.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — Wave 1.

## Interfaces

- Consumes: (none)
- Produces: the CSS placement contract every later CHATFIX task relies on —
  `.UnicDB-ai-chat-v2-header{grid-row:1}`, `-banner{grid-row:2}`, `-main{grid-row:3;
  display:flex; flex-direction:column; min-width:0; min-height:0}`, `-composer{grid-row:4}`,
  `-hint{grid-row:5}`; the transcript (`.UnicDB-ai-chat-v2-transcript`) is the sole scroll
  region (`overflow-y:auto`, `min-height:0`).

---

## Discussion

### 2026-09-16 · planner · bao-opus
Verified no existing test pins the broken `grid-template-rows` auto-placement string (checked
shell/controllerSurfaces/composer/sessions/transcript/errorsScrollA11y CSS assertions), so this
change cannot silently break a neighbor test. The two visually-hidden live regions are
out-of-flow and never claim a track — do not give them grid-row values.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

### RED (before implementation)

Command: `cd .worktrees/task-chatfix-001 && npx vitest run webview/aiChat/__tests__/shellGrid.test.ts`

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-chatfix-001

 ❯ webview/aiChat/__tests__/shellGrid.test.ts  (6 tests | 6 failed) 5ms
   ❯ ... > pins all five shell children to explicit grid-row 1..5
     → expected \.UnicDB-ai-chat-v2-header to declare grid-row: 1: expected false to be true
   ❯ ... > keeps the composer on a content-sized track that cannot be crushed
     → expected false to be true
   ❯ ... > makes the transcript the sole scroll region via a flex main
     → .UnicDB-ai-chat-v2-main rule must exist: expected undefined not to be undefined
   ❯ ... > clips at the root only — main never hides overflow
     → expected undefined not to be undefined
   ❯ ... > keeps every new placement rule V2-scoped with balanced braces
     → expected false to be true
   ❯ ... > lets a hidden banner keep its explicit track
     → expected false to be true

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯

 Test Files  1 failed (1)
      Tests  6 failed (6)
```

All 6 failed for the expected reason: no `grid-row` declarations existed and no
`.UnicDB-ai-chat-v2-main` rule existed. No test was immediately GREEN, so no
test fix was needed.

### GREEN + Verification (after implementation)

Command 1: `npx vitest run webview/aiChat/__tests__/shellGrid.test.ts webview/aiChat/__tests__/shell.test.ts`

```
 ✓ webview/aiChat/__tests__/shellGrid.test.ts  (6 tests) 3ms
 ✓ webview/aiChat/__tests__/shell.test.ts  (14 tests) 28ms

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Start at  22:38:16
   Duration  604ms (transform 48ms, setup 0ms, collect 12ms, tests 31ms, environment 386ms, prepare 79ms)
```

Command 2: `npm run typecheck`

```
> UnicDB@1.54.0 typecheck
> tsc --noEmit
```
(exit 0, no errors)

Command 3: `npm run compile`

```
  dist/extension.js       6.6mb ⚠️
  dist/extension.js.map  12.0mb

⚡ Done in 160ms
esbuild: build complete
```

### Files changed (worktree commit d51b2d0, milestone: TASK-CHATFIX-001)

- `webview/aiChat/styles.css` (+17): `grid-row: 1` on `-header`, `2` on
  `-banner`, `4` on `-composer`, `5` on `-hint`; new `.UnicDB-ai-chat-v2-main`
  rule (`grid-row: 3; display: flex; flex-direction: column; min-width: 0;
  min-height: 0`) before the transcript section. Root `grid-template-rows`,
  root `overflow: hidden`, `-banner[hidden]`, and the `-transcript` rule are
  untouched. Composer auto-grow logic (COMPOSER_AUTO_GROW_*) untouched.
- `webview/aiChat/__tests__/shellGrid.test.ts` (new, +101): tests 1-6 from
  §Test Cases, node environment, same `readFileSync(process.cwd())/styles.css`
  pattern as `shell.test.ts:135-141`.

Status: PASS
Note: none — diff is insertions-only on the two target files; no other rules changed.

