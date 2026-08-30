// src/ui/comparePanel.ts
// TASK-DBX03-004 — preview-only compare panel host. CSP-clean: the
// webview renders with textContent only. The panel NEVER executes the
// plan — clipboard copy is the only hand-off.

import * as vscode from "vscode";
import type { CompareRequest, CompareResult } from "./compareService";
import { buildCompareHtml } from "./comparePanelHtml";

export const COMPARE_PANEL_VIEW_TYPE = "vsdbComparePanel";

export interface ComparePanelOptions {
  extensionUri: vscode.Uri;
}

/** Test-friendly pure helper: the webview message guard. */
export function isCopySqlMessage(msg: unknown): msg is { type: "copySql"; sql: string } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "copySql" &&
    typeof (msg as { sql?: unknown }).sql === "string"
  );
}

export class ComparePanel {
  private static instance: ComparePanel | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private lastMessage: { result: CompareResult; request: CompareRequest } | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  static get(options: ComparePanelOptions): ComparePanel {
    if (!ComparePanel.instance) ComparePanel.instance = new ComparePanel(options.extensionUri);
    return ComparePanel.instance;
  }

  show(result: CompareResult, req: CompareRequest): void {
    this.lastMessage = { result, request: req };
    if (this.panel) {
      this.panel.reveal();
      this.post();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      COMPARE_PANEL_VIEW_TYPE,
      `Compare ${req.source.table} → ${req.target.table}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = buildCompareHtml(
      this.panel.webview,
      "comparePanel.js",
      "webview.css",
    );
    this.post();
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (isCopySqlMessage(msg)) {
        void vscode.env.clipboard.writeText(msg.sql);
        void vscode.window.showInformationMessage(
          "Sync SQL copied. Paste into the SQL Console to review and run — the panel never executes.",
        );
      }
    });
  }

  private post(): void {
    if (this.panel && this.lastMessage) {
      void this.panel.webview.postMessage({
        type: "vsdb-compare",
        result: this.lastMessage.result,
        request: this.lastMessage.request,
      });
    }
  }
}
