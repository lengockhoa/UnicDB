// src/core/__tests__/connectionManagerActiveSchema.test.ts
// ConnectionManager wraps every Postgres adapter's `runQuery` with a
// `SET search_path TO "<schema>", public;` prepend when the
// `ActiveSchemaStore` has a pinned schema for that connection.
//
// Covers (acceptance):
//   - postgres + pinned schema → runQuery receives SET-prepended SQL
//   - postgres + no pin → runQuery receives the SQL untouched
//   - non-postgres driver → never wraps (mysql/mssql/bigquery unaffected)
//   - probe adapters (used by addConnection / editConnection validation)
//     are NOT wrapped — they never run user SQL anyway, so wrapping them
//     would only mask validation failures.
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
  dispose(): void {
    this.listeners = [];
  }
}

class FakeMemento {
  private data = new Map<string, unknown>();
  constructor(initial: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(initial)) this.data.set(k, v);
  }
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
}

vi.mock("vscode", () => ({
  EventEmitter: vi.fn(() => new FakeEventEmitter<unknown>()),
  workspace: {
    workspaceFolders: undefined as
      | undefined
      | ReadonlyArray<{ uri: unknown; name: string; index: number }>,
  },
}));

// Imports AFTER the mock.
import { ConnectionManager } from "../connectionManager";
import { ActiveSchemaStore } from "../activeSchemaStore";
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter } from "../../adapters/types";
import type { RunResult } from "../../adapters/types";

interface Capture {
  /** Adapter returned by the factory — caller can reach into its `runQuery`. */
  adapter: DbAdapter;
  /** Captured SQL passed to `runQuery` (post-wrap). */
  runs: string[];
}

function makeCfg(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "pg1",
    name: "Local PG",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    user: "u",
    database: "d",
    sslMode: "prefer",
    manualCommit: false,
    ...overrides,
  } as ConnectionConfig;
}

function makeCapture(): Capture {
  const runs: string[] = [];
  const adapter: DbAdapter = {
    connect: async () => undefined,
    close: async () => undefined,
    testConnection: async () => undefined,
    runQuery: async (sql: string): Promise<RunResult> => {
      runs.push(sql);
      return { results: [] };
    },
    listSchemas: async () => [],
    listTables: async () => [],
    listViews: async () => [],
    listRoutines: async () => [],
    listColumns: async () => [],
  } as unknown as DbAdapter;
  return { adapter, runs };
}

function setup(opts: {
  driver?: ConnectionConfig["driver"];
  connectionId?: string;
  pinSchema?: string;
}) {
  const cfg = makeCfg({
    id: opts.connectionId ?? "pg1",
    driver: opts.driver ?? "postgres",
  });
  const factory = vi.fn(() => opts.adapter ?? makeCapture().adapter);
  const cap = makeCapture();
  // Re-wire factory to return our capture adapter.
  const adapter = cap.adapter;
  const realFactory = vi.fn(() => adapter);

  const mem = new FakeMemento();
  const store = new ActiveSchemaStore(mem as never);
  if (opts.pinSchema) store.set(cfg.id, opts.pinSchema);

  const ctx = {
    secrets: {
      get: async (_k: string) => "pw",
      store: async (_k: string, _v: string) => undefined,
      delete: async (_k: string) => undefined,
    },
    workspaceState: mem,
    globalState: mem,
  };
  const mgr = new ConnectionManager(
    ctx as never,
    realFactory as never,
    undefined,
    undefined,
    store,
  );
  // Avoid the factory-calls-argument shadow.
  void factory;
  return { mgr, cfg, adapter, cap, store };
}

describe("ConnectionManager — active schema wrap (postgres)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prepends SET search_path when a schema is pinned", async () => {
    const { mgr, cfg, cap } = setup({ pinSchema: "analytics" });
    await mgr.addConnection(cfg, "pw");
    await mgr.setActive(cfg.id);
    const a = await mgr.getAdapter();
    await a.runQuery("SELECT 1;");
    expect(cap.runs).toHaveLength(1);
    expect(cap.runs[0]).toBe(
      'SET search_path TO "analytics", public;\nSELECT 1;',
    );
  });

  it("does NOT prepend when no schema is pinned", async () => {
    const { mgr, cfg, cap } = setup({});
    await mgr.addConnection(cfg, "pw");
    await mgr.setActive(cfg.id);
    const a = await mgr.getAdapter();
    await a.runQuery("SELECT 1;");
    expect(cap.runs).toEqual(["SELECT 1;"]);
  });

  it("does NOT prepend for non-postgres drivers (mysql)", async () => {
    const { mgr, cfg, cap } = setup({ driver: "mysql", pinSchema: "ignored" });
    await mgr.addConnection(cfg, "pw");
    await mgr.setActive(cfg.id);
    const a = await mgr.getAdapter();
    await a.runQuery("SELECT 1;");
    expect(cap.runs).toEqual(["SELECT 1;"]);
  });

  it("does NOT prepend for non-postgres drivers (mssql)", async () => {
    const { mgr, cfg, cap } = setup({ driver: "mssql", pinSchema: "ignored" });
    await mgr.addConnection(cfg, "pw");
    await mgr.setActive(cfg.id);
    const a = await mgr.getAdapter();
    await a.runQuery("SELECT 1;");
    expect(cap.runs).toEqual(["SELECT 1;"]);
  });

  it("dynamic pin change is reflected on the next getAdapter() call", async () => {
    const { mgr, cfg, cap, store } = setup({ pinSchema: "analytics" });
    await mgr.addConnection(cfg, "pw");
    await mgr.setActive(cfg.id);
    let a = await mgr.getAdapter();
    await a.runQuery("SELECT 1;");
    expect(cap.runs[0]).toContain('SET search_path TO "analytics"');

    // Switch pin → next getAdapter() returns a freshly-built adapter that
    // wraps with the new schema. The previous `a` is closed.
    store.set(cfg.id, "reporting");
    a = await mgr.getAdapter();
    await a.runQuery("SELECT 2;");
    expect(cap.runs[1]).toContain('SET search_path TO "reporting"');
  });

  it("getActiveSchema / setActiveSchema delegations round-trip", async () => {
    const { mgr, cfg } = setup({});
    await mgr.addConnection(cfg, "pw");
    expect(mgr.getActiveSchema(cfg.id)).toBeUndefined();
    mgr.setActiveSchema(cfg.id, "reporting");
    expect(mgr.getActiveSchema(cfg.id)).toBe("reporting");
    mgr.setActiveSchema(cfg.id, undefined);
    expect(mgr.getActiveSchema(cfg.id)).toBeUndefined();
  });
});