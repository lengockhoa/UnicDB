# TASK-CLEAN2-007 — Deduplicate safe markdown helpers into `webview/markdownSafe.ts`

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (item #12), §3

## Goal

Move the duplicated safe-markdown family from `webview/aiChatPanelMain.ts` and
`webview/aiChatPanelThread.ts` into one webview-local module, preserving the exact
escape-first / controlled-replace security contract, fenced-code `data-raw` Copy contract,
and all element IDs/classes. `renderMarkdown` stays re-exported from aiChatPanelThread for
compatibility, while its tests move to import the canonical module directly.

## Target Files

- `webview/markdownSafe.ts` (new) — export exactly:
  - `export function escapeHtml(s: string): string`
  - `export function renderMarkdown(text: string): string`
  Copy the verified canonical bodies from aiChatPanelThread.ts:42-101, preserving fence
  output exactly: `<pre class="UnicDB-md-code" data-raw="${escapeHtml(f.code)}"><code class="UnicDB-md-code-lang-${escapeHtml(f.lang)}">${f.code}</code><button type="button" class="UnicDB-md-copy">Copy</button></pre>`.
- `webview/aiChatPanelThread.ts` — delete local escapeHtml/renderMarkdown; import
  `escapeHtml`, `renderMarkdown` from `./markdownSafe`; then re-export the local imported
  binding as `export { renderMarkdown };` so current external import compatibility holds;
  leave local `unescapeHtml`/`wireCopyButtons` untouched (out of
  scope, see Discussion). No bubble/card/id/class changes.
- `webview/aiChatPanelMain.ts` — delete local escapeHtml/renderMarkdown; import both from
  `./markdownSafe`; existing usages at :1289/:1369 remain behavior-identical. Leave local
  `unescapeHtml` (:1511)/`wireCopyButtons` (:1522) untouched. Do not touch
  `src/ui/aiChatPanel.ts` engine dispatch or any IDs.
- `webview/__tests__/aiChatPanelThread.test.ts` — replace its `renderMarkdown` import from
  `../aiChatPanelThread` with `../markdownSafe`; all assertions otherwise unchanged.
- `webview/__tests__/markdownSafe.test.ts` (new) — direct contract tests below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `renders the pinned markdown subset` | `**b**`→`<strong>b</strong>`; `` `c` ``→`<code>c</code>`; `## x`→`<h2>x</h2>`; `### y`→`<h3>y</h3>`; ` ```sql\nSELECT 1\n``` ` contains `UnicDB-md-code`, `UnicDB-md-code-lang-sql`, `data-raw="SELECT 1"`, and `UnicDB-md-copy` | new direct module test |
| 2 | edge (XSS/escaping) | `escapeHtml maps all five metacharacters before markdown replacement` | `escapeHtml('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;'`; hostile `**<img src=x onerror=boom>**` yields `<strong>&lt;img src=x onerror=boom&gt;</strong>` (no literal `<img`) | new direct module test |
| 3 | edge (roundtrip/boundary) | `fenced raw code stays recoverable through data-raw` | fence code containing `<>&"'` yields `data-raw="&lt;&gt;&amp;&quot;&#39;"` (exact HTML-escaped attribute order determined by escapeHtml) and trims one trailing fence newline; verified only through `renderMarkdown` output, WITHOUT moving `unescapeHtml` | new direct module test |
| 4 | regression | existing aiChatPanelThread markdown cases | existing :360-367 tests pass with exactly one import-path change; pinned escaped bold/fenced-Copy assertions unchanged | existing test |
| 5 | regression (bundle) | main panel usage and build | `src/ui/__tests__/aiChatPanel.test.ts` passes; `npm run compile` exits 0, proving esbuild resolves the new bundled import | existing suite + compile |

## Test Files

- `webview/__tests__/markdownSafe.test.ts` (new) — direct happy/edge/roundtrip contract tests.
- `webview/__tests__/aiChatPanelThread.test.ts` — update import path only; contains
  regression cases at :360-367.
- `src/ui/__tests__/aiChatPanel.test.ts` — mapped regression suite for
  `webview/aiChatPanelMain.ts`, MUST NOT be modified (tests-map.json verified).

## Verification Commands

```bash
npx vitest run webview/__tests__/markdownSafe.test.ts webview/__tests__/aiChatPanelThread.test.ts src/ui/__tests__/aiChatPanel.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `markdownSafe.ts` (new) exports exactly the two named function signatures above;
      both consumers import them; thread re-exports `renderMarkdown` for compatibility.
- [ ] No duplicate local `function escapeHtml` or `function renderMarkdown` remains in
      either consumer (grep returns 0 per function/file); local `unescapeHtml` is unchanged.
- [ ] All §Test Cases pass, including the five-char escape mapping, hostile text, and
      data-raw recoverability; existing pinned test assertions change only in import path.
- [ ] `npm run typecheck` and `npm run compile` exit 0; focused three-file vitest command
      exits 0.
- [ ] `src/ui/aiChatPanel.ts` untouched; no element IDs/classes renamed/removed; no
      credentials or dangerous flags added to any wire frame.
- [ ] lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: existing main uses `renderMarkdown(text: string): string` for assistant bubbles
  and `escapeHtml(s: string): string` for plain text; existing per-consumer
  `wireCopyButtons(rootEl: HTMLElement): void` keeps consuming its local
  `unescapeHtml(s: string): string`.
- Produces: `escapeHtml(s: string): string` and `renderMarkdown(text: string): string` from
  `webview/markdownSafe.ts`; compatibility re-export `renderMarkdown` from
  `webview/aiChatPanelThread.ts` remains available.

---

## Discussion

### 2026-09-08 · planner · unic-smart
Canonical source is thread.ts:42-101; main's `renderMarkdown` output is verified identical
(including `data-raw` output) despite more detailed inline comments. No esbuild config edit:
esbuild.js already bundles `webview/aiChatPanelMain.ts` as an entry point and resolves local
imports. Do not move wireCopyButtons. Although `unescapeHtml` is also duplicated (thread
:106-113; main :1511), leave it untouched: the caller fixed scope to the named
renderMarkdown/escapeHtml pair (12 items exactly); queue inverse-helper dedup separately.
