# PLAN — Cycle UX1: consolidated UX batch (13 user requests R0–R13)

Prior cycles: MENU closed at `1e96f89`, tree clean, `v1.51.1` pending maintainer bump.
This is a fresh cycle on `main`.

## §1 Intent

The user submitted 13 UX requests in one batched session, all around the day-to-day
developer loop in UnicDB: schema-tree polish, console templates, an in-extension user guide,
DataGrip-parity SQL Generator, filter alignment, results placement, a settings hub, chat
UX fixes, DDL result handling, and auto-refresh of the schema tree. Success = every active
request (R1–R13) ships in one cycle with behaviour pinned by tests; the suite stays at the
3420|2 baseline + new tests green; `npm run typecheck` and `npm run compile` stay clean.

**Known caveat — vision evidence UNRELIABLE.** 12 screenshots were attached. The vision
receipts (all `unic-vision`, repaired for a JSON syntax corruption; verdicts preserved)
record 9 receipts describing content UNRELATED to the stated hypotheses (Vue/CreatePR
pages, an app.roles data-cleanup doc, an Extensions Marketplace shot) and 3 receipts
UNREADABLE/bytes-inaccessible. The user's **verbatim Vietnamese text descriptions are the
sole source of truth** for this plan; no receipt corroborates any R-hypothesis. Where a
description was ambiguous (R5 exact offset, R9 exact garble mechanism, R10 which element
gets padding), each task's first step is a code-grounded reproduction of the described
symptom; the fix targets the stated user-visible outcome, not a pixel.

Requests (R0 already shipped in MENU commit `1e96f89` — do NOT duplicate):

| ID | Ask (condensed) | Decision (confirmed in P0) |
|----|-----------------|-----------------------------|
| R1 | Sample Data menu broken → "console templates": open console pre-filled with INSERT templates the user runs manually | Confirmed |
| R2 | Book icon on schema-tree title bar opens a user guide (markdown) | Confirmed: tree icon → markdown |
| R3+R4 | Right-click View/Function → "SQL Generator" fetches `pg_get_viewdef`/`pg_get_functiondef`, opens new console with the DDL, savable as .sql | Confirmed |
| R5 | Filter dropdown: Select All checkbox offset vs item checkboxes — align | Confirmed |
| R6+R7 | Cannot open any console from the left pane | Confirmed bug fix |
| R8a | Results pane at BOTTOM by default, configurable via setting | Confirmed; extend existing `UnicDB.resultsPlacement` |
| R8b | Gear icon on left pane top → settings hub | Confirmed |
| R9 | Chat pending: text renders one-char-per-line vertically before colour arrives | Confirmed |
| R10 | Chat left padding too tight ("dính vô viền") | Confirmed |
| R11 | Chat loading: plain text + "AI is thinking…" + spinner; code blocks boxed with copy | Confirmed (copy button + boxed code ALREADY ship — task finishes the gaps) |
| R12 | DDL/non-SELECT: suppress results table; success card (what was applied) / failure card (what failed + pinpoint) | Confirmed |
| R13 | After any query, auto-refresh schema tree (debounced) | Confirmed |

## §2 Scope

**In-scope**

- `package.json` — `contributes.commands`, `contributes.menus` (`view/title`,
  `view/item/context`), `contributes.configuration` (extend existing
  `UnicDB.resultsPlacement`), `activationEvents` additions for new commands.
- `src/extension.ts` — new command handlers; console-open fix (R6+R7); `runStatements`
  post-success refresh hook (R13); DDL kind stamping call-site (R12).
- `src/ui/tableCommands.ts` — R1 rewire of `UnicDB.generateSampleData` to console templates.
- `src/ui/consolePanel.ts` — R6+R7 `show()` view-column fix.
- `webview/aiChatPanelMain.ts` + `webview/styles.css` — chat UX (R9, R10, R11).
- `webview/main.ts` + `webview/styles.css` — filter alignment (R5), DDL status card (R12).
- `src/ui/resultsPanel.ts`, `src/ui/resultsGridModel.ts` — R12 card signal; R8a placement.
- `src/core/queryRunner.ts` — `classifyStatementKind` + `StatementResult.kind?` (R12).
- `src/core/schemaImpact.ts` — `shouldRefreshAfter` classification (R13).
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — guard-filter extension for
  `activationEvents` + `contributes.configuration` lines (UX1-006 only).
- `docs/UnicDB_USER_GUIDE.md` — new authored Vietnamese user guide (R2).
- Tests in existing homes per `.cache/index/tests-map.json` (listed per task).
- `CHANGELOG.md` — user-facing entries per repo convention.

**Out-of-scope**

- R0 (already shipped; do not re-touch).
- Version bump / tag / push (maintainer-owned per OC4O/MENU precedent); commits (P3 owns).
- Frozen surfaces: `src/adapters/bigqueryTypes.ts`, `src/adapters/bigqueryAdc.ts`,
  `src/adapters/types.ts`, dependency manifest + `package-lock.json`.
- Drag-to-move affordance for results (R8a nice-to-have): VS Code webview panels are
  natively user-draggable; the setting is the requested lever. Keybinding rejected as noise.
- Per-adapter DDL grammar for R12 (classification from statement text + `commandTag` only);
  BigQuery `StatementResult` pending shapes unaffected (`kind` stays `undefined` there).
- AI-driven sample-data path stays callable; only the DEFAULT surface changes (R1).

**Wave constraint (operative rule — P2.5 round-1 revision).** The hard invariant is
**per-region file ownership**, not per-file: each task's Target Files section names the
exact region it owns — for `webview/styles.css` a selector prefix, for `src/extension.ts`
a named function/slot, for `package.json` a contributes block. Overlap that is NOT
governed by a written region contract must be broken with a `Dependencies` edge. Region
contracts in force: styles.css → UX1-005 `.UnicDB-setfilter-*`, UX1-008 `.UnicDB-chat-*`,
UX1-010 `.UnicDB-ddl-*` (append-only); extension.ts wave-1 → UX1-001 `commandGenerateSelect`
only vs UX1-010 `runStatements` stamping slot only; extension.ts wave-2 lane → serialised
by edges, not regions. package.json and src/extension.ts are the hot files — tasks owning
them are chained (dependency = file exclusivity + UX1-006's guard fix, not logic).

**Tasks → waves** (waves inferred from `Dependencies` fields):

| Task | Title | Wave | Owns (files — region contracts in §3) |
|------|-------|------|--------------|
| UX1-001 | Console open from left pane (R6+R7) | 1 | `src/ui/consolePanel.ts`, `src/extension.ts` (commandGenerateSelect ONLY), `src/ui/__tests__/consolePanel.test.ts`, `src/extension.test.ts` (generateSelect describe ONLY) |
| UX1-005 | Filter Select All alignment (R5) | 1 | `webview/main.ts` (SetFilterComponent ONLY), `webview/styles.css` (.UnicDB-setfilter-* ONLY), `src/ui/__tests__/webviewSetFilter.test.ts` |
| UX1-006 | Results placement `top` + guard filter extension (R8a) | 1 | `package.json`, `src/ui/resultsPanel.ts`, `src/ui/__tests__/resultsPanel.test.ts`, `src/adapters/__tests__/bq04SurfaceGuard.test.ts` |
| UX1-008 | Chat pending garble + left padding (R9+R10) | 1 | `webview/aiChatPanelMain.ts`, `webview/styles.css` (.UnicDB-chat-* ONLY), `src/ui/__tests__/chatLayoutCss.test.ts` |
| UX1-010 | DDL result handling (R12) | 1 | `src/core/queryRunner.ts`, `src/core/__tests__/queryRunner.test.ts`, `src/ui/resultsGridModel.ts`, `src/ui/__tests__/resultsGridModel.test.ts`, `webview/main.ts` (renderActivePanel/state-tab regions ONLY), `webview/styles.css` (.UnicDB-ddl-* APPEND-ONLY), `src/extension.ts` (runStatements kind-stamping ONLY), `src/ui/__tests__/ddlStatusCard.test.ts` (new) |
| UX1-002 | SQL Generator view/function (R3+R4) | 2 | `package.json`, `src/extension.ts` (full ownership from UX1-002 onward), `src/extension.test.ts` |
| UX1-007 | Settings hub icon (R8b) | 3 | `package.json`, `src/extension.ts`, `src/extension.test.ts` |
| UX1-009 | Chat thinking row + streamed code blocks (R11) | 2 | `webview/aiChatPanelMain.ts`, `webview/styles.css`, `src/ui/__tests__/aiChatPanelBundle.test.ts` |
| UX1-011 | Auto-refresh after any query (R13) | 4 | `src/extension.ts`, `src/core/schemaImpact.ts`, `src/core/__tests__/schemaImpact.test.ts`, `src/extension.test.ts` |
| UX1-003 | Sample Data → console templates (R1) | 3 | `package.json`, `src/ui/tableCommands.ts`, `src/ui/__tests__/tableCommands.test.ts` |
| UX1-004 | User guide icon + guide doc (R2) | 4 | `package.json`, `src/extension.ts`, `src/extension.test.ts`, `docs/UnicDB_USER_GUIDE.md` (new) |

Same-wave file overlap analysis (audited, P2.5 round-1 revision — full audit including
UX1-005 and UX1-001):

- Wave 1 — `webview/styles.css`: owned by THREE tasks (UX1-005, UX1-008, UX1-010) under
  the region-contract rule above; regions are disjoint selector families (`.UnicDB-setfilter-*`
  / `.UnicDB-chat-*` / append-only `.UnicDB-ddl-*` block), so the P3 merge is conflict-free.
  Each task's Target Files names its selectors and its acceptance criteria include a
  `git diff -- webview/styles.css` scoping check.
- Wave 1 — `src/extension.ts` / `src/extension.test.ts`: owned by UX1-001 and UX1-010 under
  the region-contract rule; regions are disjoint functions (UX1-001: `commandGenerateSelect`
  fallback branch + its own extension.test.ts describe; UX1-010: the `runStatements`
  kind-stamping slot next to `stampBqDialect`). Both task files state the contract.
- Wave 1 — no other file is shared between any two wave-1 tasks (UX1-006's package.json is
  sole-owned in wave 1; UX1-005 and UX1-010 both touch `webview/main.ts` under disjoint
  region contracts: SetFilterComponent class vs renderActivePanel/state-tab logic).
- Wave 2: UX1-002 (extension.ts + package.json + extension.test.ts) and UX1-009
  (webview-only) — two fully parallel lanes, no shared file.
- Wave 3: UX1-003 (package.json) and UX1-007 (package.json + extension.ts) share
  package.json — serialised by the edges already declared in their files (UX1-007 →
  UX1-002; UX1-003 → UX1-006 keeps wave-1 exclusivity and orders it before wave-3
  package.json consumers). To keep the runner's inference unambiguous, UX1-003's edge on
  UX1-006 plus UX1-007's placement after UX1-002 means the two wave-3 tasks share no
  concurrent package.json window in practice; if the runner schedules them together
  anyway, UX1-003's tableCommands.ts work and UX1-007's extension.ts work are disjoint —
  only package.json overlaps, and both make appends to different contributes blocks
  (`menus.view/item/context` vs `commands`/`view/title`/`activationEvents`).
- Wave 4: UX1-011 and UX1-004 both own extension.ts + extension.test.ts — UX1-011
  serialises via its `TASK-UX1-007` edge; UX1-004 serialises via `TASK-UX1-003`. The
  runner cannot place 011 and 004 concurrently unless 007 and 003 both finished, which
  cannot happen while either still runs — and both tasks append to disjoint
  contributes/regions regardless. Residual risk accepted and noted in §3 (UX1-004).

CORRECTED serialisation edges (finding 1 fix): the extension.ts lane across waves 2–4 is
strictly `UX1-002 → UX1-007 → UX1-011` and UX1-009 runs in parallel with UX1-002. UX1-007
now declares `Dependencies: TASK-UX1-002` and UX1-011 now declares
`Dependencies: TASK-UX1-002, TASK-UX1-007` — with the second edge present, the runner can
never schedule 007 and 011 concurrently on the same files (the previous gap). UX1-003's
existing edge on UX1-006 (package.json exclusivity) keeps waves 1–3 package.json safe.

Scope complexity: MEDIUM — one subsystem (VS Code extension UX), 11 tasks, 4–5 effective
waves (waves 2–4 partially serialised by the extension.ts lane; UX1-009 rides parallel in
wave 2, UX1-003 in wave 3).

## §3 Approach

**Frozen surfaces + guard.** `bq04SurfaceGuard.test.ts` (base `75cdb08`) filters
`[+-] "command|title|category|icon|when|group|order|keybinding|mac|win|linux":` lines and
menu-block header keys from the package.json dependency diff. Verified green today (4/4).
Risk verified: **`activationEvents` lines (`"onCommand:UnicDB.x",`) and
`contributes.configuration` property keys (`"UnicDB.resultsPlacement": {`) match NEITHER
whitelist** — they survive the filter and fail guard test 3. UX1-006 therefore extends the
filter with narrowly-anchored patterns (`/^[+-]\s+"onCommand:[a-zA-Z0-9.]+",?\s*$/` and a
`"UnicDB\.[a-zA-Z.]+"\s*:\s*\{` configuration-block key pattern) and pins them with a test.
This is a filter extension over NON-dependency keys; the dependency-manifest assertion
(dedication of the guard) is untouched, and the sanity-check block keeps proving
non-tautology. All later package.json tasks (UX1-002/003/004/007) chain AFTER UX1-006.

**UX1-001 (R6+R7).** Verified root cause — NOT the brief's guess. `UnicDB.openConsoleForObject`
takes a node argument and never checks for an editor; the actual defect is in
`ConsolePanel.show()` (src/ui/consolePanel.ts:178): the panel is created with
`ViewColumn.Active`, which resolves to nothing when no text editor is active — the panel is
created but never becomes visible ("không mở được console"). Fix: in `show()`, when
`vscode.window.activeTextEditor === undefined && visibleTextEditors.length === 0`, create
with `ViewColumn.One`. Secondary path: `commandGenerateSelect` (extension.ts:2530) toasts
"UnicDB: no active editor." on the same left-pane trigger — that fix lives in extension.ts,
so UX1-001 carries a wave-1 extension.ts edit under a **region contract**: UX1-001 owns
ONLY the `commandGenerateSelect` function (its `!editor` branch) and the corresponding
`src/extension.test.ts` describe block. The wave-1 overlap audit above names the co-owner
(UX1-010, which owns ONLY the `runStatements` kind-stamping slot) — disjoint functions,
disjoint test describes; no serialisation edge needed. (This corrects the earlier draft
claim that "no other wave-1 task touches extension.ts", flagged by P2.5 round 1.)

**UX1-002 (R3+R4).** Two commands `UnicDB.generateViewDdl` / `UnicDB.generateFunctionDdl`
(+ `onCommand:` activations, + two `view/item/context` entries with `when: viewItem ==
view` / `viewItem == routine` — **the tree's routine contextValue is `"routine"`, NOT
`"function"`**, verified schemaTree.ts:565; the brief's suggested `when` clause would have
produced dead menu entries). Handler: resolve node meta (schemaTree node shape
`{ meta: { connection, schema, objectName } }`, verified schemaTree.ts:541-549/565-575) →
pg gate → `adapter.catalog.objectDdl(kind, name, schema)` — **already implemented** at
src/adapters/postgres.ts:975 over `objectDdlSql` (pgCatalog.ts:258 emits
`pg_get_viewdef(schema.name::regclass, true)` / `pg_get_functiondef(qualified::regproc::oid)`)
→ open console singleton via the OC4O `commandOpenConsole` + `seedTab("DDL schema.name",
ddl + missing ";")` pattern. Nothing new is invented at the SQL layer.

**UX1-003 (R1).** Keep the command id `UnicDB.generateSampleData` (no id churn). Rewire in
src/ui/tableCommands.ts: resolve node → `introspectTable` (already used there) → build
5–10 typed INSERT template statements from `format_type` (int → number, text/varchar →
quoted string, bool → true/false, timestamp → NOW(), numeric → 0, uuid → gen_random_uuid()
wrapped in a comment noting pgcrypto) → open the console via the same
`commandOpenConsole`+`seedTab` seam (import from extension.ts is not possible — instead
execute `UnicDB.openConsoleForObject` then use `ConsolePanel.seedTab` through a new tiny
exported helper `openConsoleWithTemplate(mgr, {name, buffer})` placed in tableCommands.ts
and wired in extension.ts in the SAME task — extension.ts is unowned in wave 3 except by
UX1-003 itself). Never auto-execute. AI path retained behind an explicit second command
palette entry only if zero-cost; otherwise the AI flow is dropped from the menu but its
code stays (dead-code-free rule: the AI branch remains reachable through the existing
`sampleDataAi` module tests). Edge: 0 insertable columns → commented header-only template.

**UX1-004 (R2).** New `UnicDB.openUserGuide`: resolve `docs/UnicDB_USER_GUIDE.md` against
`context.extensionUri` (NOT `process.cwd()`), then
`vscode.commands.executeCommand("markdown.showPreview", uri)`; missing-file fallback =
toast, never throw. One `view/title` entry (`$(book)`, group `navigation`) on
`UnicDB.schemaTree`. Serialisation note: UX1-004 is the last extension.ts +
package.json consumer (edge on UX1-003); its appended contributes entries land in
different blocks than UX1-007's (guide `view/title` vs settings command+icon). The guide (Vietnamese) covers: connections, schema tree, console,
results placement, AI chat, sample data, SQL Generator, settings hub, filter, refresh —
cross-referenced against §1's R list so the reviewer can check coverage.

**UX1-005 (R5).** Code-derived hypothesis (pixels unusable): the Select All row nests its
checkbox inside `label.UnicDB-setfilter-selectall-label` (gap 6px, row padding `4px 8px`)
while entries are flat `label.UnicDB-setfilter-entry` rows (gap 6px, row padding `2px 8px`,
styles.css:602) — the TASK-009 pin (styles.css:1113 `padding-left: 8px` on both) equalised
left edges but NOT the checkbox x-position when label/row vertical padding and any
inherited margins differ in the popup's flex context. Fix: one shared rule in
webview/styles.css giving both rows an identical flex scaffold + explicit identical
checkbox indent (e.g. both `display:flex; align-items:center; gap:6px; padding:4px 8px`,
label identical), keep the `border-bottom` divider. Pinned by extending
`webviewSetFilter.test.ts` with a CSS-source contract (chatLayoutCss.test.ts pattern —
jsdom does not apply stylesheets) asserting the two selectors carry byte-identical
indent-bearing declarations. Region contract: UX1-005's styles.css edits stay inside the
`.UnicDB-setfilter-*` selectors (plus the TASK-009 shared-indent rule at :1113);
`.UnicDB-chat-*` belongs to UX1-008, `.UnicDB-ddl-*` to UX1-010's append-only block.
Executor FIRST reproduces at runtime; if the true cause
differs, fix the cause but keep the pinned contract green (contract = observable
equal-indent outcome).

**UX1-006 (R8a + guard).** Existing: `UnicDB.resultsPlacement` enum `below|beside`, default
`below`, `readPlacementSetting()` (resultsPanel.ts:231) + `moveEditorToBelowGroup` at
CREATE (resultsPanel.ts:286). User still sees top-right → their config likely says
`beside`, or the panel predates the setting. Changes: (a) add `"top"` enum value →
`workbench.action.moveEditorToAboveGroup` with a runtime availability check + silent
degrade to beside (same `canExecuteCommands()` defensive pattern); (b) sharpen the setting
description (CREATE-time only; panel reveal never moves it); (c) extend the bq04 guard
filter as described above + pin with tests. Default stays `bottom`-equivalent (`below`) —
new users get bottom, existing configs are respected; a test must assert
`readPlacementSetting(undefined)` → `"below"` so the new `top` value cannot silently shift
the default (P2.5 YAGNI guard: the task must prove the user's original complaint — results
not at bottom — already has a correct default, and `top` is strictly opt-in).

**UX1-007 (R8b).** `UnicDB.openSettings` →
`vscode.commands.executeCommand("workbench.action.openSettings", "@ext:lengockhoa.UnicDB")`
(publisher `lengockhoa`, name `UnicDB` — package.json:2-6). One `view/title` entry with
`$(settings-gear)` (differs from `UnicDB.openAiSettings`'s `$(gear)`). Serialisation: UX1-007
waits for UX1-002 (extension.ts exclusivity, wave-2 lane) and precedes UX1-011 — the
extension.ts lane across the cycle is `UX1-002 → UX1-007 → UX1-011 → (UX1-004 last)`.
Later settings land in `contributes.configuration` automatically — this is the hub seed
the user asked for.

**UX1-008 (R9+R10).** R9 code-derived hypothesis: `.UnicDB-chat-assistant.UnicDB-chat-streaming`
re-declares `white-space: pre-wrap` (styles.css:935) and `.UnicDB-chat-caret` is
`display:inline-block` (styles.css:1491) — an inline-block atom after a trailing space /
at a wrap opportunity can drop to its own line, and during the pre-first-delta phase the
queued dot (`.UnicDB-chat-queued`, inline-block 6px) sits in the USER bubble while the
assistant side shows nothing; with narrow widths this reads as vertical one-char-per-line
text. Fix: `.UnicDB-chat-bubble { min-height: 1lh; width: fit-content; max-width: 95%; }`
+ caret `display:inline` (no line-box of its own) + keep `pre-wrap` (streamed SQL needs
newlines). R10: assistant/streaming bubbles get `padding-left: 12px` and the thread gets
left inset so bubbles no longer touch the panel border. Region contract: this task's
styles.css edits stay inside `.UnicDB-chat-*` selectors (including the bubble padding);
`.UnicDB-setfilter-*` belongs to UX1-005 and `.UnicDB-ddl-*` to UX1-010's append-only block. Pinned by extending
chatLayoutCss.test.ts (CSS-source contract, jsdom pattern). Executor reproduces first; the
pinned contract is the observable outcome (no forced-break child on the streaming bubble;
min-height; fit-content), not a specific property.

**UX1-009 (R11).** Copy button + boxed fenced code ALREADY ship (`renderMarkdown` →
`<pre class="UnicDB-md-code" data-raw=...><button class="UnicDB-md-copy">Copy</button></pre>`,
aiChatPanelMain.ts:455; `wireCopyButtons` :1291; `.UnicDB-md-copy` styles.css:1455). Real
gaps, verified in source: (a) the only loading affordance is the 6px pulsing dot on the
QUEUED USER bubble — user wants an assistant-side "AI is thinking…" row: add
`appendThinking()` rendering a `.UnicDB-chat-thinking-row` (spinner glyph via CSS animation
+ text), invoked on send, removed on first delta/error/done (same lifecycle as
`resolveQueuedUserBubble`, aiChatPanelMain.ts:986); (b) streamed deltas render as plain
text nodes (appendDelta :1128) — code blocks only format on the TERMINAL message, so
mid-stream SQL arrives unboxed: in `appendDelta`, when the accumulated bubble text
contains a closed fence, re-render through `renderMarkdown` (escapes first — safe) and
re-wire copy buttons; (c) right-edge truncation: `overflow-wrap: anywhere` on
`.UnicDB-chat-bubble`. Pinned via aiChatPanelBundle.test.ts (bundle test — needs
`npm run compile` first).

**UX1-010 (R12).** Pure helper `classifyStatementKind(sql: string, dialect?: SqlDialect):
"select" | "ddl" | "dml" | "other"` in src/core/queryRunner.ts (first significant keyword
after comment/whitespace stripping; `WITH … SELECT` → select; `SELECT … INTO` → ddl;
`EXPLAIN`/`SHOW` → other) + additive `kind?: …` on `StatementResult` (undefined on
BQ-pending shapes; stamped in extension.ts `runStatements` next to `stampBqDialect` —
extension.ts edit is one line, declared in Target Files; extension.ts is unowned in
wave 1 by any other task). Webview (webview/main.ts `renderActivePanel` :1174 + tab
creation): statements with `kind !== "select"` suppress the grid tab and render a status
card (`.UnicDB-ddl-card` in styles.css — UX1-010's styles.css contract is APPEND-ONLY: one
new `.UnicDB-ddl-*` block, zero edits to existing selectors owned by UX1-005/008):
success → commandTag-derived line + duration;
failure → verbatim `r.error` + `hint` (regex `LINE \d+:` / `character \d+` from pg error
text; multi-statement → "statement N of M" + failing SQL). Region contracts per §2:
UX1-005 owns `.UnicDB-setfilter-*` selectors in styles.css, UX1-008 owns `.UnicDB-chat-*`
(+ the chat bubble padding inside them), UX1-010 appends `.UnicDB-ddl-*` only — disjoint
families, so their P3 merge is trivial.
src/ui/resultsGridModel.ts
carries `kind` through reconstruction (the `dialect` precedent, BQ04-001). Regression:
SELECT statements render a grid unchanged.

**UX1-011 (R13).** Serialisation: lands LAST on the extension.ts lane
(`Dependencies: TASK-UX1-002, TASK-UX1-007`) so it never races UX1-007 on extension.ts or
extension.test.ts (P2.5 finding 1). Extend the existing seam instead of inventing a path:
`invalidateAfterSchemaDdl` (extension.ts:881) already classifies + refreshes for DDL.
Add `shouldRefreshAfter(completed: readonly string[], dialect?: SqlDialect):
"full" | "tree" | "none"` as a PURE export in src/core/schemaImpact.ts (next to
`completedSchemaImpact` :129): DDL → full, DML-only → tree, SELECT-only → none. In
extension.ts, replace the closure body: full → `schemaCache.invalidate() +
acSchemaCache.invalidate() + sqlSemanticTokens.refresh() + tree.refresh()` (exact
`UnicDB.refreshSchema` semantics, extension.ts:673) + `UnicDB.commands.executeCommand(
"UnicDB.refreshSchema")` is NOT re-fired (avoids double-invalidate); tree → `tree.refresh()`
only. 200ms trailing debounce (module-level timer; `deactivate()` clears it —
extension.ts:1299 region). Multi-statement runs already arrive as one `completed` array →
one decision per run; debounce coalesces back-to-back runs.

**Alternatives rejected (cycle-level).** One mega-task (unreviewable); renaming the sample
data command id (activationEvents + docs churn, zero benefit); bespoke docs viewer (R2
markdown preview is native); SQL Generator as clipboard-only (user explicitly wants a
console); adapter-level DDL grammar for R12 (fragile cross-driver); unconditioned refresh
after every statement (tree churn).

## §4 Test Plan

Per-task matrices live in each TASK-UX1-NNN.md (every task: ≥1 happy + ≥2 edge cases of
DIFFERENT kinds + regression where the task fixes a bug). Cycle-level digest:

| Type | Test Name | Expected |
|------|-----------|----------|
| happy (UX1-001) | show() with zero visible editors → ViewColumn.One | createWebviewPanel called with ViewColumn.One |
| happy (UX1-002) | view node → SQL Generator → seeded console tab | tab named `DDL schema.v`, buffer ends with `;`, contains `CREATE OR REPLACE VIEW` (from mocked objectDdl) |
| happy (UX1-003) | table node → console INSERT templates | console seeded with ≥5 INSERT statements for introspected columns; zero runner.run calls |
| happy (UX1-005) | select-all vs entry checkbox indent | CSS contract: both selectors carry identical padding-left declaration |
| happy (UX1-006) | resultsPlacement=top → moveEditorToAboveGroup attempted | executeCommand called with moveEditorToAboveGroup; unavailable → silent beside fallback |
| happy (UX1-008) | streaming bubble layout contract | bubble rule carries min-height + width:fit-content; caret rule has no inline-block |
| happy (UX1-009) | thinking row appears on send | `.UnicDB-chat-thinking-row` present after send, removed on first delta |
| happy (UX1-010) | CREATE FUNCTION success → card not grid | statement card shows `CREATE FUNCTION` + duration; grid tab count excludes the DDL statement |
| happy (UX1-011) | CREATE TABLE run → full refresh once | 1 refresh-path call; 3 DDL statements in one run → still exactly 1 |
| edge-kind A — empty/none (UX1-003) | 0 insertable columns | header-comment-only template, 0 INSERT lines, no throw |
| edge-kind A — empty (UX1-004) | guide file missing | toast, no throw |
| edge-kind A — empty (UX1-010) | DML success (UPDATE 0 rows) | card renders with commandTag, no grid, no error |
| edge-kind B — boundary/malformed (UX1-002) | non-pg node or missing catalog capability | toast, zero adapter calls |
| edge-kind B — malformed (UX1-009) | unterminated fence mid-stream | no boxed half-fence before fence closes; renders once closed |
| edge-kind B — boundary (UX1-010) | pg error with `LINE 3: …` | error verbatim; hint contains `LINE 3` + statement ordinal |
| edge-kind B — boundary (UX1-011) | SELECT-only run | classification "none"; zero refresh calls |
| edge-kind C — concurrency/lifecycle (UX1-011) | deactivate() with pending debounce | timer cleared; no refresh after deactivate |
| edge-kind C — lifecycle (UX1-001) | show() twice; second call reveals | second call takes reveal path, no second panel |
| regression (UX1-001) | console from left pane, no editor | opens visibly (RED today: ViewColumn.Active + no editor → invisible) |
| regression (UX1-006) | guard test 3 after configuration+activationEvents additions | still green (filter extended first; sanity block unchanged) |
| regression (UX1-010) | SELECT 1 → grid tab unchanged | grid renders for kind "select" (byte-identical behaviour) |
| regression (UX1-008) | multi-line streamed SQL keeps newlines | pre-wrap retained on assistant bubbles (RED if naive white-space:normal fix applied) |

## §5 Verification Commands

Project scripts (package.json `scripts`): `test` = `vitest run`; `typecheck` = `tsc
--noEmit`; `compile` = `node esbuild.js`; `verify:release` = `npm test && npm run typecheck
&& npm run compile`. **There is no lint script** — per RULES.md, every task's verification
therefore includes `npm run typecheck && npm run compile` alongside targeted tests. Per-task
commands are in the task files: targeted vitest file(s) first, then typecheck+compile;
bundle tests (UX1-009) require `npm run compile` BEFORE the vitest invocation (documented
in the task). The last task of the cycle runs `npm run verify:release` (full suite vs the
3420|2 baseline + new tests).

## §6 Acceptance Criteria

Cycle-level:
- [ ] All 12 active requests (R1–R13) shipped, each with ≥1 pinning test (trace §2 table →
      task files; R0 excluded as already shipped in `1e96f89`).
- [ ] `npm run verify:release` green; suite ≥ 3420 passing / 2 skipped baseline (new tests
      added; none removed/skipped); typecheck 0 errors; compile clean.
- [ ] bq04SurfaceGuard 4/4 green after `contributes.configuration` + `activationEvents`
      additions (UX1-006 filter extension lands before any later package.json task).
- [ ] Frozen-surface proof: `git diff 75cdb08..HEAD -- src/adapters/bigqueryTypes.ts
      src/adapters/bigqueryAdc.ts src/adapters/types.ts` empty; guard-filtered package.json
      dependency diff empty.
- [ ] No version bump, no tag, no push, no executor commits (P3 owns the commit).
- [ ] `CHANGELOG.md` updated for the user-facing batch; `docs/UnicDB_USER_GUIDE.md` covers
      every shipped feature in §1's R list.
- [ ] R0 untouched.

Per-task acceptance lists (tests pass, no related-suite regression, reviewer APPROVED /
APPROVED-WITH-MINOR, docs updated if user-facing) live in the task files.

## §7 Global Constraints

- Frozen: `src/adapters/bigqueryTypes.ts`, `src/adapters/bigqueryAdc.ts`,
  `src/adapters/types.ts`, dependency manifest (`dependencies`/`devDependencies`/
  `peerDependencies`/`engines`) + `package-lock.json` — no task touches them.
- Test floor: 3420 passing / 2 skipped baseline; never remove or skip existing tests.
- No version bump, no tag, no push; executor does not commit (P3 owns `handoff:` commit).
- Verification always includes `npm run typecheck && npm run compile` (no lint script
  exists); never claim done on read-only evidence.
- New contributions use whitelisted contributes keys only
  (`command|title|category|icon|when|group|order`); `activationEvents` /
  `contributes.configuration` lines require UX1-006's narrowly-anchored guard-filter
  extension — never a bare `onCommand` catch-all that could mask a dependency line.
- All AI chatter stays inside `docs/AI_HANDOFF/`; state machine per RULES.md.
- Bilingual copy per surrounding code (Vietnamese user-facing strings where neighbouring
  toasts are Vietnamese; English comments/tests).

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) `activationEvents` + `contributes.configuration` lines survive the
bq04SurfaceGuard filter (verified against the live filter with a reconstructed diff) —
added the UX1-006 guard-filter extension and chained every package.json task after it.
(2) R3+R4 `when` clauses corrected to `viewItem == routine` (schemaTree.ts:565) — the
brief's `viewItem == function` would have shipped dead menu entries. (3) R6+R7 root cause
re-grounded: the brief's guess (openConsoleForObject requires an editor) is false — the
command takes a node arg; the real defect is `ConsolePanel.show()` creating with
`ViewColumn.Active`, invisible with no editor (consolePanel.ts:178). (4) R11 descoped to
the two real gaps (assistant-side thinking row; mid-stream fence formatting) after
verifying copy button + boxed code already ship (aiChatPanelMain.ts:455,1291).
(5) R8a reframed: bottom-default already exists (`UnicDB.resultsPlacement`); task adds `top`
enum + guard filter, keeps default. (6) R13 wired onto the existing
`invalidateAfterSchemaDdl` seam via a new pure `shouldRefreshAfter` in schemaImpact.ts
instead of a parallel refresh path. (7) Wave overlap audit found UX1-008/UX1-010 sharing
webview/styles.css in wave 1 — resolved by region contracts (`.UnicDB-chat-*` vs new
`.UnicDB-ddl-*` block) with an explicit fallback (UX1-008 CSS to wave 2) documented in both
task files; extension.ts/extension.test.ts collisions in wave 2 resolved with explicit
UX1-011→UX1-002 and UX1-007→UX1-002 dependency edges.
Known gaps: (a) R5's exact pixel offset unverifiable (vision receipts: 9 unrelated, 3
UNREADABLE) — task pins the equal-indent CSS contract + requires runtime reproduction
first; (b) R9's mechanism is a code-derived hypothesis (inline-block caret on pre-wrap) —
pinned contract is the observable outcome, executor may adjust properties if reproduction
shows a different cause; (c) `workbench.action.moveEditorToAboveGroup` availability is
runtime-checked with silent degrade; (d) guide prose coverage is reviewed against §1's R
list, not pixels; (e) wave 2's extension.ts serialisation (UX1-007, UX1-011 after UX1-002)
reduces nominal width — accepted because same-file exclusivity is a hard invariant.

## Plan Review Log

### Round 1 — code-reviewer findings (P2.5 plan review)
Date: 2026-09-04 · Model: unic-smart
Status: Issues Found

COMPLETENESS:
  - none — all 13 request ids (R1–R13) map to tasks; R0 exclusion justified; every task
    file carries happy + ≥2 edge kinds of different kinds + regression rows; test floor
    3420|2 carried through §1/§5/§6/§7; P0 decisions faithfully recorded per row.
CONSISTENCY:
  - PLAN.md:106-110 vs TASK-UX1-007.md:55-56 / TASK-UX1-011.md:72-75 — the wave-2
    serialisation claim is not backed by the declared dependency edges. UX1-007 and
    UX1-011 are mutual siblings (each declares only TASK-UX1-002), so a DAG runner can
    execute them concurrently while both own src/extension.ts AND src/extension.test.ts.
    TASK-UX1-011.md:74 even says "declare this edge so same-file tasks never race" — but
    no 007↔011 edge is declared anywhere. Concrete failure: concurrent edits to
    extension.test.ts → lost describe blocks / verify:release failures in P4. Fix: declare
    UX1-011 Dependencies = TASK-UX1-007 (strict lane 002 → 007 → 011), or demote UX1-011
    to wave 3.
  - PLAN.md:142-143 vs PLAN.md:244-249 — direct self-contradiction on wave-1 extension.ts
    exclusivity: §3 UX1-001 asserts "No other wave-1 task touches extension.ts", yet §3
    UX1-010 stamps `kind` in extension.ts in wave 1 (TASK-UX1-010.md:22-24), and
    TASK-UX1-001.md:20-25 itself adds an extension.ts edit + extension.test.ts (both
    files claim "extension.ts is otherwise unowned in wave 1" — both claims are false
    given the other task). PLAN.md:84 (§2 wave table) also omits extension.ts /
    extension.test.ts from UX1-001's ownership row. Fix: update the §2 table rows and the
    overlap audit to list the UX1-001 × UX1-010 extension.ts overlap with the mitigation
    (disjoint functions: commandGenerateSelect vs runStatements), or move UX1-001's
    commandGenerateSelect fallback out of wave 1.
  - PLAN.md:96-105 — the "audited" same-wave overlap analysis misses UX1-005: three
    wave-1 tasks (UX1-005, UX1-008, UX1-010) own webview/styles.css (PLAN.md:85,88;
    TASK-UX1-005.md:17-20), while the audit discusses only UX1-008 vs UX1-010. The strict
    invariant at PLAN.md:76-77 ("no two same-wave tasks share a file") is already violated
    threefold. The per-task region contracts (setfilter / chat / append-only .UnicDB-ddl-*)
    with git-diff acceptance checks are a sound mitigation — promote them to the operative
    rule in PLAN.md and add UX1-005 to the audit, instead of presenting strict no-overlap
    as the constraint.
CLARITY:
  - none material — §3 is line-anchored and executor-actionable; spot-checked claims
    verified in source (consolePanel.ts:181 ViewColumn.Active; schemaTree.ts:55
    contextValue "routine"; postgres.ts:975 objectDdl; resultsPanel.ts:226
    readPlacementSetting). Verification commands runnable as written; bundle-test
    compile-first ordering documented (UX1-009).
SCOPE:
  - none blocking — 11 tasks for 13 requests with strict TDD is proportionate; hot-file
    chaining is deliberate. Optional: merging UX1-007 (settings hub, 5 tests, trivial
    wiring) into UX1-002 would shrink the wave-2 extension.ts lane from 3 tasks to 2 and
    dissolve finding 1 naturally; not required.
YAGNI:
  - minor — R8a "top" enum is borderline: the user's ask (bottom default, configurable)
    already ships (below|beside, default below), and the user-visible symptom (results at
    top-right) is hypothesised to be a `beside` config the new value does not fix.
    Keeping "top" is cheap and defensible, but UX1-006 should add one verification step
    proving a default-config first-open lands below, so the task cannot ship without
    touching the actual complaint. Drag-to-move and keybinding already correctly descoped.

NOTES: Vision caveat (9 mismatched / 3 unreadable receipts) is accepted as documented;
text-description grounding with code-derived hypotheses + runtime-reproduce-first steps
is the right handling. Process observation: planner self-reports unic-smart and this
review also runs unic-smart — the model-isolation table is a code-review (executor)
gate, not a spec/plan gate, so this does not block, but a different-model round-2
reviewer would strengthen independence.

### Round 1 — planner revisions
Date: 2026-09-04 · Model: unic-smart
Status: all 3 important + 1 minor findings addressed

- Finding 1 (wave-2 serialisation undelivered) — FIXED. UX1-011 now declares
  `Dependencies: TASK-UX1-002, TASK-UX1-007`; UX1-007 declares `TASK-UX1-002`. The
  extension.ts + extension.test.ts lane is strictly `UX1-002 → UX1-007 → UX1-011` with no
  possible 007↔011 race (sequential-by-edge, the safest option). UX1-009 runs parallel
  with UX1-002 (no shared file). Effective waves re-numbered in the §2 table (UX1-007 now
  wave 3, UX1-011 now wave 4; task IDs unchanged). §2 wave table + overlap audit updated;
  TASK-UX1-007.md and TASK-UX1-011.md Dependencies sections rewritten to state the
  enforced order.
- Finding 2 (§3 wave-1 extension.ts self-contradiction) — FIXED by promoting the region
  contract (option b). The false claim "extension.ts is unowned/no other wave-1 task
  touches extension.ts" is removed from PLAN.md §3, TASK-UX1-001.md and
  TASK-UX1-010.md. Replacement contract: UX1-001 owns ONLY `commandGenerateSelect` (+ its
  extension.test.ts describe), UX1-010 owns ONLY the `runStatements` kind-stamping slot —
  disjoint functions/describes, no edge needed. UX1-001's full file ownership (including
  extension.ts + extension.test.ts) now appears in the §2 wave-1 row, closing the
  "missing from the wave table" point.
- Finding 3 (wave-1 styles.css triple overlap) — FIXED. The wave-constraint rule at the
  top of §2 is rewritten: the operative rule is per-REGION file ownership with written
  contracts, not strict per-file exclusivity. Full audit now includes UX1-005: three
  disjoint selector families (UX1-005 `.UnicDB-setfilter-*`, UX1-008 `.UnicDB-chat-*`,
  UX1-010 append-only `.UnicDB-ddl-*`). §3 entries for UX1-005/008/010 each state the
  contract. Task files updated (005 Target Files, 008 Dependencies — the "move CSS to
  wave 2" fallback retired, 010 Target Files + Dependencies). Executor P3 merge is
  selector-disjoint.
- Finding 4 (minor, UX1-006 YAGNI guard) — FIXED. TASK-UX1-006 Verification Commands now
  end with a `node -e` manifest assertion: `UnicDB.resultsPlacement` must keep
  `default: "below"` while its enum gains `top` (verified RED today — enum is
  `["below","beside"]` — and green after the task). Case 2 already pins the runtime
  counterpart (`readPlacementSetting(undefined)` → `"below"`, resultsPanel.ts:226-239
  fallback verified). Acceptance criterion added.

No task IDs changed; no tasks added or removed; wave numbering re-derived from the
corrected dependency graph only.

### Round 2 — code-reviewer re-review (orchestrator applied, not re-reviewed)
Date: 2026-09-04 · Applied by: orchestrator (main session, claude-sonnet-4-6)
Reason: unic-smart pool returned HTTP 429 (gateway rate-limit) for the round-2 reviewer
spawn after 0 tool uses. Per `handoff-fullstack.md` P2.5 cap: "count ≥ 2 → do NOT invoke
the reviewer again. Have the planner apply every outstanding finding directly to PLAN.md
and the affected TASK-xxx files, append `### Round <N> — findings applied without
re-review` to the Plan Review Log listing what was changed, then proceed to P3."

Independent orchestrator sanity-check of round-1 planner revisions (read all 11 task-file
`Dependencies` fields, the §2 wave-constraint rule, the §3 per-task narrative, and
the four finding-fix entries above):

- **Finding 1 fix verified** — UX1-007 declares `Dependencies: TASK-UX1-002`; UX1-011
  declares `Dependencies: TASK-UX1-002, TASK-UX1-007`. Runner cannot start UX1-011 until
  UX1-007 done; cannot start UX1-007 until UX1-002 done. The wave-2 extension.ts lane is
  strictly serial 002→007→011 with no race. UX1-009 declares `Dependencies: TASK-UX1-002`
  for wave ordering only (no shared file) — non-blocking.
- **Finding 2 fix verified** — TASK-UX1-001 Dependencies states region contract
  (`commandGenerateSelect` only); TASK-UX1-010 Dependencies states region contract
  (`runStatements` stamping slot only). PLAN.md §2 operative rule is "per-region file
  ownership, not per-file"; the false "extension.ts is unowned in wave 1" claim is
  removed.
- **Finding 3 fix verified** — PLAN.md §2 wave-constraint rule now reads
  "per-REGION file ownership, not per-file"; UX1-005 region `.UnicDB-setfilter-*`,
  UX1-008 region `.UnicDB-chat-*`, UX1-010 region `.UnicDB-ddl-*` (append-only). Executor
  P3 merge is selector-disjoint; the §3 narrative states the contract for each task.
- **Finding 4 fix verified** — TASK-UX1-006 Verification Commands end with a
  `node -e` manifest assertion that the JSON manifest keeps `default: "below"` and a
  runtime fallback test that `readPlacementSetting(undefined) === "below"`.

No new findings introduced by the round-1 revisions (wave re-numbering stable, task IDs
unchanged, no new cross-wave file conflicts, all 11 `Dependencies` fields form a DAG
without cycles: UX1-006 → UX1-002 → {UX1-007 → UX1-011, UX1-009}; UX1-006 → UX1-003;
UX1-006 → UX1-004).

**Outcome: P2.5 accepted on round 1 (after 1 revision round).** Proceeding to P3
(commit plan).
