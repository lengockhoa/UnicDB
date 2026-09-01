// src/ui/schemaCache.ts
// TASK-008 — Schema cache với TTL (default 60s) wrapping adapter introspection.
//
// Mỗi lần user gõ trong SQL editor, CompletionItemProvider cần
// schemas/tables/columns — không thể gọi adapter trên mỗi keystroke. Cache
// này giữ kết quả introspection theo TTL:
//   - Entry còn fresh (age < ttlMs) → trả cached, KHÔNG gọi adapter.
//   - Entry hết hạn → thử refresh; nếu adapter lỗi → trả stale data (không
//     throw — completion phải never-crash), nếu chưa từng có cache → [].
//   - `invalidate()` xoá toàn bộ entry (vsdb.refreshSchema command).
//
// vscode-free: chỉ phụ thuộc adapter types → test thuần Node, không cần mock.

import type {
  ColumnInfo,
  DbAdapter,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableConstraintInfo,
  TableInfo,
  ViewInfo,
} from "../adapters/types";
import { hasAdapterCapability } from "../adapters/types";

/** Provider adapter (lazy) — trả null khi không có active connection. */
export type SchemaAdapterProvider = () =>
  | Promise<DbAdapter | null>
  | DbAdapter
  | null;

export interface SchemaCacheOptions {
  /** TTL milliseconds — default 60_000. */
  ttlMs?: number;
  /** Clock inject cho test (default Date.now). */
  now?: () => number;
}

/** `D` là kiểu data đầy đủ (vd `TableInfo[]`), không phải element type. */
interface CacheEntry<D> {
  data: D;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * SchemaCache wraps adapter introspection with TTL caching. DBX-02 adds:
 * - `hasCatalog()` — capability gate (Postgres-only `adapter.catalog`).
 * - `getViews/getRoutines` — schema-scoped lists.
 * - `getConstraints(schema, table)` — table-scoped FK / constraint rows.
 * - `getSequences(schema)` — schema-scoped sequences.
 * - `getObjectDdl(kind, schema, name)` — DDL text for view/routine.
 *
 * Stale-on-error contract: if a refresh rejects, return the previous cached
 * value (or undefined/[] for first call). No adapter call propagates a throw
 * to the caller; completion must never-crash.
 */
export class SchemaCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private schemasEntry: CacheEntry<SchemaInfo[]> | null = null;
  private tablesAllEntry: CacheEntry<TableInfo[]> | null = null;
  private readonly tablesBySchema = new Map<string, CacheEntry<TableInfo[]>>();
  private readonly columnsByKey = new Map<string, CacheEntry<ColumnInfo[]>>();
  private readonly viewsBySchema = new Map<string, CacheEntry<ViewInfo[]>>();
  private readonly routinesBySchema = new Map<string, CacheEntry<RoutineInfo[]>>();
  private readonly sequencesBySchema = new Map<string, CacheEntry<SequenceInfo[]>>();
  private readonly constraintsByKey = new Map<string, CacheEntry<TableConstraintInfo[]>>();
  private readonly ddlByKey = new Map<string, CacheEntry<string | null>>();
  /** Single-flight registry: key → shared in-flight adapter refresh. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Bumped on invalidate — pre-invalidate responses must not commit. */
  private generation = 0;
  /**
   * TASK-RLX03-003 — last resolved non-null adapter identity. A DIFFERENT
   * non-null adapter (reconnect / active-connection switch) is a cache
   * generation boundary: all cached families belong to the old connection.
   * Null/throwing provider leaves this untouched (stale-on-error contract).
   */
  private adapterIdentity: DbAdapter | null = null;

  constructor(
    private readonly adapterProvider: SchemaAdapterProvider,
    options: SchemaCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Danh sách schema (cached theo TTL). */
  async getSchemas(): Promise<SchemaInfo[]> {
    const adapter = await this.resolveAdapter();
    const existing = this.schemasEntry;
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        "schemas",
        () => adapter.listSchemas(false),
        (entry) => {
          this.schemasEntry = entry;
        },
        existing,
      )) ?? []
    );
  }

  /** Danh sách table — toàn bộ (không schema) hoặc theo schema (cached). */
  async getTables(schema?: string): Promise<TableInfo[]> {
    const adapter = await this.resolveAdapter();
    if (schema === undefined) {
      const existing = this.tablesAllEntry;
      if (!adapter) return this.stale(existing) ?? [];
      return (
        (await this.fetchEntry(
          "tables:all",
          () => adapter.listTables(),
          (entry) => {
            this.tablesAllEntry = entry;
          },
          existing,
        )) ?? []
      );
    }
    const existing = this.tablesBySchema.get(schema) ?? null;
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        `tables:${schema}`,
        () => adapter.listTables(schema),
        (entry) => {
          this.tablesBySchema.set(schema, entry);
        },
        existing,
      )) ?? []
    );
  }

  /** Columns của một table (cached theo TTL, key = schema.table). */
  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const key = `${schema ?? ""}.${table}`;
    const adapter = await this.resolveAdapter();
    // existing đọc SAU resolveAdapter — invalidate do adapter transition
    // phải xóa slot trước khi freshness được đánh giá.
    const existing = this.columnsByKey.get(key) ?? null;
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        `columns:${key}`,
        () => adapter.listColumns(table, schema),
        (entry) => {
          this.columnsByKey.set(key, entry);
        },
        existing,
      )) ?? []
    );
  }

  /** True iff the resolved adapter DECLARES the catalog capability (DBX-08). */
  async hasCatalog(): Promise<boolean> {
    const adapter = await this.resolveAdapter();
    return hasAdapterCapability(adapter, "catalog");
  }

  /** Views for one schema (cached). `undefined` schema → no catalog data. */
  async getViews(schema?: string): Promise<ViewInfo[]> {
    if (schema === undefined) return [];
    const adapter = await this.resolveAdapter();
    const existing = this.viewsBySchema.get(schema) ?? null;
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        `views:${schema}`,
        () => adapter.listViews(schema),
        (entry) => {
          this.viewsBySchema.set(schema, entry);
        },
        existing,
      )) ?? []
    );
  }

  /** Routines for one schema (cached). `undefined` schema → no catalog data. */
  async getRoutines(schema?: string): Promise<RoutineInfo[]> {
    if (schema === undefined) return [];
    const adapter = await this.resolveAdapter();
    const existing = this.routinesBySchema.get(schema) ?? null;
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        `routines:${schema}`,
        () => adapter.listRoutines(schema),
        (entry) => {
          this.routinesBySchema.set(schema, entry);
        },
        existing,
      )) ?? []
    );
  }

  /**
   * Constraints for one (schema, table) — TABLE-SCOPED. Only the requested
   * (schema, table) tuple is ever queried; never an eager whole-database
   * scan. Returns [] if no catalog capability.
   */
  async getConstraints(
    schema: string,
    table: string,
  ): Promise<TableConstraintInfo[]> {
    const key = `${schema}.${table}`;
    const adapter = await this.resolveAdapter();
    const existing = this.constraintsByKey.get(key) ?? null;
    if (!hasAdapterCapability(adapter, "catalog")) {
      return this.stale(existing) ?? [];
    }
    // Declaration is the admission decision; the optional object is only a
    // defensive execution seam (DBX-08).
    const catalog = adapter!.catalog;
    if (!catalog) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        `constraints:${key}`,
        () => catalog.listConstraints(schema, table),
        (entry) => {
          this.constraintsByKey.set(key, entry);
        },
        existing,
      )) ?? []
    );
  }

  /** Sequences for one schema (cached). Returns [] if no catalog capability. */
  async getSequences(schema: string): Promise<SequenceInfo[]> {
    const adapter = await this.resolveAdapter();
    const existing = this.sequencesBySchema.get(schema) ?? null;
    if (!hasAdapterCapability(adapter, "catalog")) {
      return this.stale(existing) ?? [];
    }
    const catalog = adapter!.catalog;
    if (!catalog) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        `sequences:${schema}`,
        () => catalog.listSequences(schema),
        (entry) => {
          this.sequencesBySchema.set(schema, entry);
        },
        existing,
      )) ?? []
    );
  }

  /**
   * DDL text for one (kind, schema, name) object — view or routine.
   * Returns undefined when not found / no catalog capability / adapter throws.
   * Cached null = "tried and got nothing" — must not be confused with stale.
   */
  async getObjectDdl(
    kind: "view" | "routine",
    schema: string,
    name: string,
  ): Promise<string | undefined> {
    const key = `${kind}:${schema}.${name}`;
    const adapter = await this.resolveAdapter();
    const existing = this.ddlByKey.get(key) ?? null;
    // Object DDL is gated by its OWN declaration (DBX-08) — catalog presence
    // alone never admits DDL retrieval.
    if (!hasAdapterCapability(adapter, "objectDdl")) {
      return existing ? (existing.data ?? undefined) : undefined;
    }
    const catalog = adapter!.catalog;
    if (!catalog || typeof catalog.objectDdl !== "function") {
      // Defensive: declared but the matching API is missing (contract
      // violation in production) → unavailable, never a TypeError.
      return existing ? (existing.data ?? undefined) : undefined;
    }
    return await this.fetchEntryDdl(
      `ddl:${key}`,
      () => catalog.objectDdl(kind, name, schema),
      (entry) => {
        this.ddlByKey.set(key, entry);
      },
      existing,
    );
  }

  /** Xoá toàn bộ cached entries — lần gọi kế tiếp fetch fresh. */
  invalidate(): void {
    // TASK-RLX-002: bump generation — response in-flight bắt đầu trước đây
    // sẽ KHÔNG commit được. Adapter I/O không bị hủy (chỉ bỏ qua commit).
    this.generation += 1;
    this.schemasEntry = null;
    this.tablesAllEntry = null;
    this.tablesBySchema.clear();
    this.columnsByKey.clear();
    this.viewsBySchema.clear();
    this.routinesBySchema.clear();
    this.sequencesBySchema.clear();
    this.constraintsByKey.clear();
    this.ddlByKey.clear();
  }

  // ---- Private ---------------------------------------------------------------

  private async resolveAdapter(): Promise<DbAdapter | null> {
    let adapter: DbAdapter | null;
    try {
      adapter = await this.adapterProvider();
    } catch {
      // getAdapter() throw (no active / missing password) → coi như không
      // có adapter; stale data (nếu có) vẫn được trả. Identity giữ nguyên —
      // không phải adapter replacement, không invalidate.
      return null;
    }
    // TASK-RLX03-003 — adapter identity boundary. First non-null adapter only
    // establishes identity (no spurious invalidate/fetch); a DIFFERENT later
    // non-null adapter means reconnect or active-connection switch: cached
    // entries belong to the old generation, so invalidate BEFORE the caller
    // evaluates freshness or reads any cache slot. Same adapter → no-op, the
    // single-flight/generation semantics of RLX-01 stay intact. Null is not a
    // transition (transient unavailable adapter keeps its stale contract).
    if (adapter && this.adapterIdentity !== adapter) {
      if (this.adapterIdentity !== null) this.invalidate();
      this.adapterIdentity = adapter;
    }
    return adapter;
  }

  private isFresh(entry: CacheEntry<unknown> | null): boolean {
    return entry !== null && this.now() - entry.fetchedAt < this.ttlMs;
  }

  /** Có stale → stale; null = chưa từng cache. */
  private stale<D>(entry: CacheEntry<D> | null): D | null {
    return entry ? entry.data : null;
  }

  /**
   * Core fetch-or-cached: fresh → cached; expired → refresh, lỗi → stale
   * (hoặc null nếu chưa từng cache — caller map sang []). `commit` lưu entry
   * mới vào đúng slot.
   *
   * TASK-RLX-002: các caller trùng key refresh cùng một slot hết hạn sẽ share
   * đúng một in-flight promise (single-flight theo key). Registry được dọn
   * trong `finally`. Guard `generation` chặn response bắt đầu trước
   * `invalidate()` ghi đè cache: response cũ vẫn trả cho caller đang chờ,
   * chỉ không commit — invalidate không hủy adapter I/O.
   */
  private fetchEntry<D>(
    key: string,
    fetch: () => Promise<D>,
    commit: (entry: CacheEntry<D>) => void,
    existing: CacheEntry<D> | null,
  ): Promise<D | null> {
    if (this.isFresh(existing)) return Promise.resolve(existing!.data);
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<D | null>;
    const startGen = this.generation;
    // Register BEFORE the body runs: a provider that THROWS SYNCHRONOUSLY
    // would otherwise settle the promise during the sync phase of the async
    // body — before `inflight.set` below — leaving a permanently dead entry
    // in the registry (next caller coalesces onto it and can never retry).
    // `Promise.resolve().then(...)` guarantees set-first ordering.
    const work: Promise<D | null> = Promise.resolve().then(async () => {
      try {
        const data = await fetch();
        if (this.generation === startGen) {
          commit({ data, fetchedAt: this.now() });
        }
        return data;
      } catch {
        // Adapter lỗi mid-refresh → stale tốt hơn empty.
        return this.stale(existing);
      } finally {
        if (this.inflight.get(key) === work) this.inflight.delete(key);
      }
    });
    this.inflight.set(key, work);
    return work;
  }

  /**
   * DDL variant: `null` (object not found) is a valid cached state and must
   * be preserved across refresh failures so we don't repeatedly probe a
   * missing object. Inline stale fallback returns undefined when no cache.
   */
  private fetchEntryDdl(
    key: string,
    fetch: () => Promise<string>,
    commit: (entry: CacheEntry<string | null>) => void,
    existing: CacheEntry<string | null> | null,
  ): Promise<string | undefined> {
    if (this.isFresh(existing)) {
      return Promise.resolve(existing!.data ?? undefined);
    }
    const inflight = this.inflight.get(key);
    if (inflight) return inflight as Promise<string | undefined>;
    const startGen = this.generation;
    // Same sync-throw protection as fetchEntry: register the in-flight
    // promise BEFORE the body can settle on a synchronous provider throw.
    const work: Promise<string | undefined> = Promise.resolve().then(
      async () => {
        try {
          const data = await fetch();
          if (this.generation === startGen) {
            commit({ data, fetchedAt: this.now() });
          }
          return data;
        } catch {
          return existing ? (existing.data ?? undefined) : undefined;
        } finally {
          if (this.inflight.get(key) === work) this.inflight.delete(key);
        }
      },
    );
    this.inflight.set(key, work);
    return work;
  }
}