// src/ui/__tests__/browseCommands.test.ts
// TASK-001 — Unit tests cho buildBrowseSelect + registerBrowseCommands
// (vsdb.browseTableData command).
//
// Reuses the vi.mock("vscode") + vi.hoisted pattern from
// src/ui/__tests__/tableCommands.test.ts. ConnectionManager is a vi.fn()-based
// mock whose instance exposes getActive/setActive/listConnections/getAdapter.
//
// Verifies:
//  1. pure SELECT builder across pg/mysql/mssql + edge cases
//  2. command registration, palette fallback, busy/run/render pipeline
//  3. active-connection alignment ordering
//  4. error propagation + finally setBusy(false)
//  5. 0-row result still renders
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import type { ConnectionConfig, ParsedStatement } from "../../config/types";
import type { StatementResult } from "../../core/queryRunner";
import type { ConnectionManager } from "../../core/connectionManager";

interface BrowseNodeArg {
  meta?: {
    connection?: ConnectionConfig;
    schema?: string;
    objectName?: string;
  };
}

const state = vi.hoisted(() => ({
  registeredCommands: new Map<string, Function>(),
  infoMessages: [] as string[],
  errorMessages: [] as string[],
}));

vi.mock("vscode", () => ({
  EventEmitter: vi.fn().mockImplementation(() => {
    const listeners: Array<(e: unknown) => void> = [];
    return {
      event: (l: (e: unknown) => void) => {
        listeners.push(l);
        return { dispose: () => {} };
      },
      fire: (e: unknown) => listeners.slice().forEach((l) => l(e)),
      dispose: () => listeners.splice(0),
    };
  }),
  TreeItem: vi.fn(),
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: vi.fn(),
  ThemeColor: vi.fn(),
  Uri: {
    file: (p: string) => ({
      toString: () => `file://${p}`,
      fsPath: p,
      path: p,
      scheme: "file",
    }),
    parse: (s: string) => ({ toString: () => s }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
      path: p.join("/"),
    })),
  },
  ViewColumn: { Active: 1, Beside: 2 },
  window: {
    showInformationMessage: vi.fn((msg: string) => {
      state.infoMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showErrorMessage: vi.fn((msg: string) => {
      state.errorMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showInputBox: vi.fn().mockResolvedValue(undefined),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    setStatusBarMessage: vi.fn(() => ({ dispose: () => {} })),
    createWebviewPanel: vi.fn(),
    createTreeView: vi.fn(() => ({ reveal: vi.fn(), dispose: vi.fn() })),
    showTextDocument: vi.fn().mockResolvedValue({}),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    openTextDocument: vi.fn().mockResolvedValue({}),
  },
  commands: {
    registerCommand: vi.fn((id: string, fn: Function) => {
      state.registeredCommands.set(id, fn);
      return { dispose: () => state.registeredCommands.delete(id) };
    }),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  env: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
  languages: {
    registerCodeLensProvider: vi.fn(() => ({ dispose: () => {} })),
  },
}));

import * as vscode from "vscode";

import { buildBrowseSelect, registerBrowseCommands } from "../browseCommands";

interface FakeRunner {
  run: Mock;
}

interface FakePanel {
  setBusy: Mock;
  render: Mock;
  setBusySequence: boolean[];
  renderCalls: Array<{ results: StatementResult[]; header: string }>;
}

function makeFakeRunner(results: StatementResult[]): FakeRunner {
  return {
    run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
      onUpdate(results);
      return results;
    }),
  };
}

function makeFakePanel(): FakePanel {
  const setBusySequence: boolean[] = [];
  const renderCalls: Array<{ results: StatementResult[]; header: string }> = [];
  return {
    setBusy: vi.fn((b: boolean) => {
      setBusySequence.push(b);
    }),
    render: vi.fn((results: StatementResult[], header: string) => {
      renderCalls.push({ results, header });
    }),
    setBusySequence,
    renderCalls,
  };
}

interface FakeMgrOptions {
  activeId?: string | null;
  active?: ConnectionConfig | null;
  setActiveImpl?: (id: string) => Promise<void>;
}

function makeFakeMgr(opts: FakeMgrOptions = {}) {
  const setActive = opts.setActiveImpl
    ? vi.fn(opts.setActiveImpl)
    : vi.fn(async (_id: string) => undefined);
  return {
    setActive,
    getActive: vi.fn(() => opts.active ?? null),
    listConnections: vi.fn(() => []),
    getAdapter: vi.fn(),
  };
}

function resetState() {
  state.registeredCommands.clear();
  state.infoMessages.length = 0;
  state.errorMessages.length = 0;
}

beforeEach(() => {
  resetState();
});

// =============================================================================
// buildBrowseSelect — pure per-dialect SELECT builder.
// =============================================================================
describe("buildBrowseSelect", () => {
  it("#1 postgres quoting with schema — no trailing semicolon", () => {
    const sql = buildBrowseSelect("postgres", "public", "users");
    expect(sql).toBe('SELECT * FROM "public"."users"');
    expect(sql.endsWith(";")).toBe(false);
  });

  it("#2 mysql backtick + mssql bracket quoting", () => {
    const mysqlSql = buildBrowseSelect("mysql", "mydb", "users");
    expect(mysqlSql).toBe("SELECT * FROM `mydb`.`users`");
    const mssqlSql = buildBrowseSelect("mssql", "mydb", "users");
    expect(mssqlSql).toBe("SELECT * FROM [mydb].[users]");
  });

  it("#3 embedded delimiter chars are escaped per-dialect", () => {
    expect(buildBrowseSelect("postgres", "public", 'ev"il')).toBe(
      'SELECT * FROM "public"."ev""il"',
    );
    expect(buildBrowseSelect("mysql", "mydb", "ev`il")).toBe(
      "SELECT * FROM `mydb`.`ev``il`",
    );
    expect(buildBrowseSelect("mssql", "mydb", "ev]il")).toBe(
      "SELECT * FROM [mydb].[ev]]il]",
    );
  });

  it("#4 empty schema — driver-specific unqualified form", () => {
    expect(buildBrowseSelect("postgres", "", "t")).toBe('SELECT * FROM "t"');
    expect(buildBrowseSelect("mysql", "", "t")).toBe("SELECT * FROM `t`");
    expect(buildBrowseSelect("mssql", "", "t")).toBe("SELECT * FROM [t]");
  });
});

// =============================================================================
// registerBrowseCommands — vsdb.browseTableData
// =============================================================================
describe("registerBrowseCommands", () => {
  it("#5 palette / no meta — showInformationMessage, no runner.run, no setBusy(true)", async () => {
    const runner = makeFakeRunner([]);
    const panel = makeFakePanel();
    const mgr = makeFakeMgr();
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    expect(fn).toBeDefined();
    await fn!(undefined);
    await fn!({});
    expect(runner.run).not.toHaveBeenCalled();
    expect(panel.setBusy).not.toHaveBeenCalledWith(true);
    expect(state.infoMessages.length).toBe(2);
  });

  it("#6 happy pipeline — setActive? → runner.run once → render onUpdate + final; setBusy true…false", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "Test PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const fakeResults: StatementResult[] = [
      {
        index: 0,
        sql: 'SELECT * FROM "public"."users"',
        status: "done",
        result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 1 },
        durationMs: 1,
      },
    ];
    const runner = makeFakeRunner(fakeResults);
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
    // runner.run called once with the expected statement.
    expect(runner.run).toHaveBeenCalledTimes(1);
    const [stmts, onUpdate] = runner.run.mock.calls[0] as [
      ParsedStatement[],
      (r: StatementResult[]) => void,
    ];
    // Simulate onUpdate call — render must be invoked (onUpdate + final; spec says ≥2).
    onUpdate(fakeResults);
    expect(panel.render.mock.calls.length).toBeGreaterThanOrEqual(2);
    // First onUpdate call uses the mocked results array (may be called multiple times
    // by test setup + manual onUpdate invocation + final render — every call must pass
    // the mocked results array, never an empty/incorrect substitute).
    for (const call of panel.render.mock.calls) {
      expect(call[0]).toBe(fakeResults);
    }
    // setBusy sequence true…false.
    expect(panel.setBusySequence).toEqual([true, false]);
  });

  it("#7 active-connection alignment — node conn ≠ active → setActive called BEFORE first runner.run", async () => {
    const nodeConn: ConnectionConfig = {
      id: "c2",
      name: "Other PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const activeConn: ConnectionConfig = {
      id: "c1",
      name: "Test PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const callOrder: string[] = [];
    const runner: FakeRunner = {
      run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
        callOrder.push("runner.run");
        onUpdate([]);
        return [];
      }),
    };
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: activeConn });
    const setActiveSpy = mgr.setActive.mockImplementation(async (id: string) => {
      callOrder.push(`setActive:${id}`);
    });
    void setActiveSpy;
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: nodeConn, schema: "public", objectName: "users" } });
    expect(mgr.setActive).toHaveBeenCalledWith("c2");
    // setActive MUST appear BEFORE runner.run in call order.
    const setActiveIdx = callOrder.indexOf("setActive:c2");
    const runIdx = callOrder.indexOf("runner.run");
    expect(setActiveIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(setActiveIdx).toBeLessThan(runIdx);

    // Case 7b: node conn === active → setActive NOT called.
    state.registeredCommands.clear();
    state.infoMessages.length = 0;
    state.errorMessages.length = 0;
    const mgr2 = makeFakeMgr({ activeId: "c1", active: activeConn });
    const runner2 = makeFakeRunner([]);
    const panel2 = makeFakePanel();
    registerBrowseCommands({
      mgr: mgr2 as unknown as ConnectionManager,
      runner: runner2 as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel2 as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn2 = state.registeredCommands.get("vsdb.browseTableData");
    await fn2!({ meta: { connection: activeConn, schema: "public", objectName: "users" } });
    expect(mgr2.setActive).not.toHaveBeenCalled();
    expect(runner2.run).toHaveBeenCalledTimes(1);
  });

  it("#8 setActive rejection — showErrorMessage + setBusy(false) reached; panel.render NEVER with results", async () => {
    const nodeConn: ConnectionConfig = {
      id: "c2",
      name: "Other",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const activeConn: ConnectionConfig = {
      id: "c1",
      name: "Test",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const fakeResults: StatementResult[] = [
      {
        index: 0,
        sql: 'SELECT * FROM "public"."users"',
        status: "done",
        result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 1 },
        durationMs: 1,
      },
    ];
    const runner: FakeRunner = {
      run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
        onUpdate(fakeResults);
        return fakeResults;
      }),
    };
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({
      activeId: "c1",
      active: activeConn,
      setActiveImpl: async () => {
        throw new Error("setActive failed");
      },
    });
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: nodeConn, schema: "public", objectName: "users" } });
    expect(state.errorMessages.length).toBe(1);
    expect(state.errorMessages[0]).toMatch(/setActive failed/);
    // finally: setBusy(false) MUST have been called.
    expect(panel.setBusySequence[panel.setBusySequence.length - 1]).toBe(false);
    // panel.render NEVER invoked with results array (we abort before runner.run).
    expect(panel.render).not.toHaveBeenCalled();

    // Case 8b: runner.run rejects → showErrorMessage + setBusy(false); render NEVER with results.
    state.registeredCommands.clear();
    state.infoMessages.length = 0;
    state.errorMessages.length = 0;
    const runner2: FakeRunner = {
      run: vi.fn(async () => {
        throw new Error("runner boom");
      }),
    };
    const panel2 = makeFakePanel();
    const mgr2 = makeFakeMgr({ activeId: "c1", active: activeConn });
    registerBrowseCommands({
      mgr: mgr2 as unknown as ConnectionManager,
      runner: runner2 as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel2 as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn2 = state.registeredCommands.get("vsdb.browseTableData");
    await fn2!({ meta: { connection: activeConn, schema: "public", objectName: "users" } });
    expect(state.errorMessages.length).toBe(1);
    expect(state.errorMessages[0]).toMatch(/runner boom/);
    expect(panel2.setBusySequence).toEqual([true, false]);
    expect(panel2.render).not.toHaveBeenCalled();
  });

  it("#9 0-row table — runner resolves done with rows:[] → panel.render still called (not error path)", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "Test PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const emptyResults: StatementResult[] = [
      {
        index: 0,
        sql: 'SELECT * FROM "public"."users"',
        status: "done",
        result: { columns: ["id"], rows: [], rowCount: 0, durationMs: 1 },
        durationMs: 1,
      },
    ];
    const runner: FakeRunner = {
      run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
        onUpdate(emptyResults);
        return emptyResults;
      }),
    };
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
    // panel.render invoked (onUpdate + final) with the mocked empty results.
    expect(panel.render).toHaveBeenCalled();
    expect(panel.render.mock.calls[0][0]).toBe(emptyResults);
    expect(panel.render.mock.calls[1][0]).toBe(emptyResults);
    // NOT in the error path: no errorMessages.
    expect(state.errorMessages).toEqual([]);
  });
});

// =============================================================================
// TASK-007 — vsdb.browseTableData applies qualifyKeywordTables. Browse SQL is
// already qualified (driver-specific quoting), so the transform is a no-op for
// the normal `public/users` browse. Test verifies the wiring: listTables is
// consulted (called with "public") and the existing pipeline stays intact.
// =============================================================================
it("#11 browse path applies qualifyKeywordTables — listTables('public') consulted, SQL unchanged for normal browse", async () => {
  const conn: ConnectionConfig = {
    id: "c1",
    name: "Test PG",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "vsdb",
    database: "vsdb",
  };
  const listTablesSpy = vi.fn(async (_schema: string): Promise<Array<{ name: string; schema: string }>> => [{ name: "order", schema: "public" }]);
  const mgr = makeFakeMgr({ activeId: "c1", active: conn });
  (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter =
    vi.fn(async () => ({ listTables: listTablesSpy }));
  const runner: FakeRunner = {
    run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
      onUpdate([]);
      return [];
    }),
  };
  const panel = makeFakePanel();
  registerBrowseCommands({
    mgr: mgr as unknown as ConnectionManager,
    runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
    panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
  });
  const fn = state.registeredCommands.get("vsdb.browseTableData");
  expect(fn).toBeDefined();
  await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
  expect(runner.run).toHaveBeenCalledTimes(1);
  const [stmts] = runner.run.mock.calls[0] as [ParsedStatement[], unknown];
  expect(stmts[0]!.text).toBe('SELECT * FROM "public"."users"');
  // RED: listTables must be called with "public" — currently NOT called because
  // browseCommands has no wiring to the transform.
  expect(listTablesSpy).toHaveBeenCalledWith("public");
});

// Suppress lint warning about unused vscode import — needed to wire the mock.
void vscode;