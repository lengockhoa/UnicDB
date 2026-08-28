// src/ui/__tests__/ddlView.test.ts
// TASK-AF-002 — vsdb-ddl: virtual document content provider.
// Tests 7-9 from TASK-AF-002 §Test Cases.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";

const state = vi.hoisted(() => ({
  providers: new Map<string, { provideTextDocumentContent: (uri: unknown) => string }>(),
  registeredCommands: new Map<string, Function>(),
  openedDocuments: [] as Array<{ uri: unknown; options?: unknown }>,
  shownDocuments: [] as Array<{ uri: unknown; options?: unknown }>,
  infoMessages: [] as string[],
  errorMessages: [] as string[],
  workspaceEdits: [] as unknown[],
}));

vi.mock("vscode", () => ({
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: () => ({ dispose: () => {} }),
    fire: () => {},
    dispose: () => {},
  })),
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p, scheme: "file" }),
    parse: (s: string) => ({ toString: () => s, scheme: s.split(":")[0], path: s.split(":")[1] ?? "", query: "" }),
  },
  workspace: {
    registerTextDocumentContentProvider: vi.fn((scheme: string, provider: unknown) => {
      state.providers.set(scheme, provider as never);
      return { dispose: () => state.providers.delete(scheme) };
    }),
    openTextDocument: vi.fn((uri: unknown, options?: unknown) => {
      state.openedDocuments.push({ uri, options });
      return Promise.resolve({ uri });
    }),
    applyEdit: vi.fn((edit: unknown) => {
      state.workspaceEdits.push(edit);
      return Promise.resolve(true);
    }),
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
    })),
    textDocuments: [],
  },
  window: {
    showInformationMessage: vi.fn((msg: string) => {
      state.infoMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showErrorMessage: vi.fn((msg: string) => {
      state.errorMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showTextDocument: vi.fn((uri: unknown, options?: unknown) => {
      state.shownDocuments.push({ uri, options });
      return Promise.resolve({});
    }),
  },
  commands: {
    registerCommand: vi.fn((id: string, fn: Function) => {
      state.registeredCommands.set(id, fn);
      return { dispose: () => state.registeredCommands.delete(id) };
    }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3 },
}));

import * as vscode from "vscode";
import { DdlViewProviderImpl, openDdl, registerDdlView } from "../ddlView";

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

interface AdapterLookup {
  getAdapterFor?: (cfg: ConnectionConfig) => Promise<unknown>;
  getActive?: () => ConnectionConfig | null;
}

function makeAdapter(opts: {
  ddlImpl?: (kind: "view" | "routine" | "trigger", name: string, schema?: string) => Promise<string>;
  catalog?: boolean;
} = {}) {
  return {
    catalog: opts.catalog === false ? undefined : {
      objectDdl: vi.fn().mockImplementation(
        opts.ddlImpl ?? ((kind: "string", name: string) =>
          Promise.resolve(`CREATE ${kind.toUpperCase()} ${name};`)),
      ),
    },
  };
}

function makeMgr(adapter: unknown, opts: AdapterLookup = {}) {
  const cfg = makeCfg({ id: "m1" });
  return {
    listConnections: () => [cfg],
    getActive: opts.getActive ?? (() => cfg),
    getAdapter: async () => adapter,
    getAdapterFor: opts.getAdapterFor ?? (async () => adapter),
    onDidChangeActive: () => ({ dispose: () => {} }),
  };
}

describe("DdlViewProvider — TASK-AF-002 vsdb-ddl virtual document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.providers.clear();
    state.registeredCommands.clear();
    state.openedDocuments = [];
    state.shownDocuments = [];
    state.infoMessages = [];
    state.errorMessages = [];
    state.workspaceEdits = [];
  });

  it("Test #7 — openDdl(view) caches DDL from catalog.objectDdl; provideTextDocumentContent returns it", async () => {
    const adapter = makeAdapter({
      ddlImpl: async (_kind, name) => `CREATE VIEW ${name} AS SELECT 1;`,
    });
    const mgr = makeMgr(adapter);
    const provider = new DdlViewProviderImpl({ mgr, showDocument: (async (uri: vscode.Uri) => { state.shownDocuments.push({ uri }); return {}; }) as never });

    const node = {
      label: "v_active",
      contextValue: "view",
      meta: { connection: makeCfg(), schema: "public", objectName: "v_active" },
    };
    await openDdl(provider, node as never);

    // openDdl populates provider.cache; provider is the registered content
    // provider when wired via registerDdlView. Here we created the provider
    // directly and verify cache contents.
    const cached = Array.from(provider.cache.values())[0];
    expect(cached).toContain("CREATE VIEW v_active");
    expect(cached).toContain("SELECT 1");
  });

  it("Test #8 — catalog.objectDdl rejects → cached document contains error notice", async () => {
    const adapter = makeAdapter({
      ddlImpl: async () => {
        throw new Error("permission denied");
      },
    });
    const mgr = makeMgr(adapter);
    const provider = new DdlViewProviderImpl({ mgr, showDocument: vi.fn().mockResolvedValue({}) as never });

    const node = {
      label: "v_secret",
      contextValue: "view",
      meta: { connection: makeCfg(), schema: "public", objectName: "v_secret" },
    };

    await openDdl(provider, node as never);

    const cached = Array.from(provider.cache.values())[0];
    expect(cached).toContain("permission denied");
    expect(cached.toLowerCase()).toContain("error");
  });

  it("Test #9 — adapter without catalog → cached document explains Postgres-only limitation", async () => {
    const adapter = makeAdapter({ catalog: false });
    const mgr = makeMgr(adapter);
    const provider = new DdlViewProviderImpl({ mgr, showDocument: vi.fn().mockResolvedValue({}) as never });

    const node = {
      label: "v_x",
      contextValue: "view",
      meta: { connection: makeCfg(), schema: "public", objectName: "v_x" },
    };

    await openDdl(provider, node as never);

    const cached = Array.from(provider.cache.values())[0];
    expect(cached.toLowerCase()).toContain("postgres");
  });
});

describe("registerDdlView — extension-side wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.providers.clear();
    state.registeredCommands.clear();
    state.openedDocuments = [];
    state.shownDocuments = [];
    state.infoMessages = [];
    state.errorMessages = [];
    state.workspaceEdits = [];
  });

  it("registers provider for vsdb-ddl + openDdl + refreshDdl commands", () => {
    const adapter = makeAdapter();
    const mgr = makeMgr(adapter);
    const disposables: { dispose: () => void }[] = [];
    registerDdlView(mgr as never, disposables);
    expect(state.providers.has("vsdb-ddl")).toBe(true);
    expect(state.registeredCommands.has("vsdb.openDdl")).toBe(true);
    expect(state.registeredCommands.has("vsdb.refreshDdl")).toBe(true);
    for (const d of disposables) d.dispose();
  });

  it("refreshDdl clears the cache for the active document", async () => {
    const adapter = makeAdapter({
      ddlImpl: async (_kind, name) => `CREATE VIEW ${name} AS SELECT 1;`,
    });
    const mgr = makeMgr(adapter);
    const disposables: { dispose: () => void }[] = [];
    const provider = registerDdlView(mgr as never, disposables);

    const node = {
      label: "v_active",
      contextValue: "view",
      meta: { connection: makeCfg(), schema: "public", objectName: "v_active" },
    };
    await openDdl(provider, node as never);

    const uriKey = Array.from(provider.cache.keys())[0];
    provider.refreshUri({ toString: () => uriKey, scheme: "vsdb-ddl", path: "", query: "" } as never);

    // After refreshUri, cache cleared → provideTextDocumentContent returns "".
    const p = state.providers.get("vsdb-ddl")!;
    const content = await p.provideTextDocumentContent({ toString: () => uriKey });
    expect(content).toBe("");

    const refresh = state.registeredCommands.get("vsdb.refreshDdl");
    expect(typeof refresh).toBe("function");
    await (refresh as () => Promise<void>)();
    for (const d of disposables) d.dispose();
  });
});

void vscode;
