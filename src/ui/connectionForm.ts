// src/ui/connectionForm.ts
// ConnectionForm — webview panel điền connection info MỘT CHỖ (thay 7 input box
// tuần tự cũ). Hỗ trợ add + edit, SSL mode + cert paths, test connection.
//
// Reuse pattern của ResultsPanel: CSP strict, message protocol typed
// (connectionFormMessages.ts), password KHÔNG log/echo.
import * as vscode from "vscode";
import type { ConnectionConfig, DriverType, SslMode } from "../config/types";
import type { AdapterFactory } from "../core/connectionManager";
import type {
  ConnectionFormSubmit,
  ConnectionFormTest,
  FormHostMessage,
  FormWebviewMessage,
} from "./connectionFormMessages";

/** Extract submit payload chung cho test + submit. */
type SubmitPayload = Omit<ConnectionFormSubmit, "type">;

export interface ConnectionFormOptions {
  extensionUri: vscode.Uri;
  /** null → add mode; ConnectionConfig → edit mode (prefill, không có password). */
  existing: ConnectionConfig | null;
  factory: AdapterFactory;
  /** Đã có password stored (edit mode) — test dùng password stored khi form bỏ trống. */
  getStoredPassword: (id: string) => Promise<string | undefined>;
  onSave: (payload: SubmitPayload, existingId: string | null) => Promise<void>;
}

export class ConnectionForm {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private testing = false;

  constructor(private readonly options: ConnectionFormOptions) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "UnicDB.connectionForm",
      this.options.existing
        ? `Edit Connection — ${this.options.existing.name}`
        : "New Connection",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: FormWebviewMessage) =>
        this.handleMessage(msg),
      ),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.panel = null;
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
      }),
    );
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ---- Private -------------------------------------------------------------

  private async handleMessage(msg: FormWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({ type: "init", existing: this.options.existing });
        break;
      case "pickFile":
        await this.handlePickFile(msg.field);
        break;
      case "test":
        await this.handleTest(msg);
        break;
      case "submit":
        try {
          await this.options.onSave(this.stripType(msg), this.options.existing?.id ?? null);
          this.dispose();
        } catch (err) {
          this.post({
            type: "testResult",
            ok: false,
            message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      case "cancel":
        this.dispose();
        break;
    }
  }

  private stripType(msg: ConnectionFormSubmit): SubmitPayload {
    const { type: _type, ...payload } = msg;
    return payload;
  }

  private async handlePickFile(
    field: "sslCaPath" | "sslCertPath" | "sslKeyPath",
  ): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title:
        field === "sslCaPath"
          ? "Chọn CA certificate (.pem)"
          : field === "sslCertPath"
            ? "Chọn client certificate (.pem)"
            : "Chọn client private key",
      filters: { Certificates: ["pem", "crt", "key", "cer"], "All files": ["*"] },
    });
    if (!picks || picks.length === 0) return;
    this.panel?.webview.postMessage({ type: "pickFileResult", field, path: picks[0].fsPath });
  }

  private async handleTest(msg: ConnectionFormTest): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    const existingId = this.options.existing?.id ?? null;
    let password = msg.password;
    if (password === "" && existingId) {
      password = (await this.options.getStoredPassword(existingId)) ?? "";
    }
    const cfg: ConnectionConfig = {
      id: existingId ?? `test-${Date.now()}`,
      name: msg.name,
      driver: msg.driver,
      host: msg.host,
      port: msg.port,
      user: msg.user,
      database: msg.database,
      sslMode: msg.sslMode,
      sslCaPath: msg.sslCaPath || undefined,
      sslCertPath: msg.sslCertPath || undefined,
      sslKeyPath: msg.sslKeyPath || undefined,
    };
    const probe = this.options.factory(cfg, password);
    let ok = false;
    let message = "";
    try {
      await probe.testConnection();
      ok = true;
      message = "Kết nối thành công.";
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      try {
        await probe.close();
      } catch {
        // ignore
      }
    }
    this.testing = false;
    this.post({ type: "testResult", ok, message });
  }

  private post(msg: FormHostMessage | { type: "pickFileResult"; field: string; path: string }): void {
    void this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "connectionForm.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview.css"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>UnicDB Connection</title>
</head>
<body class="UnicDB-form-body">
  <div id="UnicDB-root" class="UnicDB-form">
    <div class="UnicDB-form-loading">Loading…</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
