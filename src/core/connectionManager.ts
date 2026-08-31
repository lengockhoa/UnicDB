// src/core/connectionManager.ts
// ConnectionManager — CRUD + persistence cho connection (TASK-005).
//
// Quy tắc lưu trữ:
//   - Metadata (name/driver/host/port/user/database/ssl) → Memento
//     workspaceState nếu có workspace mở, globalState nếu không (design §8).
//   - Password → SecretStorage với key `vsdb.pass.<id>`.
//   - Active connection id → Memento `vsdb.activeConnection` (cùng scope với metadata).
//
// Test-connect: gọi adapter.testConnection() trước khi lưu (add/edit). Fail → throw, không lưu.
//
// Lazy connect: getAdapter() mở socket lần đầu, reset idle timer 10 phút. Mỗi lần gọi
// reset timer; nếu hết 10 phút không activity → adapter.close(). Query mới reconnect.
//
// Fallback (design §8):
//   - SecretStorage lỗi → KHÔNG lưu, hỏi password mỗi lần connect (ở đây ta KHÔNG crash
//     add/edit — nếu store fail thì skip, vẫn cho phép ghi metadata).
//   - Không có workspace → lưu vào globalState thay vì workspaceState.
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { DbAdapter } from "../adapters/types";
import {
  isMutationSql,
  mutationStatements,
  ReadOnlyViolation,
} from "./readOnlyIntent";
import { SshTunnelManager } from "./sshTunnelManager";

const KEY_CONNECTIONS = "vsdb.connections";
const KEY_ACTIVE = "vsdb.activeConnection";
const KEY_PASS_PREFIX = "vsdb.pass.";

/** 10 phút idle. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface InternalState {
  connections: ConnectionConfig[];
  activeId: string | null;
}

export type AdapterFactory = (cfg: ConnectionConfig, password: string) => DbAdapter;

export class ConnectionManager {
  /** DBX-05: SSH tunnel lifecycle owner (started lazily per connection id). */
  private readonly tunnels: SshTunnelManager;
  private state: InternalState = { connections: [], activeId: null };
  private currentAdapter: DbAdapter | null = null;
  private currentActiveId: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Cache adapters for NON-active connections (e.g. used by SchemaTreeProvider when
   * expanding non-active connections). Manager owns them — closed on dispose /
   * editConnection / deleteConnection. Single ownership: callers MUST NOT close
   * adapters returned by `getAdapterFor`.
   */
  private readonly passiveAdapters = new Map<string, DbAdapter>();

  private readonly _onDidChangeActiveEmitter: vscode.EventEmitter<ConnectionConfig | null>;
  /** Fires khi active connection đổi (set/delete). */
  readonly onDidChangeActive: vscode.Event<ConnectionConfig | null>;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly factory: AdapterFactory,
    /** DBX-05: injectable tunnel manager (tests pass a fake). */
    tunnels?: SshTunnelManager,
  ) {
    this.tunnels = tunnels ?? new SshTunnelManager();
    this._onDidChangeActiveEmitter = new vscode.EventEmitter<ConnectionConfig | null>();
    this.onDidChangeActive = this._onDidChangeActiveEmitter.event;
    // Load state khi khởi tạo.
    this.loadState();
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Thêm connection mới. Test-connect trước; fail → throw, không lưu gì.
   * Lưu metadata + password; KHÔNG active ngay (user phải gọi setActive riêng).
   */
  async addConnection(cfg: ConnectionConfig, password: string): Promise<void> {
    // Test-connect qua resolver (DBX-05: tunnel-aware — probe đi qua
    // 127.0.0.1:<localPort> như adapter thật). Nếu fail → không lưu.
    const probe = await this.resolveAdapter(cfg, password);
    let probeOk = false;
    try {
      await probe.testConnection();
      probeOk = true;
    } finally {
      // Đóng probe để tránh leak socket.
      try {
        await probe.close();
      } catch {
        // ignore
      }
      // Probe tunnel (nếu có) không được rò rỉ khi add thất bại.
      if (!probeOk) this.stopTunnel(cfg.id);
    }


    // Lưu metadata vào state Memento đã chọn.
    this.state.connections.push({ ...cfg });
    await this.persistConnections();

    // Lưu password vào SecretStorage (try — nếu lỗi vẫn giữ metadata, để caller xử lý).
    await this.tryStorePassword(cfg.id, password);

    this.fireConnectionsChanged();
  }

  /**
   * Sửa connection. Test-connect lại với password mới (nếu đổi); fail → throw, không lưu.
   * Nếu connection đang active → đóng adapter cũ (sẽ reconnect lazy ở getAdapter kế tiếp).
   */
  async editConnection(
    id: string,
    patch: Partial<ConnectionConfig>,
    password?: string,
  ): Promise<void> {
    const idx = this.state.connections.findIndex((c) => c.id === id);
    if (idx < 0) {
      throw new Error(`Connection "${id}" không tồn tại`);
    }
    const old = this.state.connections[idx];
    const next: ConnectionConfig = { ...old, ...patch, id: old.id };

    // Test-connect lại nếu có đổi password HOẶC đổi bất kỳ trường nào khác (driver/host/...).
    // An toàn nhất: luôn test-connect. DBX-05: probe đi qua resolver để tunnel
    // config mới được dùng ngay trong lúc test.
    const testPassword = password ?? (await this.tryGetPassword(id)) ?? "";
    const probe = await this.resolveAdapter(next, testPassword);
    let probeOk = false;
    try {
      await probe.testConnection();
      probeOk = true;
    } finally {
      try {
        await probe.close();
      } catch {
        // ignore
      }
      // Nếu edit thất bại, đừng để tunnel mới của probe treo.
      if (!probeOk) this.stopTunnel(id);
    }

    // Commit changes.
    this.state.connections[idx] = next;
    await this.persistConnections();

    if (password !== undefined) {
      await this.tryStorePassword(id, password);
    }

    // Nếu connection đang active → đóng adapter để reconnect với config mới.
    if (this.currentActiveId === id && this.currentAdapter) {
      await this.closeCurrentAdapter();
    }
    // Config changed → drop any cached passive adapter so next getAdapterFor reconnects.
    await this.closePassiveAdapter(id);
    // DBX-05: config changed → old tunnel (if any) must be replaced on next use.
    this.stopTunnel(id);

    this.fireConnectionsChanged();
    if (this.currentActiveId === id) {
      this._onDidChangeActiveEmitter.fire(next);
    }
  }

  /**
   * Xoá connection. Nếu đang active → đóng adapter + clear active.
   */
  async deleteConnection(id: string): Promise<void> {
    const idx = this.state.connections.findIndex((c) => c.id === id);
    if (idx < 0) return; // idempotent
    const wasActive = this.currentActiveId === id;
    this.state.connections.splice(idx, 1);
    await this.persistConnections();
    await this.tryDeletePassword(id);

    if (wasActive) {
      await this.closeCurrentAdapter();
      this.state.activeId = null;
      this.currentActiveId = null;
      await this.persistActive();
      this._onDidChangeActiveEmitter.fire(null);
    }
    // Drop any cached passive adapter to free the socket.
    await this.closePassiveAdapter(id);
    // DBX-05: no connection, no tunnel.
    this.stopTunnel(id);
    this.fireConnectionsChanged();
  }

  /** Danh sách connections hiện tại (copy). */
  listConnections(): ConnectionConfig[] {
    return this.state.connections.slice();
  }

  /** Password đã store cho connection (SecretStorage); undefined nếu lỗi/chưa có. */
  async getStoredPassword(id: string): Promise<string | undefined> {
    return this.tryGetPassword(id);
  }

  /** Connection đang active (null nếu chưa chọn). */
  getActive(): ConnectionConfig | null {
    if (!this.state.activeId) return null;
    return this.state.connections.find((c) => c.id === this.state.activeId) ?? null;
  }

  /**
   * Chuyển active sang connection `id`. Đóng adapter cũ (nếu có).
   * Lưu id vào Memento. KHÔNG eagerly mở socket — getAdapter() mới lazy connect.
   */
  async setActive(id: string): Promise<void> {
    const cfg = this.state.connections.find((c) => c.id === id);
    if (!cfg) {
      throw new Error(`Connection "${id}" không tồn tại`);
    }
    if (this.currentActiveId === id) {
      // Đã active — chỉ đảm bảo persisted.
      this.state.activeId = id;
      await this.persistActive();
      return;
    }

    // Đóng adapter cũ trước khi chuyển.
    await this.closeCurrentAdapter();

    this.state.activeId = id;
    this.currentActiveId = id;
    await this.persistActive();

    this._onDidChangeActiveEmitter.fire(cfg);
  }

  /**
   * Lấy adapter cho connection `cfg` (KHÔNG đổi active). Dùng cho schema tree khi user
   * expand một connection không phải active.
   *
   * Manager owns the cached adapter (single ownership — callers MUST NOT close it).
   * Adapter is closed on dispose(), editConnection, deleteConnection.
   * Throw nếu không lấy được password từ SecretStorage hoặc testConnection fail.
   */
  async getAdapterFor(cfg: ConnectionConfig): Promise<DbAdapter> {
    // Reuse cached passive adapter if present (avoid socket leak on every expansion).
    const cached = this.passiveAdapters.get(cfg.id);
    if (cached) {
      return cached;
    }

    let password: string | undefined;
    try {
      password = await this.tryGetPassword(cfg.id);
    } catch {
      password = undefined;
    }
    if (password === undefined || password === null) {
      throw new Error(
        `Không tìm được password cho connection "${cfg.name}". Vui lòng nhập lại password (edit connection).`,
      );
    }
    const adapter = this.guardAdapter(await this.resolveAdapter(cfg, password), cfg);
    try {
      await adapter.testConnection();
    } catch (err) {
      try {
        await adapter.close();
      } catch {
        // ignore
      }
      throw err;
    }
    this.passiveAdapters.set(cfg.id, adapter);
    return adapter;
  }

  /**
   * Close + drop any cached passive adapter for connection `id`. Used by
   * editConnection (config changed → reconnect) and deleteConnection (removed).
   * Idempotent.
   */
  private async closePassiveAdapter(id: string): Promise<void> {
    const adapter = this.passiveAdapters.get(id);
    if (!adapter) return;
    this.passiveAdapters.delete(id);
    try {
      await adapter.close();
    } catch {
      // ignore
    }
  }

  /**
   * Lấy adapter hiện tại (lazy connect). Reset idle timer 10 phút mỗi lần gọi.
   * Throw nếu không có active hoặc password không lấy được từ SecretStorage.
   */
  async getAdapter(): Promise<DbAdapter> {
    const active = this.getActive();
    if (!active) {
      throw new Error("Chưa chọn connection active");
    }
    if (!this.currentAdapter || this.currentActiveId !== active.id) {
      // Lazy connect: tạo adapter mới.
      let password: string | undefined;
      try {
        password = await this.ctx.secrets.get(KEY_PASS_PREFIX + active.id);
      } catch {
        password = undefined;
      }
      if (password === undefined || password === null) {
        throw new Error(
          `Không tìm được password cho connection "${active.name}". Vui lòng nhập lại password (edit connection).`,
        );
      }
      const adapter = this.guardAdapter(await this.resolveAdapter(active, password), active);
      try {
        await adapter.testConnection();
      } catch (err) {
        // Đóng adapter nếu test-connect fail để tránh leak.
        try {
          await adapter.close();
        } catch {
          // ignore
        }
        throw err;
      }
      this.currentAdapter = adapter;
      this.currentActiveId = active.id;
    }
    this.resetIdleTimer();
    return this.currentAdapter;
  }

  /** Dispose: đóng tất cả adapters (active + passive), clear timer. */
  async dispose(): Promise<void> {
    await this.closeCurrentAdapter();
    // Close every cached passive adapter to avoid socket leaks across reloads.
    const ids = Array.from(this.passiveAdapters.keys());
    for (const id of ids) {
      await this.closePassiveAdapter(id);
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // DBX-05: never leak ssh processes on extension reload/dispose.
    this.tunnels.stopAll();
    // _onDidChangeActiveEmitter is owned by the extension context (subscribed
    // to context.subscriptions); do NOT dispose it here — doing so would
    // also drop listeners that are still active on a reloaded window.
  }

  /**
   * DBX-05 — tunnel + read-only helpers.
   * `resolveAdapter` builds the EFFECTIVE adapter config: when a tunnel is
   * configured, the adapter connects to 127.0.0.1:<bound local port> while
   * the persisted metadata keeps the original host/port.
   * `guardAdapter` enforces read-only intent BEFORE any statement leaves the
   * extension (mutation → ReadOnlyViolation, no network I/O).
   */
  private async resolveAdapter(
    cfg: ConnectionConfig,
    password: string,
  ): Promise<DbAdapter> {
    let effective = cfg;
    if (cfg.tunnel) {
      // `port` = bastion SSH port (default 22); `targetPort` = the DATABASE
      // port to forward to from the bastion — they are different by design.
      const handle = await this.tunnels.start(
        {
          ...cfg.tunnel,
          port: cfg.tunnel.port ?? 22,
          targetPort: cfg.port,
        },
        cfg.id,
      );
      effective = {
        ...cfg,
        host: "127.0.0.1",
        port: handle.localPort,
      };
    }
    return this.factory(effective, password);
  }

  private guardAdapter(adapter: DbAdapter, cfg: ConnectionConfig): DbAdapter {
    if (!cfg.readOnly) return adapter;
    const original = adapter.runQuery.bind(adapter);
    // Replace the runQuery property on the same object — preserves the
    // prototype chain (matters for close/testConnection called by dispose).
    Object.defineProperty(adapter, "runQuery", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (sql: string) => {
        if (isMutationSql(sql)) {
          throw new ReadOnlyViolation(mutationStatements(sql));
        }
        return original(sql);
      },
    });
    return adapter;
  }

  /** Expose tunnel mutation for edit/delete (stop the old tunnel). */
  stopTunnel(id: string): void {
    this.tunnels.stop(id);
  }

  // ---- Private -------------------------------------------------------------

  /** Chọn Memento (workspaceState nếu có folder, globalState nếu không). */
  private pickMemento(): vscode.Memento {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return this.ctx.workspaceState;
    }
    return this.ctx.globalState;
  }

  private async loadState(): Promise<void> {
    const m = this.pickMemento();
    const list = m.get<ConnectionConfig[]>(KEY_CONNECTIONS);
    if (Array.isArray(list)) {
      this.state.connections = list.slice();
    }
    const active = m.get<string>(KEY_ACTIVE);
    if (typeof active === "string" && this.state.connections.some((c) => c.id === active)) {
      this.state.activeId = active;
      this.currentActiveId = active;
    }
  }

  private async persistConnections(): Promise<void> {
    const m = this.pickMemento();
    await m.update(KEY_CONNECTIONS, this.state.connections);
  }

  private async persistActive(): Promise<void> {
    const m = this.pickMemento();
    if (this.state.activeId) {
      await m.update(KEY_ACTIVE, this.state.activeId);
    } else {
      await m.update(KEY_ACTIVE, undefined);
    }
  }

  private async tryStorePassword(id: string, password: string): Promise<void> {
    try {
      await this.ctx.secrets.store(KEY_PASS_PREFIX + id, password);
    } catch {
      // design §8 fallback: SecretStorage lỗi → KHÔNG lưu, sẽ hỏi mỗi lần connect.
      // Metadata vẫn được lưu.
    }
  }

  private async tryGetPassword(id: string): Promise<string | undefined> {
    try {
      return await this.ctx.secrets.get(KEY_PASS_PREFIX + id);
    } catch {
      return undefined;
    }
  }

  private async tryDeletePassword(id: string): Promise<void> {
    try {
      await this.ctx.secrets.delete(KEY_PASS_PREFIX + id);
    } catch {
      // ignore
    }
  }

  private async closeCurrentAdapter(): Promise<void> {
    if (this.currentAdapter) {
      try {
        await this.currentAdapter.close();
      } catch {
        // ignore
      }
      this.currentAdapter = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      // Idle timeout → đóng adapter. KHÔNG clear currentActiveId để getAdapter biết
      // connection nào cần reconnect. currentAdapter = null ở đây là đủ.
      this.closeCurrentAdapter();
    }, IDLE_TIMEOUT_MS);
  }

  private fireConnectionsChanged(): void {
    // Hiện không có event cho connections list; statusbar polling qua getActive.
  }
}