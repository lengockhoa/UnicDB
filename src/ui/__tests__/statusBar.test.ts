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
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter } from "../../adapters/types";

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
    expect(item.text).toBe("");
    expect(item.hide).toHaveBeenCalled();
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
    expect(item.text).toBe("$(database) Local [postgres]");
    expect(item.command).toBe("vsdb.selectConnection");
    expect(item.show).toHaveBeenCalled();
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
    expect(item.text).toContain("A");

    await mgr.setActive("b");
    expect(item.text).toContain("B");
  });
});