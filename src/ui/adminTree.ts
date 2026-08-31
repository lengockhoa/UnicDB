// src/ui/adminTree.ts
// AdminTreeProvider — TreeDataProvider cho "Admin" view (TASK-AHL-002).
//
// Quy tắc cứng:
//   - DBX-08: Admin category chỉ xuất hiện khi adapter DECLARE `admin`
//     (hasAdapterCapability, fail-closed). False/missing declaration → đúng
//     MỘT explanation node verbatim `ADMIN_UNSUPPORTED_LABEL`, KHÔNG gọi bất
//     kỳ AdminApi method nào (gate chạy trước mọi structural access).
//   - Sub-categories: Roles, Sessions, Locks. Grants hiển thị như sub của Role
//     (lazy; expand Role → listRoleGrants).
//   - Probe fail → `admin_error` node mang PG error code (vd 42501) cho user.
//   - Cache: 60s TTL, key theo (connId, adminKind). Refresh qua `vsdb.admin.refresh`.
//
// Node `meta.adminKind` discriminator cho phép getChildren dispatch an toàn.
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import { hasAdapterCapability, type DbAdapter } from "../adapters/types";
// DBX-08 — single source of truth for the pinned unsupported-admin wording
// (owned by adminSessionsPanel; the tree re-exports it as its node label).
import { ADMIN_UNSUPPORTED_MESSAGE } from "./adminSessionsPanel";

/**
 * DBX-08 — verbatim root label for a connection whose adapter does NOT declare
 * the `admin` capability (false, missing, or partial declaration). Pinned by
 * TASK-DBX08-003 Test Case #4; do not reword.
 */
export const ADMIN_UNSUPPORTED_LABEL = ADMIN_UNSUPPORTED_MESSAGE;

/** Discriminator cho admin node (phân biệt với schemaTree category). */
export type AdminKind =
  | "admin_category"
  | "roles"
  | "role"
  | "role_grant"
  | "sessions"
  | "session"
  | "locks"
  | "lock_wait"
  | "admin_error"
  | "admin_unsupported";

export interface AdminNode {
  label: string;
  icon?: string;
  description?: string;
  tooltip?: string;
  /** Discriminator; map sang `contextValue` cho menu contributions. */
  contextValue: AdminKind;
  collapsible: vscode.TreeItemCollapsibleState;
  command?: { command: string; title: string; arguments?: unknown[] };
  meta?: {
    connection?: ConnectionConfig;
    adminKind?: AdminKind;
    role?: string;
    pid?: number;
  };
}

const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/** Build a tree-friendly error node carrying the PG error code when present. */
function adminErrorNode(op: string, err: unknown): AdminNode {
  const message = err instanceof Error ? err.message : String(err);
  // Surface PG SQLSTATE 42501 (insufficient_privilege) for visibility.
  const codeMatch = /(?:\b|^)([0-9A-Z]{5})(?:\b|$)/.exec(message);
  const code = codeMatch ? codeMatch[1] : undefined;
  const label = code
    ? `Failed to load ${op} (${code}): ${message}`
    : `Failed to load ${op}: ${message}`;
  return {
    label,
    icon: "error",
    contextValue: "admin_error",
    collapsible: vscode.TreeItemCollapsibleState.None,
  };
}

/** Test seam: tránh vscode import trong test. Caller truyền connectionList thẳng. */
export interface AdminTreeOptions {
  /** Override default cache TTL (default 60_000). Test only. */
  cacheTtlMs?: number;
}

export class AdminTreeProvider implements vscode.TreeDataProvider<AdminNode> {
  private readonly mgr: ConnectionManager;
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<AdminNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache = new Map<string, CacheEntry<AdminNode[]>>();
  private activeSub: { dispose(): void } | null = null;
  private readonly ttl: number;

  constructor(mgr: ConnectionManager, opts: AdminTreeOptions = {}) {
    this.mgr = mgr;
    this.ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
    this.activeSub = this.mgr.onDidChangeActive(() =>
      this._onDidChangeTreeData.fire(undefined),
    );
  }

  /** Public API cho extension.ts gọi khi user bấm `vsdb.admin.refresh`. */
  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Dispose: clear cache + drop active subscription. */
  dispose(): void {
    this.cache.clear();
    if (this.activeSub) {
      this.activeSub.dispose();
      this.activeSub = null;
    }
    this._onDidChangeTreeData.dispose();
  }

  // ---- vscode TreeDataProvider -------------------------------------------

  getTreeItem(node: AdminNode): vscode.TreeItem {
    return node;
  }

  async getChildren(element?: AdminNode): Promise<AdminNode[]> {
    if (!element) {
      // Root: 1 admin node per Postgres connection; mysql/mssql are skipped.
      return this.getRootChildren();
    }
    if (element.contextValue === "admin_category") {
      return this.getAdminCategoryChildren(element);
    }
    if (element.contextValue === "roles") {
      return this.getRolesChildren(element);
    }
    if (element.contextValue === "role") {
      return this.getRoleGrantsChildren(element);
    }
    if (element.contextValue === "sessions") {
      return this.getSessionsChildren(element);
    }
    if (element.contextValue === "locks") {
      return this.getLocksChildren(element);
    }
    return [];
  }

  // ---- resolution helpers -------------------------------------------------

  private async getAdapterFor(conn: ConnectionConfig): Promise<DbAdapter> {
    const active = this.mgr.getActive();
    if (active && active.id === conn.id) {
      return await this.mgr.getAdapter();
    }
    return await this.mgr.getAdapterFor(conn);
  }

  private cacheGet<T>(key: string): T | undefined {
    const e = this.cache.get(key);
    if (e && e.expiresAt > Date.now()) return e.data as T;
    return undefined;
  }

  private cacheSet<T extends AdminNode[]>(key: string, data: T): void {
    this.cache.set(key, { data: data as AdminNode[], expiresAt: Date.now() + this.ttl });
  }

  private async getRootChildren(): Promise<AdminNode[]> {
    const conns = this.mgr.listConnections();
    const out: AdminNode[] = [];
    for (const conn of conns) {
      let adapter: DbAdapter | null = null;
      try {
        adapter = await this.getAdapterFor(conn);
      } catch {
        // Probe fail (can't connect) → omit. Don't surface an error node at
        // root; the existing schema tree / connection tree handles it.
        continue;
      }
      // DBX-08 — admission is the DECLARED admin capability, never structural
      // `adapter.admin` presence. The gate must fire BEFORE any access to
      // adapter.admin (no AdminApi member is reached on a non-admin adapter);
      // false/missing declaration → one verbatim explanation node instead of
      // silent omission.
      if (!hasAdapterCapability(adapter, "admin")) {
        out.push({
          label: ADMIN_UNSUPPORTED_LABEL,
          contextValue: "admin_unsupported",
          collapsible: vscode.TreeItemCollapsibleState.None,
          meta: { connection: conn },
        });
        continue;
      }
      out.push({
        label: `Admin (${conn.name})`,
        icon: "shield",
        contextValue: "admin_category",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, adminKind: "admin_category" },
      });
    }
    return out;
  }

  private async getAdminCategoryChildren(node: AdminNode): Promise<AdminNode[]> {
    const conn = node.meta?.connection;
    if (!conn) return [];
    const key = `admin|${conn.id}|root`;
    const cached = this.cacheGet<AdminNode[]>(key);
    if (cached) return cached;
    const out: AdminNode[] = [
      {
        label: "Roles",
        icon: "person",
        contextValue: "roles",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, adminKind: "roles" },
      },
      {
        label: "Sessions",
        icon: "pulse",
        contextValue: "sessions",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, adminKind: "sessions" },
      },
      {
        label: "Locks",
        icon: "lock",
        contextValue: "locks",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, adminKind: "locks" },
      },
    ];
    this.cacheSet(key, out);
    return out;
  }

  private async getRolesChildren(node: AdminNode): Promise<AdminNode[]> {
    const conn = node.meta?.connection;
    if (!conn) return [];
    const key = `admin|${conn.id}|roles`;
    const cached = this.cacheGet<AdminNode[]>(key);
    if (cached) return cached;
    let out: AdminNode[];
    try {
      const adapter = await this.getAdapterFor(conn);
      if (!adapter.admin) return [];
      const roles = await adapter.admin.listRoles();
      out = roles.map((r) => ({
        label: r.name,
        icon: "person",
        description: r.canLogin
          ? r.isSuperuser
            ? "SUPERUSER"
            : "login"
          : "no-login",
        contextValue: "role",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        meta: { connection: conn, adminKind: "role", role: r.name },
      }));
    } catch (err) {
      out = [adminErrorNode("listRoles", err)];
    }
    this.cacheSet(key, out);
    return out;
  }

  private async getRoleGrantsChildren(node: AdminNode): Promise<AdminNode[]> {
    const conn = node.meta?.connection;
    const role = node.meta?.role;
    if (!conn || !role) return [];
    const key = `admin|${conn.id}|role|${role}`;
    const cached = this.cacheGet<AdminNode[]>(key);
    if (cached) return cached;
    let out: AdminNode[];
    try {
      const adapter = await this.getAdapterFor(conn);
      if (!adapter.admin) return [];
      const grants = await adapter.admin.listRoleGrants(role);
      out = grants.map((g) => ({
        label: `${g.schema}.${g.object}`,
        icon: "key",
        description: g.privileges.join(", "),
        contextValue: "role_grant",
        collapsible: vscode.TreeItemCollapsibleState.None,
        meta: { connection: conn, adminKind: "role_grant" },
      }));
    } catch (err) {
      out = [adminErrorNode("listRoleGrants", err)];
    }
    this.cacheSet(key, out);
    return out;
  }

  private async getSessionsChildren(node: AdminNode): Promise<AdminNode[]> {
    const conn = node.meta?.connection;
    if (!conn) return [];
    const key = `admin|${conn.id}|sessions`;
    const cached = this.cacheGet<AdminNode[]>(key);
    if (cached) return cached;
    let out: AdminNode[];
    try {
      const adapter = await this.getAdapterFor(conn);
      if (!adapter.admin) return [];
      const sessions = await adapter.admin.listSessions();
      out = sessions.map((s) => ({
        label: `pid ${s.pid} (${s.usename})`,
        icon: "pulse",
        description: `${s.state} ${s.durationMs}ms`,
        contextValue: "session",
        collapsible: vscode.TreeItemCollapsibleState.None,
        meta: { connection: conn, adminKind: "session", pid: s.pid },
      }));
    } catch (err) {
      out = [adminErrorNode("listSessions", err)];
    }
    this.cacheSet(key, out);
    return out;
  }

  private async getLocksChildren(node: AdminNode): Promise<AdminNode[]> {
    const conn = node.meta?.connection;
    if (!conn) return [];
    const key = `admin|${conn.id}|locks`;
    const cached = this.cacheGet<AdminNode[]>(key);
    if (cached) return cached;
    let out: AdminNode[];
    try {
      const adapter = await this.getAdapterFor(conn);
      if (!adapter.admin) return [];
      const locks = await adapter.admin.listLockWaits();
      out = locks.map((l) => ({
        label: `pid ${l.blockedPid} ← pid ${l.blockingPid}`,
        icon: "lock",
        description: `${l.lockType} (${l.mode})${l.relation ? " on " + l.relation : ""}`,
        contextValue: "lock_wait",
        collapsible: vscode.TreeItemCollapsibleState.None,
        meta: {
          connection: conn,
          adminKind: "lock_wait",
          pid: l.blockedPid,
        },
      }));
    } catch (err) {
      out = [adminErrorNode("listLockWaits", err)];
    }
    this.cacheSet(key, out);
    return out;
  }
}
