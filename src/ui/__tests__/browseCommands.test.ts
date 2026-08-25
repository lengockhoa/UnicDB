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
    expect(buildBrowseSelect("postgres", "public", "users")).toBe(
      'SELECT * FROM "public"."users"',
    );
  });

  it("#2 mysql backtick + mssql bracket quoting", () => {
    expect(buildBrowseSelect("mysql", "mydb", "users")).toBe(
      "SELECT * FROM `mydb`.`users`",
    );
    expect(buildBrowseSelect("mssql", "dbo", "users")).toBe(
      "SELECT * FROM [dbo].[users]",
    );
  });

  it("#3 embedded delimiter chars are escaped per-dialect", () => {
    expect(buildBrowseSelect("postgres", "public", 'weird"name')).toBe(
      'SELECT * FROM "public"."weird""name"',
    );
    expect(buildBrowseSelect("mysql", "mydb", "we`ird")).toBe(
      "SELECT * FROM `mydb`.`we``ird`",
    );
    expect(buildBrowseSelect("mssql", "dbo", "we]ird")).toBe(
      "SELECT * FROM [dbo].[we]]ird]",
    );
  });

  it("#4 empty schema — driver-specific unqualified form", () => {
    expect(buildBrowseSelect("postgres", "", "users")).toBe('SELECT * FROM "users"');
    expect(buildBrowseSelect("mysql", "", "users")).toBe("SELECT * FROM `users`");
    expect(buildBrowseSelect("mssql", "", "users")).toBe("SELECT * FROM [users]");
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
    await fn!({});
    expect(state.infoMessages).toHaveLength(1);
    expect(state.infoMessages[0]).toContain("open a table node");
    expect(runner.run).not.toHaveBeenCalled();
    expect(panel.setBusy).not.toHaveBeenCalled();
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
    const runner: FakeRunner = {
      run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
        onUpdate([
          {
            index: 0,
            sql: 'SELECT * FROM "public"."users"',
            status: "running",
          } as StatementResult,
        ]);
        return [
          {
            index: 0,
            sql: 'SELECT * FROM "public"."users"',
            status: "done",
            result: { columns: ["id"], rows: [[1]] },
          } as StatementResult,
        ];
      }),
    };
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter = vi.fn(
      async () => ({ listTables: vi.fn(async () => []) }),
    );
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(panel.render).toHaveBeenCalledTimes(2);
    expect(panel.setBusySequence[0]).toBe(true);
    expect(panel.setBusySequence[panel.setBusySequence.length - 1]).toBe(false);
    expect(state.errorMessages).toEqual([]);
  });

  it("#7 active-connection alignment — node conn ≠ active → setActive called BEFORE first runner.run", async () => {
    const active: ConnectionConfig = {
      id: "c1",
      name: "Active",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "u",
      database: "d",
    };
    const nodeConn: ConnectionConfig = {
      id: "c2",
      name: "Other",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "u",
      database: "d",
    };
    const order: string[] = [];
    const setActive = vi.fn(async (_id: string) => {
      order.push("setActive");
    });
    const runner: FakeRunner = {
      run: vi.fn(async (_stmts: ParsedStatement[], _onUpdate: (r: StatementResult[]) => void) => {
        order.push("runner.run");
        return [];
      }),
    };
    const panel = makeFakePanel();
    const mgr = {
      setActive,
      getActive: vi.fn(() => active),
      listConnections: vi.fn(() => []),
      getAdapter: vi.fn(async () => ({ listTables: vi.fn(async () => []) })),
    };
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: nodeConn, schema: "public", objectName: "users" } });
    expect(setActive).toHaveBeenCalledWith("c2");
    expect(order).toEqual(["setActive", "runner.run"]);
  });

  it("#8 setActive rejection — showErrorMessage + setBusy(false) reached; panel.render NEVER with results", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "Active",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "u",
      database: "d",
    };
    const mgr = makeFakeMgr({
      activeId: null,
      active: null,
      setActiveImpl: async (_id: string) => {
        throw new Error("conn refused");
      },
    });
    const runner = makeFakeRunner([]);
    const panel = makeFakePanel();
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
    expect(state.errorMessages).toHaveLength(1);
    expect(state.errorMessages[0]).toContain("conn refused");
    expect(runner.run).not.toHaveBeenCalled();
    expect(panel.render).not.toHaveBeenCalled();
    expect(panel.setBusySequence[panel.setBusySequence.length - 1]).toBe(false);
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
    const runner: FakeRunner = {
      run: vi.fn(async (_stmts: ParsedStatement[], onUpdate: (r: StatementResult[]) => void) => {
        onUpdate([]);
        return [
          {
            index: 0,
            sql: 'SELECT * FROM "public"."empty"',
            status: "done",
            result: { columns: ["id"], rows: [] },
          } as StatementResult,
        ];
      }),
    };
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter = vi.fn(
      async () => ({ listTables: vi.fn(async () => []) }),
    );
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "empty" } });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(panel.render).toHaveBeenCalled();
    expect(panel.setBusySequence[panel.setBusySequence.length - 1]).toBe(false);
    expect(state.errorMessages).toEqual([]);
  });

  // Regression guard for the equality branch of `active.id !== conn.id` in
  // registerBrowseCommands (src/ui/browseCommands.ts). When the node conn is
  // already the active connection, setActive MUST NOT be called — a regression
  // that always calls setActive would still satisfy test #7 (which only
  // asserts the inequality path) but would cause needless state churn.
  it("#7b node conn === active → setActive NOT called; runner.run still executes", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "Test PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    const runner = makeFakeRunner([]);
    const panel = makeFakePanel();
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
    expect(mgr.setActive).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Regression guard for the runner-throw path through catch/finally at
  // src/ui/browseCommands.ts. runner.run rejecting must surface a single
  // showErrorMessage carrying the original message, leave panel.render
  // untouched (no onUpdate fired before the throw), and still execute the
  // finally setBusy(false).
  it("#8b runner.run rejects → showErrorMessage + setBusy(false); panel.render NEVER called", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "Test PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "vsdb",
      database: "vsdb",
    };
    const runner: FakeRunner = {
      run: vi.fn(async () => {
        throw new Error("runner boom");
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
    expect(state.errorMessages).toHaveLength(1);
    expect(state.errorMessages[0]).toContain("runner boom");
    expect(panel.setBusySequence[panel.setBusySequence.length - 1]).toBe(false);
    expect(panel.render).not.toHaveBeenCalled();
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
// =============================================================================
// TASK-001 — PG read-path is plain SELECT for every object (table / view /
// matview / foreign table). The previous TASK-006 implementation called
// `adapter.listColumns` and wrapped the SELECT with a subquery alias to
// append `ctid` for no-PK PG tables. That path crashed on views with
// `column "ctid" does not exist` and forced the save flow to chase host
// metadata. After this change, `vsdb.browseTableData` executes exactly one
// `buildBrowseSelect(...)` qualified through `qualifyKeywordTables` — no
// `listColumns`, no wrap, no host-added ctid column.
// =============================================================================

interface PgBrowseFixture {
  captureSql(sql: string): void;
  captured(): string[];
  adapter: AdapterWithTables & { listColumns: Mock };
}

function makePgBrowseFixture(
  listColumnsImpl: () => Promise<Array<{ name: string; isPrimaryKey?: boolean }>>,
): PgBrowseFixture {
  const captured: string[] = [];
  const captureSql = (sql: string) => {
    captured.push(sql);
  };
  const adapter: AdapterWithTables & { listColumns: Mock } = {
    listTables: vi.fn(async (_schema: string) => []),
    listColumns: vi.fn(listColumnsImpl),
  };
  return { captureSql, captured: () => captured, adapter };
}

describe("registerBrowseCommands — TASK-001 PG read-path is plain SELECT", () => {
  it("#12 PG view → plain SELECT (no wrap, adapter.listColumns NOT called, no ctid substring)", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "u",
      database: "d",
    };
    const fix = makePgBrowseFixture(
      async () => [
        { name: "id", isPrimaryKey: false },
        { name: "title", isPrimaryKey: false },
      ],
    );
    const runner = makeFakeRunner([]);
    (runner.run as Mock) = vi.fn(
      async (stmts: ParsedStatement[], _onUpdate: (r: StatementResult[]) => void) => {
        for (const s of stmts) fix.captureSql(s.text);
        return [];
      },
    );
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter = vi.fn(
      async () => fix.adapter,
    );
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "v_notes" } });
    expect(fix.captured()).toHaveLength(1);
    const sql = fix.captured()[0]!;
    // The view regression: under the previous TASK-006 wrap path the host
    // would crash with `column "ctid" does not exist` when the query ran
    // against a view (or matview / foreign table). Under TASK-001 the host
    // issues a plain SELECT and never touches adapter.listColumns.
    expect(sql).toBe('SELECT * FROM "public"."v_notes"');
    expect(fix.adapter.listColumns).not.toHaveBeenCalled();
    expect(sql.toLowerCase()).not.toContain("ctid");
  });

  it("#13 PG table WITH PK → browse SQL unchanged (no ctid appended)", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "u",
      database: "d",
    };
    const fix = makePgBrowseFixture(
      async () => [
        { name: "id", isPrimaryKey: true },
        { name: "name", isPrimaryKey: false },
      ],
    );
    const runner = makeFakeRunner([]);
    (runner.run as Mock) = vi.fn(
      async (stmts: ParsedStatement[], _onUpdate: (r: StatementResult[]) => void) => {
        for (const s of stmts) fix.captureSql(s.text);
        return [];
      },
    );
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter = vi.fn(
      async () => fix.adapter,
    );
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "users" } });
    expect(fix.captured()).toHaveLength(1);
    const sql = fix.captured()[0]!;
    expect(sql).toBe('SELECT * FROM "public"."users"');
    expect(sql.toLowerCase()).not.toContain("ctid");
  });

  it("#14 MySQL no-PK → browse SQL unchanged (driver != postgres)", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "My",
      driver: "mysql",
      host: "127.0.0.1",
      port: 3306,
      user: "u",
      database: "d",
    };
    const fix = makePgBrowseFixture(async () => [{ name: "name", isPrimaryKey: false }]);
    const runner = makeFakeRunner([]);
    (runner.run as Mock) = vi.fn(
      async (stmts: ParsedStatement[], _onUpdate: (r: StatementResult[]) => void) => {
        for (const s of stmts) fix.captureSql(s.text);
        return [];
      },
    );
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter = vi.fn(
      async () => fix.adapter,
    );
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "mydb", objectName: "notes" } });
    expect(fix.captured()).toHaveLength(1);
    const sql = fix.captured()[0]!;
    expect(sql).toBe("SELECT * FROM `mydb`.`notes`");
    expect(sql.toLowerCase()).not.toContain("ctid");
  });

  it("#15 PG no-PK + adapter.listColumns rejects → SQL stays plain SELECT (catalog failure path no longer relevant for browse)", async () => {
    const conn: ConnectionConfig = {
      id: "c1",
      name: "PG",
      driver: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "u",
      database: "d",
    };
    const captured: string[] = [];
    const runner = makeFakeRunner([]);
    (runner.run as Mock) = vi.fn(
      async (stmts: ParsedStatement[], _onUpdate: (r: StatementResult[]) => void) => {
        for (const s of stmts) captured.push(s.text);
        return [];
      },
    );
    const panel = makeFakePanel();
    const mgr = makeFakeMgr({ activeId: "c1", active: conn });
    (mgr as unknown as { getAdapter: () => Promise<unknown> }).getAdapter = vi.fn(
      async () => ({
        listTables: vi.fn(async () => []),
        listColumns: vi.fn(async () => {
          throw new Error("catalog unavailable");
        }),
      }),
    );
    registerBrowseCommands({
      mgr: mgr as unknown as ConnectionManager,
      runner: runner as unknown as Parameters<typeof registerBrowseCommands>[0]["runner"],
      panel: panel as unknown as Parameters<typeof registerBrowseCommands>[0]["panel"],
    });
    const fn = state.registeredCommands.get("vsdb.browseTableData");
    await fn!({ meta: { connection: conn, schema: "public", objectName: "notes" } });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('SELECT * FROM "public"."notes"');
  });
});
