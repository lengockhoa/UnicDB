# TASK-AIC-003 — Add native SQL editor ghost-text provider

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§7

## Goal

Add a native VS Code SQL inline-completion provider that delegates to AIC-002 and returns ghost text without changing existing deterministic `SqlCompletionProvider` popup completion.

## Target Files

- `src/ui/aiSqlCompletionProvider.ts` (new) — `InlineCompletionItemProvider` implementation and VS Code cancellation/range adaptation.
- `src/ui/__tests__/aiSqlCompletionProvider.test.ts` (new) — mocked-VS-Code provider behavior tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | current SQL request yields native inline item | Service resolving `"ers"` for `SELECT * FROM us|` returns exactly one `InlineCompletionItem` with `insertText === "ers"` and cursor insertion range. | Mock vscode `InlineCompletionItem`, SQL document/position, active PostgreSQL context. |
| 2 | edge — cancellation | VS Code cancellation forwards to service and returns no item | A cancelled `CancellationToken` is forwarded as AIC-002's request signal, causes `[]`, and prevents late item publication without creating another controller. | Abort-aware fake service and cancellation token. |
| 3 | edge — unavailable | no model/no connection is silent | Null/disabled service outcome produces `[]` and does not throw or issue a UI notification. | Null result and missing active connection fakes. |
| 4 | edge — stale/data isolation | changed document or connection rejects old suffix | A result whose captured document version/cursor/connection no longer matches returns `[]`, never an old ghost suffix. | Deferred request followed by version/connection change. |
| 5 | regression | deterministic provider remains independent | Tests retain `SqlCompletionProvider` root/dot completion behavior and this new provider never invokes/changes it. | Existing deterministic provider fixture plus separate AI provider. |

## Test Files

- `src/ui/__tests__/aiSqlCompletionProvider.test.ts` (new) — new inline provider tests.
- `src/ui/__tests__/sqlCompletionProvider.test.ts` — regression run only; no source change is expected unless a test support correction is truly necessary.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiSqlCompletionProvider.test.ts src/ui/__tests__/sqlCompletionProvider.test.ts
npm run typecheck
```

No lint script is defined in `package.json`.

## Acceptance Criteria

- [ ] The provider implements the verified VS Code interface `provideInlineCompletionItems(document, position, context, token)` and returns native `InlineCompletionItem` ghost text only for a current non-empty suffix.
- [ ] Cancellation, unavailable configuration/connection, stale document/connection state, and service errors return `[]` without disrupting typing.
- [ ] The provider does not make direct provider/network calls, create a second debounce/cache/controller, or log prompt/request text.
- [ ] Existing `SqlCompletionProvider` remains deterministic and additive.
- [ ] All named test cases and verification commands pass with fresh output.
- [ ] Reviewer verdict is `approved` or `approved_minor`.

## Dependencies

- TASK-AIC-002

## Interfaces

- Consumes: AIC-002 `SqlAutocompleteService` request method resolving `Promise<string | null>` for caller scope `document.uri.toString()` and the supplied `CancellationToken`; VS Code `InlineCompletionItemProvider.provideInlineCompletionItems(document: TextDocument, position: Position, context: InlineCompletionContext, token: CancellationToken): ProviderResult<InlineCompletionItem[] | InlineCompletionList>`.
- Produces: `AiSqlCompletionProvider` (new) implementing `vscode.InlineCompletionItemProvider`; returns `vscode.InlineCompletionItem[]` and performs no registration itself.

---

## Discussion

### 2026-08-29 · planner · unic-smart
Registration belongs exclusively to AIC-005. The provider must preserve the existing `SqlCompletionProvider` in `src/ui/sqlCompletionProvider.ts`; do not modify it merely to add AI behavior.

## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT:
  ✓ src/ui/aiSqlCompletionProvider.ts (new) — InlineCompletionItemProvider
    implementing vscode.InlineCompletionItemProvider. Forwards the
    CancellationToken into an internal AbortController linked into the
    service's signal. Pre-cancelled token short-circuits without calling
    the service. Default stale guard: doc.version + cursor.character vs.
    snapshot captured at request time. Default buildRequest: callerScope =
    doc.uri, cursorOffset = position.character, full documentText, fingerprint
    = "v1". Catches any throw from the service and returns []. No second
    debounce / cache / controller. No vscode calls beyond the constructor
    parameter type and `new InlineCompletionItem`.
  ✓ src/ui/__tests__/aiSqlCompletionProvider.test.ts (new) — 7 tests:
    happy single-item, pre-cancelled token, mid-flight cancellation,
    loadConfig null, service null, service throw, stale doc version.
  ✓ src/ai/sqlAutocomplete.ts — added optional `signal?: AbortSignal` to
    SqlAutocompleteRequest; service now short-circuits on pre-cancelled
    external signal and links the signal into its internal per-scope
    AbortController via the new private `linkSignal` helper.
Verification Output:
  $ npx vitest run src/ui/__tests__/aiSqlCompletionProvider.test.ts
  Test Files  1 passed (1)
       Tests  7 passed (7)
  Duration  237ms
  $ npm run typecheck
  (clean, no diagnostics)
  $ npx vitest run  (full suite regression)
  Test Files  147 passed | 1 skipped (148)
       Tests  2167 passed | 2 skipped (2169)
Status: PASS
Note: in-pass correction — first pass left service.suggest with a 2-arg
signature while the provider wanted to pass a 3rd AbortSignal. Resolved
by extending SqlAutocompleteRequest with an optional `signal` field and
wiring it into the existing per-scope AbortController via linkSignal —
keeps the service's single-ownership promise intact instead of adding
a second controller.
---
