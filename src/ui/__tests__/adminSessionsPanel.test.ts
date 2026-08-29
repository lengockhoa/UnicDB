// src/ui/__tests__/adminSessionsPanel.test.ts
// Tests for AdminSessionsPanelCore (TASK-AHL-003).
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
