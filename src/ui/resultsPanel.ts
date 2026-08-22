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
// IMPORTANT (fix round 1):
// - sanitizeRowsForPostMessage() converts BigInt → string với marker.
//   BigInt vượt Number.MAX_SAFE_INTEGER → string nguyên bản (an toàn).
//   BigInt nằm trong safe range → number (compact form). Date → ISO string.
//   Catches throws from structured clone (BigInt) silently.
// - postMessage failures (rejected Thenable) are logged via console + showErrorMessage
//   so caller can react (instead of being silently void-ed).
//
// Phụ thuộc: vscode (UI-only).
import * as vscode from "vscode";
import type { QueryRunner, StatementResult } from "../core/queryRunner";
import type { HostMessage, WebviewMessage, ExportFileMessage } from "./messages";

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
    // IMPORTANT #5 (fix round 1): sanitize rows trước khi postMessage.
    // webview.postMessage dùng structured clone — THROWs trên BigInt.
    let payload: HostMessage = msg;
    if (msg.type === "state") {
      payload = {
        ...msg,
        results: msg.results.map((r) => sanitizeStatementResult(r)),
      };
    }
    // Catch rejection (BigInt slip-through, internal errors) — surface to user.
    try {
      const p = this.panel.webview.postMessage(payload) as unknown;
      if (p && typeof (p as { then?: unknown }).then === "function") {
        (p as Thenable<unknown>).then(
          undefined,
          (err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.error("[vsdb] postMessage rejected:", m);
            void vscode.window.showErrorMessage(`Results panel postMessage failed: ${m}`);
          },
        );
      }
    } catch (err) {
      // synchronous throw (vd structured clone BigInt không bị Thenable catch).
      const m = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[vsdb] postMessage sync throw:", m);
      void vscode.window.showErrorMessage(`Results panel postMessage failed: ${m}`);
    }
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "loadMore":
        // Mark busy TRƯỚC await để webview enable Cancel button ngay khi batch
        // bắt đầu fetch qua mạng. finally đảm bảo busy:false kể cả khi reject,
        // tránh kẹt disable vĩnh viễn.
        this.setBusy(true);
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
          // Cancel-during-loadMore: runner đã hủy cursor (xem queryRunner.ts
          // loadMoreImpl — currentBatched set trước fetchBatch). Nuốt error
          // (không toast) và re-post state để webview clear in-flight flag.
          const cancelled = this.runner.isCancelled?.() === true ||
            /cancel/i.test(err instanceof Error ? err.message : String(err));
          if (!cancelled) {
            void vscode.window.showErrorMessage(
              `Load more failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          this.postMessage({
            type: "state",
            header: this.header,
            results: this.lastResults,
            busy: this.busy,
          });
        } finally {
          this.setBusy(false);
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
      case "exportFile":
        await this.handleExportFile(msg.format, msg.text);
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
   * TASK-502 — Export-to-file handler. Show a save dialog with a sensible
   * default file name based on the format, then UTF-8-encode the payload
   * and write via workspace.fs. Cancellation (user closed the dialog) is
   * a silent no-op — the webview does not expect any reply message.
   *
   * Format → default extension:
   *   tsv|csv|xml|json → results.<ext>
   *   sql-*            → results.sql
   */
  private async handleExportFile(
    format: ExportFileMessage["format"],
    text: string,
  ): Promise<void> {
    const ext = format.startsWith("sql-") ? "sql" : format;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`results.${ext}`),
      filters:
        ext === "sql"
          ? { SQL: ["sql"], "All Files": ["*"] }
          : { [format.toUpperCase()]: [ext], "All Files": ["*"] },
    });
    if (!uri) return; // user cancelled
    // Fix R1 minor: catch rejected workspace.fs.writeFile (permissions,
    // dropped network path, etc.) so the failure surfaces as a user
    // notification instead of an unhandled promise rejection.
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to write export: ${msg}`);
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

/**
 * Sanitize a single StatementResult for webview.postMessage structured-clone.
 *
 * BigInt vượt Number.MAX_SAFE_INTEGER → string (nguyên bản).
 * BigInt nằm trong safe range → number (compact).
 * Date → ISO string.
 * Circular objects → walk replaced with "[Circular]".
 *
 * IMPORTANT #5 (fix round 1): without this, webview.postMessage THROWS on
 * BigInt (DataCloneError) and the panel stops updating silently.
 */
export function sanitizeStatementResult(r: StatementResult): StatementResult {
  if (!r.result) return r;
  const result = r.result;
  return {
    ...r,
    result: {
      ...result,
      rows: result.rows.map((row) => sanitizeRow(row)),
    },
  };
}

function sanitizeRow(row: any[]): any[] {
  return row.map((v) => sanitizeCell(v, new WeakSet()));
}

function sanitizeCell(v: any, seen: WeakSet<object>): any {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "bigint") {
    // If within safe integer range → number; else string.
    if (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number(v);
    }
    return v.toString();
  }
  if (t !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) {
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    return v.map((x) => sanitizeCell(x, seen));
  }
  if (seen.has(v as object)) return "[Circular]";
  seen.add(v as object);
  const out: Record<string, any> = {};
  for (const k of Object.keys(v as object)) {
    try {
      out[k] = sanitizeCell((v as any)[k], seen);
    } catch {
      out[k] = "[Unserializable]";
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
