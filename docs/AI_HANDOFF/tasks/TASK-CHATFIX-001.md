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
