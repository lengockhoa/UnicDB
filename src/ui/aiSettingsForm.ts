// src/ui/aiSettingsForm.ts
// AiSettingsForm — single-instance webview panel that lets the user view/edit
// the OpenAI-compatible AI backend config (baseUrl, method, timeoutMs,
// maxSteps, both model roles, apiKey). Test button smoke-fires the provider.
//
// Mirrors ConnectionForm / NewTableForm patterns: CSP strict, retainContext,
// typed messages, reveal-on-reshow, dispose.
// SECURITY: apiKey is NEVER round-tripped to the webview. The host sends
// `hasApiKey: boolean` only; an empty key on submit with an existing stored
// key reuses the stored key. Invalid settings ⇒ save rejected, error posted.
import * as vscode from "vscode";
import type { AiConfig } from "../ai/settings";
import {
  aiSettingsErrors,
  defaultAiSettings,
  type AiSettings,
} from "../ai/settings";
import type { AiConfigStore } from "../ai/config";
import type {
  AiSettingsFormHostMessage,
  AiSettingsFormWebviewMessage,
} from "./aiSettingsFormMessages";
import type {
  ProviderRequest,
  ProviderResult,
} from "../ai/provider";

const PANEL_ID = "vsdb.aiSettingsForm";

export interface AiSettingsFormOptions {
  extensionUri: vscode.Uri;
  /**
   * Injected store. Subset of AiConfigStore so host tests can swap a fake
   * without depending on the full vscode-bound class.
   */
  store: Pick<
    AiConfigStore,
    "loadSettings" | "loadApiKey" | "save"
  >;
  /**
   * Provider complete seam. The default wiring (extension.ts) binds this to
   * `createProviderClient({...cfg}).complete` so the Test button can fire a
   * real smoke call against user-entered values without needing a stored
   * apiKey on the form.
   */
  complete: (
    cfg: AiConfig,
    role: "work",
    req: ProviderRequest,
  ) => Promise<ProviderResult>;
}

export class AiSettingsForm {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** Guard against concurrent Test-button calls. */
  private testing = false;

  constructor(private readonly options: AiSettingsFormOptions) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      "VSDB AI Settings",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.options.extensionUri, "dist"),
        ],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        (msg: AiSettingsFormWebviewMessage) => this.handleMessage(msg),
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

  private async handleMessage(
    msg: AiSettingsFormWebviewMessage,
  ): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.handleReady();
        return;
      case "save":
        await this.handleSave(msg.settings, msg.apiKey);
        return;
      case "test":
        await this.handleTest(msg.settings, msg.apiKey);
        return;
      case "cancel":
        this.dispose();
        return;
    }
  }

  private async handleReady(): Promise<void> {
    const [storedSettings, storedApiKey] = await Promise.all([
      this.options.store.loadSettings(),
      this.options.store.loadApiKey(),
    ]);
    const settings: AiSettings = storedSettings ?? defaultAiSettings();
    const hasApiKey = storedApiKey !== undefined;
    this.post({ type: "init", settings, hasApiKey });
  }

  private async handleSave(
    submitted: AiSettings,
    submittedApiKey: string,
  ): Promise<void> {
    // Authoritative re-validation on host side.
    const errors = aiSettingsErrors(submitted);
    if (errors.length > 0) {
      // B13: a failed SAVE must not be reported through the `testResult`
      // channel — that makes it look like the Test-button connection check
      // failed, when nothing was ever tested. Use the dedicated `saveResult`
      // channel instead.
      this.post({
        type: "saveResult",
        ok: false,
        error: errors[0],
      });
      return;
    }
    let apiKey = submittedApiKey;
    if (apiKey === "") {
      const stored = await this.options.store.loadApiKey();
      if (stored === undefined) {
        // Empty key, nothing stored ⇒ refuse to save. Mirror the spec guard
        // ("API key is required").
        this.post({
          type: "saveResult",
          ok: false,
          error: "API key is required",
        });
        return;
      }
      apiKey = stored;
    }
    try {
      await this.options.store.save(submitted, apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "saveResult", ok: false, error: message });
      return;
    }
    this.post({ type: "saved" });
  }

  private async handleTest(
    submitted: AiSettings,
    submittedApiKey: string,
  ): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    try {
      // Re-validate host-side; never fire provider for invalid settings.
      const errors = aiSettingsErrors(submitted);
      if (errors.length > 0) {
        this.post({
          type: "testResult",
          ok: false,
          error: errors[0],
        });
        return;
      }
      let apiKey = submittedApiKey;
      if (apiKey === "") {
        const stored = await this.options.store.loadApiKey();
        if (stored === undefined) {
          this.post({
            type: "testResult",
            ok: false,
            error: "API key is required",
          });
          return;
        }
        apiKey = stored;
      }
      const cfg: AiConfig = { ...submitted, apiKey };
      const req: ProviderRequest = {
        modelId: submitted.models.work.modelId,
        messages: [{ role: "user", content: "Reply with: ok" }],
        maxOutputTokens: 8,
      };
      const start = Date.now();
      try {
        await this.options.complete(cfg, "work", req);
        const latencyMs = Date.now() - start;
        this.post({ type: "testResult", ok: true, latencyMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.post({ type: "testResult", ok: false, error: message });
      }
    } finally {
      this.testing = false;
    }
  }

  private post(msg: AiSettingsFormHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "aiSettingsForm.js"),
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
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>VSDB AI Settings</title>
</head>
<body class="vsdb-form-body">
  <div id="vsdb-root" class="vsdb-form">
    <div class="vsdb-form-loading">Loading…</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}