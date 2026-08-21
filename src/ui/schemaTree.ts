// src/ui/schemaTree.ts
// SchemaTreeProvider — TreeDataProvider cho "Schema Explorer" view.
//
// Node types:
//   - "connection"          : mỗi connection trong ConnectionManager (active có chấm xanh).
//   - "category"            : "Tables" / "Views" / "Routines"
//   - "table" / "view"      : tên table/view với schema + qualifiedName
//   - "routine"             : function/procedure
//   - "column"              : column trong table
//   - "error"               : node báo lỗi khi adapter throw
//   - "empty-add"           : placeholder "Add Connection" khi rỗng
//
// Caching: 60s theo (connectionId, category). Refresh invalidates cache và fire onDidChangeTreeData.
//
// Util cho Generate SELECT / Copy qualified name được export để extension.ts dùng.
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import type { DbAdapter } from "../adapters/types";

export type CategoryKind = "tables" | "views" | "routines" | "columns";

export interface VsdbNode {
  /** Hiển thị trong tree. */
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
      item.iconPath = new vscode.ThemeIcon(node.icon);
    }
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    if (node.command) item.command = node.command;
    item.contextValue = node.contextValue;
    return item;
  }

  async getChildren(node: VsdbNode | undefined): Promise<VsdbNode[]> {
    try {
      if (node === undefined) {
        return this.getRoot();
      }
      if (node.contextValue === "connection") {
        return this.getCategoriesForConnection(node);
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
    const conns = this.mgr.listConnections();
    if (conns.length === 0) {
      return [
        {
          label: "No connections. Click + to add.",
          contextValue: "empty-add",
          collapsible: vscode.TreeItemCollapsibleState.None,
          command: {
            command: "vsdb.addConnection",
            title: "Add Connection",
          },
        },
      ];
    }
    const active = this.mgr.getActive();
    return conns.map((c) => ({
      label: `${active && active.id === c.id ? "$(pass-filled) " : ""}${c.name}`,
      tooltip: `${c.name}\n${c.driver}@${c.host}:${c.port}/${c.database}\nClick để đổi active connection`,
      contextValue: "connection",
      collapsible: vscode.TreeItemCollapsibleState.Collapsed,
      // Click → switch active (cập nhật statusBar + chấm xanh ở root).
      command: {
        command: "vsdb.selectConnectionFromTree",
        title: "Select as Active Connection",
        arguments: [c.id],
      },
      meta: { connection: c },
    }));
  }

  private getCategoriesForConnection(node: VsdbNode): VsdbNode[] {
    const conn = node.meta?.connection;
    if (!conn) return [];
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    return [
      {
        label: "Tables",
        icon: "table",
        contextValue: "category",
        collapsible: collapsed,
        meta: { connection: conn, category: "tables" },
      },
      {
        label: "Views",
        icon: "eye",
        contextValue: "category",
        collapsible: collapsed,
        meta: { connection: conn, category: "views" },
      },
      {
        label: "Routines",
        icon: "symbol-function",
        contextValue: "category",
        collapsible: collapsed,
        meta: { connection: conn, category: "routines" },
      },
    ];
  }

  // ---- Category children: tables/views/routines ----------------------------

  private async getCategoryChildren(node: VsdbNode): Promise<VsdbNode[]> {
    const conn = node.meta?.connection;
    const category = node.meta?.category;
    if (!conn || !category) return [];
    const key = `category|${conn.id}|${category}`;

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
        const tables = await adapter.listTables();
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
        const views = await adapter.listViews();
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
        const routines = await adapter.listRoutines();
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
 * - mysql:    SELECT * FROM `table` LIMIT 100;  (không schema thông thường)
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
    return `SELECT * FROM \`${p.table}\` LIMIT 100;`;
  }
  // postgres
  return `SELECT * FROM ${qual} LIMIT 100;`;
}
