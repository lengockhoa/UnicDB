// src/ui/schemaForm.ts
// TASK-003 — Host wrapper cho "Create New Schema" webview dialog (DataGrip-style).
// Mirror src/ui/newTableForm.ts: CSP strict, typed messages, reveal-on-reshow,
// dispose pattern. Validation lives HOST-side trong `validate` (pure):
//   - empty name → "Name is required"
//   - regex /^[A-Za-z_][A-Za-z0-9_$]*$/ (PG bare identifier)
//   - length ≤ 63 (PG NAMEDATALEN-1)
//   - duplicate check case-insensitive via listSchemaNames() snapshot
// OK-gating mirrors preview: errors>0 ⇒ OK disabled (webview renders button state).
// submit → runDdl(CREATE SCHEMA "<name>";, name); success → onOk callback.
import * as vscode from "vscode";
import { alwaysQuote } from "../core/ddl/alterTable";

const PANEL_ID = "UnicDB.schemaForm";

/** Identifier shape: PG bare identifier (no quoting). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_LEN = 63;

export interface SchemaFormOptions {
  extensionUri: vscode.Uri;
  /** Snapshot existing schema names (case-insensitive dup check). */
  listSchemaNames: () => Promise<string[]>;
  /**
   * Execute CREATE SCHEMA "<name>"; Trả về void khi success, throw để signal
   * error — host sẽ post lại preview với error message (form vẫn mở cho retry).
   */
  runDdl: (sql: string, name: string) => Promise<void>;
  /** Called after runDdl resolves. Caller wires refresh+reveal+info here. */
  onOk?: (sql: string, name: string) => void;
  /** Called when runDdl rejects. Caller wires showErrorMessage here. */
  onError?: (msg: string) => void;
}

interface PreviewMsg {
  type: "preview";
  sql: string;
  errors: string[];
  okEnabled: boolean;
}
interface InitMsg {
  type: "init";
  existingNames: string[];
}
type HostMessage = InitMsg | PreviewMsg;
interface ReadyMsg {
  type: "ready";
}
interface NameChangedMsg {
  type: "nameChanged";
  name: string;
}
interface SubmitMsg {
  type: "submit";
  name: string;
}
interface CancelMsg {
  type: "cancel";
}
type WebviewMessage = ReadyMsg | NameChangedMsg | SubmitMsg | CancelMsg;

export interface ValidationResult {
  sql: string;
  errors: string[];
  okEnabled: boolean;
}

/** Pure — name + existingNames → {sql, errors, okEnabled}. */
export function validate(name: string, existingNames: string[]): ValidationResult {
  const errors: string[] = [];
  if (name.length === 0) {
    return { sql: "—", errors: ["Name is required"], okEnabled: false };
  }
  if (name.length > MAX_LEN) {
    errors.push(`Name must be ≤ ${MAX_LEN} characters (got ${name.length})`);
  }
  if (!IDENT_RE.test(name)) {
    errors.push(
      "Name must start with a letter or underscore and contain only letters, digits, underscores, or $",
    );
  }
  // Case-insensitive duplicate check (PG folds unquoted identifiers to lowercase).
  if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    errors.push(`Schema "${name}" already exists`);
  }
  if (errors.length > 0) {
    return { sql: "—", errors, okEnabled: false };
  }
  return { sql: `CREATE SCHEMA ${alwaysQuote(name)};`, errors: [], okEnabled: true };
}

export class SchemaForm {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private existingNames: string[] = [];
  private lastName = "";

  constructor(private readonly options: SchemaFormOptions) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      "Create New Schema",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg)),
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

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.handleReady();
        return;
      case "nameChanged":
        this.lastName = msg.name;
        this.postPreview();
        return;
      case "submit":
        await this.handleSubmit(msg.name);
        return;
      case "cancel":
        this.dispose();
        return;
    }
  }

  private async handleReady(): Promise<void> {
    try {
      this.existingNames = await this.options.listSchemaNames();
    } catch {
      this.existingNames = [];
    }
    this.post({ type: "init", existingNames: this.existingNames });
    this.postPreview();
  }

  private postPreview(): void {
    const result = validate(this.lastName, this.existingNames);
    this.post({ type: "preview", ...result });
  }

  private async handleSubmit(name: string): Promise<void> {
    // Re-validate host-side (never run invalid SQL).
    const result = validate(name, this.existingNames);
    if (!result.okEnabled) {
      this.post({ type: "preview", ...result });
      return;
    }
    try {
      await this.options.runDdl(result.sql, name);
      this.options.onOk?.(result.sql, name);
      this.dispose();
    } catch (err) {
      const msg = `Create Schema failed: ${err instanceof Error ? err.message : String(err)}`;
      this.options.onError?.(msg);
      this.post({
        type: "preview",
        sql: result.sql,
        errors: [msg],
        okEnabled: false,
      });
    }
  }

  private post(msg: HostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "schemaForm.js"),
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
  <title>UnicDB Create Schema</title>
</head>
<body class="UnicDB-form-body">
  <div id="UnicDB-root" class="UnicDB-form"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}