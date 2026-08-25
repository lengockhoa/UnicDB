# TASK-002 — Schema-aware SQL semantic tokens provider

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Coloring, Layer 2)

## Goal

Add a `DocumentSemanticTokensProvider` for `.sql` files that colors identifiers by what
they *are* on the live connection — schema / table / column — by reading the already
shipped `SchemaCache`. This is the DataGrip-like half of the coloring work: TextMate can
only match regexes, it cannot know `users` is a real table.

## Target Files

- `src/ui/sqlSemanticTokens.ts` **(new)** — `SQL_SEMANTIC_LEGEND` +
  `class SqlSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider`,
  including the `onDidChangeSemanticTokens` event and a `refresh()` method (see
  *Cold-cache refresh* below).
- `src/extension.ts` — register the provider next to the existing
  `SqlCompletionProvider` registration (currently `src/extension.ts:142-156`). The
  `schemaCache` instance already exists there (`src/extension.ts:132`) — reuse it, do not
  construct a second cache. Also call the provider's `refresh()` from the two places that
  already invalidate the cache: the `mgr.onDidChangeActive` subscription
  (`src/extension.ts:141`) and the `vsdb.refreshSchema` command handler
  (`src/extension.ts:233-237`).
- `src/ui/__tests__/sqlSemanticTokens.test.ts` **(new)** — tests below.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `known table is tokenized as class` | exactly one token whose range covers `users` and whose type index is `legend.tokenTypes.indexOf("class")` | cache stubbed with `listTables → [{name:"users",schema:"public"}]`; doc `SELECT * FROM users` |
| 2 | unit (happy) | `known column is tokenized as property` | token for `email` typed `property` | `listColumns → [{name:"email",...}]`; doc `SELECT email FROM users` |
| 3 | unit (happy) | `known schema is tokenized as namespace` | token for `public` typed `namespace` | `listSchemas → [{name:"public"}]`; doc `SELECT * FROM public.users` |
| 4 | edge (no connection) | `no active connection returns zero tokens without throwing` | resolved value's `data.length === 0`; no throw | provider built with `hasConnection: () => false` |
| 5 | edge (adapter failure) | `adapter provider rejecting resolves to empty tokens` | resolves (not rejects); `data.length === 0` | `SchemaCache` built over a provider that throws |
| 6 | edge (unknown identifier) | `identifier not in the schema emits no token` | zero tokens for doc `SELECT * FROM not_a_table` | cache has only `users` — TextMate coloring must show through untouched |
| 7 | edge (masked text) | `identifier inside a string literal or comment is not tokenized` | `SELECT 'users' -- users` → zero tokens | reuse `maskLiteralsAndComments` from `src/core/dangerousStatement.ts:89` rather than re-implementing |
| 8 | edge (registration guard) | `activate() does not throw when the API is absent` | `activate` completes with a `vscode.languages` mock lacking `registerDocumentSemanticTokensProvider` | mirrors the partial mock in `src/extension.test.ts:159-164` |
| 9 | edge (cold cache → stale coloring) | `first call on a cold cache emits nothing, then refresh() fires onDidChangeSemanticTokens` | call 1 (adapter's `listTables` still pending) resolves with `data.length === 0`; after the adapter settles and `refresh()` is called, the `onDidChangeSemanticTokens` listener has fired **exactly once**; a second `provideDocumentSemanticTokens` then returns the `users` token typed `class` | provider built over a `SchemaCache` whose adapter resolves on a manually released deferred; listener registered via `provider.onDidChangeSemanticTokens(spy)` before call 1 |
| 10 | edge (event storm) | `refresh() called 3x fires the event 3x and never throws with zero listeners` | with no listener attached, 3 `refresh()` calls do not throw; with one listener attached, 3 calls → 3 firings (the provider must not swallow or coalesce — VS Code debounces re-requests itself) | fresh provider; `SQL_SEMANTIC_LEGEND` unchanged between firings |

Kinds covered: happy (1-3), missing-precondition (4), dependency-failure (5),
negative-match (6), lexical-context (7), host-capability (8), async-readiness /
first-paint staleness (9), event-lifecycle (10).

## Test Files

- `src/ui/__tests__/sqlSemanticTokens.test.ts` — cases 1-7, 9, 10. Follow the
  `vi.mock("vscode", …)` pattern already used by
  `src/ui/__tests__/sqlCompletionProvider.test.ts:7-26`; the mock must additionally provide
  `SemanticTokensLegend`, `SemanticTokensBuilder` (a minimal
  `push(line, char, length, type)` recorder + `build()`), `Position`, `Range`, and
  `EventEmitter` (a minimal `{ event, fire, dispose }` recorder — cases 9 and 10 assert on
  its firings).
- `src/extension.test.ts` — **modify**, add case 8 only. This file is not a Target File of
  any other task in this wave, so there is no collision.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/sqlSemanticTokens.test.ts src/extension.test.ts
npm test
```

## Acceptance Criteria

- [ ] `src/ui/sqlSemanticTokens.ts` exports `SQL_SEMANTIC_LEGEND` and
      `SqlSemanticTokensProvider`.
- [ ] Registration in `src/extension.ts` is wrapped in
      `if (typeof vscode.languages.registerDocumentSemanticTokensProvider === "function")`
      and pushed onto the same `disposables` array as the completion provider.
- [ ] Selector is `{ scheme: "file", language: "sql" }` — matches the existing CodeLens /
      completion selectors at `src/extension.ts:120` and `:151`.
- [ ] The provider never throws and never rejects; every failure path resolves to an empty
      token set.
- [ ] `SqlSemanticTokensProvider` exposes
      `readonly onDidChangeSemanticTokens: vscode.Event<void>` and a public `refresh(): void`
      that fires it, plus `dispose()` disposing the underlying `EventEmitter`.
- [ ] `src/extension.ts` calls `refresh()` from **both** cache-invalidation sites —
      `mgr.onDidChangeActive` (`:141`) and the `vsdb.refreshSchema` handler (`:233-237`) —
      and pushes the provider onto `disposables` so its emitter is released on deactivate.
- [ ] All 10 Test Cases PASS.
- [ ] `npm run typecheck` clean; `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — independent of TASK-001. Semantic tokens layer over whatever TextMate grammar
  is active; they do not require VSDB's injection grammar to exist.

## Interfaces

- Consumes (both already exist at HEAD, do not redefine):
  - `class SchemaCache` — `src/ui/schemaCache.ts:42`. Methods used:
    `getSchemas(): Promise<SchemaInfo[]>`, `getTables(schema?: string): Promise<TableInfo[]>`,
    `getColumns(table: string, schema?: string): Promise<ColumnInfo[]>`, `invalidate(): void`.
  - `maskLiteralsAndComments(sql: string, dialect?: SqlDialect): string` —
    `src/core/dangerousStatement.ts:89`. Blanks literals/comments in place, preserving
    offsets, so token ranges stay correct.
- Produces:
  - `export const SQL_SEMANTIC_LEGEND: vscode.SemanticTokensLegend` with
    `tokenTypes = ["namespace", "class", "property", "keyword"]` and `tokenModifiers = []`.
  - `export class SqlSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider`
    with constructor `(deps: { cache: SchemaCache; hasConnection?: () => boolean })` — the
    same dependency shape as `SqlCompletionProvider` (`src/ui/sqlCompletionProvider.ts:31-37`)
    — and:
    ```ts
    readonly onDidChangeSemanticTokens: vscode.Event<void>;
    refresh(): void;   // fires the event; safe with zero listeners
    dispose(): void;   // disposes the backing EventEmitter
    ```

---

## Discussion

### 2026-08-25 · planner · bao-opus

`@types/vscode` is pinned at `1.75.0` and does export `SemanticTokensLegend` /
`SemanticTokensBuilder` (verified in `node_modules/@types/vscode/index.d.ts:3852,3869`),
so no engine bump is needed.

`SchemaCache.getColumns` needs a table name. For `SELECT email FROM users` the provider
must first resolve the FROM target, then ask for that table's columns — do not fan out
`getColumns` across every cached table on every keystroke (60 s TTL or not, that is an
N-query storm on a large schema). If the FROM target cannot be resolved, emit table and
schema tokens only and skip columns; that degradation is acceptable and case 6 already
asserts silence is safe.

→ @executor: `provideDocumentSemanticTokens` is called on nearly every edit. Keep it
allocation-light and never `await` anything but the cache.

**Cold-cache refresh (plan review R1, finding 2).** `SchemaCache` is asynchronous and
starts empty: `getTables()` on a cold cache calls `resolveAdapter()` and awaits a live
round trip (`src/ui/schemaCache.ts:75-101`), and with no adapter yet it returns
`this.stale(existing) ?? []` — i.e. an empty array. VS Code asks for semantic tokens
**once** when a document opens and then only on document change or on an explicit
`onDidChangeSemanticTokens` signal. So without that event the very first open of a `.sql`
file paints with an empty schema and stays uncolored until the user types — the exact
symptom this task exists to remove.

Required shape:

- Own a `vscode.EventEmitter<void>`; expose its `.event` as `onDidChangeSemanticTokens`
  (the optional member of `vscode.DocumentSemanticTokensProvider` — VS Code re-requests
  tokens for all visible SQL documents when it fires).
- `refresh()` just calls `emitter.fire()`. It must be safe with zero listeners and must
  not coalesce (case 10) — VS Code does its own debouncing, and swallowing a fire can lose
  the only signal.
- Call `refresh()` wherever the cache becomes newly-valid. Two sites already exist and
  need no new plumbing: `mgr.onDidChangeActive` at `src/extension.ts:141` (currently
  `() => schemaCache.invalidate()`) and the `vsdb.refreshSchema` command at
  `src/extension.ts:233-237`. Extend both to also call `provider.refresh()`.
- Additionally, when `provideDocumentSemanticTokens` runs against a **cold** cache — the
  awaited lookup returned empty *and* `hasConnection()` is true — schedule one `refresh()`
  after the in-flight cache promise settles. Guard it with a per-provider "already
  scheduled" boolean so a burst of keystrokes cannot produce a fire-per-edit loop: fire →
  re-request → still cold → fire again is an infinite cycle, and the boolean is what
  breaks it. Never fire from inside the provide call synchronously.
- Push the provider onto `disposables` so the emitter is disposed on deactivate.

This does not change the "never throw, always resolve" contract: a cold cache still
resolves to zero tokens (case 4 unchanged), it just gets a second chance once data lands.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
SUMMARY: Added SqlSemanticTokensProvider (.sql semantic coloring by live
  schema/table/column via SchemaCache), wired registration + refresh() into
  extension.ts, and shipped 10 TDD test cases (9 unit + 1 registration guard).
TEST_PLAN_FOLLOWED: task §Test Cases (#1-#10)
FILES_CHANGED:
  - src/ui/sqlSemanticTokens.ts: new — SQL_SEMANTIC_LEGEND + provider
    (onDidChangeSemanticTokens EventEmitter, provideDocumentSemanticTokens,
    refresh(), dispose(), cold-cache refresh scheduling).
  - src/extension.ts: import provider; construct next to SchemaCache; guard
    registerDocumentSemanticTokensProvider; push provider onto disposables;
    refresh() from mgr.onDidChangeActive + vsdb.refreshSchema.
  - src/ui/__tests__/sqlSemanticTokens.test.ts: new — cases #1-#7,#9,#10.
  - src/extension.test.ts: case #8 (registration guard) added.
TESTS_ADDED:
  - src/ui/__tests__/sqlSemanticTokens.test.ts: #1-#7,#9,#10.
  - src/extension.test.ts: TASK-002 #8 activate() không throw khi API vắng mặt.
VERIFICATION:
  command: npx vitest run src/ui/__tests__/sqlSemanticTokens.test.ts src/extension.test.ts && npm run typecheck && npm test
  result: semantic tests 9/9 pass; extension tests 60/60 pass; typecheck clean; full npm test 1337 passed, 0 failed (2 skipped)
  output_excerpt: |
    Test Files  96 passed | 1 skipped (97)
    Tests  1337 passed | 2 skipped (1339)
RED_OUTPUT (module missing, pre-implementation):
    FAIL src/ui/__tests__/sqlSemanticTokens.test.ts
    Error: Failed to load url ../sqlSemanticTokens ... Does the file exist?
    Test Files  1 failed (1) / Tests no tests
ISSUES: none
HANDOFF_TO_REVIEWER: yes — provider is a new shared-runtime surface
NEXT: ready for review
```

**Design decisions (recorded per Handoff mode):**
- `provideDocumentSemanticTokens` keeps `vscode`'s `(document, token)` arity; the
  legend is the module constant `SQL_SEMANTIC_LEGEND` (fixed at registration), so no
  legend parameter is threaded through. Tests pass the legend arg harmlessly (ignored).
- Cold cache: `Promise.race` with a 50 ms timeout. Timeout wins → empty token set +
  one auto-`refresh()` when the in-flight lookup settles, guarded by a per-provider
  `coldRefreshScheduled` boolean (breaks the fire-per-edit loop; never fires
  synchronously inside provide).
- Column resolution: only the LAST `FROM` target's columns are fetched (schema-qualified
  `public.users` handled); unresolvable FROM → schema/table tokens only, no N-query storm.
- `npm run compile` was run once because `dist/` was absent in this clean worktree
  (pre-existing test `schemaFormBundlePresent` needs it); after that full suite is green.
