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
    this._onDidChangeTreeData.fire(undefined);
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
    return this.mgr.listConnections().map((c) => ({
      label: c.name,
      icon: DRIVER_ICONS[c.driver] ?? "database",
      tooltip: `${c.name}\n${c.driver}@${c.host}:${c.port}/${c.database}\nClick để đổi active connection`,
      contextValue: "connection",
      collapsible: vscode.TreeItemCollapsibleState.Expanded,
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
        children = schemas.map((s) => ({
          label: s.name,
          icon: "symbol-namespace",
          tooltip: `${conn.name} / ${s.name}`,
          contextValue: "schema",
          collapsible: vscode.TreeItemCollapsibleState.Collapsed,
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
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    return [
      {
        label: "Tables",
        icon: "table",
        contextValue: "category",
        collapsible: collapsed,
        meta: { connection: conn, schema, category: "tables" },
      },
      {
        label: "Views",
        icon: "eye",
        contextValue: "category",
        collapsible: collapsed,
        meta: { connection: conn, schema, category: "views" },
      },
      {
        label: "Routines",
        icon: "symbol-function",
        contextValue: "category",
        collapsible: collapsed,
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

    // Cache check.
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

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

    let children: VsdbNode[];
    try {
      if (category === "tables") {
        const tables = await adapter.listTables(schema);
        children = tables.map((t) => ({
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
          command: {
            command: "vsdb.copyQualifiedName",
            title: "Copy qualified name",
            arguments: [qualifiedName({ table: t.name, schema: t.schema })],
          },
        }));
      } else if (category === "views") {
        const views = await adapter.listViews(schema);
        children = views.map((v) => ({
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
          command: {
            command: "vsdb.copyQualifiedName",
            title: "Copy qualified name",
            arguments: [qualifiedName({ table: v.name, schema: v.schema })],
          },
        }));
      } else {
        const routines = await adapter.listRoutines(schema);
        children = routines.map((r) => ({
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
      children = [
        {
          label: `Connect failed: ${message}`,
          icon: "error",
          contextValue: "error",
          collapsible: vscode.TreeItemCollapsibleState.None,
        },
      ];
    }

    // DataGrip-like count badge: cập nhật description + re-render sau khi load.
    const isError = children.length === 1 && children[0].contextValue === "error";
    if (!isError) {
      node.description = String(children.length);
      this._onDidChangeTreeData.fire(node);
    }

    this.cache.set(key, {
      data: children,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return children;
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
      meta: { column: { name: c.name, dataType: c.dataType } },
    }));

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return data;
  }
}

// ---- Public utilities -------------------------------------------------------

/** Trả về schema.name hoặc name nếu schema rỗng. */
export function qualifiedName(p: {
  table: string;
  schema: string;
}): string {
  return p.schema && p.schema.length > 0 ? `${p.schema}.${p.table}` : p.table;
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
