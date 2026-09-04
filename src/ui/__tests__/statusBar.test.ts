// src/ui/__tests__/statusBar.test.ts
// Unit test cho createStatusBar — TASK-005 statusBar (không nằm trong 7 bắt buộc
// nhưng đảm bảo behavior khi wire).
import { describe, it, expect, beforeEach, vi } from "vitest";

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
}

class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

class FakeSecretStorage {
  private data = new Map<string, string>();
  get(key: string) { return Promise.resolve(this.data.get(key)); }
  store(key: string, value: string) { this.data.set(key, value); return Promise.resolve(); }
  delete(key: string) { this.data.delete(key); return Promise.resolve(); }
}

let mockEmitters: FakeEventEmitter<unknown>[] | undefined;
let mockWorkspaceFolders: unknown;
let mockStatusBarItem: {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

vi.mock("vscode", () => {
  return {
    EventEmitter: vi.fn(() => {
      if (!mockEmitters) mockEmitters = [];
      const e = new FakeEventEmitter<unknown>();
      mockEmitters.push(e);
      return e;
    }),
    window: {
      createStatusBarItem: vi.fn(() => mockStatusBarItem),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    get workspace() {
      return { get workspaceFolders() { return mockWorkspaceFolders; } };
    },
  };
});

import { ConnectionManager } from "../../core/connectionManager";
import { createStatusBar } from "../statusBar";
import type { SshTunnelManager, TunnelExit, TunnelExitSubscription } from "../../core/sshTunnelManager";
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter } from "../../adapters/types";

function makeFakeTunnels() {
  let counter = 56000;
  const listeners = new Set<(e: TunnelExit) => void>();
  return {
    startCalls: [] as Array<{ key: string }>,
    async start(_cfg: unknown, key: string) {
      this.startCalls.push({ key });
      return { key, localPort: ++counter };
    },
    stop: () => true,
    stopAll: () => {},
    dispose: () => {},
    list: () => [],
    onDidExit(listener: (e: TunnelExit) => void): TunnelExitSubscription {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emitExit(e: TunnelExit) {
      for (const l of Array.from(listeners)) l(e);
    },
  };
}

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

function makeAdapter() {
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

describe("createStatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitters = [];
    mockStatusBarItem = {
      text: "",
      tooltip: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
    mockWorkspaceFolders = [{ uri: { toString: () => "f" }, name: "f", index: 0 }];
  });

  it("không có active → text rỗng, hide() được gọi", () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const adapter = makeAdapter();
    const factory = vi.fn(() => adapter as unknown as DbAdapter);
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory,
    );

    const item = createStatusBar(mgr);
    expect(item.item.text).toBe("");
    expect(item.item.hide).toHaveBeenCalled();
  });

  it("có active → text '$(database) <name> [<driver>]', command 'vsdb.selectConnection'", async () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const adapter = makeAdapter();
    const factory = vi.fn(() => adapter as unknown as DbAdapter);
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory,
    );

    await mgr.addConnection(makeCfg({ id: "a", name: "Local", driver: "postgres" }), "p");
    await mgr.setActive("a");

    const item = createStatusBar(mgr);
    expect(item.item.text).toBe("$(database) Local [postgres]");
    expect(item.item.command).toBe("vsdb.selectConnection");
    expect(item.item.show).toHaveBeenCalled();
  });

  it("setActive fires onDidChangeActive → statusBar update", async () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const adapter = makeAdapter();
    const factory = vi.fn(() => adapter as unknown as DbAdapter);
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory,
    );

    await mgr.addConnection(makeCfg({ id: "a", name: "A" }), "p1");
    await mgr.addConnection(makeCfg({ id: "b", name: "B" }), "p2");
    await mgr.setActive("a");

    const item = createStatusBar(mgr);
    expect(item.item.text).toContain("A");

    await mgr.setActive("b");
    expect(item.item.text).toContain("B");
  });

  // RLX-03 TASK-RLX03-002 — recovery-text literal exact match.
  it("renders exact recovery literals and returns to normal on next active change", async () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunneled = makeCfg({
      id: "a",
      name: "Local",
      driver: "postgres",
      tunnel: { host: "bastion", port: 22 },
    });
    const other = makeCfg({ id: "b", name: "Other", driver: "postgres" });
    ws.update("vsdb.connections", [tunneled, other]);
    ws.update("vsdb.activeConnection", "a");
    await secret.store("vsdb.pass.a", "pwA");
    await secret.store("vsdb.pass.b", "pwB");

    const oldA = makeAdapter();
    const newA = makeAdapter();
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => newA);
    const tunnels = makeFakeTunnels();
    const sleep = vi.fn(async () => {});
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );

    const item = createStatusBar(mgr);
    expect(item.item.text).toBe("$(database) Local [postgres]");

    // Record every text assignment so we can assert the EXACT pinned
    // literals in order (Test Case 6).
    const textHistory: string[] = [];
    let currentText = item.item.text;
    textHistory.push(currentText);
    Object.defineProperty(item.item, "text", {
      configurable: true,
      get: () => currentText,
      set: (v: string) => {
        currentText = v;
        textHistory.push(v);
      },
    });

    await mgr.getAdapter();
    // Trigger the recovery loop.
    tunnels.emitExit({ key: "a", code: 1, signal: null, intentional: false });
    // Yield several times so the loop can publish each status.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    // Both pinned recovery literals rendered exactly, in order.
    expect(textHistory).toContain("$(sync~spin) Local reconnecting (1/2)");
    expect(textHistory).toContain("$(check) Local reconnected");
    expect(textHistory[textHistory.length - 1]).toBe("$(check) Local reconnected");

    // Now switch active to a different connection — text should return to normal form.
    await mgr.setActive("b");
    expect(item.item.text).toBe("$(database) Other [postgres]");

    item.dispose();
    await mgr.dispose();
  });

  it("renders exact failed text when both attempts fail", async () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const tunneled = makeCfg({
      id: "f",
      name: "Local",
      driver: "postgres",
      tunnel: { host: "bastion", port: 22 },
    });
    ws.update("vsdb.connections", [tunneled]);
    ws.update("vsdb.activeConnection", "f");
    await secret.store("vsdb.pass.f", "pwF");

    const oldA = makeAdapter();
    const failA1 = makeAdapter();
    const failA2 = makeAdapter();
    failA1.testConnection.mockRejectedValueOnce(new Error("nope"));
    failA2.testConnection.mockRejectedValueOnce(new Error("nope"));
    const factory = vi.fn()
      .mockImplementationOnce(() => oldA)
      .mockImplementationOnce(() => failA1)
      .mockImplementationOnce(() => failA2);
    const tunnels = makeFakeTunnels();
    const sleep = vi.fn(async () => {});
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory as never,
      tunnels as unknown as SshTunnelManager,
      { delayMs: 1_000, sleep },
    );
    const item = createStatusBar(mgr);
    await mgr.getAdapter();
    tunnels.emitExit({ key: "f", code: 1, signal: null, intentional: false });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    expect(item.item.text).toBe("$(error) Local reconnect failed");
    item.dispose();
    await mgr.dispose();
  });

  // TASK-UX2-003 case 6 + 7 — wrapper shape. `createStatusBar` returns a
  // wrapper `{ item, setErrorBadge, dispose }` (breaking change from bare
  // StatusBarItem). Existing callers use `.item` for the raw StatusBarItem
  // (e.g. for dispose or text access) and `.setErrorBadge(reason|null)` for
  // the red error chip. `.dispose()` is the canonical cleanup.
  it("case 6 — setErrorBadge flips text to $(error) then back to plain on null", async () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const adapter = makeAdapter();
    const factory = vi.fn(() => adapter as unknown as DbAdapter);
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory,
    );
    await mgr.addConnection(makeCfg({ id: "a", name: "Local", driver: "postgres" }), "p");
    await mgr.setActive("a");

    const wrapper = createStatusBar(mgr);
    expect(wrapper.item.text).toBe("$(database) Local [postgres]");

    wrapper.setErrorBadge("ECONNREFUSED");
    expect(wrapper.item.text).toBe("$(error) Local [postgres]");
    expect(wrapper.item.tooltip).toBe("vsdb: error: ECONNREFUSED");

    wrapper.setErrorBadge(null);
    // Back to the normal render path.
    expect(wrapper.item.text).toBe("$(database) Local [postgres]");
    expect(wrapper.item.tooltip).toBe("Local — click để đổi connection");

    wrapper.dispose();
  });

  it("case 7 — wrapper exposes item (underlying StatusBarItem) + dispose for existing call sites", async () => {
    const secret = new FakeSecretStorage();
    const ws = new FakeMemento();
    const g = new FakeMemento();
    const adapter = makeAdapter();
    const factory = vi.fn(() => adapter as unknown as DbAdapter);
    const mgr = new ConnectionManager(
      { secrets: secret, workspaceState: ws, globalState: g } as never,
      factory,
    );
    await mgr.addConnection(makeCfg({ id: "a", name: "Local", driver: "postgres" }), "p");
    await mgr.setActive("a");

    const wrapper = createStatusBar(mgr);

    // `.item` is the underlying vscode.StatusBarItem — exposes the original
    // `text` / `command` / `dispose` etc. for legacy call sites.
    expect(wrapper.item).toBeDefined();
    expect(typeof wrapper.item.text).toBe("string");
    expect(wrapper.item.command).toBe("vsdb.selectConnection");
    expect(wrapper.item.text).toBe("$(database) Local [postgres]");

    // `.dispose()` is the canonical cleanup — must dispose the underlying
    // item AND the subscribed listeners. Calling the underlying item's
    // dispose directly is fine; the wrapper's dispose also handles it.
    expect(typeof wrapper.dispose).toBe("function");
    wrapper.dispose();
    expect(mockStatusBarItem.dispose).toHaveBeenCalled();
  });
});