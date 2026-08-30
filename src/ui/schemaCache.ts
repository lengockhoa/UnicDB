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
    const existing = this.columnsByKey.get(key) ?? null;
    const adapter = await this.resolveAdapter();
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
        () => adapter.listColumns(table, schema),
        (entry) => {
          this.columnsByKey.set(key, entry);
        },
        existing,
      )) ?? []
    );
  }

  /** True iff the resolved adapter exposes the optional catalog capability. */
  async hasCatalog(): Promise<boolean> {
    const adapter = await this.resolveAdapter();
    return adapter?.catalog !== undefined;
  }

  /** Views for one schema (cached). `undefined` schema → no catalog data. */
  async getViews(schema?: string): Promise<ViewInfo[]> {
    if (schema === undefined) return [];
    const existing = this.viewsBySchema.get(schema) ?? null;
    const adapter = await this.resolveAdapter();
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
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
    const existing = this.routinesBySchema.get(schema) ?? null;
    const adapter = await this.resolveAdapter();
    if (!adapter) return this.stale(existing) ?? [];
    return (
      (await this.fetchEntry(
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
    const existing = this.constraintsByKey.get(key) ?? null;
    const adapter = await this.resolveAdapter();
    if (!adapter || !adapter.catalog) return this.stale(existing) ?? [];
    const catalog = adapter.catalog;
    return (
      (await this.fetchEntry(
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
    const existing = this.sequencesBySchema.get(schema) ?? null;
    const adapter = await this.resolveAdapter();
    if (!adapter || !adapter.catalog) return this.stale(existing) ?? [];
    const catalog = adapter.catalog;
    return (
      (await this.fetchEntry(
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
    const existing = this.ddlByKey.get(key) ?? null;
    const adapter = await this.resolveAdapter();
    if (!adapter || !adapter.catalog) {
      return existing ? (existing.data ?? undefined) : undefined;
    }
    const catalog = adapter.catalog;
    return await this.fetchEntryDdl(
      () => catalog.objectDdl(kind, name, schema),
      (entry) => {
        this.ddlByKey.set(key, entry);
      },
      existing,
    );
  }

  /** Xoá toàn bộ cached entries — lần gọi kế tiếp fetch fresh. */
  invalidate(): void {
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
    try {
      return await this.adapterProvider();
    } catch {
      // getAdapter() throw (no active / missing password) → coi như không
      // có adapter; stale data (nếu có) vẫn được trả.
      return null;
    }
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
   */
  private async fetchEntry<D>(
    fetch: () => Promise<D>,
    commit: (entry: CacheEntry<D>) => void,
    existing: CacheEntry<D> | null,
  ): Promise<D | null> {
    if (this.isFresh(existing)) return existing!.data;
    try {
      const data = await fetch();
      commit({ data, fetchedAt: this.now() });
      return data;
    } catch {
      // Adapter lỗi mid-refresh → stale tốt hơn empty.
      return this.stale(existing);
    }
  }

  /**
   * DDL variant: `null` (object not found) is a valid cached state and must
   * be preserved across refresh failures so we don't repeatedly probe a
   * missing object. Inline stale fallback returns undefined when no cache.
   */
  private async fetchEntryDdl(
    fetch: () => Promise<string>,
    commit: (entry: CacheEntry<string | null>) => void,
    existing: CacheEntry<string | null> | null,
  ): Promise<string | undefined> {
    if (this.isFresh(existing)) return existing!.data ?? undefined;
    try {
      const data = await fetch();
      commit({ data, fetchedAt: this.now() });
      return data;
    } catch {
      return existing ? (existing.data ?? undefined) : undefined;
    }
  }
}