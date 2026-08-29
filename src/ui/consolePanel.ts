// src/ui/consolePanel.ts
// TASK-003 (cycle Z) — DataGrip-style SQL Console host panel: owns the
//   `vsdb.console` webview, validates every inbound message against the
//   consolePanelMessages guard, routes valid runs to an injected callback
//   (extension.ts delegates to the shared runStatements flow), and saves the
//   buffer through the OS save dialog.
// TASK-AF-004 (cycle AF) — Console v2: multi-tab registry (host-side state),
//   per-statement and selection-only run, Memento-persisted query history
//   (cap 200), EXPLAIN / EXPLAIN ANALYZE routed through the destructive-
//   confirm gate, and a Format button round-trip via formatSql.
//
// Pattern mirror: src/ui/schemaForm.ts (idempotent show, strict CSP, dispose
// clears everything) + src/ui/aiChatPanel.ts's onDispose hook so a caller
// holding a singleton learns the instance died with its webview tab.
// Save flow mirrors src/ui/resultsPanel.ts:handleExportFile.
import * as vscode from "vscode";
import type { ConsoleToHostMessage } from "./consolePanelMessages";
import {
  CONSOLE_HISTORY_CAP,
  CONSOLE_HISTORY_KEY,
  isConsoleToHostMessage,
  newTabId,
  suggestSaveFileName,
  type ConsoleHostToWebviewMessage,
  type ConsoleTabState,
} from "./consolePanelMessages";
import { splitStatements } from "../core/statementParser";
import { formatSql } from "../core/sqlFormat";
import {
  analyzeStatement,
  guardTier,
} from "../core/dangerousStatement";

const PANEL_ID = "vsdb.console";

export interface ConsoleTabSpec {
  id: string;
  name: string;
  buffer: string;
}

export interface ConsolePanelOptions {
  extensionUri: vscode.Uri;
  /**
   * Injected run callback — extension.ts wires this to the shared
   * runStatements flow. Receives one or more SQL statements.
   */
  onRun: (sql: string) => void | Promise<void>;
  /**
   * Fired when THIS panel tears down its webview — both explicit dispose()
   * and the user closing the tab. Extension.ts uses it to drop its
   * singleton reference so a later reopen rebuilds cleanly.
   */
  onDispose?: () => void;
  /**
   * Optional Memento for history persistence. extension.ts wires the global
   * Memento; tests pass a FakeMemento. When omitted, history is kept in
   * memory only.
   */
  memento?: vscode.Memento;
  /**
   * Cycle AIC TASK-AIC-004 — Console ghost-text autocomplete callback.
   * extension.ts wires this to the AIC-002 SqlAutocompleteService through
   * AIC-005. The host owns per-tab cancellation, sequence, and stale
   * guarding; the callback receives the request and a tab-scoped
   * AbortSignal and resolves with the suffix or null.
   */
  onAutocomplete?: (req: {
    tabId: string;
    requestId: string;
    cursorOffset: number;
    documentText: string;
    schemaFingerprint: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
}

/** Detect `EXPLAIN ANALYZE` (or ANALYSE) at depth 0 — the only EXPLAIN form
 *  that requires the destructive-statement confirm gate. Returns true when
 *  the first non-comment keyword is EXPLAIN and a depth-0 ANALYZE/ANALYSE
 *  modifier follows. Mirrors analyzeStatement's modifier handling. */
export function isExplainAnalyze(sql: string): boolean {
  // Strip line + block comments to avoid false positives inside them.
  const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "");
  const wordRe = /[A-Za-z_]+|\(|\)/g;
  let m: RegExpExecArray | null;
  let depth = 0;
  let sawExplain = false;
  let sawAnalyze = false;
  while ((m = wordRe.exec(stripped)) !== null) {
    const tok = m[0];
    if (tok === "(") {
      depth += 1;
      continue;
    }
    if (tok === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    const lower = tok.toLowerCase();
    if (!sawExplain) {
      if (lower === "explain") {
        sawExplain = true;
        continue;
      }
      // First depth-0 keyword isn't EXPLAIN → not EXPLAIN ANALYZE.
      return false;
    }
    // EXPLAIN at depth 0; modifiers next.
    if (lower === "analyze" || lower === "analyse") {
      sawAnalyze = true;
      continue;
    }
    if (lower === "verbose") continue;
    // Modifier slot exhausted without ANALYZE → not destructive.
    return sawAnalyze;
  }
  return sawAnalyze;
}

export class ConsolePanel {
  private readonly extensionUri: vscode.Uri;
  private readonly onRun: (sql: string) => void | Promise<void>;
  private readonly options: ConsolePanelOptions;
  private readonly memento: vscode.Memento | undefined;
  private readonly onAutocomplete: ConsolePanelOptions["onAutocomplete"];
  /** Per-tab AbortController for the in-flight autocomplete request. */
  private readonly acControllers = new Map<string, AbortController>();
  /** Per-tab last requestId — late results are dropped if it changed. */
  private readonly acRequestId = new Map<string, string>();
  private readonly tabs: ConsoleTabSpec[] = [];
  private activeTabId = "";
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(options: ConsolePanelOptions) {
    this.extensionUri = options.extensionUri;
    this.onRun = options.onRun;
    this.memento = options.memento;
    this.onAutocomplete = options.onAutocomplete;
    this.options = options;
    this.tabs.push({ id: newTabId(), name: "Query 1", buffer: "" });
    this.activeTabId = this.tabs[0].id;
    this.hydrateHistory();
  }

  /** Idempotent open/reveal — one live webview per ConsolePanel. */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      "VSDB Console",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Every existing VSDB form/results panel retains context when hidden;
        // Console keeps typing/scroll state across tab switches the same way.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    // Send the initial state once the bundle is ready.
    this.postState();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: unknown) => {
        // SECURITY: webview postMessage data is untrusted runtime input —
        // nothing is routed before the guard accepts it.
        if (!isConsoleToHostMessage(msg)) return;
        void this.handleMessage(msg);
      }),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        for (const ctrl of this.acControllers.values()) ctrl.abort();
        this.acControllers.clear();
        this.acRequestId.clear();
        this.panel = null;
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.options.onDispose?.();
      }),
    );
  }

  dispose(): void {
    // AIC-004: cancel every in-flight autocomplete before tearing down so
    // the underlying service / abort signal path settles cleanly.
    for (const ctrl of this.acControllers.values()) ctrl.abort();
    this.acControllers.clear();
    this.acRequestId.clear();
    const panel = this.panel;
    this.panel = null;
    panel?.dispose();
    if (!panel) {
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
      this.options.onDispose?.();
    }
  }

  // ---- Tab registry accessors (test seam + extension.ts consumers) ---------

  /** Snapshot of the tab list. Order = creation order; the first entry is
   *  the default tab. Mutating the returned array does NOT mutate state. */
  listTabs(): ReadonlyArray<ConsoleTabSpec> {
    return this.tabs.map((t) => ({ ...t }));
  }

  /** Active tab id — empty string if the registry is empty (should never be;
   *  the constructor always seeds one tab). */
  getActiveTabId(): string {
    return this.activeTabId;
  }

  /** Buffer of the active tab. */
  getActiveBuffer(): string {
    return this.tabById(this.activeTabId)?.buffer ?? "";
  }

  /** Buffer of a specific tab by id; empty when missing. */
  getBuffer(tabId: string): string {
    return this.tabById(tabId)?.buffer ?? "";
  }

  /** Replace a tab's buffer. Silently no-op on unknown id. */
  setBuffer(tabId: string, buffer: string): void {
    const tab = this.tabById(tabId);
    if (tab) tab.buffer = buffer;
  }

  /** Make `tabId` active. Silently no-op on unknown id. */
  switchTab(tabId: string): void {
    if (this.tabById(tabId)) this.activeTabId = tabId;
  }

  /** Create a new tab with an optional display name. Returns the new spec.
   *  The new tab becomes active immediately. */
  createTab(name?: string): ConsoleTabSpec {
    const n = this.tabs.length + 1;
    const spec: ConsoleTabSpec = {
      id: newTabId(),
      name: name ?? `Query ${n}`,
      buffer: "",
    };
    this.tabs.push(spec);
    this.activeTabId = spec.id;
    return { ...spec };
  }

  /** Close a tab by id. Closing the last remaining tab creates a fresh
   *  empty tab (registry stays >=1). Closing the active tab activates the
   *  previous neighbor (left), matching editor-tab conventions; the first
   *  tab falls forward to the new first. */
  closeTab(tabId: string): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    // AIC-004: cancel any in-flight autocomplete for the tab being closed.
    this.acControllers.get(tabId)?.abort();
    this.acControllers.delete(tabId);
    this.acRequestId.delete(tabId);
    this.tabs.splice(idx, 1);
    if (this.tabs.length === 0) {
      const fresh = { id: newTabId(), name: "Query 1", buffer: "" };
      this.tabs.push(fresh);
      this.activeTabId = fresh.id;
      return;
    }
    if (this.activeTabId === tabId) {
      const nextIdx = Math.max(0, idx - 1);
      this.activeTabId = this.tabs[nextIdx].id;
    }
  }

  /** Rename a tab. Silently no-op on unknown id / empty name. */
  renameTab(tabId: string, name: string): void {
    if (!name) return;
    const tab = this.tabById(tabId);
    if (tab) tab.name = name;
  }

  // ---- History accessors ----------------------------------------------------

  /** Most-recent-first history list. Capped at CONSOLE_HISTORY_CAP entries. */
  getHistory(): string[] {
    return [...this.history];
  }

  /** History recall: returns the entry at `offset` from newest.
   *  offset >= 0 walks older (0=newest, 1=next older, …); negative walks
   *  from the oldest end. Out-of-range wraps to the opposite end. */
  recallHistory(offset: number): string {
    if (this.history.length === 0) return "";
    const n = this.history.length;
    let idx = offset;
    if (idx >= n) idx = idx % n;
    while (idx < 0) idx += n;
    if (idx >= n) idx = idx % n;
    return this.history[idx] ?? "";
  }

  // ---- Private state --------------------------------------------------------

  private history: string[] = [];

  private hydrateHistory(): void {
    if (!this.memento) return;
    const raw = this.memento.get<unknown>(CONSOLE_HISTORY_KEY);
    if (Array.isArray(raw)) {
      this.history = raw.filter(
        (e): e is string => typeof e === "string",
      ).slice(0, CONSOLE_HISTORY_CAP);
    }
  }

  private tabById(tabId: string): ConsoleTabSpec | undefined {
    return this.tabs.find((t) => t.id === tabId);
  }

  private postState(): void {
    if (!this.panel) return;
    const msg: ConsoleHostToWebviewMessage = {
      type: "state",
      tabs: this.tabs.map<ConsoleTabState>((t) => ({
        id: t.id,
        name: t.name,
        buffer: t.buffer,
        active: t.id === this.activeTabId,
      })),
      activeTabId: this.activeTabId,
      history: this.history,
    };
    void this.panel.webview.postMessage(msg);
  }

  private postExplainResult(plan: string, error?: string): void {
    if (!this.panel) return;
    const msg: ConsoleHostToWebviewMessage = {
      type: "explainResult",
      plan,
      error,
    };
    void this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: ConsoleToHostMessage): Promise<void> {
    switch (msg.type) {
      case "runConsole":
        await this.handleRunSelection(this.activeTabId, msg.sql);
        return;
      case "saveConsoleAsSql":
        await this.handleSave(msg.sql);
        return;
      case "runStatement": {
        const tabId = msg.tabId ?? this.activeTabId;
        await this.handleRunStatement(tabId, msg.index);
        return;
      }
      case "runSelection": {
        const tabId = msg.tabId ?? this.activeTabId;
        await this.handleRunSelection(tabId, msg.text);
        return;
      }
      case "explain": {
        const tabId = msg.tabId ?? this.activeTabId;
        await this.handleExplain(tabId, msg.sql, msg.analyze);
        return;
      }
      case "format": {
        const tabId = msg.tabId ?? this.activeTabId;
        const raw = msg.sql ?? this.getBuffer(tabId);
        this.handleFormat(tabId, raw);
        return;
      }
      case "historyPush":
        this.pushHistory(msg.sql);
        return;
      case "historyList":
        await this.postHistoryList();
        return;
      case "createTab":
        this.createTab(msg.name);
        this.postState();
        return;
      case "closeTab":
        this.closeTab(msg.tabId);
        this.postState();
        return;
      case "switchTab":
        this.switchTab(msg.tabId);
        this.postState();
        return;
      case "renameTab":
        this.renameTab(msg.tabId, msg.name);
        this.postState();
        return;
      case "updateBuffer":
        this.setBuffer(msg.tabId, msg.buffer);
        return;
      case "requestAutocomplete":
        void this.handleAutocompleteRequest(
          msg.tabId,
          msg.requestId,
          msg.cursorOffset,
          msg.documentText,
        );
        return;
      case "acceptAutocomplete":
        this.handleAcceptAutocomplete(
          msg.tabId,
          msg.requestId,
          msg.suffix,
        );
        return;
      case "clearAutocomplete":
        this.handleClearAutocomplete(msg.tabId);
        return;
    }
  }

  // ---- Run paths ------------------------------------------------------------

  private async handleRunStatement(
    tabId: string,
    index: number,
  ): Promise<void> {
    const buf = this.getBuffer(tabId);
    const stmts = splitStatements(buf);
    const stmt = stmts[index];
    if (!stmt) return;
    await this.runOne(stmt.text);
  }

  private async handleRunSelection(
    tabId: string,
    text: string,
  ): Promise<void> {
    if (!text || text.trim().length === 0) return;
    await this.runOne(text);
    void tabId;
  }

  private async runOne(sql: string): Promise<void> {
    await this.onRun(sql);
    // Successful run appends to history (last-first). We don't gate on
    // "did onRun throw" — the runner's own error surfacing is the host's
    // responsibility; the history is the user's recall surface, not a
    // success log.
    this.pushHistory(sql);
  }

  private async handleExplain(
    _tabId: string,
    sql: string,
    analyze: boolean,
  ): Promise<void> {
    if (analyze || isExplainAnalyze(sql)) {
      const ok = await this.confirmExplainAnalyze(sql);
      if (!ok) return;
    }
    // Re-route the EXPLAIN through the same onRun — extension.ts's runner
    // path handles the EXPLAIN verbatim (the driver adapter executes it).
    await this.onRun(sql);
    this.pushHistory(sql);
    // The plan pane message is best-effort: the real plan text comes back
    // via the results flow, but we emit a stub marker so the webview can
    // flip into the plan view. Actual rendering is delegated to the
    // results/plan pane host — out of scope for this task's wire surface.
    this.postExplainResult(`(plan executed) ${sql.split("\n", 1)[0] ?? ""}`);
  }

  /** Route EXPLAIN ANALYZE through the destructive-statement confirm gate:
   *  analyzeStatement + guardTier on the underlying SELECT detects the
   *  data-touching tier (red for missing WHERE, amber for conditional
   *  DELETE, none for SELECT). For SELECT the gate is none — but we still
   *  show the explicit EXPLAIN ANALYZE warning so the user is never
   *  surprised by ANALYZE executing. */
  private async confirmExplainAnalyze(sql: string): Promise<boolean> {
    const a = analyzeStatement(sql);
    const tier = guardTier(a);
    if (tier === "none") {
      // Pure SELECT under EXPLAIN ANALYZE → still prompt because ANALYZE
      // executes the query.
      const picked = await vscode.window.showWarningMessage(
        "VSDB: EXPLAIN ANALYZE sẽ THỰC SỰ CHẠY câu lệnh (đo timing thật). Tiếp tục?",
        { modal: true },
        "Run",
      );
      return picked === "Run";
    }
    // Destructive — reuse the existing red/amber confirm shape from
    // extension.ts. We replicate the modal here because the host does not
    // own the console panel; extension.ts's confirmDangerousStatements is
    // private. The contract: modal + a single "Run" button.
    const isRed = tier === "red";
    const picked = await vscode.window.showWarningMessage(
      isRed
        ? "VSDB: EXPLAIN ANALYZE trên câu lệnh PHÁ HOẠI — sẽ XÓA DỮ LIỆU. Kiểm tra lại query!"
        : "VSDB: EXPLAIN ANALYZE trên câu lệnh nguy hiểm có điều kiện — chạy câu lệnh này?",
      { modal: true },
      isRed ? "Vẫn chạy (nguy hiểm)" : "Run",
    );
    return picked === (isRed ? "Vẫn chạy (nguy hiểm)" : "Run");
  }

  private handleFormat(tabId: string, raw: string): void {
    if (!raw || raw.trim().length === 0) return;
    const formatted = formatSql(raw);
    if (!formatted) return;
    this.setBuffer(tabId, formatted);
    this.postState();
  }

  // ---- AIC-004 ghost-text seam ---------------------------------------------

  private async handleAutocompleteRequest(
    tabId: string,
    requestId: string,
    cursorOffset: number,
    documentText: string,
  ): Promise<void> {
    // Cancel any previous in-flight request for this tab.
    this.acControllers.get(tabId)?.abort();
    const controller = new AbortController();
    this.acControllers.set(tabId, controller);
    this.acRequestId.set(tabId, requestId);
    if (!this.onAutocomplete) {
      await this.postAutocompleteResult(tabId, requestId, null);
      return;
    }
    let suffix: string | null;
    try {
      suffix = await this.onAutocomplete({
        tabId,
        requestId,
        cursorOffset,
        documentText,
        schemaFingerprint: "v1",
        signal: controller.signal,
      });
    } catch {
      // Silent failure per spec — never notify on autocomplete errors.
      suffix = null;
    }
    // Late guard: if a newer request superseded us, or the tab switched,
    // or the user cleared, do not post. Also drop if the tab disappeared.
    if (this.acRequestId.get(tabId) !== requestId) return;
    if (!this.tabById(tabId)) return;
    if (controller.signal.aborted) return;
    this.acControllers.delete(tabId);
    this.acRequestId.delete(tabId);
    await this.postAutocompleteResult(tabId, requestId, suffix);
  }

  private handleAcceptAutocomplete(
    tabId: string,
    _requestId: string,
    suffix: string,
  ): void {
    const tab = this.tabById(tabId);
    if (!tab) return;
    // Atomic: just append the suffix to the buffer (webview chooses the
    // insertion offset at accept time; the host is the single source of
    // truth for buffer state). No textarea mutation in the webview path.
    tab.buffer = tab.buffer + suffix;
    this.postState();
  }

  private handleClearAutocomplete(tabId: string): void {
    this.acControllers.get(tabId)?.abort();
    this.acControllers.delete(tabId);
    this.acRequestId.delete(tabId);
  }

  private async postAutocompleteResult(
    tabId: string,
    requestId: string,
    suffix: string | null,
  ): Promise<void> {
    if (!this.panel) return;
    const msg: ConsoleHostToWebviewMessage = {
      type: "autocompleteResult",
      tabId,
      requestId,
      suffix,
    };
    await this.panel.webview.postMessage(msg);
  }

  private pushHistory(sql: string): void {
    const trimmed = sql.trim();
    if (!trimmed) return;
    // Dedupe consecutive identical entries.
    if (this.history[0] === trimmed) return;
    this.history.unshift(trimmed);
    if (this.history.length > CONSOLE_HISTORY_CAP) {
      this.history.length = CONSOLE_HISTORY_CAP;
    }
    void this.memento?.update(CONSOLE_HISTORY_KEY, [...this.history]);
  }

  private async postHistoryList(): Promise<void> {
    if (!this.panel) return;
    const msg: ConsoleHostToWebviewMessage = {
      type: "historyList",
      items: [...this.history],
    };
    await this.panel.webview.postMessage(msg);
  }

  // ---- Save-as-SQL ----------------------------------------------------------

  private async handleSave(sql: string): Promise<void> {
    const defaultUri = vscode.Uri.file(suggestSaveFileName(new Date()));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { SQL: ["sql"], "All Files": ["*"] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(sql),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to save console SQL: ${message}`);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "consolePanel.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"),
    );
    const cspSource = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src ${cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>VSDB Console</title>
</head>
<body class="vsdb-form-body">
  <div id="vsdb-root" class="vsdb-console"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
