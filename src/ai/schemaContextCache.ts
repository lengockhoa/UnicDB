// src/ai/schemaContextCache.ts
// Independent review fixes — schema-context resolver + bounded cache.
//
// What this module is responsible for:
//   1. Cross-connection race safety: `createSchemaContextResolver(deps).resolve()`
//      captures the active connection ID at the start, and re-verifies the
//      SAME identity after every awaited adapter/listTables call. If the
//      active connection changed mid-flight, the resolver returns an empty
//      context — the stale result must never leak across connections.
//   2. Cost control: `createSchemaContextCache(deps, opts)` wraps the resolver
//      with a bounded cache keyed by active connection identity. Repeated
//      resolves for the same connection serve cached data without re-issuing
//      listTables / listColumns. Connection change → invalidate → next
//      resolve re-hydrates. Hydration fans listColumns out across tables
//      with a conservative concurrency cap (default 4) and never queries
//      rows (no runQuery on this path).
//
// Hard rules (defense in depth, tested):
//   - Schema-only: only listTables + listColumns are called on the adapter.
//   - No-throw: resolver swallows adapter errors and returns empty context.
//   - Bounded: cache invalidates on connection identity change OR explicit
//     invalidate(). No unbounded growth.
//   - Concurrency cap: hydration listColumns calls respect the configured
//     cap; never exceed it even for huge schema sizes.

import type { DbAdapter, ColumnInfo, TableInfo } from "../adapters/types";
import type { ConnectionConfig } from "../config/types";
import type { SchemaContext, SchemaTable } from "./sqlAutocomplete";

// ---- Resolver -------------------------------------------------------------

/** Minimal surface the resolver depends on. Decouples it from the concrete
 *  ConnectionManager — tests inject a tiny stub. */
export interface ResolverDeps {
  /** Active connection synchronously (a copy / null if none). */
  getActive: () => ConnectionConfig | null;
  /** Lazy-connect to the current active. May throw; resolver swallows. */
  getAdapter: () => Promise<DbAdapter>;
}

export interface SchemaContextResolver {
  resolve(_scope: string): Promise<SchemaContext>;
}

/**
 * Construct a schema-context resolver. Pure: holds no state. Each call to
 * `resolve()` is race-safe — captures active ID at the start, re-verifies
 * after each awaited adapter / listTables operation, and aborts the result
 * if the active connection changed.
 */
export function createSchemaContextResolver(
  deps: ResolverDeps,
): SchemaContextResolver {
  return {
    async resolve(_scope: string): Promise<SchemaContext> {
      const beforeActive = deps.getActive();
      if (!beforeActive) return emptyContext();
      const beforeId = beforeActive.id;

      let adapter: DbAdapter;
      try {
        adapter = await deps.getAdapter();
      } catch {
        return emptyContext();
      }
      // Re-verify identity after getAdapter() resolved.
      const midActive = deps.getActive();
      if (!midActive || midActive.id !== beforeId) return emptyContext();

      let tables: TableInfo[];
      try {
        tables = await adapter.listTables();
      } catch {
        return emptyContext();
      }
      // Re-verify identity AFTER listTables too — covers listTables that
      // awaits a slow query while the user switches connections.
      const afterActive = deps.getActive();
      if (!afterActive || afterActive.id !== beforeId) return emptyContext();

      return {
        dialect: midActive.driver,
        connectionName: midActive.name ?? midActive.id,
        tables: tables.map((t) => ({
          schema: t.schema,
          name: t.name,
          columns: [],
        })),
      };
    },
  };
}

// ---- Bounded cache --------------------------------------------------------

export interface SchemaContextCacheOptions {
  /** Cache TTL milliseconds. Default 60_000. 0 = always re-hydrate. */
  ttlMs?: number;
  /** Concurrency cap for listColumns during hydration. Default 4. */
  columnConcurrency?: number;
  /** Clock inject for tests. */
  now?: () => number;
}

interface CacheEntry {
  connectionId: string;
  /** Pre-rendered SchemaContext — returned by reference on cache hit. */
  context: SchemaContext;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;

export interface SchemaContextCache {
  resolve(scope: string): Promise<SchemaContext>;
  /** Drop the entire cache. Idempotent. */
  invalidate(): void;
}

/**
 * Construct a bounded schema context cache. The cache is keyed implicitly
 * by the active connection ID captured during hydration. When the active
 * connection changes, the next resolve detects a new identity and
 * re-hydrates (no separate invalidate call needed for the connection-change
 * case). `invalidate()` is the explicit seam for callers that want to force
 * a refresh for any other reason (e.g. a manual vsdb.refreshSchema command).
 */
export function createSchemaContextCache(
  deps: ResolverDeps,
  opts: SchemaContextCacheOptions = {},
): SchemaContextCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const columnConcurrency = Math.max(1, opts.columnConcurrency ?? DEFAULT_CONCURRENCY);
  const now = opts.now ?? (() => Date.now());

  let entry: CacheEntry | null = null;
  // Promise dedupe: if a hydration is in flight, callers await the same
  // promise instead of triggering parallel listTables/listColumns storms.
  let inflight: Promise<SchemaContext> | null = null;
  // Generation guard: invalidate() bumps this so a hydration that started
  // BEFORE the invalidate can no longer commit its (stale, pre-DDL) entry
  // when it eventually settles — mirroring the resolver's identity/race
  // guard discipline (stale result must never leak into fresh state).
  let generation = 0;

  const resolver = createSchemaContextResolver(deps);

  async function hydrate(startGen: number): Promise<SchemaContext> {
    // Fetch tables via the race-safe resolver.
    const ctx = await resolver.resolve("");
    const active = deps.getActive();
    if (!active) return ctx;

    // Fetch columns concurrently with a bounded cap.
    const adapter = await safeGetAdapter(deps);
    if (!adapter) return ctx;
    const cols = await mapWithConcurrency(
      ctx.tables,
      columnConcurrency,
      async (t) => {
        try {
          const raw: ColumnInfo[] = await adapter.listColumns(t.name, t.schema);
          return raw.map((c) => ({ name: c.name, dataType: c.dataType }));
        } catch {
          return [];
        }
      },
    );
    const tables: SchemaTable[] = ctx.tables.map((t, i) => ({
      schema: t.schema,
      name: t.name,
      columns: cols[i] ?? [],
    }));
    const hydrated: SchemaContext = {
      dialect: ctx.dialect,
      connectionName: ctx.connectionName,
      tables,
    };
    // Commit only if no invalidate() landed while this hydration was in
    // flight — otherwise the entry is stale (pre-DDL) and must be dropped.
    if (generation === startGen) {
      entry = {
        connectionId: active.id,
        context: hydrated,
        fetchedAt: now(),
      };
    }
    return hydrated;
  }

  return {
    async resolve(_scope: string): Promise<SchemaContext> {
      const active = deps.getActive();
      if (!active) {
        // No active connection → no cache hit possible; return empty.
        entry = null;
        return emptyContext();
      }

      // Cache hit when: same connection id AND entry fresh. The
      // active-id check is what makes a connection change trigger
      // re-hydration without needing an explicit invalidate call.
      // ttlMs === 0 forces re-hydration on every resolve.
      const fresh =
        ttlMs > 0 &&
        entry !== null &&
        entry.connectionId === active.id &&
        now() - entry.fetchedAt < ttlMs;

      if (fresh && entry) {
        // Return the SAME reference so callers (and tests) can rely on
        // reference equality to assert "no re-hydration happened".
        return entry.context;
      }

      // Connection change OR stale → re-hydrate. Coalesce concurrent calls
      // onto a single in-flight hydration (prevents N keystrokes each
      // firing their own listTables during a burst) — but ONLY when that
      // hydration is still current (not invalidated mid-flight).
      if (inflight) return inflight;
      const startGen = generation;
      const p = hydrate(startGen).finally(() => {
        // Ownership check: null the reference only if this hydration still
        // owns `inflight`. After invalidate() dropped it, a NEW promise may
        // be installed — the old hydration's finally must not clear that one.
        if (inflight === p) inflight = null;
      });
      inflight = p;
      return p;
    },
    invalidate(): void {
      entry = null;
      // Drop the in-flight reference so post-invalidate resolves start a
      // FRESH hydration instead of coalescing onto the stale one, and bump
      // the generation so the stale hydration cannot commit its entry later.
      generation++;
      inflight = null;
    },
  };
}

// ---- helpers --------------------------------------------------------------

function emptyContext(): SchemaContext {
  return { dialect: "", connectionName: "", tables: [] };
}

async function safeGetAdapter(deps: ResolverDeps): Promise<DbAdapter | null> {
  try {
    return await deps.getAdapter();
  } catch {
    return null;
  }
}

/**
 * Like `Promise.all(items.map(fn))` but never runs more than `cap` tasks at
 * once. Implementation: simple rolling-window semaphore — no extra deps.
 * On any rejection, the whole thing rejects (caller must guard).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  cap: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers: Promise<void>[] = [];
  const limit = Math.max(1, Math.min(cap, items.length));
  for (let k = 0; k < limit; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}