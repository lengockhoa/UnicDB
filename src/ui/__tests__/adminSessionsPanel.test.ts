// src/ui/__tests__/adminSessionsPanel.test.ts
// Tests for AdminSessionsPanelCore (TASK-AHL-003) + DBX-08 capability gate.
import { describe, it, expect, vi } from "vitest";

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => {}; fire() {}; dispose() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { getConfiguration: vi.fn() },
  Uri: { file: (p: string) => ({ toString: () => p, fsPath: p }) },
}));
import {
  AdminSessionsPanelCore,
  buildPanelHtml,
  renderUnsupportedAdminHtml,
  type PanelMessage,
} from "../adminSessionsPanel";

function makeCore(opts?: { confirmResult?: boolean; selfPid?: number | null }) {
  const confirm = vi.fn().mockResolvedValue(opts?.confirmResult ?? true);
  const postMessage = vi.fn();
  const runSql = vi.fn().mockResolvedValue({ rows: [{ pid: opts?.selfPid ?? 9999 }] });
  const core = new AdminSessionsPanelCore({ runSql, confirm, postMessage });
  return { core, confirm, postMessage, runSql };
}

describe("AdminSessionsPanelCore", () => {
  it("Sessions tab renders rows from setData", () => {
    const { core } = makeCore();
    core.setData({
      sessions: [
        { pid: 11, usename: "alice", state: "active", durationMs: 120, query: "SELECT 1" },
        { pid: 22, usename: "bob", state: "idle", durationMs: 50, query: "SELECT 2" },
        { pid: 33, usename: "carol", state: "active", durationMs: 9999, query: "SELECT 3" },
      ],
      locks: [],
    });
    const html = core.render();
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("carol");
    expect(core.getSessions()).toHaveLength(3);
  });

  it("Locks tab renders blocked → blocking chains", () => {
    const { core } = makeCore();
    core.setData({
      sessions: [],
      locks: [
        { blockedPid: 50, blockingPid: 60, lockType: "relation", mode: "ExclusiveLock", relation: "public.t" },
        { blockedPid: 70, blockingPid: 80, lockType: "transactionid", mode: "ShareLock", relation: undefined },
      ],
    });
    const html = core.render();
    expect(html).toContain("ExclusiveLock");
    expect(html).toContain("ShareLock");
    expect(html).toContain("public.t");
  });

  it("self-pid disables buttons + adds (self) badge in HTML", async () => {
    const { core } = makeCore({ selfPid: 42 });
    await core.loadSelfPid();
    core.setData({
      sessions: [{ pid: 42, usename: "me", state: "active", durationMs: 1, query: "x" }],
      locks: [],
    });
    const html = core.render();
    expect(html).toContain("(self)");
    expect(html).toMatch(/<button[^>]*data-action="kill"[^>]*data-pid="42"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*data-action="terminate"[^>]*data-pid="42"[^>]*disabled/);
  });

  it("Kill (cancel) fires pg_cancel_backend after confirm", async () => {
    const { core, confirm } = makeCore({ confirmResult: true, selfPid: 1 });
    const sql = await core.handleMessage({ kind: "kill", pid: 9999 } as PanelMessage);
    expect(sql).toBe("SELECT pg_cancel_backend(9999)");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("Terminate fires pg_terminate_backend after confirm", async () => {
    const { core, confirm } = makeCore({ confirmResult: true, selfPid: 1 });
    const sql = await core.handleMessage({ kind: "terminate", pid: 9999 } as PanelMessage);
    expect(sql).toBe("SELECT pg_terminate_backend(9999)");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("deny on confirm → no SQL returned", async () => {
    const { core, confirm } = makeCore({ confirmResult: false, selfPid: 1 });
    const sql = await core.handleMessage({ kind: "kill", pid: 9999 } as PanelMessage);
    expect(sql).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("self-pid is rejected even if confirm is somehow not called", async () => {
    const { core } = makeCore({ selfPid: 100 });
    await core.loadSelfPid();
    const sql = await core.handleMessage({ kind: "kill", pid: 100 } as PanelMessage);
    expect(sql).toBeNull();
  });
  it("setError surfaces 42501 in the rendered HTML", () => {
    const { core } = makeCore();
    core.setError("ERROR: 42501 insufficient_privilege");
    const html = core.render();
    expect(html).toContain("error");
    expect(html).toContain("42501");
  });

  it("loadSelfPid runs SELECT pg_backend_pid() and caches result", async () => {
    const { core, runSql } = makeCore({ selfPid: 1234 });
    await core.loadSelfPid();
    expect(core.getSelfPid()).toBe(1234);
    expect(runSql).toHaveBeenCalledWith("SELECT pg_backend_pid() AS pid");
  });

  it("buildPanelHtml escapes query text safely", () => {
    const html = buildPanelHtml({
      sessions: [
        {
          pid: 1,
          usename: "<script>alert(1)</script>",
          state: "active",
          durationMs: 1,
          query: "SELECT 'x' FROM \"t\"",
        },
      ],
      locks: [],
      selfPid: null,
      errorMessage: null,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;t&quot;");
  });
});

// =============================================================================
// TASK-DBX08-003 — Test Case #3 (panel seam): a false/missing `admin`
// declaration produces the precise unsupported error state BEFORE
// `pg_backend_pid()` SQL or any AdminApi method call. Structural presence of
// `adapter.admin` alone no longer admits the panel data path.
// =============================================================================
describe("AdminSessionsPanel refresh — DBX-08 declared admin capability", () => {
  const UNSUPPORTED_MESSAGE =
    "VSDB: Admin tools are not supported by this connection's database.";

  function makeAdminApi(): {
    api: {
      listRoles: ReturnType<typeof vi.fn>;
      listRoleGrants: ReturnType<typeof vi.fn>;
      listSessions: ReturnType<typeof vi.fn>;
      listLockWaits: ReturnType<typeof vi.fn>;
      buildGrantSql: ReturnType<typeof vi.fn>;
      buildRevokeSql: ReturnType<typeof vi.fn>;
    };
  } {
    return {
      api: {
        listRoles: vi.fn().mockResolvedValue([]),
        listRoleGrants: vi.fn().mockResolvedValue([]),
        listSessions: vi.fn().mockResolvedValue([]),
        listLockWaits: vi.fn().mockResolvedValue([]),
        buildGrantSql: vi.fn(),
        buildRevokeSql: vi.fn(),
      },
    };
  }

  async function refreshAgainst(adapter: unknown): Promise<{
    html: string;
    runSqlCalls: string[];
    getError: () => string | null;
  }> {
    let html = "";
    const runSqlCalls: string[] = [];
    let errorState: string | null = null;
    // Exercise the real refresh() path with a minimal webview double, keeping
    // the test mapped to src/ui/adminSessionsPanel.ts (not just the core).
    const { AdminSessionsPanel } = await import("../adminSessionsPanel");
    interface Refreshable {
      refresh(): Promise<void>;
    }
    const panelStub = {
      webview: {
        set html(value: string) {
          html = value;
        },
        get html() {
          return html;
        },
        postMessage: vi.fn().mockResolvedValue(undefined),
        onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
      },
      onDidDispose: vi.fn(() => ({ dispose: () => {} })),
      reveal: vi.fn(),
    };
    const conn = {
      id: "c1",
      name: "c",
      driver: "mysql",
      host: "h",
      port: 5432,
      user: "u",
      database: "d",
    };
    const mgr = {
      getActive: () => conn,
      getAdapter: vi.fn(async () => adapter),
      getAdapterFor: vi.fn(async () => adapter),
    };
    // The private constructor is exercised here on purpose: refresh() is the
    // production data path under test (capability gate before self-PID SQL).
    const PrivatePanel = AdminSessionsPanel as unknown as {
      new (...args: unknown[]): Refreshable;
    };
    const fakeAdapter = adapter as {
      runQuery?: (sql: string) => Promise<unknown>;
    };
    fakeAdapter.runQuery = vi.fn(async (sql: string) => {
      runSqlCalls.push(sql);
      return { rows: [{ pid: 4242 }] };
    });
    const instance = new PrivatePanel(panelStub, mgr, conn) as unknown as {
      refresh(): Promise<void>;
      core: AdminSessionsPanelCore;
    };
    await instance.refresh();
    return { html, runSqlCalls, getError: () => instance.core.getError() };
  }

  it("refresh with false admin declaration renders the unsupported state before pg_backend_pid or admin calls", async () => {
    const { api } = makeAdminApi();
    const adapter = {
      capabilities: { catalog: false, objectDdl: false, tableDdl: false, admin: false },
      admin: api,
    };
    const { html, runSqlCalls, getError } = await refreshAgainst(adapter);
    // Core error state is the VERBATIM message; the HTML banner is its
    // HTML-escaped render (browser-equivalent).
    expect(getError()).toBe(UNSUPPORTED_MESSAGE);
    expect(html).toContain("Admin tools are not supported by this connection");
    expect(runSqlCalls).toHaveLength(0); // no SELECT pg_backend_pid()
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.listLockWaits).not.toHaveBeenCalled();
  });

  it("refresh with missing capabilities (legacy adapter) renders the same unsupported state", async () => {
    const { api } = makeAdminApi();
    const adapter = { admin: api };
    const { html, runSqlCalls, getError } = await refreshAgainst(adapter);
    expect(getError()).toBe(UNSUPPORTED_MESSAGE);
    expect(html).toContain("Admin tools are not supported by this connection");
    expect(runSqlCalls).toHaveLength(0);
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it("declared admin:true keeps the existing data flow (self-PID + sessions)", async () => {
    const { api } = makeAdminApi();
    api.listSessions.mockResolvedValue([
      { pid: 7, usename: "bob", state: "active", durationMs: 5, query: "SELECT 1" },
    ]);
    api.listLockWaits.mockResolvedValue([]);
    const adapter = {
      capabilities: { catalog: true, objectDdl: true, tableDdl: true, admin: true },
      admin: api,
    };
    const { html, runSqlCalls } = await refreshAgainst(adapter);
    expect(html).toContain("bob");
    expect(runSqlCalls).toContain("SELECT pg_backend_pid() AS pid");
  });

  it("renderUnsupportedAdminHtml renders the precise unsupported error state", () => {
    const html = renderUnsupportedAdminHtml();
    expect(html).toContain("Admin tools are not supported by this connection");
    expect(html).toContain("error");
  });
});
