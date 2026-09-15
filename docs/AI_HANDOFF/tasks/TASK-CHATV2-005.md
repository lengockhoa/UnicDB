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
