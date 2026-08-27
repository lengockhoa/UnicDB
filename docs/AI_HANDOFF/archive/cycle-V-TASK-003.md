# TASK-003 — Webview SQL tokenizer + themed styles

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Coloring, Layer 3)

## Goal

Colorize SQL inside VSDB's own webviews, which no TextMate grammar or semantic-token
provider can reach: the Results panel's Messages tab (`r.sql` rendered flat at
`webview/main.ts:2758-2761`) and the AI chat's fenced ```` ```sql ```` block
(`webview/aiChatPanelMain.ts:139`). Ship a dependency-free pure tokenizer that emits a
`DocumentFragment` of `<span>`s, never an HTML string.

## Target Files

- `webview/sqlHighlight.ts` **(new)** — `tokenizeSql` + `highlightSql`. Pure, no imports
  from `vscode`, `ag-grid-community`, or `src/`.
- `webview/aiChatPanelMain.ts` — in `renderMarkdown` (line 134) the fenced-code branch
  (line 139) currently returns an HTML string. Keep the string path for non-SQL langs, but
  mark SQL blocks so the caller at line 262 (`div.innerHTML = markdown ? renderMarkdown(text) : …`)
  can post-process: after assigning, query `code.vsdb-md-code-lang-sql` nodes and replace
  each one's children with `highlightSql(node.textContent ?? "")`. Reading `textContent`
  from an already-escaped node and writing back via a fragment keeps the existing
  no-`innerHTML`-for-user-content contract intact.
- `webview/main.ts` — `renderMessagesInto` (line 2744): replace
  `sql.textContent = r.sql;` (line 2760) with `sql.appendChild(highlightSql(r.sql));`.
  This is the only edit to this file in this task. **Wave-1 only** — TASK-005 edits the
  same file in wave 2 and must re-read it.
- `webview/styles.css` — add `.vsdb-sql-tok-*` rules keyed off `--vscode-*` theme
  variables so colors track the user's theme.
- `src/ui/__tests__/sqlHighlight.test.ts` **(new)** — cases 1-7.
- `src/ui/__tests__/webviewSqlHighlight.test.ts` **(new)** — case 8 (bundle integration).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `tokenizes keywords, identifiers, numbers` | `tokenizeSql("SELECT 1 FROM t")` → kinds `["keyword","number","keyword","ident"]` (whitespace skipped or emitted as `ws`, asserted explicitly either way) | none |
| 2 | unit (happy) | `string literal and line comment are single tokens` | `SELECT 'a b' -- c` → one `string` token with text `'a b'`, one `comment` token with text `-- c` | none |
| 3 | unit (happy) | `highlightSql returns a fragment whose textContent round-trips` | `frag.textContent === input` for a 5-statement sample | verifies no character is dropped or duplicated |
| 4 | edge (injection) | `hostile SQL never becomes live markup` | input `SELECT '<img src=x onerror=alert(1)>'` → `frag.querySelectorAll("img").length === 0`; `frag.textContent` contains the literal `<img` | jsdom |
| 5 | edge (unterminated literal) | `unterminated string terminates and does not hang` | `SELECT 'abc` returns in < 50 ms; the tail is one `string` token `'abc` | asserted with an explicit elapsed-time bound |
| 6 | edge (empty + whitespace-only) | `empty input yields an empty fragment` | `highlightSql("")` → `childNodes.length === 0`; `highlightSql("   ")` → `textContent === "   "` | boundary |
| 7 | edge (dialect quoting) | `bracket and backtick identifiers are one ident token each` | `SELECT [a b], \`c d\` FROM t` → `[a b]` and `` `c d` `` each a single `ident` token | mssql/mysql quoting |
| 8 | integration (bundle) | `Messages tab renders colorized SQL` | after a `state` message with `status:"error"`, `pre.vsdb-msg-sql` contains ≥ 1 `span.vsdb-sql-tok-keyword` and its `textContent` equals the original SQL | loads `dist/webview.js` in jsdom — mirror the skip-if-missing guard in `src/ui/__tests__/webviewSetFilter.test.ts:15-16` |

Kinds: happy (1-3), security (4), malformed-input/hang (5), empty boundary (6),
dialect-lexical (7), end-to-end wiring (8).

## Test Files

- `src/ui/__tests__/sqlHighlight.test.ts` — cases 1-7 (`// @vitest-environment jsdom`;
  cases 1-2 are pure and need no DOM but keep one file for cohesion).
- `src/ui/__tests__/webviewSqlHighlight.test.ts` **(new)** — case 8. Copy the bundle-load
  harness from `src/ui/__tests__/webviewSetFilter.test.ts` (ResizeObserver / matchMedia
  stubs, `acquireVsCodeApi` stub, skip when `dist/webview.js` is missing).

## Verification Commands

```bash
npm run typecheck
npx tsc -p tsconfig.webview.json --noEmit
npm run compile
npx vitest run src/ui/__tests__/sqlHighlight.test.ts src/ui/__tests__/webviewSqlHighlight.test.ts
npm test
```

`npm run compile` MUST run before the vitest line — case 8 loads `dist/webview.js` and
silently skips if it is stale or absent.

Webview tsc gate — **snapshot diff, not "no new filename"**. `tsconfig.webview.json` has 61
pre-existing errors across six files (mostly `TS2393`/`TS2451` shared-global-scope
redeclarations, plus `TS2339`/`TS2304`/`TS2678` and others), and `webview/aiChatPanelMain.ts`
(10 of them) is one of the files this task edits, so a filename-based check would pass no
matter what this task breaks. Per PLAN.md §5, capture per-file counts before and after and
require an empty diff:

```bash
npx tsc -p tsconfig.webview.json --noEmit 2>&1 \
  | grep -oE '^[a-zA-Z0-9_/.-]+\.ts' | sort | uniq -c | sort -rn > /tmp/vsdb-webview-tsc-before.txt
# ... make the edits ...
npx tsc -p tsconfig.webview.json --noEmit 2>&1 \
  | grep -oE '^[a-zA-Z0-9_/.-]+\.ts' | sort | uniq -c | sort -rn > /tmp/vsdb-webview-tsc-after.txt
diff /tmp/vsdb-webview-tsc-before.txt /tmp/vsdb-webview-tsc-after.txt && echo "WEBVIEW TSC BASELINE UNCHANGED"
```

Note `webview/sqlHighlight.ts` is a **new** file: it must contribute **zero** errors, i.e.
it must not appear in the after-snapshot at all. Do not fix the 61 baseline errors. Paste
the diff result into the Executor Report.

## Acceptance Criteria

- [ ] `webview/sqlHighlight.ts` exists and uses no `innerHTML`. Gate (exits 0 on success;
      bare `grep -c` exits 1 on zero matches and would fail a `set -e` script):
      `! grep -q innerHTML webview/sqlHighlight.ts`
- [ ] `webview/main.ts:2760`'s `sql.textContent = r.sql` is replaced by an `appendChild`
      of the fragment; no other line in that file is changed by this task.
- [ ] AI-chat SQL code blocks contain `span.vsdb-sql-tok-*` children after render.
- [ ] `webview/styles.css` new rules reference only `var(--vscode-…)` colors — no hardcoded
      hex values (so light/dark/high-contrast themes all work).
- [ ] All 8 Test Cases PASS.
- [ ] `npm run typecheck` clean; webview tsc snapshot diff empty ("WEBVIEW TSC BASELINE
      UNCHANGED") and `webview/sqlHighlight.ts` absent from the after-snapshot;
      `npm run compile` writes
      all 7 bundles without error; `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none) — the tokenizer is self-contained by design; it must not import from
  `src/`, because `webview/aiChatPanelMain.ts` is bundled standalone by esbuild
  (`esbuild.js` `aiChatPanelConfig`) and pulling in host code would bloat it.
- Produces (exact signatures TASK-005 and future webview work may reuse):
  ```ts
  export type SqlTokenKind =
    | "keyword" | "string" | "number" | "comment" | "ident" | "punct" | "ws";
  export interface SqlToken { kind: SqlTokenKind; text: string; start: number; end: number; }
  export function tokenizeSql(sql: string): SqlToken[];
  export function highlightSql(sql: string): DocumentFragment;
  ```
  CSS class per token: `vsdb-sql-tok-<kind>`.

---

## Discussion

### 2026-08-25 · planner · bao-opus

The AI-chat path is the delicate one. `renderMarkdown` escapes user text *first*
(`escapeHtml` at `webview/aiChatPanelMain.ts:102`) and the file's security contract —
spelled out in `src/ui/__tests__/aiChatPanelWebview.test.ts:1-13` — is that hostile agent
output never reaches the page as live nodes. The post-process approach here reads
`textContent` off an already-escaped `<code>` node and writes back a fragment built with
`createElement`/`textContent`, so no new sink is introduced. Do **not** restructure
`renderMarkdown` to emit token markup inside the HTML string; that would create one.

Case 5 exists because a hand-rolled lexer's classic failure is a `while` that never
advances on an unterminated quote. Note `webview/main.ts` is also edited in wave 2 by
TASK-005 — this task's edit is deliberately a one-line swap to keep the later merge trivial.

→ @executor: keep `tokenizeSql` dialect-agnostic (accept `"`, `` ` ``, and `[…]` quoting
all at once). The webview does not know which driver is active at render time.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (before implementation — `npx vitest run src/ui/__tests__/sqlHighlight.test.ts src/ui/__tests__/webviewSqlHighlight.test.ts`, module target absent + dist absent):

```
 ❯ src/ui/__tests__/sqlHighlight.test.ts  (0 test)
 ↓ src/ui/__tests__/webviewSqlHighlight.test.ts  (1 test | 1 skipped)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ui/__tests__/sqlHighlight.test.ts [ src/ui/__tests__/sqlHighlight.test.ts ]
Error: Failed to resolve import "../../../webview/sqlHighlight" from "src/ui/__tests__/sqlHighlight.test.ts". Does the file exist?
 ❯ TransformPluginContext._formatError node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:49258:41
 ...

 Test Files  1 failed | 1 skipped (2)
      Tests  1 skipped (1)
```

Expected RED for a new module (test target not yet implemented); webviewSqlHighlight case 8 skipped per its skip-if-missing guard (dist/webview.js absent at that point). Not a false GREEN.

Verification Output (all §Verification Commands run in the worktree after implementation):

```
$ npm run typecheck
> tsc --noEmit          → exit 0 (clean)

$ npx tsc -p tsconfig.webview.json --noEmit   (AFTER snapshot, 5 files / 40 raw errors)
  14 webview/main.ts
  10 webview/connectionFormMain.ts
  10 webview/aiSettingsFormMain.ts
   5 webview/schemaFormMain.ts
   1 webview/newTableFormMain.ts

$ diff /tmp/vsdb-webview-tsc-before.txt /tmp/vsdb-webview-tsc-after.txt
1d0
<   21 webview/aiSettingsFormMain.ts
4c3
<   10 webview/aiChatPanelMain.ts
---
>   10 webview/aiSettingsFormMain.ts
# => diff shows ONLY reductions (61 → 40), zero additions, and
#    webview/sqlHighlight.ts is absent from the after-snapshot (0 errors).

$ npm run compile
⚡ Done in 141ms
esbuild: build complete          # all 7 bundles (extension/webview/connectionForm/newTableForm/aiSettingsForm/aiChatPanel/schemaForm)

$ npx vitest run src/ui/__tests__/sqlHighlight.test.ts src/ui/__tests__/webviewSqlHighlight.test.ts
 ✓ src/ui/__tests__/sqlHighlight.test.ts  (8 tests) 9ms
 ✓ src/ui/__tests__/webviewSqlHighlight.test.ts  (1 test) 45ms
 Test Files  2 passed (2)
      Tests  9 passed (9)

$ npm test
 Test Files  97 passed | 1 skipped (98)
      Tests  1336 passed | 2 skipped (1338)     # baseline 1327 + 9 new, 0 failed
```

Acceptance gates re-verified: `grep -q innerHTML webview/sqlHighlight.ts` → no match (PASS); new `styles.css` `.vsdb-sql-tok-*` rules reference only `var(--vscode-…)`, no hex; AI-chat ```sql block renders `span.vsdb-sql-tok-keyword` children (manual jsdom check on the bundled aiChatPanel — 3 keyword spans, no `<script>`/`<img>` injection).

Status: PASS

Note:
1. **Webview tsc snapshot is NOT literally empty — only error reductions.** Adding the required `import { highlightSql }` to `webview/aiChatPanelMain.ts` turns that file into a module, which resolves its 10 global-scope `TS2393/TS2451` redeclarations AND 11 cross-file conflicts they caused in `aiSettingsFormMain.ts`. Total 61 → 40 raw errors. No new errors, no new filenames; `webview/sqlHighlight.ts` contributes zero (absent from after-snapshot). The diff-based gate is a false-negative here (it flags improvements too) — the orchestrator's "assert the diff adds none" holds.
2. `webview/main.ts` change = import line + the one-line `sql.textContent = r.sql` → `sql.appendChild(highlightSql(r.sql))` swap; nothing else.
3. `webview/sqlHighlight.ts` is bundled into both `dist/webview.js` and `dist/aiChatPanel.js` by esbuild (dependency-free).
4. **Required harness fix** (consequence of this task's own edit, otherwise `npm test` regresses): `src/ui/__tests__/aiChatPanelWebview.test.ts` compiled `aiChatPanelMain.ts` standalone via esbuild stdin, which broke once that file gained a relative import (`Could not resolve ./sqlHighlight` → leaked `require`). Changed it to bundle the real file on disk (`--bundle`, no `--outfile` → stdout). 27/27 still pass.
5. Task file's literal snapshot-diff gate (`diff ... && echo "WEBVIEW TSC BASELINE UNCHANGED"`) will NOT echo the string because of the reductions above; intent (no new errors) is satisfied. Flagged for the reviewer.

NEXT: ready for review.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: "npm run typecheck && npx vitest run src/ui/__tests__/sqlHighlight.test.ts src/ui/__tests__/webviewSqlHighlight.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts && npx tsc -p tsconfig.webview.json --noEmit 2>&1 | grep -oE '^[a-zA-Z0-9_./-]+\\.ts' | sort | uniq -c | sort -rn"
  result: typecheck clean; 3 test files 36/36 pass; webview tsc 40 errors in 5 files (baseline 61 in 6; reductions only, zero additions; sqlHighlight.ts absent)
FINDINGS:
  critical: none
  important: none
  minor:
    - docs/AI_HANDOFF/tasks/TASK-003.md:104-105 — task acceptance criteria says the webview tsc diff should echo "WEBVIEW TSC BASELINE UNCHANGED" but reductions cause diff output; intent (no new errors) is met. File the acceptance-criteria text for future tasks.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: All 8 test cases verified with real assertions. highlightSql builds fragments via createElement+textContent (no innerHTML). XSS safety confirmed. aiChatPanelMain post-process reads textContent from escaped nodes, writes back via replaceChildren. Tokenizer covers all edge cases (unterminated strings, bracket/backtick idents, empty input). The minor CSS finding on comment color (operatorForeground) is a design choice, not a defect.
