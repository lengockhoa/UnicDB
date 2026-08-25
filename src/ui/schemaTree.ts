// src/ui/schemaTree.ts
// SchemaTreeProvider — TreeDataProvider cho "Schema Explorer" view.
//
// Node types:
//   - "connection"          : mỗi connection trong ConnectionManager (root expand sẵn, icon theo driver, active tint xanh).
//   - "schema"              : schema trong connection (icon symbol-namespace).
//   - "category"            : "Tables" / "Views" / "Routines" (folder trong 1 schema)
//   - "table" / "view"      : tên table/view với schema + qualifiedName
//   - "routine"             : function/procedure
//   - "column"              : column trong table
//   - "error"               : node báo lỗi khi adapter throw
//   - "empty-add"           : placeholder "No schemas" (empty connection list do viewsWelcome render)
//
// Caching: 60s theo (connectionId, category). Refresh invalidates cache và fire onDidChangeTreeData.
//
// Util cho Generate SELECT / Copy qualified name được export để extension.ts dùng.
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import type { DbAdapter } from "../adapters/types";


/** Icon theo driver — giống DataGrip: mỗi DB type có icon riêng. */
const DRIVER_ICONS: Record<string, string> = {
  postgres: "database",
  mysql: "server",
  mssql: "azure",
};

export type CategoryKind = "tables" | "views" | "routines" | "columns";

export interface VsdbNode {
  label: string;
  /** Icon id VS Code (vd "$(database)") hoặc undefined. */
  icon?: string;
  /** Sub-label ngắn (vd dataType cho column). */
  description?: string;
  /** Tooltip full text. */
  tooltip?: string;
  /** "connection" | "category" | "table" | "view" | "routine" | "column" | "error" | "empty-add" */
  contextValue: string;
  /** vscode TreeItemCollapsibleState. */
  collapsible: vscode.TreeItemCollapsibleState;
  /** Command khi click (vd generate SELECT đặt vào command field). */
  command?: { command: string; title: string; arguments?: unknown[] };
  /** Tham chiếu nội bộ để getChildren xử lý. */
  meta?: {
    connection?: ConnectionConfig;
    category?: CategoryKind;
    /** Dùng cho table/view/routine. */
    objectKey?: string;
    schema?: string;
    objectName?: string;
    /** Dùng cho column. */
    column?: { name: string; dataType: string };
  };
}

const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class SchemaTreeProvider implements vscode.TreeDataProvider<VsdbNode> {
  private readonly mgr: ConnectionManager;
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<VsdbNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache lazy-loaded children theo node key. Node key = `connectionId|category|objectKey`. */
  private cache = new Map<string, CacheEntry<VsdbNode[]>>();

  /**
   * Cache riêng cho row counts. Tách khỏi `cache` (typed `VsdbNode[]`)
   * vì entry khác type (number), tránh `as any` và giữ key namespace sạch.
   * Key: `rowcount|${conn.id}|${schema}|${table}`, TTL = CACHE_TTL_MS.
   */
  private rowCountCache = new Map<string, CacheEntry<number>>();

  /** In-flight guard chống double-fetch row count khi node re-render. */
  private rowCountFetching = new Set<string>();

  /** Filter text hiện tại ('' = không filter). Case-insensitive substring match trên label. */
  private filterText = "";

  /** Track active-change subscription so we can dispose it. */
  private activeSub: { dispose(): void } | null = null;

  constructor(mgr: ConnectionManager) {
    this.mgr = mgr;
    // Re-render khi active đổi (chấm xanh, status text).
    this.activeSub = this.mgr.onDidChangeActive(() =>
      this._onDidChangeTreeData.fire(undefined),
    );
  }

  /** Dispose: drop cache and active subscription. Manager owns adapters (closes them). */
  dispose(): void {
    this.cache.clear();
    this.rowCountCache.clear();
    this.rowCountFetching.clear();
    if (this.activeSub) {
      this.activeSub.dispose();
      this.activeSub = null;
    }
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Lấy adapter cho connection. Nếu connection đang active → dùng manager (lazy connect + idle).
   * Nếu không active → gọi `mgr.getAdapterFor(cfg)` (manager method caches the adapter
   * per connection id — single ownership, manager closes on dispose/edit/delete).
   */
  private async getAdapterFor(conn: ConnectionConfig): Promise<DbAdapter> {
    const active = this.mgr.getActive();
    if (active && active.id === conn.id) {
      return await this.mgr.getAdapter();
    }
    return await this.mgr.getAdapterFor(conn);
  }

  /** Public API cho extension.ts gọi khi user bấm Refresh. */
  refresh(): void {
    this.cache.clear();
    this.rowCountCache.clear();
    this.rowCountFetching.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set filter text (case-insensitive substring match trên label). '' = tắt filter. */
  setFilter(text: string): void {
    if (this.filterText === text) return;
    this.filterText = text;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Filter text hiện tại ('' = không filter). */
  getFilter(): string {
    return this.filterText;
  }

  /** Case-insensitive substring match. */
  private matchesFilter(label: string): boolean {
    if (this.filterText === "") return true;
    return label.toLowerCase().includes(this.filterText.toLowerCase());
  }

  getTreeItem(node: VsdbNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.collapsible);
    if (node.icon) {
      if (node.contextValue === "connection" && this.isActive(node)) {
        // Active connection: tint icon xanh (giống chấm xanh cũ) qua ThemeColor.
        item.iconPath = new vscode.ThemeIcon(
          node.icon,
          new vscode.ThemeColor("testing.iconPassed"),
        );
      } else {
        item.iconPath = new vscode.ThemeIcon(node.icon);
      }
    }
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    if (node.command) item.command = node.command;
    item.contextValue = node.contextValue;
    return item;
  }

  /** Node connection có phải active connection hiện tại không. */
  private isActive(node: VsdbNode): boolean {
    const active = this.mgr.getActive();
    return Boolean(active && node.meta?.connection?.id === active.id);
  }

  async getChildren(node: VsdbNode | undefined): Promise<VsdbNode[]> {
    try {
      if (node === undefined) {
        return this.getRoot();
      }
      if (node.contextValue === "connection") {
        return this.getSchemaNodesForConnection(node);
      }
      if (node.contextValue === "schema") {
        return this.getCategoriesForSchema(node);
      }
      if (node.contextValue === "category") {
        return this.getCategoryChildren(node);
      }
      if (node.contextValue === "table") {
        return this.getColumnChildren(node);
      }
      // Error / empty / others → không có children.
      return [];
    } catch (_err) {
      // Phòng trường hợp exception ngoài luồng — tree không bao giờ crash.
      return [];
    }
  }

  // ---- Root: connections ----------------------------------------------------

  private getRoot(): VsdbNode[] {
    // Empty state do viewsWelcome trong package.json render ("No connections yet.
    // [Add Connection]"), không cần placeholder node trong tree.
    // Root: connections LUÔN giữ kể cả khi filter active — connections là
    // ancestor containers, filter áp cho object names (schema/table/view/...),
    // không phải connection names.
    return this.mgr.listConnections().map((c) => ({
      label: c.name,
      icon: DRIVER_ICONS[c.driver] ?? "database",
      tooltip: `${c.name}\n${c.driver}@${c.host}:${c.port}/${c.database}\nClick để đổi active connection`,
      contextValue: "connection",
      // TASK-010/D3 — Collapsed (không phải Expanded): tránh VS Code auto-expand
      // MỌI connection lúc activation → mở socket + listSchemas cho từng DB dù
      // user chưa từng đụng tới. Click-to-activate command bên dưới không đổi.
      collapsible: vscode.TreeItemCollapsibleState.Collapsed,
      // Click → switch active (statusBar + icon tint cập nhật qua onDidChangeActive).
      command: {
        command: "vsdb.selectConnectionFromTree",
        title: "Select as Active Connection",
        arguments: [c.id],
      },
      meta: { connection: c },
    }));
  }


  // ---- Schema nodes (connection → schemas) ---------------------------------

  private async getSchemaNodesForConnection(node: VsdbNode): Promise<VsdbNode[]> {
    const conn = node.meta?.connection;
    if (!conn) return [];

    const hideSystemSchemas = vscode.workspace
      .getConfiguration("vsdb")
      .get<boolean>("hideSystemSchemas", true);
    const includeSystem = !hideSystemSchemas;
    const key = `schemas|${conn.id}|includeSystem=${includeSystem ? 1 : 0}`;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // Cached nodes were built Collapsed. When a filter is active the spec
      // requires ancestors of matches to be Expanded — remap on the way out
      // (cache keeps the canonical Collapsed copy; filter state is transient).
      if (this.filterText) {
        return cached.data.map((n) =>
          n.collapsible === vscode.TreeItemCollapsibleState.Collapsed
            ? { ...n, collapsible: vscode.TreeItemCollapsibleState.Expanded }
            : n,
        );
      }
      return cached.data;
    }

    let adapter: DbAdapter;
    try {
      adapter = await this.getAdapterFor(conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errNode: VsdbNode = {
        label: `Connect failed: ${message}`,
        icon: "error",
        contextValue: "error",
        collapsible: vscode.TreeItemCollapsibleState.None,
      };
      this.cache.set(key, {
        data: [errNode],
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return [errNode];
    }

    let children: VsdbNode[];
    try {
      const schemas = await adapter.listSchemas(includeSystem);
      if (schemas.length === 0) {
        children = [
          {
            label: "No schemas",
            contextValue: "empty-add",
            collapsible: vscode.TreeItemCollapsibleState.None,
          },
        ];
      } else {
        const filterActive = this.filterText !== "";
        children = schemas.map((s) => ({
          label: s.name,
          icon: "symbol-namespace",
          tooltip: `${conn.name} / ${s.name}`,
          contextValue: "schema",
          // Filter active: expand schema để user thấy được match sâu bên trong.
          collapsible: filterActive
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
          meta: { connection: conn, schema: s.name },
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      children = [
        {
          label: `Connect failed: ${message}`,
          icon: "error",
          contextValue: "error",
          collapsible: vscode.TreeItemCollapsibleState.None,
        },
      ];
    }

    this.cache.set(key, {
      data: children,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return children;
  }

  private getCategoriesForSchema(node: VsdbNode): VsdbNode[] {
    const conn = node.meta?.connection;
    const schema = node.meta?.schema;
    if (!conn || !schema) return [];
    // Filter active: expand category để user thấy match bên trong mà không cần click.
    const collapsible = this.filterText !== ""
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    return [
      {
        label: "Tables",
        icon: "table",
        contextValue: "category",
        collapsible,
        meta: { connection: conn, schema, category: "tables" },
      },
      {
        label: "Views",
        icon: "eye",
        contextValue: "category",
        collapsible,
        meta: { connection: conn, schema, category: "views" },
      },
      {
        label: "Routines",
        icon: "symbol-function",
        contextValue: "category",
        collapsible,
        meta: { connection: conn, schema, category: "routines" },
      },
    ];
  }

  // ---- Category children: tables/views/routines ----------------------------

  private async getCategoryChildren(node: VsdbNode): Promise<VsdbNode[]> {
    const conn = node.meta?.connection;
    const category = node.meta?.category;
    const schema = node.meta?.schema;
    if (!conn || !category || !schema) return [];
    const key = `category|${conn.id}|${schema}|${category}`;
    const filterActive = this.filterText !== "";

    // Cache check — cache LUÔN chứa list UNFILTERED (nếu có filter, lọc ở
    // output trước khi return). Đảm bảo badge = tổng unfiltered + filter chỉ
    // ảnh hưởng output array, không ảnh hưởng cache count.
    const cached = this.cache.get(key);
    let children: VsdbNode[];
    if (cached && cached.expiresAt > Date.now()) {
      children = cached.data;
    } else {
      // Lazy: load via manager (cho active connection) hoặc getAdapterFor() cho non-active.
      let adapter: DbAdapter;
      try {
        adapter = await this.getAdapterFor(conn);
      } catch (err) {
        // Adapter throw → trả về error node, tree không crash.
        const message = err instanceof Error ? err.message : String(err);
        const errNode: VsdbNode = {
          label: `Connect failed: ${message}`,
          icon: "error",
          contextValue: "error",
          collapsible: vscode.TreeItemCollapsibleState.None,
        };
        this.cache.set(key, {
          data: [errNode],
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return [errNode];
      }

      let raw: VsdbNode[];
      try {
        if (category === "tables") {
          const tables = await adapter.listTables(schema);
          raw = tables.map((t) => {
            const n: VsdbNode = {
              label: t.name,
              description: t.schema,
              tooltip: `${t.schema}.${t.name}`,
              contextValue: "table",
              collapsible: vscode.TreeItemCollapsibleState.Collapsed,
              meta: {
                connection: conn,
                category: "columns",
                objectKey: `${conn.id}.${t.schema}.${t.name}`,
                schema: t.schema,
                objectName: t.name,
              },
            };
            // TASK-002 — double-click/Enter opens ResultsPanel with SELECT *
            // for this table. Argument is the whole VsdbNode so browseCommands
            // can read .meta. Chevrons keep single-click expand behavior.
            n.command = {
              command: "vsdb.browseTableData",
              title: "Browse Data",
              arguments: [n],
            };
            return n;
          });
        } else if (category === "views") {
          const views = await adapter.listViews(schema);
          raw = views.map((v) => {
            const n: VsdbNode = {
              label: v.name,
              description: v.schema,
              tooltip: `${v.schema}.${v.name}`,
              contextValue: "view",
              collapsible: vscode.TreeItemCollapsibleState.None,
              meta: {
                connection: conn,
                schema: v.schema,
                objectName: v.name,
              },
            };
            n.command = {
              command: "vsdb.browseTableData",
              title: "Browse Data",
              arguments: [n],
            };
            return n;
          });
        } else {
          const routines = await adapter.listRoutines(schema);
          raw = routines.map((r) => ({
            label: r.name,
            description: r.kind,
            tooltip: `${r.schema}.${r.name} (${r.kind})`,
            contextValue: "routine",
            collapsible: vscode.TreeItemCollapsibleState.None,
            meta: {
              connection: conn,
              schema: r.schema,
              objectName: r.name,
            },
            command: {
              command: "vsdb.copyQualifiedName",
              title: "Copy qualified name",
              arguments: [qualifiedName({ table: r.name, schema: r.schema })],
            },
          }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        raw = [
          {
            label: `Connect failed: ${message}`,
            icon: "error",
            contextValue: "error",
            collapsible: vscode.TreeItemCollapsibleState.None,
          },
        ];
      }

      children = raw;

      // DataGrip-like count badge: cập nhật description + re-render sau khi load.
      // Badge tính từ list UNFILTERED → set TRƯỚC filter để tránh stale sau clear.
      const isError = children.length === 1 && children[0].contextValue === "error";
      if (!isError) {
        node.description = String(children.length);
        this._onDidChangeTreeData.fire(node);
      }

      // Cache unfiltered list (cho filter sau này + lần sau getChildren).
      this.cache.set(key, {
        data: children,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      // Row count fetch fire-and-forget chỉ cho tables.
      // TASK-010/D2 — batch: 1 estimateTableRowsBatch cho CẢ schema thay vì
      // N estimateTableRows (1 mỗi table). Guard rỗng TRƯỚC khi gọi — 0 table
      // node → không issue query nào.
      if (category === "tables" && !isError) {
        const tableNodes = children.filter((c) => c.contextValue === "table");
        if (tableNodes.length > 0) {
          this.fetchRowCountsBatch(tableNodes, conn, schema);
        }
      }
    }

    // Filter output. Empty match → node "No matches for '<q>'".
    if (filterActive) {
      const filtered = children.filter((c) => this.matchesFilter(c.label));
      if (filtered.length === 0) {
        return [
          {
            label: `No matches for '${this.filterText}'`,
            contextValue: "empty-add",
            collapsible: vscode.TreeItemCollapsibleState.None,
          },
        ];
      }
      return filtered;
    }
    return children;
  }

  /**
   * TASK-010/D2 — Fire-and-forget fetch row count cho CẢ schema (1 round trip)
   * thay vì 1 fetch mỗi table. Giữ nguyên hành vi cũ:
   * - Per-table cache hit (rowCountCache, TTL 60s): set description sync, không
   *   đưa table đó vào batch request.
   * - Nếu MỌI table đều cache hit → không gọi estimateTableRowsBatch (0 query).
   * - In-flight dedup theo (connId, schema) — re-expand khi batch đang chạy sẽ
   *   không bắn thêm request.
   * - Table bị adapter OMIT khỏi Map (dropped mid-flight) hoặc count === null
   *   → giữ nguyên description fallback (schema), không set, không lỗi.
   * - Reject → nuốt lỗi, tree vẫn render đủ mọi table node (fire-and-forget).
   */
  private fetchRowCountsBatch(
    tableNodes: VsdbNode[],
    conn: ConnectionConfig,
    schema: string,
  ): void {
    const now = Date.now();
    const pendingNodes: VsdbNode[] = [];
    const pendingNames: string[] = [];
    for (const tNode of tableNodes) {
      const tName = tNode.meta?.objectName;
      if (!tName) continue;
      const key = `rowcount|${conn.id}|${schema}|${tName}`;
      const cached = this.rowCountCache.get(key);
      if (cached && cached.expiresAt > now) {
        tNode.description = formatRows(cached.data);
      } else {
        pendingNodes.push(tNode);
        pendingNames.push(tName);
      }
    }
    if (pendingNames.length === 0) return;

    const inFlightKey = `rowcountbatch|${conn.id}|${schema}`;
    if (this.rowCountFetching.has(inFlightKey)) return;
    this.rowCountFetching.add(inFlightKey);

    this.getAdapterFor(conn)
      .then((adapter) => adapter.estimateTableRowsBatch(schema, pendingNames))
      .then((counts) => {
        this.rowCountFetching.delete(inFlightKey);
        for (const tNode of pendingNodes) {
          const tName = tNode.meta?.objectName;
          if (!tName) continue;
          const count = counts.get(tName);
          // Omitted (dropped mid-flight) hoặc null → giữ schema fallback.
          if (count === undefined || count === null) continue;
          const key = `rowcount|${conn.id}|${schema}|${tName}`;
          this.rowCountCache.set(key, {
            data: count,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
          tNode.description = formatRows(count);
          // (review fix round C, Finding #7) — fire PER changed node instead
          // of `fire(undefined)` (whole-tree refresh). `undefined` tells VS
          // Code to re-query every node in the tree from root, which is far
          // more work than re-rendering just the table nodes whose row-count
          // description actually changed; `fire(tNode)` mirrors the existing
          // narrow pattern already used at the description-update call site
          // above (line ~479) for the same VsdbNode type.
          this._onDidChangeTreeData.fire(tNode);
        }
      })
      .catch(() => {
        this.rowCountFetching.delete(inFlightKey);
      });
  }

  // ---- Table columns ------------------------------------------------------

  private async getColumnChildren(node: VsdbNode): Promise<VsdbNode[]> {
    const conn = node.meta?.connection;
    const objectKey = node.meta?.objectKey;
    const schema = node.meta?.schema;
    const tableName = node.meta?.objectName;
    if (!conn || !objectKey || !tableName) return [];

    const key = `columns|${objectKey}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    let adapter: DbAdapter;
    try {
      adapter = await this.getAdapterFor(conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errNode: VsdbNode = {
        label: `Connect failed: ${message}`,
        icon: "error",
        contextValue: "error",
        collapsible: vscode.TreeItemCollapsibleState.None,
      };
      this.cache.set(key, {
        data: [errNode],
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return [errNode];
    }

    let columns;
    try {
      columns = await adapter.listColumns(tableName, schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errNode: VsdbNode = {
        label: `Failed to load columns: ${message}`,
        icon: "error",
        contextValue: "error",
        collapsible: vscode.TreeItemCollapsibleState.None,
      };
      this.cache.set(key, {
        data: [errNode],
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return [errNode];
    }

    const data: VsdbNode[] = columns.map((c) => ({
      label: c.name,
      description: c.dataType,
      icon: c.isPrimaryKey ? "key" : "symbol-field",
      tooltip: `${c.name}: ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.isPrimaryKey ? " PK" : ""}`,
      contextValue: "column",
      collapsible: vscode.TreeItemCollapsibleState.None,
      // Carry connection/schema/objectKey để getParent(column) → table hoạt
      // động (fix round 1 getParent).
      meta: {
        connection: conn,
        schema,
        objectKey,
        column: { name: c.name, dataType: c.dataType },
      },
    }));

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    // Filter output khi filter active.
    if (this.filterText !== "") {
      const filtered = data.filter((c) => this.matchesFilter(c.label));
      if (filtered.length === 0) {
        return [
          {
            label: `No matches for '${this.filterText}'`,
            contextValue: "empty-add",
            collapsible: vscode.TreeItemCollapsibleState.None,
          },
        ];
      }
      return filtered;
    }
    return data;
  }
  /**
   * TASK-005 — Locate the table node for (conn, schema, table).
   * Reuses the same path getCategoryChildren uses (adapter.listTables).
   * Returns null khi table không có trong schema / adapter fail.
   */
  async findTableNode(
    conn: ConnectionConfig,
    schema: string,
    table: string,
  ): Promise<VsdbNode | null> {
    let adapter: DbAdapter;
    try {
      adapter = await this.getAdapterFor(conn);
    } catch {
      return null;
    }
    let tables;
    try {
      tables = await adapter.listTables(schema);
    } catch {
      return null;
    }
    const hit = tables.find((t) => t.name === table && t.schema === schema);
    if (!hit) return null;
    return {
      label: hit.name,
      description: hit.schema,
      tooltip: `${hit.schema}.${hit.name}`,
      contextValue: "table",
      collapsible: vscode.TreeItemCollapsibleState.Collapsed,
      meta: {
        connection: conn,
        category: "columns",
        objectKey: `${conn.id}.${hit.schema}.${hit.name}`,
        schema: hit.schema,
        objectName: hit.name,
      },
      command: {
        command: "vsdb.copyQualifiedName",
        title: "Copy qualified name",
        arguments: [qualifiedName({ table: hit.name, schema: hit.schema })],
      },
    };
  }

  /**
   * TASK-003 — Locate the schema node for (conn, schema). Reuses the same
   * path getSchemaNodesForConnection uses (adapter.listSchemas(false)). Returns
   * null khi schema không có / adapter fail.
   */
  async findSchemaNode(
    conn: ConnectionConfig,
    schema: string,
  ): Promise<VsdbNode | null> {
    let adapter: DbAdapter;
    try {
      adapter = await this.getAdapterFor(conn);
    } catch {
      return null;
    }
    let schemas;
    try {
      schemas = await adapter.listSchemas(false);
    } catch {
      return null;
    }
    const hit = schemas.find((s) => s.name === schema);
    if (!hit) return null;
    return {
      label: hit.name,
      icon: "symbol-namespace",
      tooltip: `${conn.name} / ${hit.name}`,
      contextValue: "schema",
      collapsible: vscode.TreeItemCollapsibleState.Collapsed,
      meta: { connection: conn, schema: hit.name },
    };
  }

  /**
   * getParent — bắt buộc cho vscode.TreeView.reveal() (vscode.d.ts):
   * "This method should be implemented in order to access TreeView.reveal API".
   * Trước fix: thiếu → reveal throw "Tree item not found" → try/catch nuốt →
   * UI không reveal sau DDL. Sau fix: trả về ancestor đúng để vscode tìm được
   * đường đi xuống node.
   *
   * Quan hệ (theo meta):
   *   - connection → null (root)
   *   - schema    → connection
   *   - category  → schema
   *   - table     → category (Tables/Views/Routines)
   *   - column    → table (qua objectKey)
   *
   * Implementation: build parent node mỗi lần (cheap; chỉ khi reveal trigger).
   * Nếu meta thiếu → null (giống connection root).
   */
  getParent(node: VsdbNode): VsdbNode | null {
    const meta = node.meta;
    if (!meta) return null;

    if (node.contextValue === "connection") return null;

    if (node.contextValue === "schema") {
      const conn = meta.connection;
      if (!conn) return null;
      return {
        label: conn.name,
        icon: DRIVER_ICONS[conn.driver] ?? "database",
        tooltip: `${conn.name}\n${conn.driver}@${conn.host}:${conn.port}/${conn.database}\nClick để đổi active connection`,
        contextValue: "connection",
        // TASK-010/D3 — giữ nhất quán với getRoot(): connection nodes Collapsed.
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        command: {
          command: "vsdb.selectConnectionFromTree",
          title: "Select as Active Connection",
          arguments: [conn.id],
        },
        meta: { connection: conn },
      };
    }

    if (node.contextValue === "category") {
      const conn = meta.connection;
      const schema = meta.schema;
      if (!conn || !schema) return null;
      return {
        label: schema,
        icon: "symbol-namespace",
        tooltip: `${conn.name} / ${schema}`,
        contextValue: "schema",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, schema },
      };
    }

    if (node.contextValue === "table") {
      const conn = meta.connection;
      const schema = meta.schema;
      if (!conn || !schema) return null;
      // Parent = category node "Tables" (vì table nodes đều dưới Tables category).
      return {
        label: "Tables",
        icon: "table",
        contextValue: "category",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, schema, category: "tables" },
      };
    }

    if (node.contextValue === "column") {
      const conn = meta.connection;
      const schema = meta.schema;
      const objectKey = meta.objectKey;
      if (!conn || !schema || !objectKey) return null;
      // objectKey format: `${conn.id}.${schema}.${table}` → derive table name.
      const parts = objectKey.split(".");
      const tableName = parts.slice(2).join(".");
      return {
        label: tableName,
        description: schema,
        tooltip: `${schema}.${tableName}`,
        contextValue: "table",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: {
          connection: conn,
          category: "columns",
          objectKey,
          schema,
          objectName: tableName,
        },
      };
    }

    // view / routine / column / error / empty-add → no parent (or unknown)
    return null;
  }
}

// ---- Public utilities -------------------------------------------------------

/**
 * TASK-005 — Module-scoped reference to the singleton SchemaTreeProvider,
 * set once by extension.ts at activate(). revealTableNode below uses it to
 * locate the table node without taking an extra dependency arg.
 */
let _activeProvider: SchemaTreeProvider | null = null;
export function registerSchemaTreeProvider(p: SchemaTreeProvider): void {
  _activeProvider = p;
}
export function clearSchemaTreeProvider(): void {
  _activeProvider = null;
}

/**
 * TASK-005 — Reveal a table node in the schema tree after a DDL operation.
 * findTableNode may return null nếu absent (tree đang refresh / table vừa drop);
 * trong trường hợp đó → no-op. reveal() có thể throw nếu node đã dispose /
 * tree đã đóng → nuốt để caller không phải xử lý.
 */
export async function revealTableNode(
  treeView: vscode.TreeView<unknown>,
  conn: ConnectionConfig,
  schema: string,
  table: string,
): Promise<void> {
  if (!_activeProvider) return;
  const node = await _activeProvider.findTableNode(conn, schema, table);
  if (!node) return;
  try {
    await treeView.reveal(node, { select: true, expand: false });
  } catch {
    // Node có thể đã dispose / tree đã refresh → bỏ qua, command vẫn OK.
  }
}

/**
 * TASK-003 — Reveal a schema node in the schema tree after a DDL operation.
 * findSchemaNode may return null nếu absent (tree đang refresh); trong
 * trường hợp đó → no-op. reveal() có thể throw nếu node đã dispose /
 * tree đã đóng → nuốt để caller không phải xử lý.
 */
export async function revealSchemaNode(
  treeView: vscode.TreeView<unknown>,
  conn: ConnectionConfig,
  schema: string,
): Promise<void> {
  if (!_activeProvider) return;
  const node = await _activeProvider.findSchemaNode(conn, schema);
  if (!node) return;
  try {
    await treeView.reveal(node, { select: true, expand: false });
  } catch {
    // Node có thể đã dispose / tree đã refresh → bỏ qua.
  }
}

/** Trả về schema.name hoặc name nếu schema rỗng. */
export function qualifiedName(p: {
  table: string;
  schema: string;
}): string {
  return p.schema && p.schema.length > 0 ? `${p.schema}.${p.table}` : p.table;
}

/**
 * Format row count theo notation compact.
 * Pin locale 'en' để deterministic (Intl trên máy user có thể là vi/ja/...).
 * Examples: 176 → '176'; 1234567 → '1.2M'.
 */
export function formatRows(n: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/**
 * Generate SELECT template theo driver:
 * - postgres: SELECT * FROM [schema.]table LIMIT 100;
 * - mysql:    SELECT * FROM `[schema.]table` LIMIT 100;  (qualify khi schema khác rỗng)
 * - mssql:    SELECT TOP 100 * FROM [schema.]table;
 */
export function generateSelectForTable(p: {
  driver: ConnectionConfig["driver"];
  table: string;
  schema: string;
}): string {
  const qual = qualifiedName({ table: p.table, schema: p.schema });
  if (p.driver === "mssql") {
    return `SELECT TOP 100 * FROM ${qual};`;
  }
  if (p.driver === "mysql") {
    return p.schema && p.schema.length > 0
      ? `SELECT * FROM \`${p.schema}\`.\`${p.table}\` LIMIT 100;`
      : `SELECT * FROM \`${p.table}\` LIMIT 100;`;
  }
  // postgres
  return `SELECT * FROM ${qual} LIMIT 100;`;
}
