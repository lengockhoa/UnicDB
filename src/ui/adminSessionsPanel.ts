// src/ui/adminSessionsPanel.ts
// AdminSessionsPanel — webview panel cho Sessions + Locks + kill/terminate
// confirm. (TASK-AHL-003)
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import type { DbAdapter } from "../adapters/types";

/** Distinct user-action messages từ webview. */
export type PanelMessage =
  | { kind: "refresh" }
  | { kind: "kill"; pid: number }
  | { kind: "terminate"; pid: number };

/** Row shape lưu trong core. */
export interface SessionRow {
  pid: number;
  usename: string;
  state: string;
  durationMs: number;
  query: string;
}

export interface LockRow {
  blockedPid: number;
  blockingPid: number;
  lockType: string;
  mode: string;
  relation: string | undefined;
}

/** HTML escape — an toàn cho cả query text. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/** Build panel HTML. */
export function buildPanelHtml(state: {
  sessions: SessionRow[];
  locks: LockRow[];
  selfPid: number | null;
  errorMessage: string | null;
}): string {
  const sessionRow = (s: SessionRow): string => {
    const isSelf = state.selfPid === s.pid;
    const disabled = isSelf ? "disabled" : "";
    const selfBadge = isSelf ? " (self)" : "";
    return `<tr data-pid="${s.pid}">
  <td>${s.pid}${escapeHtml(selfBadge)}</td>
  <td>${escapeHtml(s.usename)}</td>
  <td>${escapeHtml(s.state)}</td>
  <td>${s.durationMs}ms</td>
  <td><code>${escapeHtml(s.query)}</code></td>
  <td>
    <button data-action="kill" data-pid="${s.pid}" ${disabled}>Kill</button>
    <button data-action="terminate" data-pid="${s.pid}" ${disabled}>Terminate</button>
  </td>
</tr>`;
  };
  const lockRow = (l: LockRow): string =>
    `<tr>
  <td>${l.blockedPid}</td>
  <td>${l.blockingPid}</td>
  <td>${escapeHtml(l.lockType)}</td>
  <td>${escapeHtml(l.mode)}</td>
  <td>${escapeHtml(l.relation ?? "-")}</td>
</tr>`;
  const err = state.errorMessage
    ? `<div class="error">${escapeHtml(state.errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; border-bottom: 1px solid var(--vscode-editorWidget-border); padding: 4px 8px; }
  th { font-weight: 600; }
  code { font-family: var(--vscode-editor-font-family); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; margin-right: 4px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { color: var(--vscode-errorForeground); padding: 8px; border: 1px solid var(--vscode-errorBorder); margin-bottom: 8px; }
</style></head><body>
${err}
<h2>Sessions</h2>
<table>
  <thead><tr><th>pid</th><th>user</th><th>state</th><th>duration</th><th>query</th><th>actions</th></tr></thead>
  <tbody>${state.sessions.map(sessionRow).join("")}</tbody>
</table>
<h2>Locks</h2>
<table>
  <thead><tr><th>blocked</th><th>blocking</th><th>type</th><th>mode</th><th>relation</th></tr></thead>
  <tbody>${state.locks.map(lockRow).join("")}</tbody>
</table>
<button data-action="refresh">Refresh</button>
<script>
  const vscodeApi = acquireVsCodeApi();
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute("data-action");
    if (action === "refresh") {
      vscodeApi.postMessage({ kind: "refresh" });
      return;
    }
    if (action === "kill" || action === "terminate") {
      const pid = parseInt(target.getAttribute("data-pid") || "0", 10);
      if (pid > 0) {
        vscodeApi.postMessage({ kind: action, pid });
      }
    }
  });
</script>
</body></html>`;
}

export interface AdminSessionsPanelDeps {
  /** Run a SQL string via the connection's adapter (test seam). */
  runSql: (sql: string) => Promise<unknown>;
  /** Show a confirm modal (test seam). Returns true on Yes. */
  confirm: (message: string, options: { modal: boolean }) => Thenable<boolean>;
  /** Post a message to the webview (test seam). */
  postMessage: (msg: PanelMessage) => void;
}

/**
 * Pure renderer + state machine. Build HTML + handle messages without
 * coupling to vscode internals so unit tests don't need a host.
 */
export class AdminSessionsPanelCore {
  private selfPid: number | null = null;
  private errorMessage: string | null = null;
  private sessions: SessionRow[] = [];
  private locks: LockRow[] = [];

  constructor(private readonly deps: AdminSessionsPanelDeps) {}

  /** Load self-pid by querying `pg_backend_pid()`. */
  async loadSelfPid(): Promise<void> {
    try {
      const result = (await this.deps.runSql(
        "SELECT pg_backend_pid() AS pid",
      )) as { rows: Array<{ pid: number }> };
      this.selfPid = result.rows[0]?.pid ?? null;
    } catch {
      this.selfPid = null;
    }
  }

  /** Refresh from injected admin api (test seam passes fixture data). */
  setData(args: { sessions: SessionRow[]; locks: LockRow[] }): void {
    this.sessions = args.sessions;
    this.locks = args.locks;
    this.errorMessage = null;
  }

  /** Set error message (used when listSessions / listLockWaits fail). */
  setError(message: string): void {
    this.errorMessage = message;
  }

  /** Get the self-pid (for tests). */
  getSelfPid(): number | null {
    return this.selfPid;
  }

  /** Get current sessions (for tests). */
  getSessions(): ReadonlyArray<SessionRow> {
    return this.sessions;
  }

  /** Get current locks (for tests). */
  getLocks(): ReadonlyArray<LockRow> {
    return this.locks;
  }

  /** Get current error message (for tests). */
  getError(): string | null {
    return this.errorMessage;
  }

  /** Render current state as HTML for the webview. */
  render(): string {
    return buildPanelHtml({
      sessions: [...this.sessions],
      locks: [...this.locks],
      selfPid: this.selfPid,
      errorMessage: this.errorMessage,
    });
  }

  /**
   * Handle an incoming message from the webview. Returns the SQL the host
   * should run (kill / terminate) or null for refresh.
   */
  async handleMessage(msg: PanelMessage): Promise<string | null> {
    if (msg.kind === "refresh") {
      this.deps.postMessage({ kind: "refresh" });
      return null;
    }
    if (msg.pid === this.selfPid) {
      // Self-protection belt-and-braces: webview also disables the button.
      return null;
    }
    if (msg.kind === "kill") {
      const ok = await this.deps.confirm(
        `Cancel the running query on pid ${msg.pid}?`,
        { modal: true },
      );
      if (!ok) return null;
      return `SELECT pg_cancel_backend(${msg.pid})`;
    }
    if (msg.kind === "terminate") {
      const ok = await this.deps.confirm(
        `DROP the connection for pid ${msg.pid}? This will close the session.`,
        { modal: true },
      );
      if (!ok) return null;
      return `SELECT pg_terminate_backend(${msg.pid})`;
    }
    return null;
  }
}

/**
 * Thin vscode-side wrapper. Constructed by extension.ts; opens a webview
 * panel, loads the data from `adapter.admin`, and routes messages through
 * the core.
 */
export class AdminSessionsPanel {
  static current: AdminSessionsPanel | undefined;

  static async show(
    mgr: ConnectionManager,
    conn: ConnectionConfig,
  ): Promise<AdminSessionsPanel> {
    const existing = AdminSessionsPanel.current;
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      "vsdb.adminSessions",
      "Admin: Sessions & Locks",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    const instance = new AdminSessionsPanel(panel, mgr, conn);
    AdminSessionsPanel.current = instance;
    panel.onDidDispose(() => {
      AdminSessionsPanel.current = undefined;
    });
    return instance;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly core: AdminSessionsPanelCore;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly mgr: ConnectionManager,
    private readonly conn: ConnectionConfig,
  ) {
    this.panel = panel;
    this.core = new AdminSessionsPanelCore({
      runSql: (sql) => this.runSql(sql),
      confirm: (msg, opts) =>
        vscode.window
          .showWarningMessage(msg, { modal: opts.modal }, "Yes")
          .then((r) => r === "Yes"),
      postMessage: (m) => this.panel.webview.postMessage(m),
    });
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
        const sql = await this.core.handleMessage(msg);
        if (sql) {
          try {
            await this.runSql(sql);
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          await this.refresh();
        }
      }),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
      }),
    );
    void this.refresh();
  }

  /** Re-fetch sessions/locks and re-render. */
  async refresh(): Promise<void> {
    try {
      const adapter = await this.getAdapter();
      if (!adapter.admin) {
        this.core.setError("Adapter does not support admin operations");
        this.panel.webview.html = this.core.render();
        return;
      }
      await this.core.loadSelfPid();
      const [sessions, locks] = await Promise.all([
        adapter.admin.listSessions(),
        adapter.admin.listLockWaits(),
      ]);
      this.core.setData({
        sessions: sessions.map((s) => ({
          pid: s.pid,
          usename: s.usename,
          state: s.state,
          durationMs: s.durationMs,
          query: s.query,
        })),
        locks: locks.map((l) => ({
          blockedPid: l.blockedPid,
          blockingPid: l.blockingPid,
          lockType: l.lockType,
          mode: l.mode,
          relation: l.relation,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.core.setError(message);
    }
    this.panel.webview.html = this.core.render();
  }

  private async getAdapter(): Promise<DbAdapter> {
    const active = this.mgr.getActive();
    if (active && active.id === this.conn.id) {
      return await this.mgr.getAdapter();
    }
    return await this.mgr.getAdapterFor(this.conn);
  }

  private async runSql(sql: string): Promise<unknown> {
    const adapter = await this.getAdapter();
    // Adapter is required to expose a runQuery for admin SQL.
    const a = adapter as DbAdapter & {
      runQuery?: (sql: string) => Promise<{ rows: unknown[] }>;
    };
    if (typeof a.runQuery === "function") {
      return await a.runQuery(sql);
    }
    throw new Error("Adapter does not expose runQuery");
  }
}
