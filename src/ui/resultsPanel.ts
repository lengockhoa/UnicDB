// src/ui/resultsPanel.ts
// ResultsPanel — webview panel bên dưới editor, TÁI SỬ DỤNG panel cũ nếu còn mở.
//
// Trách nhiệm:
// - Tạo / hiện webview panel.
// - Nhận `render(results, header)` từ extension host → postMessage sang webview.
// - Nhận message từ webview: `loadMore`, `cancel`, `copy` → gọi callbacks.
// - `setBusy(true/false)` để disable/enable buttons trên webview.
//
// Bảo mật:
// - HTML được build từ template (không inline script từ remote).
// - CSP meta tag chỉ cho phép script-src 'self' và vscode-webview.
// - Sử dụng asWebviewUri() cho JS/CSS.
//
// Phụ thuộc: vscode (UI-only).
import * as vscode from "vscode";
import type { QueryRunner, StatementResult } from "../core/queryRunner";
import type { HostMessage, WebviewMessage } from "./messages";

export interface ResultsPanelOptions {
  /** QueryRunner instance (để loadMore / cancel). */
  runner: QueryRunner;
  /** View column mặc định (mặc định Beside). */
  viewColumn?: vscode.ViewColumn;
  /** Title cho panel. */
  title?: string;
}

export class ResultsPanel {
  private readonly runner: QueryRunner;
  private readonly viewColumn: vscode.ViewColumn;
  private readonly title: string;
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private header: string = "";
  private lastResults: StatementResult[] = [];
  private busy: boolean = false;

  constructor(options: ResultsPanelOptions) {
    this.runner = options.runner;
    this.viewColumn = options.viewColumn ?? vscode.ViewColumn.Beside;
    this.title = options.title ?? "VSDB Results";
  }

  /**
   * Hiện (hoặc tạo) panel. TÁI SỬ DỤNG panel cũ nếu còn mở.
   */
  show(): void {
    if (this.panel) {
      this.panel.reveal(this.viewColumn);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "vsdb.results",
      this.title,
      this.viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri(), "dist")],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    // Listen messages từ webview.
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg)),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.panel = null;
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
      }),
    );
  }

  /**
   * Render results mới vào panel. Nếu panel chưa mở → show().
   */
  render(results: StatementResult[], header: string): void {
    this.header = header;
    this.lastResults = results;
    this.show();
    if (this.panel) {
      this.postMessage({
        type: "state",
        header,
        results,
        busy: this.busy,
      });
    }
  }

  /**
   * Set busy flag (disable buttons trên webview).
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.panel) {
      this.postMessage({ type: "busy", busy });
    }
  }

  /**
   * Dispose panel + resources.
   */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /**
   * Visible? (cho testing).
   */
  isVisible(): boolean {
    return this.panel !== null && this.panel.visible;
  }

  // ---- Private -------------------------------------------------------------

  private postMessage(msg: HostMessage): void {
    if (!this.panel) return;
    // Safe JSON — Date/BigInt được stringified cẩn thận.
    void this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "loadMore":
        try {
          const updated = await this.runner.loadMore(msg.index);
          this.lastResults = updated;
          this.postMessage({
            type: "state",
            header: this.header,
            results: updated,
            busy: this.busy,
          });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Load more failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      case "cancel":
        await this.runner.cancel();
        this.setBusy(false);
        break;
      case "copy":
        // Copy text do webview build sẵn (tab-separated). Ghi vào clipboard.
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case "ready":
        // Send initial state khi webview ready.
        this.postMessage({
          type: "state",
          header: this.header,
          results: this.lastResults,
          busy: this.busy,
        });
        break;
    }
  }

  /**
   * Lấy extension URI (dùng cho asWebviewUri). Trả về static placeholder
   * vì extension host sẽ inject URI thực qua `withExtensionUri()` ở TASK-007.
   *
   * For testing, an injected URI is used via `setExtensionUri()`.
   */
  private extensionUri(): vscode.Uri {
    return this._injectedExtensionUri ?? vscode.Uri.file(process.cwd());
  }
  private _injectedExtensionUri: vscode.Uri | null = null;
  setExtensionUri(uri: vscode.Uri): void {
    this._injectedExtensionUri = uri;
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri(), "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri(), "dist", "webview.css"),
    );
    const cspSource = webview.cspSource;
    // CSP: chỉ cho phép script/style từ webview csp source.
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src ${cspSource}`,
      `font-src ${cspSource} data:`,
      `img-src ${cspSource} data:`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${escapeHtml(this.title)}</title>
</head>
<body>
  <div id="vsdb-root" class="vsdb-webview">
    <div class="vsdb-loading">Loading results…</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
