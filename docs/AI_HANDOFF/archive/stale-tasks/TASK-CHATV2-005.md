# TASK-CHATV2-005 — V2 app shell, icon factory and scoped visual tokens

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§2–5

## Goal
Mount the new semantic V2 skeleton and complete scoped design primitives without changing turn behavior. Establish exact layout, local icons, theme behavior and responsive foundations every later component uses.

## Target Files
- `webview/aiChat/shell.ts` — new root/header/banner/transcript/composer/live-region mount points.
- `webview/aiChat/icons.ts` — new local SVG factory with closed icon names.
- `webview/aiChat/styles.css` — new V2-only tokens/layout/component primitives.
- `webview/aiChatPanelMain.ts` — mount V2 shell from existing esbuild entry.
- `src/ui/aiChatPanel.ts` — root class becomes `UnicDB-chat UnicDB-ai-chat-v2` only during migration.
- `webview/aiChat/__tests__/shell.test.ts` — semantics and class-scope tests.
- `src/ui/__tests__/aiChatPanelBundle.test.ts` — V2 bundle marker.

## Required Work / Exact Spec
Create one `.UnicDB-ai-chat-v2` vertical grid: 40px header; conditional 28–40px banner; `minmax(0,1fr)` transcript viewport; conditional context strip max 72px; sticky composer area; 20px keyboard hint. Root padding 10px vertical/12px horizontal; transcript padding 8px horizontal with 16px turn gaps. Use `min-width:0`, `min-height:0` at every flex/grid overflow boundary.

Header mount points: 16px product mark + `UnicDB AI`, session title, engine status pill, 32×32 overflow. Product mark is not clickable unless session list behavior exists. Add one `aria-live=polite` region and one `aria-live=assertive` error/permission region; both visually hidden, not `display:none`.

Implement `createChatIcon(name,size): SVGSVGElement` using `createElementNS`; closed names: database, plug, ellipsis, plus, slash, chevron-down/right, file, selection, table, view, routine, schema, shield-check, shield-alert, arrow-up, stop-square, copy, edit, retry, check, x, warning, spinner. SVG has `viewBox=0 0 24 24`, currentColor, aria-hidden and cannot accept raw SVG/string markup.

Styles use exact tokens/typography/radii/spacing/colors in PLAN §3. All selectors begin `.UnicDB-ai-chat-v2` except keyframes and visually-hidden utility specifically namespaced. No remote font, icon library, CSS framework, inline unsafe user-derived style, or global `.button/.chat` selector. At <420px hide optional visible labels via class while retaining `aria-label`; at <320px define two-row action grid. Controls minimum 32×32, send slot 40×40.

This task renders placeholders only—no duplicate production V1 controls/listeners. Existing functionality may remain temporarily delegated by adapter, but there must be one visible root tree. No visual claim is accepted from jsdom alone; create screenshot checklist fixture names for 320/420/768 dark/light/high contrast.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | DOM | semantic shell | one header/main/composer and two live regions with stable IDs |
| 2 | unit | icon allowlist | all names render SVG; unknown icon rejected/fallback safely |
| 3 | edge | repeated mount | no duplicate root, live region or listener marker |
| 4 | regression | CSS leakage | every V2 selector scoped; console/results selectors unchanged |
| 5 | boundary | responsive primitives | CSS contains <420 and <320 branches and 32/40px minima |
| 6 | bundle | entry reachability | compiled bundle contains V2 root marker |

## Test Files
- `webview/aiChat/__tests__/shell.test.ts`
- `src/ui/__tests__/aiChatPanelBundle.test.ts`

## Verification Commands
```bash
npm test -- --run webview/aiChat/__tests__/shell.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Exactly one visible V2 tree mounts through existing entry/CSP.
- [ ] Geometry/tokens match PLAN §3 and all styling is V2-scoped.
- [ ] Icon factory cannot inject raw markup and all icons are local.
- [ ] Responsive/HC/reduced-motion foundations exist without modifying other webviews.

## Dependencies
- TASK-CHATV2-003

## Interfaces
- Consumes: V2 host frame types for data attributes only; no reducer dependency.
- Produces: `ChatShellRefs`, `mountChatShell(root)`, `createChatIcon()` and scoped CSS primitives for 006–017.

## Discussion
(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
MILESTONES (5 commits on handoff/task-chatv2-005):
  71e049e step1 icons.ts+test · 9f5f498 step2 v2 scoped styles ·
  01277d8 step3 shell.ts+test · 0bb564a step4 wire shell + V2 root class +
  bundle marker test · 3255d59 step5 screenshot fixtures + stale-import fix
RED_OUTPUT: NOT independently captured — this run wrote files incrementally
  (one file per milestone, committed before the next) because two prior
  attempts died from an intermittent gateway stream error after spending the
  whole budget on reads. Tests were authored to exercise real behavior before
  first run; the first shell.test.ts run genuinely failed for the expected
  reasons and was fixed:
    - "repeated mount" failed: listener counter marker was reset to "0" AFTER
      registration in mountChatShell (assertion expected >0). Fix: seed the
      marker to "0" before buildHeader() so the registration bump sticks.
    - "scopes every selector" failed: the @keyframes step selectors (`0%`,
      `100%`) were comma-split and not excluded from the scope scan. Fix: the
      test skips `^\d+%$|^from$|^to$`.
  Both were test/impl mismatches, not silently-passing tests.
Verification Output:
  CMD1: npm test -- --run webview/aiChat/__tests__/shell.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
    ✓ src/ui/__tests__/aiChatPanelCloneCss.test.ts  (8 tests) 24ms
    ✓ webview/aiChat/__tests__/shell.test.ts  (14 tests) 31ms
    ✓ src/ui/__tests__/aiChatPanelBundle.test.ts  (33 tests) 194ms
    Test Files  3 passed (3)   Tests  55 passed (55)
  CMD2: npm run typecheck → tsc --noEmit, exit=0 (no output)
  CMD3: npm run compile → "esbuild: build complete", exit=0
    emits dist/aiChatPanel.css (10.4kb, 136 .UnicDB-ai-chat-v2 occurrences)
  ADDITIONAL: full `npm test` = 286 files passed | 2 skipped, 4253 tests
    passed | 5 skipped. The 9-file chat webview regression suite
    (aiChatPanelWebview / Clone* / Task002 / Task005 / DbAware / SessionState /
    E2E) = 136 passed.
Status: PASS
Note: Two implementation decisions beyond the literal step list:
  (1) The V2 stylesheet is built as its own esbuild CSS entry
      (`aiChatPanelCssConfig` → dist/aiChatPanel.css) and linked from
      buildHtml, rather than `import`ed into aiChatPanelMain.ts: the
      webview tests bundle that entry to stdout via esbuild with no outfile,
      and a CSS import makes esbuild error ("Cannot import … without an
      output path configured"). This keeps the stdout-bundling harness valid.
  (2) #thread nests INSIDE the shell's `transcript` mount point (the shell
      mounts on #UnicDB-root) instead of the shell mounting inside #thread.
      Mounting inside #thread shifted `thread.children[0]` and broke
      aiChatPanelWebview.test.ts:671 (notice-above-items). Nesting preserves
      every legacy `thread.children` assertion. Migration is otherwise inert:
      the root class is now `UnicDB-chat UnicDB-ai-chat-v2`.
  vitest.config.ts was widened to `webview/**/*.test.ts` (TASK-CHATV2-004's
  main-tree change, absent from this pre-wave-3 worktree base).
