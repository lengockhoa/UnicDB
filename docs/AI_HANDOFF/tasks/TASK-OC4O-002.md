# TASK-OC4O-002 — Help Grid panel (open from webview `...` menu)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §OC4O scope expansion

## Goal

Add a "VSDB Help" entry under the webview panel's `...` (more actions) menu on
the VSDB Results / Console / Schema panels that opens a dedicated help webview
laid out as a **grid of cards**. Each card = one feature area (Console, Results
grid, Schema tree, Connection manager, BigQuery, AI chat, Settings, etc.) with
a short description + the matching command id + a "Try it" action that runs
`vscode.commands.executeCommand(...)` for that feature.

Success: from any VSDB webview, the user clicks the `...` title menu → "VSDB
Help" → a new webview panel opens showing a responsive grid where every card
summarizes one feature and offers a one-click way to launch its command.

## Target Files

- `package.json` — new command `vsdb.openHelpGrid` (`category: VSDB`, icon
  `$(book)`); new menu entries under `webview/context` (or panel title menu
  via `webview/.../title` if available) targeting the VSDB webview ids.
- `src/ui/helpGrid.ts` (new) — pure help-card registry (id, title, blurb,
  command-id, icon) + a tiny renderer that posts the grid payload to the
  webview; no vscode dep beyond the postMessage bridge.
- `src/ui/helpGridPanel.ts` (new) — host-side `HelpGridPanel` singleton
  (same lifecycle pattern as `ConsolePanel`: create on demand, reveal on
  subsequent opens, drop singleton on dispose).
- `webview/helpGridMain.ts` (new) + `webview/helpGridMain.html` (new) — the
  webview bundle entry. CSP-clean. Cards rendered with `display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))` so the
  layout is responsive in narrow + wide panels.
- `src/extension.ts` — register `vsdb.openHelpGrid` + thread the new panel
  into the same singleton wiring.
- `src/extension.test.ts` — unit tests for the help-card registry (every
  card has a command id that is actually registered; the grid panel can be
  opened; the singleton reveal works).
- `webview/esbuild.config.mjs` (or equivalent) — register the new webview
  entry so it ships in the next `npm run build:webview`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `helpCardRegistry chứa >=8 card, mỗi card có command id đã đăng ký` | registry returns ≥8 cards; for each card, `state.registeredCommands.has(card.commandId) === true` | fresh `activate(ctx)` |
| 2 | unit | `handler vsdb.openHelpGrid tạo webview panel + postMessage { type: 'init', cards }` | first webview created, `webview.postMessage` receives `{ type: 'init', cards: [...] }` with non-empty cards list | fresh `activate(ctx)` |
| 3 | happy path | `singleton: gọi 2 lần → chỉ 1 webview panel, lần 2 reveal` | after 2 calls, `state.createdWebviewPanels.length === 1`, second call hits `reveal()` on the existing panel | fresh `activate(ctx)` |
| 4 | edge | `card không chứa command id hợp lệ → fail-closed ở registry` | registry filters out cards whose `commandId` is not a non-empty string; test pins that the registered set has zero such entries | fresh registry list |
| 5 | regression | `BQ-04 frozen-surface guard vẫn pass sau khi thêm command + menu` | `bq04SurfaceGuard` test 4/4 pass (filter widened in TASK-OC4O-001 already covers contributes changes) | post-implementation |

## Test Files

- `src/ui/__tests__/helpGrid.test.ts` (new) — registry + card-shape tests.
- `src/extension.test.ts` (extend) — add the `vsdb.openHelpGrid` block alongside the existing TASK-OC4O-001 block; reuse `activateFresh` pattern.

## Verification Commands

```bash
# Focused.
npx vitest run src/ui/__tests__/helpGrid.test.ts
npx vitest run src/extension.test.ts -t "openHelpGrid"

# Frozen-surface guard — must stay green.
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts

# Console ARP-08 #30 invariant — must stay green.
npx vitest run src/ui/__tests__/consoleTabs.test.ts

# Full suite + typecheck + bundle.
npm test
npm run typecheck
npm run build:webview
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] `npm test` still 3407+ passed | 2 skipped (additions only, no regressions).
- [ ] `npm run typecheck` exit 0.
- [ ] Webview bundle includes the new `helpGridMain` entry (`dist/helpGrid.js` present).
- [ ] From any VSDB webview (`VSDB: Results`, `VSDB: Open Console`, etc.), the `...` menu shows `VSDB Help`; the resulting panel shows ≥8 feature cards in a responsive grid; clicking a card's "Try it" runs the matching command.
- [ ] No regression in BQ-04 frozen surfaces (BQ-00 / BQ-01 / `formatBigQueryCell` / `@google-cloud/bigquery@9.0.3` all byte-identical).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-OC4O-001 (right-click Open Console for Object) — TASK-OC4O-002 ships in the SAME OC4O cycle, wave 2 after TASK-OC4O-001 lands. Rationale: TASK-OC4O-001 already widened the BQ-04 frozen-surface guard filter for contributes changes, so the guard does not need widening again for OC4O-002's command + menu additions. Wave plan: wave 1 = OC4O-001 (working-tree state, copy back) ∥ OC4O-002 (help grid source, separate files); wave 2 = webview bundle rebuild + smoke verify.

## Interfaces

- Consumes: `(none)` — independent from TASK-OC4O-001.
- Produces:
  - Command id: `vsdb.openHelpGrid` (registered in `commands` + `webview/context` menu bindings; category `VSDB`; icon `$(book)`).
  - Public type: `HelpCard { id: string; title: string; blurb: string; icon: string; commandId: string }`.
  - Pure helper: `helpCardRegistry(): readonly HelpCard[]` — returns the registered cards.
  - Host class: `HelpGridPanel` with `show(): void`, mirrors `ConsolePanel.show()`.

---

## Discussion

### 2026-09-03 · planner · claude-sonnet-4-6

User request: "Mấy cái hướng dẫn sử dụng này nên làm cho tôi một menu. Ở đó có thể mở ra và xem toàn bộ hướng dẫn sử dụng. Có thể làm cái button ngay ở phía trên (ba cái nhỏ nhỏ ở phía trên menu) để mình có thể mở ra dạng grid và có thể đọc toàn bộ hướng dẫn sử dụng."

Mapped to the standard VS Code surface: the `...` ("more actions") menu on a
webview title is exposed via `contributes.menus` entries with `webview/<id>`
context keys. VSDB's webviews are scoped under the `vsdb` namespace
(Results / Console / Schema panels). The new entry shows up at the TOP of
the `...` menu across all VSDB webviews.

Grid layout: webview-native CSS grid, no extra deps. Cards laid out
`auto-fill` so the same component shrinks gracefully in narrow panels.

### 2026-09-03 · planner · claude-sonnet-4-6

Push-back for executor: the help-card registry MUST be a pure function over
the actual registered `state.registeredCommands` set — do not hardcode command
ids. If a future cycle adds a new command, the help grid should pick it up
automatically (filter on the registry, not on a literal list).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->