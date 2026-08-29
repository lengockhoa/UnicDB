# TASK-AIC-002 — Build schema-only cancellable autocomplete service

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§7

## Goal

Create a pure, testable autocomplete orchestration service that uses the configured autocomplete model through the existing OpenAI-compatible provider semantics. It must produce bounded schema-only SQL suffixes with debounce/cancellation/stale/cache/cooldown protections and never log or transmit rows, values, history, or credentials.

## Target Files

- `src/ai/sqlAutocomplete.ts` (new) — exported service constants, schema-only prompt construction, result sanitization, the sole debounce/cancellation/sequence authority, schema-fingerprinted LRU cache, cooldown, and rate/cost guards.
- `src/ai/__tests__/sqlAutocomplete.test.ts` (new) — unit tests for service privacy, request lifecycle, and cost guards.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | configured schema request returns suffix | With autocomplete model `fast-sql`, PostgreSQL dialect, `public.users(id,email)`, and `SELECT * FROM us|`, one completion call uses model `fast-sql`, schema names/columns, bounded cursor context, and returns the sanitized suffix `ers`. | Fake `AiConfig`, schema resolver, controlled completion promise. |
| 2 | edge — privacy | no row/history/secret/log material crosses boundary | Serialized `ProviderRequest.messages` contains schema identifiers but not sentinel row `alice@example.test`, query-history sentinel, or API key sentinel; no `runQuery`/row accessor exists or is called; injected logger receives neither prompt nor suffix. | Schema fixture plus sentinel values and logger spy. |
| 3 | edge — concurrency | superseding caller-scope request cancels and suppresses stale response | Request B for the same document/tab scope aborts A; resolving A later yields `null`; B alone returns its suffix. | Deferred promise fake and abort-aware completion seam. |
| 4 | edge — boundary | exact prompt and response limits are enforced | Prefix ≤2,000 chars, suffix ≤500 chars, schema ≤12,000 chars, `maxOutputTokens === 64`; multi-line/comment-only/unchanged response sanitizes to `null`. | Oversized schema/cursor and malformed provider text fixtures. |
| 5 | edge — cost guard | schema-fingerprinted LRU cache and cooldown prevent redundant calls | Identical `(connection,dialect,fingerprint,cursor)` request is cache-hit for ≤30,000ms; maximum 100 entries evicts LRU; a distinct request within 500ms returns `null`; changing connection or fingerprint bypasses old cache. | Injectable clock and connection/fingerprint fixtures. |
| 6 | regression | absent autocomplete config is silent | `loadConfig() === null` or empty `models.autocomplete.modelId` resolves `null`, makes zero provider calls, and exposes no secret-bearing error string. | Null/empty config fakes. |

## Test Files

- `src/ai/__tests__/sqlAutocomplete.test.ts` (new) — all service tests above.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/sqlAutocomplete.test.ts
npm run typecheck
```

No lint script is defined in `package.json`.

## Acceptance Criteria

- [ ] The service consumes AIC-001's autocomplete model through the existing chat/completions-shaped `createProviderClient(...).complete()` semantics and shared endpoint/key/method/timeout.
- [ ] Prompt construction contains only bounded SQL prefix/suffix, active dialect/connection/schema identity, and schema/table/column metadata.
- [ ] Prompt/result/error/log paths exclude rows, query results, values, query history, API keys, passwords, raw prompt logging, and response-suffix logging.
- [ ] The service alone owns a 300ms debounce, caller-scope AbortController/sequence, ≤30s / 100-entry schema-fingerprinted LRU cache, 500ms cooldown, and the exact input/output caps.
- [ ] Unconfigured, cancelled, stale, malformed, and provider-failed calls return no completion without throwing or notifying.
- [ ] All named test cases and verification commands pass with fresh output.
- [ ] Reviewer verdict is `approved` or `approved_minor`.

## Dependencies

- TASK-AIC-001

## Interfaces

- Consumes: `AiConfigStore.loadConfig(): Promise<AiConfig | null>` returning `AiConfig.models.autocomplete.modelId`; `createProviderClient(opts).complete(req: ProviderRequest): Promise<ProviderResult>`; `SchemaCache.getSchemas(): Promise<SchemaInfo[]>`, `getTables(schema?: string): Promise<TableInfo[]>`, and `getColumns(table: string, schema?: string): Promise<ColumnInfo[]>`.
- Produces: exported bounds `DEBOUNCE_MS`, `SQL_PREFIX_MAX_CHARS`, `SQL_SUFFIX_MAX_CHARS`, `SCHEMA_CONTEXT_MAX_CHARS`, `MAX_OUTPUT_TOKENS`, `CACHE_TTL_MS`, `CACHE_MAX_ENTRIES`, `COOLDOWN_MS`; and `SqlAutocompleteService` with a documented request method accepting caller scope, cursor SQL, dialect, connection identity, schema fingerprint/source, and `AbortSignal`, resolving `Promise<string | null>`. Its returned non-null value is an insertion suffix only and is current for that caller-scope sequence.

---

## Discussion

### 2026-08-29 · planner · unic-smart
Use the existing chat/completions-shaped `complete`, not streaming, for the first version. Service constants are pinned in PLAN §3.0 and must be exported/tested. Do not import VS Code in this service.

## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT:
  ✓ src/ai/sqlAutocomplete.ts (new) — pure service, no vscode import.
    Exported bounds: DEBOUNCE_MS=300, SQL_PREFIX_MAX_CHARS=2000, SQL_SUFFIX_MAX_CHARS=500,
    SCHEMA_CONTEXT_MAX_CHARS=12000, MAX_OUTPUT_TOKENS=64, CACHE_TTL_MS=30000,
    CACHE_MAX_ENTRIES=100, COOLDOWN_MS=500. Prompt is schema-only (dialect, connection
    name, table(column: type) list, bounded cursor prefix/suffix). Never embeds
    rows, history, apiKey, baseUrl. Result is sanitized to a single safe SQL line
    (strip fences, drop leading ";", drop trailing ";", reject English prose).
  ✓ src/ai/__tests__/sqlAutocomplete.test.ts (new) — 25 tests:
    happy configured request, privacy boundary, concurrency/cancellation, exact
    bound pin, LRU/cooldown/connection/fingerprint cache, regression for absent
    config, malformed/error/throw resilience.
Verification Output:
  $ npx vitest run src/ai/__tests__/sqlAutocomplete.test.ts
  Test Files  1 passed (1)
       Tests  25 passed (25)
  Duration  221ms
  $ npm run typecheck
  (clean, no diagnostics)
  $ npx vitest run  (full suite regression)
  Test Files  146 passed | 1 skipped (147)
       Tests  2160 passed | 2 skipped (2162)
Status: PASS
Note: in-pass correction — initial impl had a "most-recent cache for same scope"
fallback inside the cooldown short-circuit. Spec test #5 requires that a distinct
cursor request inside COOLDOWN_MS returns null with no extra provider call, so the
fallback was removed before committing. Touched file: src/ai/sqlAutocomplete.ts
(suggest() cooldown branch and dead findCacheForScope helper; touchCooldown inlined
as a 1-line assignment per the no-tiny-functions rule).

---
