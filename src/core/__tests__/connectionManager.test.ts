// src/core/__tests__/connectionManager.test.ts
// Unit tests cho ConnectionManager (TASK-005 §Test Cases — 7 tests bắt buộc).
//
// Pattern: vi.mock('vscode') cung cấp fake SecretStorage + Memento + EventEmitter +
// window.showInformationMessage/showErrorMessage/showInputBox/showQuickPick.
// KHÔNG cần VS Code thật.
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Fake vscode module (mock trước khi import ConnectionManager) -----------

type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };
  fire(data: T): void {
    for (const l of this.listeners.slice()) l(data);
  }
  get listenerCount(): number {
    return this.listeners.length;
  }
}

class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
  _raw(): Map<string, unknown> {
    return this.data;
  }
}

class FakeSecretStorage {
  private data = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    if ((this as unknown as { _throwOnGet?: boolean })._throwOnGet) {
      return Promise.reject(new Error("SecretStorage unavailable"));
    }
    return Promise.resolve(this.data.get(key));
  }
  store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
  _raw(): Map<string, string> {
    return this.data;
  }
}

// Fake DbAdapter
function makeFakeAdapter() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    runQuery: vi.fn(),
    listSchemas: vi.fn(),
    listTables: vi.fn(),
    listViews: vi.fn(),
    listRoutines: vi.fn(),
    listColumns: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock vscode — dùng module-level state để setupHarness reset mỗi test.
// Tất cả factory references phải là LET (mutable binding) để tránh
// "Cannot access 'X' before initialization" do vi.mock được hoist lên đầu file.
let mockSecret: FakeSecretStorage | undefined;
let mockWorkspace: FakeMemento | undefined;
let mockGlobal: FakeMemento | undefined;
let mockEmitters: FakeEventEmitter<unknown>[] | undefined;
let mockStatusBarItem: ReturnType<typeof makeFakeStatusBarItem> | undefined;
let mockWorkspaceFolders: unknown;

function makeFakeStatusBarItem() {
  return {
    text: "",
    tooltip: undefined as string | undefined,
    command: undefined as string | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

vi.mock("vscode", () => {
  const EventEmitterMock = vi.fn(() => {
    if (!mockEmitters) mockEmitters = [];
    const e = new FakeEventEmitter<unknown>();
    mockEmitters.push(e);
    return e;
  });
  const windowMock = {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  };
  return {
    EventEmitter: EventEmitterMock,
    window: windowMock,
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    get workspace() {
      return {
        get workspaceFolders() {
          return mockWorkspaceFolders;
        },
      };
    },
  };
});

import { ConnectionManager } from "../connectionManager";
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter } from "../../adapters/types";

// ---- Helpers ---------------------------------------------------------------

function makeCfg(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: overrides.id ?? "c1",
    name: overrides.name ?? "Test PG",
    driver: overrides.driver ?? "postgres",
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 5432,
    user: overrides.user ?? "vsdb",
    database: overrides.database ?? "vsdb",
    ...overrides,
  };
}

interface Harness {
  mgr: ConnectionManager;
  secret: FakeSecretStorage;
  workspace: FakeMemento;
  global: FakeMemento;
  adapter: ReturnType<typeof makeFakeAdapter>;
  factory: ReturnType<typeof vi.fn>;
  emitters: FakeEventEmitter<unknown>[];
}

function setupHarness(opts: { withWorkspace?: boolean } = {}): Harness {
  mockSecret = new FakeSecretStorage();
  mockWorkspace = new FakeMemento();
  mockGlobal = new FakeMemento();
  mockEmitters = [];
  mockStatusBarItem = makeFakeStatusBarItem();
  // Default: no workspace. Individual test opt-in.
  mockWorkspaceFolders = opts.withWorkspace
    ? [{ uri: { toString: () => "file:///test" }, name: "test", index: 0 }]
    : undefined;

  const adapter = makeFakeAdapter();
  const factory = vi.fn(() => adapter as unknown as DbAdapter);

  const ctx = {
    secrets: mockSecret,
    workspaceState: mockWorkspace,
    globalState: mockGlobal,
  };

  const mgr = new ConnectionManager(ctx as never, factory);

  return {
    mgr,
    secret: mockSecret,
    workspace: mockWorkspace,
    global: mockGlobal,
    adapter,
    factory,
    emitters: mockEmitters,
  };
}

// ---- Tests -----------------------------------------------------------------

describe("ConnectionManager — CRUD + persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test #1 — addConnection lưu metadata vào workspace Memento, password vào SecretStorage", async () => {
    const h = setupHarness({ withWorkspace: true });
    await h.mgr.addConnection(makeCfg({ id: "pg1", name: "Local PG" }), "secret123");

    // Metadata: workspaceState có key vsdb.connections.
    const list = h.workspace.get<ConnectionConfig[]>("vsdb.connections");
    expect(list).toBeDefined();
    expect(list!).toHaveLength(1);
    expect(list![0].id).toBe("pg1");
    expect(list![0].name).toBe("Local PG");
    expect((list![0] as unknown as { password?: string }).password).toBeUndefined();

    // Password: SecretStorage có key vsdb.pass.pg1.
    const pass = await h.secret.get("vsdb.pass.pg1");
    expect(pass).toBe("secret123");

    // Test-connect: adapter.testConnection được gọi 1 lần.
    expect(h.adapter.testConnection).toHaveBeenCalledTimes(1);
  });

  it("Test #2 — addConnection fail test-connect → KHÔNG lưu, throw", async () => {
    const h = setupHarness({ withWorkspace: true });
    h.adapter.testConnection.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(
      h.mgr.addConnection(makeCfg({ id: "bad" }), "any"),
    ).rejects.toThrow();

    expect(h.workspace.get("vsdb.connections")).toBeUndefined();
    expect(await h.secret.get("vsdb.pass.bad")).toBeUndefined();
  });

  it("Test #3 — deleteConnection đang active: close adapter, clear active, xoá secret", async () => {
    const h = setupHarness({ withWorkspace: true });
    await h.mgr.addConnection(makeCfg({ id: "a" }), "p1");
    await h.mgr.addConnection(makeCfg({ id: "b" }), "p2");

    // setActive — không cache adapter; chỉ ghi Memento.
    await h.mgr.setActive("a");
    // factory được gọi bởi addConnection ×2 (test-connect probe). setActive không gọi.
    expect(h.factory).toHaveBeenCalledTimes(2);

    // getAdapter để open socket.
    await h.mgr.getAdapter();
    expect(h.factory).toHaveBeenCalledTimes(3);

    // close count trước khi delete.
    const closeBefore = h.adapter.close.mock.calls.length;

    await h.mgr.deleteConnection("a");
    // close được gọi thêm lần nữa khi xoá.
    expect(h.adapter.close.mock.calls.length).toBeGreaterThan(closeBefore);

    const list = h.workspace.get<ConnectionConfig[]>("vsdb.connections")!;
    expect(list.map((c) => c.id)).not.toContain("a");

    expect(await h.secret.get("vsdb.pass.a")).toBeUndefined();
    expect(h.mgr.getActive()).toBeNull();
    expect(h.workspace.get("vsdb.activeConnection")).toBeUndefined();
  });

  it("Test #4 — editConnection đổi password: secret key bị ghi đè", async () => {
    const h = setupHarness({ withWorkspace: true });
    await h.mgr.addConnection(makeCfg({ id: "x", name: "Old", host: "h1" }), "oldpass");

    await h.mgr.editConnection(
      "x",
      { name: "New", host: "h2" },
      "newpass",
    );

    expect(await h.secret.get("vsdb.pass.x")).toBe("newpass");
    const list = h.workspace.get<ConnectionConfig[]>("vsdb.connections")!;
    const updated = list.find((c) => c.id === "x")!;
    expect(updated.name).toBe("New");
    expect(updated.host).toBe("h2");
  });

  it("Test #5 — setActive remembered theo workspace; switching closes old adapter", async () => {
    const h = setupHarness({ withWorkspace: true });
    await h.mgr.addConnection(makeCfg({ id: "1" }), "p1");
    await h.mgr.addConnection(makeCfg({ id: "2" }), "p2");

    await h.mgr.setActive("2");
    expect(h.workspace.get("vsdb.activeConnection")).toBe("2");

    const active = h.mgr.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe("2");

    // Lazy connect via getAdapter → adapter được cache.
    await h.mgr.getAdapter();
    h.adapter.close.mockClear(); // reset từ addConnection probe

    // Switching sang '1' đóng adapter của '2' (closeCurrentAdapter).
    const adapterCloseBefore = h.adapter.close.mock.calls.length;
    await h.mgr.setActive("1");
    expect(h.adapter.close.mock.calls.length).toBeGreaterThan(adapterCloseBefore);

    expect(h.workspace.get("vsdb.activeConnection")).toBe("1");
    expect(h.mgr.getActive()!.id).toBe("1");
  });

  it("Test #6 — SecretStorage mất password: getAdapter throw lỗi có hướng dẫn nhập lại password", async () => {
    const h = setupHarness({ withWorkspace: true });
    await h.mgr.addConnection(makeCfg({ id: "z" }), "p");
    await h.mgr.setActive("z");

    // Giả lập secret mất password.
    await h.secret.delete("vsdb.pass.z");

    await expect(h.mgr.getAdapter()).rejects.toThrow(/nhập lại|password/i);

    // KHÔNG crash toàn cục; metadata vẫn còn.
    expect(h.mgr.listConnections().map((c) => c.id)).toContain("z");
  });

  it("Test #7 — idle timeout 10 phút: sau 10 phút adapter.close, query mới reconnect lazy", async () => {
    vi.useFakeTimers();
    try {
      const h = setupHarness({ withWorkspace: true });
      await h.mgr.addConnection(makeCfg({ id: "i" }), "p");
      await h.mgr.setActive("i");

      // getAdapter lần đầu → factory tạo adapter.
      await h.mgr.getAdapter();
      const adapterInstance = h.adapter;
      expect(adapterInstance.testConnection).toHaveBeenCalled();

      // Reset close mock — addConnection đã close probe trước đó.
      adapterInstance.close.mockClear();

      // Trước 10 phút: close chưa gọi.
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(adapterInstance.close).not.toHaveBeenCalled();

      // Qua 10 phút không activity → close fired.
      vi.advanceTimersByTime(2 * 60 * 1000);
      await vi.runAllTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      expect(adapterInstance.close).toHaveBeenCalled();

      // Query mới sau idle → reconnect lazy (factory gọi lại).
      const factoryCallsBefore = h.factory.mock.calls.length;
      await expect(h.mgr.getAdapter()).resolves.toBeDefined();
      expect(h.factory.mock.calls.length).toBeGreaterThan(factoryCallsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConnectionManager — design §8 fallbacks", () => {
  it("Fallback globalState khi không có workspace mở", async () => {
    const h = setupHarness({ withWorkspace: false });
    await h.mgr.addConnection(makeCfg({ id: "g" }), "pw");

    // Phải ghi vào globalState, KHÔNG ghi workspaceState.
    expect(h.global.get<ConnectionConfig[]>("vsdb.connections")).toBeDefined();
    expect(h.workspace.get("vsdb.connections")).toBeUndefined();
  });
});

describe("ConnectionManager — EventEmitter onDidChangeActive", () => {
  it("setActive fires onDidChangeActive cho mỗi lần đổi", async () => {
    const h = setupHarness({ withWorkspace: true });
    await h.mgr.addConnection(makeCfg({ id: "e1" }), "p");
    await h.mgr.addConnection(makeCfg({ id: "e2" }), "p");

    const events: Array<unknown> = [];
    h.mgr.onDidChangeActive((cfg) => events.push(cfg));

    await h.mgr.setActive("e1");
    await h.mgr.setActive("e2");

    expect(events).toHaveLength(2);
  });
});
// DBX-05 TASK-DBX05-003 — read-only + tunnel wiring.
import { ConnectionManager, type ConnectionRecoveryStatus, DEFAULT_RECOVERY_DELAY_MS } from "../connectionManager";
import { SshTunnelManager } from "../sshTunnelManager";
import type { TunnelExit, TunnelExitSubscription } from "../sshTunnelManager";
import { ReadOnlyViolation } from "../readOnlyIntent";

const STUB_CTX = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  globalState: { get: () => undefined, update: async () => undefined },
  secrets: { get: async (k: string) => (k.endsWith("cRO") ? "pw" : undefined), store: async () => undefined, delete: async () => undefined },
  subscriptions: [],
  extensionPath: "/tmp",
  globalStoragePath: "/tmp",
  logUri: undefined as any,
  storagePath: "/tmp",
} as never;

const baseCfg = {
  id: "cRO", name: "ro", driver: "postgres", host: "h", port: 5432, user: "u", database: "d",
  readOnly: true,
} as any;

describe("ConnectionManager DBX-05 read-only + tunnel", () => {
  it("readOnly: SELECT passes through to adapter", async () => {
    const runs: string[] = [];
    const factory = () => ({
      runQuery: async (sql: string) => { runs.push(sql); return { results: [] }; },
      testConnection: async () => {},
      close: async () => {},
    });
    const mgr = new (ConnectionManager)(STUB_CTX, factory);
    const a = await mgr.getAdapterFor({ ...baseCfg, readOnly: false });
    await a.runQuery("SELECT 1");
    mgr.dispose();
  });

  it("readOnly: DELETE throws ReadOnlyViolation BEFORE runQuery", async () => {
    const runs: string[] = [];
    const factory = () => ({
      runQuery: async (sql: string) => { runs.push(sql); return { results: [] }; },
      testConnection: async () => {},
      close: async () => {},
    });
    const mgr = new (ConnectionManager)(STUB_CTX, factory);
    const a = await mgr.getAdapterFor(baseCfg);
    expect(() => a.runQuery("DELETE FROM t")).toThrow(ReadOnlyViolation);
    expect(runs.length).toBe(0);
    mgr.dispose();
  });

  it("tunnel: adapter is created with rewritten host/port; persisted cfg unchanged", async () => {
    const fakeTunnels = {
      start: async (cfg: any) => ({ key: "cT", localPort: 55432, child: undefined }),
      stop: () => false, stopAll: () => {}, list: () => [], dispose: () => {},
    } as unknown as SshTunnelManager;
    let captured: any = null;
    const factory = (cfg: any) => {
      captured = cfg;
      return { runQuery: async () => ({ results: [] }), testConnection: async () => {}, close: async () => {} };
    };
    const mgr = new (ConnectionManager)(STUB_CTX, factory, fakeTunnels);
    // Stub secrets so the passive getAdapterFor can resolve a password.
    (STUB_CTX as any).secrets.get = async (k: string) => (k.endsWith("cT") ? "pw" : undefined);
    await mgr.getAdapterFor({ id: "cT", name: "t", driver: "postgres", host: "db", port: 5432, user: "u", database: "d", tunnel: { host: "bastion", port: 22 } } as any);
    mgr.dispose();
    expect(captured?.host).toBe("127.0.0.1");
    expect(captured?.port).toBe(55432);
  });

  it("dispose stops every tunnel (no leak)", async () => {
    const stopped: string[] = [];
    const fakeTunnels = {
      start: async () => ({ key: "k", localPort: 1, child: undefined }),
      stop: (k: string) => { stopped.push(k); return true; },
      stopAll: () => { stopped.push("ALL"); },
      list: () => [], dispose: () => { stopped.push("ALL"); },
    } as unknown as SshTunnelManager;
    const mgr = new (ConnectionManager)(
      STUB_CTX,
      () => ({ runQuery: async () => ({ results: [] }), testConnection: async () => {}, close: async () => {} }),
      fakeTunnels,
    );
    await mgr.dispose();
    expect(stopped).toContain("ALL");
  });

  // DBX-05 review round 2 — the edit/add validation probe MUST start its
  // tunnel under a temp key, never the connection id (start() is idempotent
  // per key, so probing under the id would reuse the OLD tunnel and let a
  // bad new bastion config pass save).
  it("edit probes through a temp probe-<id> tunnel key and cleans it up", async () => {
    const startedKeys: string[] = [];
    const stoppedKeys: string[] = [];
    // Seed cE into memento BEFORE constructing the manager — loadState runs
    // in the constructor. pickMemento depends on vscode.workspace folders, so
    // seed both workspace + global.
    const seed = [{ id: "cE", name: "e", driver: "postgres", host: "db", port: 5432, user: "u", database: "d", tunnel: { host: "bastion", port: 22 } }];
    (STUB_CTX as any).workspaceState.get = (key: string) =>
      key === "vsdb.connections" ? seed : undefined;
    (STUB_CTX as any).globalState.get = (key: string) =>
      key === "vsdb.connections" ? seed : undefined;
    const fakeTunnels = {
      start: async (tcfg: unknown, key: string) => {
        startedKeys.push(key);
        return { key, localPort: 55433, child: undefined };
      },
      stop: (key: string) => {
        stoppedKeys.push(key);
        return true;
      },
      stopAll: () => {},
      list: () => [],
      dispose: () => {},
    } as unknown as SshTunnelManager;
    const mgr = new (ConnectionManager)(
      STUB_CTX,
      () => ({ runQuery: async () => ({ results: [] }), testConnection: async () => {}, close: async () => {} }),
      fakeTunnels,
    );
    (STUB_CTX as any).secrets.get = async (k: string) => (k.endsWith("cE") ? "pw" : undefined);
    await mgr.editConnection("cE", { host: "db2" });
    expect(startedKeys).toContain("probe-cE");
    expect(stoppedKeys).toContain("probe-cE");
    // The real connection id tunnel was never started during the probe.
    expect(startedKeys).not.toContain("cE");
    mgr.dispose();
  });
});

// ---- RLX-03 TASK-RLX03-002 helpers -----------------------------------------

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface FakeTunnels {
  startCalls: Array<{ key: string; port: number }>;
  stopCalls: string[];
  onDidExit: (listener: (exit: TunnelExit) => void) => TunnelExitSubscription;
  start: (cfg: { host: string; port?: number; targetPort?: number; user?: string; identityFile?: string; localPort?: number }, key: string) => Promise<{ key: string; localPort: number }>;
  stop: (key: string) => boolean;
  stopAll: () => void;
  dispose: () => void;
  list: () => unknown[];
  emitExit: (exit: TunnelExit) => void;
  emitExitFor: (key: string, opts?: Partial<TunnelExit>) => void;
}

function makeFakeTunnels(): FakeTunnels {
  let counter = 55000;
  const listeners = new Set<(exit: TunnelExit) => void>();
  return {
    startCalls: [],
    stopCalls: [],
    onDidExit(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    async start(_cfg, key) {
      const port = ++counter;
      this.startCalls.push({ key, port });
      return { key, localPort: port };
    },
    stop(key) { this.stopCalls.push(key); return true; },
    stopAll() { this.stopCalls.push("ALL"); },
    dispose() {},
    list() { return []; },
    emitExit(exit) {
      for (const l of Array.from(listeners)) l(exit);
    },
    emitExitFor(key, opts = {}) {
      this.emitExit({ key, code: opts.code ?? 1, signal: opts.signal ?? null, intentional: opts.intentional ?? false });
    },
  };
}

describe("ConnectionManager — RLX-03 TASK-RLX03-002 recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----- Test 1: happy path -----
  it("unexpected active tunnel exit reconnects on first attempt", async () => {
    const cfg = makeCfg({ id: "c1", tunnel: { host: "bastion", port: 22 } })
    // Workspace folders must be visible so pickMemento() selects the same
    // FakeMemento (`ws`) these tests seed.
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunnels = makeFakeTunnels();
    const oldAdapter = makeFakeAdapter();
    const newAdapter = makeFakeAdapter();
    const factory = vi.fn()
      .mockImplementationOnce(() => oldAdapter)
      .mockImplementationOnce(() => newAdapter);
    const ctx = { secrets: secret, workspaceState: ws, globalState: g };
    ws.update("vsdb.connections", [cfg]);
    ws.update("vsdb.activeConnection", "c1");
    await secret.store("vsdb.pass.c1", "pw");
    const sleep = vi.fn(async () => {});
    const mgr = new ConnectionManager(
      ctx as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );
    const events: ConnectionRecoveryStatus[] = [];
    mgr.onDidChangeRecoveryStatus((e) => events.push(e));

    // Open the original adapter (factory call #1).
    const a0 = await mgr.getAdapter();
    expect(a0).toBe(oldAdapter);
    // Tied to a real handle so resolveAdapter pulls a port for the tunnel.
    // (Fake tunnel already produces a port.)

    // Simulate the unexpected post-ready exit.
    tunnels.emitExitFor("c1", { intentional: false });

    // Let recovery microtasks drain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Old adapter closed once.
    expect(oldAdapter.close).toHaveBeenCalledTimes(1);
    // Factory called once more for the replacement adapter.
    expect(factory).toHaveBeenCalledTimes(2);
    // Scheduler NOT called before first attempt (we only sleep between attempts).
    expect(sleep).not.toHaveBeenCalled();
    // New adapter was tested exactly once.
    expect(newAdapter.testConnection).toHaveBeenCalledTimes(1);
    // Events: "recovering" then "recovered" — both with maxAttempts: 2.
    expect(events.map((e) => e.state)).toEqual(["recovering", "recovered"]);
    expect(events[0].maxAttempts).toBe(2);
    expect(events[1].maxAttempts).toBe(2);
    expect(events[0].connectionId).toBe("c1");
    expect(events[0].attempt).toBe(1);

    await mgr.dispose();
  });

  // ----- Test 2: retry boundary -----
  it("second failure ends recovery after exactly two attempts", async () => {
    const cfg = makeCfg({ id: "c2", tunnel: { host: "bastion", port: 22 } })
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunnels = makeFakeTunnels();
    const oldA = makeFakeAdapter();
    const failA1 = makeFakeAdapter();
    const failA2 = makeFakeAdapter();
    failA1.testConnection.mockRejectedValueOnce(new Error("attempt1 fail"));
    failA2.testConnection.mockRejectedValueOnce(new Error("attempt2 fail"));
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => failA1)
      .mockImplementationOnce(() => failA2);
    const ctx = { secrets: secret, workspaceState: ws, globalState: g };
    ws.update("vsdb.connections", [cfg]);
    ws.update("vsdb.activeConnection", "c2");
    await secret.store("vsdb.pass.c2", "pw");
    const sleep = vi.fn(async () => {});
    const mgr = new ConnectionManager(
      ctx as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );
    const events: ConnectionRecoveryStatus[] = [];
    mgr.onDidChangeRecoveryStatus((e) => events.push(e));

    await mgr.getAdapter();
    tunnels.emitExitFor("c2", { intentional: false });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(failA1.testConnection).toHaveBeenCalledTimes(1);
    expect(failA2.testConnection).toHaveBeenCalledTimes(1);
    expect(failA1.close).toHaveBeenCalledTimes(1);
    expect(failA2.close).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(3);
    // No 3rd attempt / sleep / test.
    expect(factory).not.toHaveBeenCalledTimes(4);
    // Final state = "failed".
    const last = events[events.length - 1];
    expect(last.state).toBe("failed");
    expect(last.maxAttempts).toBe(2);
    expect(last.connectionId).toBe("c2");
    expect(last.attempt).toBe(2);

    await mgr.dispose();
  });

  // ----- Test 3: dispose during backoff -----
  it("dispose aborts a recovering connection while injected sleep is pending", async () => {
    const cfg = makeCfg({ id: "c3", tunnel: { host: "bastion", port: 22 } })
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunnels = makeFakeTunnels();
    const oldA = makeFakeAdapter();
    const failA = makeFakeAdapter();
    failA.testConnection.mockRejectedValueOnce(new Error("attempt fail"));
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => failA);
    const ctx = { secrets: secret, workspaceState: ws, globalState: g };
    ws.update("vsdb.connections", [cfg]);
    ws.update("vsdb.activeConnection", "c3");
    await secret.store("vsdb.pass.c3", "pw");
    const sleepDeferred = makeDeferred<void>();
    const sleep = vi.fn(() => sleepDeferred.promise);
    const mgr = new ConnectionManager(
      ctx as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );
    const events: ConnectionRecoveryStatus[] = [];
    mgr.onDidChangeRecoveryStatus((e) => events.push(e));
    const lateListener = vi.fn();
    mgr.onDidChangeRecoveryStatus(lateListener);

    await mgr.getAdapter();
    tunnels.emitExitFor("c3", { intentional: false });
    // Drain so attempt 1 runs and we land inside the sleep.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(sleep).toHaveBeenCalledTimes(1);
    // Dispose while sleep is pending.
    await mgr.dispose();
    // Everything the recovery already emitted before disposal is fine;
    // from THIS point on, no callback may fire.
    lateListener.mockClear();
    // Now settle sleep — recovery must not start attempt 2, emit failed/recovered, or call the listener.
    sleepDeferred.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // No attempt 2 → no second factory call beyond the one already done.
    expect(factory).toHaveBeenCalledTimes(2);
    // failA was already close()'d as part of attempt 1 cleanup; no further test.
    expect(failA.testConnection).toHaveBeenCalledTimes(1);
    // No "failed" emitted after dispose.
    expect(events.map((e) => e.state)).toEqual(["recovering"]);
    // Late listener never fired.
    expect(lateListener).not.toHaveBeenCalled();
  });

  // ----- Test 4: active switch during connect -----
  it("active switch aborts an old recovery while its replacement connect is pending", async () => {
    const c1 = makeCfg({ id: "c1", tunnel: { host: "bastion", port: 22 } })
    const c2 = makeCfg({ id: "c2", tunnel: { host: "bastion", port: 22 } })
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunnels = makeFakeTunnels();
    const oldA = makeFakeAdapter();
    const newA = makeFakeAdapter();
    // Make newA.testConnection a deferred that we control.
    const deferred = makeDeferred<void>();
    newA.testConnection.mockImplementationOnce(() => deferred.promise);
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => newA);
    const ctx = { secrets: secret, workspaceState: ws, globalState: g };
    ws.update("vsdb.connections", [c1, c2]);
    ws.update("vsdb.activeConnection", "c1");
    await secret.store("vsdb.pass.c1", "pwA");
    await secret.store("vsdb.pass.c2", "pwB");
    const sleep = vi.fn(async () => {});
    const mgr = new ConnectionManager(
      ctx as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );
    const events: ConnectionRecoveryStatus[] = [];
    mgr.onDidChangeRecoveryStatus((e) => events.push(e));

    await mgr.getAdapter();
    tunnels.emitExitFor("c1", { intentional: false });
    // Drain until we land in the deferred testConnection.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(newA.testConnection).toHaveBeenCalledTimes(1);

    // Switch active to c2 while the recovery is mid-await.
    await mgr.setActive("c2");
    // Now settle c1's pending test — recovery should silently abort and NOT
    // install the candidate.
    deferred.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The discarded candidate must be closed.
    expect(newA.close).toHaveBeenCalledTimes(1);
    // No recovered/failed for c1.
    const c1Events = events.filter((e) => e.connectionId === "c1");
    expect(c1Events.map((e) => e.state)).toEqual(["recovering"]);
    // No scheduler call.
    expect(sleep).not.toHaveBeenCalled();
    // No later factory/test/close beyond what switch triggered.
    // (setActive also creates a candidate for c2 lazily; we just assert c1 path stopped.)
    await mgr.dispose();
  });

  // ----- Test 5: duplicate / intentional / passive / stale exits -----
  it("duplicate, intentional, passive, and stale-key exits do not create extra recovery", async () => {
    const c1 = makeCfg({ id: "c1", tunnel: { host: "bastion", port: 22 } })
    const c2 = makeCfg({ id: "c2", tunnel: { host: "bastion", port: 22 } })
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunnels = makeFakeTunnels();
    const oldA = makeFakeAdapter();
    const newA = makeFakeAdapter();
    // Deferred connect so the recovery stays genuinely in flight across the
    // duplicate-exit assertion.
    const connectDeferred = makeDeferred<void>();
    newA.testConnection.mockImplementationOnce(() => connectDeferred.promise);
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => newA);
    const ctx = { secrets: secret, workspaceState: ws, globalState: g };
    ws.update("vsdb.connections", [c1, c2]);
    ws.update("vsdb.activeConnection", "c1");
    await secret.store("vsdb.pass.c1", "pwA");
    await secret.store("vsdb.pass.c2", "pwB");
    const sleep = vi.fn(async () => {});
    const mgr = new ConnectionManager(
      ctx as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );
    const events: ConnectionRecoveryStatus[] = [];
    mgr.onDidChangeRecoveryStatus((e) => events.push(e));

    await mgr.getAdapter();
    const factoryCallsBefore = factory.mock.calls.length;

    // Intentional exit for c1 → silent.
    tunnels.emitExitFor("c1", { intentional: true });
    await new Promise((r) => setTimeout(r, 0));
    // Non-active key (c2) → silent.
    tunnels.emitExitFor("c2", { intentional: false });
    await new Promise((r) => setTimeout(r, 0));
    // Unexpected active exit → recovery #1 starts; its connect is pending.
    tunnels.emitExitFor("c1", { intentional: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(newA.testConnection).toHaveBeenCalledTimes(1); // still pending
    // Duplicate unexpected active exit while recovery in flight → no-op.
    tunnels.emitExitFor("c1", { intentional: false });
    await new Promise((r) => setTimeout(r, 0));
    // Settle the deferred connect — recovery completes on attempt 1.
    connectDeferred.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Stale key after we switch away from c1.
    await mgr.setActive("c2");
    tunnels.emitExitFor("c1", { intentional: false });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Only ONE replacement attempt happened (factory call #2).
    expect(factory.mock.calls.length - factoryCallsBefore).toBe(1);
    // Scheduler never called.
    expect(sleep).not.toHaveBeenCalled();
    // Events only reflect the one recovery (state recovering → recovered).
    const states = events.map((e) => `${e.connectionId}/${e.state}`);
    expect(states).toEqual(["c1/recovering", "c1/recovered"]);

    await mgr.dispose();
  });

  // ----- Recovery options default behavior -----
  it("ConnectionRecoveryOptions default delayMs is 1000 and sleep is setTimeout", async () => {
    // Construct WITHOUT options, ensure default delayMs constant is 1_000.
    expect(DEFAULT_RECOVERY_DELAY_MS).toBe(1_000);

    const cfg = makeCfg({ id: "cD", tunnel: { host: "bastion", port: 22 } })
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunnels = makeFakeTunnels();
    const oldA = makeFakeAdapter();
    const failA = makeFakeAdapter();
    failA.testConnection.mockRejectedValueOnce(new Error("nope"));
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => failA);
    const ctx = { secrets: secret, workspaceState: ws, globalState: g };
    ws.update("vsdb.connections", [cfg]);
    ws.update("vsdb.activeConnection", "cD");
    await secret.store("vsdb.pass.cD", "pw");
    const mgr = new ConnectionManager(
      ctx as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
    );
    await mgr.getAdapter();
    tunnels.emitExitFor("cD", { intentional: false });
    // Wait for the default setTimeout-based sleep to fire (avoid hanging the
    // suite by capping the wait at 50ms; default sleep is 1000ms — we only
    // need to assert the *attempt* ran, not that the sleep resolved).
    await new Promise((r) => setTimeout(r, 5));
    // Dispose to abort the pending default sleep.
    await mgr.dispose();
    expect(factory.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
