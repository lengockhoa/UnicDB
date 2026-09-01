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
import type { TunnelExit } from "./sshTunnelManager";

const KEY_CONNECTIONS = "vsdb.connections";
const KEY_ACTIVE = "vsdb.activeConnection";
const KEY_PASS_PREFIX = "vsdb.pass.";

/** 10 phút idle. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** RLX-03 TASK-RLX03-002 — default inter-attempt recovery delay (ms). */
export const DEFAULT_RECOVERY_DELAY_MS = 1_000;

/** Pinned max attempts for the bounded recovery loop. */
const RECOVERY_MAX_ATTEMPTS = 2;

/**
 * RLX-03 TASK-RLX03-002 — injectable recovery timing. The `sleep` injection
 * is what makes the recovery loop testable without real time.
 */
export interface ConnectionRecoveryOptions {
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * RLX-03 TASK-RLX03-002 — observable recovery status. `attempt` is 1-based;
 * `maxAttempts` is always 2 for the bounded loop.
 */
export interface ConnectionRecoveryStatus {
  readonly connectionId: string;
  readonly state: "recovering" | "recovered" | "failed";
  readonly attempt: number;
  readonly maxAttempts: number;
}

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

  /** RLX-03 TASK-RLX03-002 — bounded recovery status events. */
  private readonly _onDidChangeRecoveryStatusEmitter: vscode.EventEmitter<ConnectionRecoveryStatus>;
  readonly onDidChangeRecoveryStatus: vscode.Event<ConnectionRecoveryStatus>;

  /**
   * RLX-03 TASK-RLX03-002 — generation guards. `activeGeneration` bumps
   * synchronously on every active-affecting operation (setActive, edit,
   * delete) so any in-flight recovery for a stale id silently aborts.
   * `lifecycleGeneration` bumps synchronously on dispose so any in-flight
   * recovery (including one mid-sleep) silently aborts. The recovery loop
   * captures both at entry and re-checks before/after every await.
   */
  private activeGeneration = 0;
  private lifecycleGeneration = 0;
  /**
   * RLX-03 fix round 1 — set synchronously BEFORE any disposal await so an
   * exit delivered after dispose() can never start a new recovery during
   * shutdown (the generation bump alone is not enough: an exit captured
   * after the bump would match the bumped generation).
   */
  private disposed = false;
  /**
   * ARP-02.3 TASK-ARP02-003 — per-connection revision counter. Bumped
   * synchronously (BEFORE any await) by add/edit/delete so an in-flight
   * PASSIVE connect (`getAdapterFor`) can detect that its snapshot is stale
   * when it resumes — mirroring the RLX-03 `activeGeneration` discipline that
   * already guards the ACTIVE path.
   */
  private connRevisions = new Map<string, number>();

  /** Tunnel-exit subscription handle — disposed in dispose(). */
  private tunnelExitSub: { dispose(): void } | null = null;
  /**
   * Per-active-id recovery loop promise. Duplicate unexpected exits share
   * ONE recovery (no second factory/scheduler/emit). Cleared when the
   * loop settles.
   */
  private recoveryInFlight: Map<string, Promise<void>> = new Map();

  /** Effective recovery delay (ms) — resolved once from options. */
  private readonly recoveryDelayMs: number;
  /** Injected inter-attempt sleep — test seam. */
  private readonly recoverySleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly factory: AdapterFactory,
    /** DBX-05: injectable tunnel manager (tests pass a fake). */
    tunnels?: SshTunnelManager,
    /** RLX-03 TASK-RLX03-002 — pinned injectable recovery options. */
    recoveryOptions: ConnectionRecoveryOptions = {},
  ) {
    this.tunnels = tunnels ?? new SshTunnelManager();
    this._onDidChangeActiveEmitter = new vscode.EventEmitter<ConnectionConfig | null>();
    this.onDidChangeActive = this._onDidChangeActiveEmitter.event;
    this._onDidChangeRecoveryStatusEmitter = new vscode.EventEmitter<ConnectionRecoveryStatus>();
    this.onDidChangeRecoveryStatus = this._onDidChangeRecoveryStatusEmitter.event;
    this.recoveryDelayMs = recoveryOptions.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
    this.recoverySleep =
      recoveryOptions.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Load state khi khởi tạo.
    this.loadState();
    // RLX-03 TASK-RLX03-002 — subscribe to tunnel exits to drive bounded
    // recovery for the currently active tunneled connection. Guarded so
    // older injectable fakes without onDidExit keep constructing.
    if (typeof this.tunnels.onDidExit === "function") {
      this.tunnelExitSub = this.tunnels.onDidExit((exit) => this.handleTunnelExit(exit));
    }
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

    // ARP-02.3: config mutation → bump the revision synchronously BEFORE any
    // await so an in-flight passive connect for this id aborts instead of
    // late-installing a candidate built from the OLD config.
    this.bumpConnRevision(id);

    // RLX-03: bump active generation synchronously BEFORE any await when
    // editing the active id — any in-flight recovery for this id must
    // silently abort (the user is mid-edit, recovery is no longer wanted).
    if (this.currentActiveId === id) {
      this.activeGeneration++;
    }

    // Test-connect lại nếu có đổi password HOẶC đổi bất kỳ trường nào khác (driver/host/...).
    // An toàn nhất: luôn test-connect. DBX-05: probe dùng tunnel TEMP KEY —
    // start() idempotent per key, nên nếu probe dùng `id` nó sẽ trả về
    // tunnel CŨ (config bastion cũ) và một config mới sai vẫn pass save.
    const testPassword = password ?? (await this.tryGetPassword(id)) ?? "";
    const probe = await this.resolveAdapter(
      next,
      testPassword,
      `probe-${id}`,
    );
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
      // Probe tunnel (dù thành công hay thất bại) luôn được dọn — nó chỉ
      // phục vụ validation; tunnel thật cho id được start lazily sau.
      this.stopTunnel(`probe-${id}`);
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
    // ARP-02.3: removal → bump the revision synchronously BEFORE any await so
    // an in-flight passive connect for this id aborts instead of
    // late-installing a candidate for a deleted connection.
    this.bumpConnRevision(id);
    // RLX-03: bump active generation synchronously BEFORE any await when
    // deleting the active id — any in-flight recovery for this id must
    // silently abort.
    if (wasActive) {
      this.activeGeneration++;
    }
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

    // RLX-03: bump active generation synchronously BEFORE any await so an
    // in-flight recovery for the OLD active id observes the change and
    // silently aborts.
    this.activeGeneration++;

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

    // ARP-02.3: snapshot the revision BEFORE the connect awaits. Any
    // edit/delete committing mid-flight invalidates this candidate.
    const rev = this.connRevisions.get(cfg.id) ?? 0;
    // Resolve the CURRENT persisted config — the caller's cfg object may be a
    // stale snapshot (schema tree captured before an edit). Untracked cfgs
    // (not in state) keep working exactly as before by falling back to cfg;
    // a MID-FLIGHT deletion is caught by the provenance re-check below.
    const current = this.currentConfigFor(cfg.id) ?? cfg;

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
    // ARP-02.3: build from the CURRENT config so a reconnect after an edit
    // targets the new host/port, never the stale caller snapshot.
    const adapter = this.guardAdapter(
      await this.resolveAdapter(current, password),
      current,
    );
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
    // ARP-02.3 provenance re-check AFTER every await (same discipline as the
    // RLX-03 ACTIVE path): revision unchanged AND the effective current
    // config is still the one we built from. `?? cfg` keeps untracked cfgs
    // (not persisted, e.g. direct caller objects) valid — deletion is only
    // possible for tracked ids, whose object identity then diverges.
    // Otherwise the late candidate is closed exactly once and never
    // installed — the next getAdapterFor reconnects with the then-current
    // config.
    if (
      (this.connRevisions.get(cfg.id) ?? 0) !== rev ||
      (this.currentConfigFor(cfg.id) ?? cfg) !== current
    ) {
      try {
        await adapter.close();
      } catch {
        // ignore
      }
      // TASK-ARP02-003 (reviewer minor, fix round 1) — resolveAdapter may
      // already have started a tunnel for cfg.id while the candidate was in
      // flight (deleteConnection's own stopTunnel ran BEFORE this re-start).
      // Without this stop the SSH tunnel + local port-forward for a deleted
      // (or edited) id is orphaned until dispose(). Idempotent: stop() is a
      // no-op when no tunnel exists for the key.
      if (current.tunnel) this.stopTunnel(cfg.id);
      throw new Error(
        `Connection "${cfg.name}" không còn hợp lệ — đã bỏ kết nối cũ`,
      );
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
   * RLX-03 TASK-RLX03-002 — resolve + test one candidate adapter through the
   * SAME lazy-construction path as `getAdapter()` (guardAdapter included).
   * On test failure the candidate is closed and the error rethrown — the
   * caller decides whether to retry.
   */
  private async buildAdapter(cfg: ConnectionConfig, password: string): Promise<DbAdapter> {
    const adapter = this.guardAdapter(await this.resolveAdapter(cfg, password), cfg);
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
    return adapter;
  }

  // ---- RLX-03 TASK-RLX03-002 — bounded active-tunnel recovery --------------

  /**
   * Gate for the recovery loop: only an UNEXPECTED post-ready exit for the
   * CURRENTLY ACTIVE, tunneled connection enters recovery. Intentional
   * (manager-issued) stops, non-active keys, and duplicate exits for a
   * recovery already in flight are silently ignored.
   */
  private handleTunnelExit(exit: TunnelExit): void {
    if (this.disposed) return; // shutdown — never recover after dispose()
    if (exit.intentional) return; // managed stop — never recover
    const active = this.getActive();
    if (!active || active.id !== exit.key) return; // not the active id
    if (!active.tunnel) return; // non-tunneled — no recovery
    if (this.recoveryInFlight.has(exit.key)) return; // duplicate shares the ONE loop per id
    const activeGen = this.activeGeneration;
    const lifecycleGen = this.lifecycleGeneration;
    const connectionId = active.id;
    const promise = this.runRecovery(connectionId, activeGen, lifecycleGen).finally(() => {
      if (this.recoveryInFlight.get(connectionId) === promise) {
        this.recoveryInFlight.delete(connectionId);
      }
    });
    this.recoveryInFlight.set(connectionId, promise);
  }

  private emitRecoveryStatus(
    connectionId: string,
    state: ConnectionRecoveryStatus["state"],
    attempt: number,
  ): void {
    this._onDidChangeRecoveryStatusEmitter.fire({
      connectionId,
      state,
      attempt,
      maxAttempts: RECOVERY_MAX_ATTEMPTS,
    });
  }

  /**
   * One bounded recovery loop for `connectionId`. Ownership is re-checked
   * BEFORE and AFTER every await (old-adapter close, inter-attempt sleep,
   * getAdapter/connect path). A failed guard silently ends the loop: no
   * further attempt, no terminal status, no later listener callback.
   * A candidate that resolves AFTER ownership changed is closed/discarded
   * and never installed as `currentAdapter`.
   */
  private async runRecovery(
    connectionId: string,
    activeGen: number,
    lifecycleGen: number,
  ): Promise<void> {
    // Pre-loop guard.
    if (!this.recoveryOwns(connectionId, activeGen, lifecycleGen)) return;
    this.emitRecoveryStatus(connectionId, "recovering", 1);

    for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // Inter-attempt backoff. Re-check ownership BEFORE and AFTER.
        if (!this.recoveryOwns(connectionId, activeGen, lifecycleGen)) return;
        await this.recoverySleep(this.recoveryDelayMs);
        if (!this.recoveryOwns(connectionId, activeGen, lifecycleGen)) return;
      }

      // Close/drop the OLD dead adapter before the first connect.
      if (attempt === 1) {
        if (!this.recoveryOwns(connectionId, activeGen, lifecycleGen)) return;
        await this.closeCurrentAdapter();
        if (!this.recoveryOwns(connectionId, activeGen, lifecycleGen)) return;
      }

      // Reconnect via the existing lazy path (getAdapter). Any candidate that
      // resolves after ownership changed is discarded below without install.
      let candidate: DbAdapter | null = null;
      try {
        candidate = await this.getAdapter();
      } catch {
        candidate = null;
      }

      // Post-await ownership re-check.
      if (!this.recoveryOwns(connectionId, activeGen, lifecycleGen)) {
        // Discard the late candidate — never install it, never close the
        // NEW active connection's adapter.
        if (candidate) {
          try {
            await candidate.close();
          } catch {
            // ignore
          }
        }
        return;
      }

      if (candidate) {
        this.emitRecoveryStatus(connectionId, "recovered", attempt);
        return;
      }

      if (attempt === RECOVERY_MAX_ATTEMPTS) {
        this.emitRecoveryStatus(connectionId, "failed", attempt);
        return;
      }
    }
  }

  /**
   * True iff the captured (id, activeGen, lifecycleGen) still owns recovery:
   * manager not disposed, generations unchanged, and the captured id is
   * still the installed active connection (both bookkeeping and config).
   */
  private recoveryOwns(
    connectionId: string,
    activeGen: number,
    lifecycleGen: number,
  ): boolean {
    if (this.disposed) return false;
    if (this.lifecycleGeneration !== lifecycleGen) return false;
    if (this.activeGeneration !== activeGen) return false;
    if (this.currentActiveId !== connectionId) return false;
    const active = this.getActive();
    if (!active || active.id !== connectionId) return false;
    return true;
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
      // RLX-03: snapshot ownership so a concurrent setActive/edit/delete/
      // dispose during the connect path cannot install a stale candidate.
      const activeGen = this.activeGeneration;
      const lifecycleGen = this.lifecycleGeneration;
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
      const adapter = await this.buildAdapter(active, password);
      // Ownership re-check AFTER every await — never assign a stale candidate.
      if (
        this.activeGeneration !== activeGen ||
        this.lifecycleGeneration !== lifecycleGen ||
        this.getActive()?.id !== active.id
      ) {
        try {
          await adapter.close();
        } catch {
          // ignore
        }
        throw new Error(
          `Connection "${active.name}" không còn active — đã bỏ kết nối cũ`,
        );
      }
      this.currentAdapter = adapter;
      this.currentActiveId = active.id;
    }
    this.resetIdleTimer();
    return this.currentAdapter;
  }

  /** Dispose: đóng tất cả adapters (active + passive), clear timer. */
  async dispose(): Promise<void> {
    // RLX-03 fix round 1: set the disposed flag synchronously BEFORE any
    // disposal await, THEN bump the lifecycle generation — both before any
    // in-flight recovery can observe anything. A tunnel exit delivered after
    // dispose() must never start a new recovery during shutdown.
    this.disposed = true;
    this.lifecycleGeneration++;
    // Dispose the tunnel-exit subscription so late exits stop reaching the
    // handler at all (belt and suspenders — the disposed flag already gates).
    this.tunnelExitSub?.dispose();
    this.tunnelExitSub = null;
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
    /** Override the tunnel key (validation probes use `probe-<id>`). */
    keyOverride?: string,
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
        keyOverride ?? cfg.id,
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
    // ARP-01.2 — secondary execution boundary: a DbTransaction obtained on a
    // read-only adapter must run through the SAME isMutationSql gate, so a
    // mutation is blocked BEFORE the driver is invoked. commit()/rollback()
    // pass through untouched; adapters without beginTransaction gain nothing.
    // The wrap happens per beginTransaction() call so two concurrent
    // transactions each get their own guard (per-call freshness).
    if (typeof adapter.beginTransaction === "function") {
      const originalBegin = adapter.beginTransaction.bind(adapter);
      adapter.beginTransaction = async () => {
        const tx = await originalBegin();
        const originalTxRun = tx.runQuery.bind(tx);
        tx.runQuery = (sql: string, values?: unknown[]) => {
          if (isMutationSql(sql)) {
            throw new ReadOnlyViolation(mutationStatements(sql));
          }
          return originalTxRun(sql, values);
        };
        return tx;
      };
    }
    return adapter;
  }

  /** Expose tunnel mutation for edit/delete (stop the old tunnel). */
  stopTunnel(id: string): void {
    this.tunnels.stop(id);
  }

  // ---- Private -------------------------------------------------------------

  /**
   * ARP-02.3 TASK-ARP02-003 — bump the revision of connection `id`
   * synchronously, before any await in the calling mutation. Idempotent per
   * mutation (a single increment per call site, like activeGeneration).
   */
  private bumpConnRevision(id: string): void {
    this.connRevisions.set(id, (this.connRevisions.get(id) ?? 0) + 1);
  }

  /**
   * ARP-02.3 TASK-ARP02-003 — re-resolve the CURRENT persisted config for
   * `cfg.id` before building a passive candidate. The caller-supplied cfg
   * (e.g. from a stale schema-tree snapshot) may lag an editConnection commit;
   * validating against the fresh config lets the stale object fail fast AND
   * makes the post-edit reconnect use the new host/port. If the connection no
   * longer exists, the caller handles it (provenance check below).
   */
  private currentConfigFor(id: string): ConnectionConfig | null {
    return this.state.connections.find((c) => c.id === id) ?? null;
  }

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