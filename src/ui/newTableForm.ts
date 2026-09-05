// src/ui/newTableForm.ts
// NewTableForm — DataGrip-style table designer webview (create + modify).
// Host wraps a webview panel: pure-fn preview (TASK-001/003) + runDdl callback
// để TASK-005 wire vào adapter.runQuery. Mirror ConnectionForm (CSP strict,
// typed messages, reveal-on-reshow, dispose pattern).
import * as vscode from "vscode";
import type { TableSpec } from "../core/ddl/createTable";
import {
  defaultColumnSpecs,
  generateCreateTable,
  specErrors,
} from "../core/ddl/createTable";
import { diffTable } from "../core/ddl/alterTable";
import type {
  NewTableFormHostMessage,
  NewTableFormWebviewMessage,
} from "./newTableFormMessages";

const PANEL_ID_CREATE = "UnicDB.newTableForm";
const DEFAULT_NAME = "table_name";

export interface NewTableFormOptions {
  extensionUri: vscode.Uri;
  mode: "create" | "modify";
  schema: string;
  /** Modify mode: name hiện tại (để hiển thị title + truyền loadSpec). */
  originalTableName?: string;
  /** Modify mode: introspect → TableSpec. Create mode: không cần. */
  loadSpec?: () => Promise<TableSpec>;
  /**
   * Execute SQL: TASK-005 wires vào adapter.runQuery.
   * Spec truyền kèm để caller có thể dùng spec.name thay vì regex SQL
   * cho reveal + notification (fix round 1).
   */
  runDdl: (sql: string, spec: TableSpec) => Promise<void>;
}

export class NewTableForm {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** Last preview SQL — submit chạy chính xác cái này. */
  private lastPreviewSql = "";
  /** Modify mode: loaded BEFORE spec (giữ để diffTable). */
  private loadedSpec: TableSpec | null = null;
  /** Modify mode: tên gốc để render title + init. */
  private readonly originalTableName: string | undefined;
  /** Create mode: tên bảng mặc định (giữ cố định cho spec ban đầu). */
  private readonly defaultTableName: string;

  constructor(private readonly options: NewTableFormOptions) {
    this.originalTableName = options.originalTableName;
    this.defaultTableName = options.originalTableName ?? DEFAULT_NAME;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const title =
      this.options.mode === "modify"
        ? `Modify — ${this.options.schema}.${this.options.originalTableName ?? ""}`
        : "New Table";
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID_CREATE,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: NewTableFormWebviewMessage) =>
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

  private async handleMessage(msg: NewTableFormWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.handleReady();
        return;
      case "specChanged":
        this.postPreview(msg.spec);
        return;
      case "submit":
        await this.handleSubmit(msg.spec);
        return;
      case "cancel":
        this.dispose();
        return;
    }
  }

  private async handleReady(): Promise<void> {
    if (this.options.mode === "create") {
      const spec: TableSpec = {
        name: this.defaultTableName,
        schema: this.options.schema,
        columns: defaultColumnSpecs(this.defaultTableName),
        keys: [],
      };
      this.loadedSpec = spec;
      this.post({ type: "init", mode: "create", schema: this.options.schema, spec });
      this.postPreview(spec);
      return;
    }
    // modify mode: loadSpec may throw → init with empty spec + loadError.
    let spec: TableSpec = {
      name: this.options.originalTableName ?? DEFAULT_NAME,
      schema: this.options.schema,
      columns: [],
      keys: [],
    };
    let loadError: string | undefined;
    if (this.options.loadSpec) {
      try {
        spec = await this.options.loadSpec();
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
      }
    }
    this.loadedSpec = spec;
    const init: NewTableFormHostMessage = loadError
      ? {
          type: "init",
          mode: "modify",
          schema: this.options.schema,
          originalTableName: this.options.originalTableName,
          spec,
          loadError,
        }
      : {
          type: "init",
          mode: "modify",
          schema: this.options.schema,
          originalTableName: this.options.originalTableName,
          spec,
        };
    this.post(init);
    this.postPreview(spec);
  }

  /** Compute preview SQL + errors and post to webview. */
  private postPreview(spec: TableSpec): void {
    const errors = specErrors(spec);
    if (errors.length > 0) {
      this.lastPreviewSql = "";
      this.post({ type: "preview", sql: "", errors });
      return;
    }
    if (this.options.mode === "modify" && this.loadedSpec) {
      const plan = diffTable(this.loadedSpec, spec);
      const allErrors = [...errors, ...plan.errors];
      if (allErrors.length > 0) {
        this.lastPreviewSql = "";
        this.post({ type: "preview", sql: "", errors: allErrors });
        return;
      }
      const sql =
        plan.statements.length > 0 ? plan.statements.join("\n") : "No changes detected.";
      this.lastPreviewSql = sql;
      this.post({ type: "preview", sql, errors: [] });
      return;
    }
    // create mode: errors already checked above; safe to generate.
    try {
      const sql = generateCreateTable(spec);
      this.lastPreviewSql = sql;
      this.post({ type: "preview", sql, errors: [] });
    } catch (err) {
      this.lastPreviewSql = "";
      this.post({
        type: "preview",
        sql: "",
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  private async handleSubmit(spec: TableSpec): Promise<void> {
    // Mirror preview gate: never run invalid SQL.
    const errors = specErrors(spec);
    if (errors.length > 0) return;
    if (this.lastPreviewSql === "") return;
    try {
      await this.options.runDdl(this.lastPreviewSql, spec);
      this.dispose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: "preview", sql: "", errors: [msg] });
      this.lastPreviewSql = "";
    }
  }

  private post(msg: NewTableFormHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "newTableForm.js"),
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
  <title>UnicDB New Table</title>
</head>
<body class="UnicDB-form-body">
  <div id="UnicDB-root" class="UnicDB-form"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
