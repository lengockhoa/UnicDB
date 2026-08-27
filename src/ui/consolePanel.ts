// src/ui/consolePanel.ts — TASK-003 (cycle Z).
// DataGrip-style SQL Console host panel: owns the `vsdb.console` webview,
// validates every inbound message against the TASK-001 guard, routes valid
// runs to an injected callback (extension.ts delegates to the shared
// runStatements flow), and saves the buffer through the OS save dialog.
//
// Pattern mirror: src/ui/schemaForm.ts (idempotent show, strict CSP, dispose
// clears everything) + src/ui/aiChatPanel.ts's onDispose hook so a caller
// holding a singleton learns the instance died with its webview tab.
// Save flow mirrors src/ui/resultsPanel.ts:handleExportFile.
import * as vscode from "vscode";
import {
  isConsoleToHostMessage,
  suggestSaveFileName,
} from "./consolePanelMessages";

const PANEL_ID = "vsdb.console";

export interface ConsolePanelOptions {
  extensionUri: vscode.Uri;
  /**
   * Injected run callback — extension.ts wires this to
   * sqlToRun(sql, {start:0,end:sql.length}, 0, mgr.getActive()?.driver) +
   * runStatements(mgr, runner, resultsPanel, statements) so Console shares the
   * established confirm/qualify/runner/render pipeline. Only values passing
   * isConsoleToHostMessage ever reach it; the raw buffer travels verbatim.
   */
  onRun: (sql: string) => void | Promise<void>;
  /**
   * Fired when THIS panel tears down its webview — both explicit dispose()
   * and the user closing the tab (onDidDispose). A singleton-holding caller
   * uses it to drop its reference so the next open constructs fresh state
   * instead of reusing a dead panel (Finding 7 precedent from AiChatPanel).
   */
  onDispose?: () => void;
}

export class ConsolePanel {
  private readonly extensionUri: vscode.Uri;
  private readonly onRun: (sql: string) => void | Promise<void>;
  private readonly options: ConsolePanelOptions;
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(options: ConsolePanelOptions) {
    this.options = options;
    this.extensionUri = options.extensionUri;
    this.onRun = options.onRun;
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
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: unknown) => {
        // SECURITY: webview postMessage data is untrusted runtime input —
        // nothing is routed before the TASK-001 guard accepts it.
        if (!isConsoleToHostMessage(msg)) return;
        if (msg.type === "runConsole") {
          void this.onRun(msg.sql);
          return;
        }
        if (msg.type === "saveConsoleAsSql") {
          void this.handleSave(msg.sql);
        }
      }),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        // Drop every host field first so reopening starts empty regardless of
        // which teardown path fired (tab close vs explicit dispose()).
        this.panel = null;
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.options.onDispose?.();
      }),
    );
  }

  dispose(): void {
    const panel = this.panel;
    this.panel = null;
    panel?.dispose(); // fires onDidDispose → the shared cleanup above
    if (!panel) {
      // Already dead (or never shown): still honor direct-dispose cleanup.
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
      this.options.onDispose?.();
    }
  }

  /**
   * Save-as-SQL host half (plan §3.3): deterministic suggested filename via
   * the TASK-001 helper, SQL-filtered dialog, cancelled → silent no-op,
   * accepted → exact UTF-8 bytes via workspace.fs.writeFile. Mirrors the
   * verified ResultsPanel.handleExportFile error handling.
   */
  private async handleSave(sql: string): Promise<void> {
    const defaultUri = vscode.Uri.file(suggestSaveFileName(new Date()));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { SQL: ["sql"], "All Files": ["*"] },
    });
    if (!uri) return; // user cancelled — silent no-op, no notification
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
    // Shared emitted stylesheet — webview/main.ts imports styles.css, so
    // dist/webview.css exists independently of this entry (planner §Discussion:
    // "Console must independently link that same emitted asset").
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
