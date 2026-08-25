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
  SchemaInfo,
  TableInfo,
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

export class SchemaCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private schemasEntry: CacheEntry<SchemaInfo[]> | null = null;
  private tablesAllEntry: CacheEntry<TableInfo[]> | null = null;
  private readonly tablesBySchema = new Map<string, CacheEntry<TableInfo[]>>();
  private readonly columnsByKey = new Map<string, CacheEntry<ColumnInfo[]>>();

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

  /** Xoá toàn bộ cached entries — lần gọi kế tiếp fetch fresh. */
  invalidate(): void {
    this.schemasEntry = null;
    this.tablesAllEntry = null;
    this.tablesBySchema.clear();
    this.columnsByKey.clear();
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
}
