// src/ui/helpGridPanel.ts
//
// TASK-OC4O-002 — VSDB Help Grid panel. Singleton lifecycle mirroring
// `ConsolePanel`: create on first `show()`, reveal on subsequent calls,
// drop the singleton when the user closes it (AiChatPanel Finding 7
// precedent). The webview renders a responsive grid of help cards; each
// card has a "Try it" button that posts `{ type: "runCommand", commandId }`
// to the host, which then runs `vscode.commands.executeCommand(...)`.

import * as vscode from "vscode";
import { helpCardRegistry, type HelpCard } from "./helpGrid";

export type HelpGridPanelOptions = {
  extensionUri: vscode.Uri;
  /** Set of command ids the extension has registered; supply from the
   *  live `state.registeredCommands` so cards with missing registrations
   *  are dropped before the panel ever sees them. */
  registeredCommandIds: ReadonlySet<string>;
};

export class HelpGridPanel {
  private readonly extensionUri: vscode.Uri;
  private readonly registeredCommandIds: ReadonlySet<string>;
  private readonly cards: readonly HelpCard[];
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(options: HelpGridPanelOptions) {
    this.extensionUri = options.extensionUri;
    this.registeredCommandIds = options.registeredCommandIds;
    this.cards = helpCardRegistry(this.registeredCommandIds);
  }

  /** Idempotent open/reveal — one live webview per HelpGridPanel. */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "vsdb.helpGrid",
      "VSDB: Help",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
        ],
      },
    );
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg: unknown) =>
      this.handleMessage(msg),
    );
    panel.onDidDispose(() => {
      this.panel = null;
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
    });
    this.panel = panel;
  }

  private buildHtml(webview: vscode.Webview): string {
    const csp = webview.cspSource;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "helpGrid.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"),
    );
    // Strip closing `</script>` from card blurb for defence-in-depth — the
    // blurb is rendered into a JSON payload that the webview inserts via
    // textContent (no innerHTML), but a stray terminator could only
    // confuse the parser if the JSON were ever inlined into a script tag.
    const safeCards = JSON.stringify(this.cards).replace(/<\/script>/g, "<\\/script>");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp};" />
<link rel="stylesheet" href="${styleUri}" />
<title>VSDB Help</title>
</head>
<body>
<div id="vsdb-help-root" data-cards="${safeCards}"></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: unknown; commandId?: unknown };
    if (m.type !== "runCommand") return;
    if (typeof m.commandId !== "string" || m.commandId.length === 0) return;
    if (
      !m.commandId.startsWith("vsdb.") &&
      !m.commandId.startsWith("workbench.")
    ) {
      return;
    }
    try {
      await vscode.commands.executeCommand(m.commandId);
    } catch {
      // Swallow — the host command is best-effort; user will see whatever
      // feedback the command itself surfaces.
    }
  }

  /** Dispose the panel and drop the underlying webview so the singleton
   *  can be re-created on the next `show()`. */
  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}