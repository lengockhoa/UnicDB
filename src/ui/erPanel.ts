// src/ui/erPanel.ts — TASK-DBX04-003
// Singleton webview host for the Relationship Explorer. Preview-only:
// the panel never executes SQL; the only side door is the SVG export
// (file save dialog). Message traffic passes a strict type guard.

import * as vscode from "vscode";
import type { ErResult } from "./erService";
import { buildErHtml } from "./erPanelHtml";

export const ER_PANEL_VIEW_TYPE = "UnicDBErPanel";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Test-friendly pure helper: the webview message guard. */
export function isErPanelMessage(
  msg: unknown,
): msg is { type: "er_ready" | "er_export_request" } | { type: "er_zoom"; delta: number } | { type: "er_export_svg"; svg: string; schema: string } {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { type?: unknown; delta?: unknown; svg?: unknown; schema?: unknown };
  if (m.type === "er_ready" || m.type === "er_export_request") return true;
  if (m.type === "er_zoom") return typeof m.delta === "number" && Number.isFinite(m.delta);
  if (m.type === "er_export_svg")
    return typeof m.svg === "string" && typeof m.schema === "string";
  return false;
}

export interface ErPanelOptions {
  extensionUri: vscode.Uri;
}

export class ErPanel {
  private static instance: ErPanel | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private lastMessage: { result: Extract<ErResult, { ok: true }>; schema: string } | null = null;
  private zoom = 1;

  constructor(private readonly extensionUri: vscode.Uri) {}

  static get(options: ErPanelOptions): ErPanel {
    if (!ErPanel.instance) ErPanel.instance = new ErPanel(options.extensionUri);
    return ErPanel.instance;
  }

  /** Show the graph for a successful result; surface an error result as
   *  a message box instead of an empty panel. */
  show(result: ErResult, ctx: { schema: string }): void {
    if (!result.ok) {
      const why =
        result.reason === "unsupported-driver"
          ? "Relationship Explorer requires an active PostgreSQL connection."
          : "Relationship Explorer requires an active connection.";
      void vscode.window.showErrorMessage(why);
      return;
    }
    this.lastMessage = { result, schema: ctx.schema };
    this.zoom = 1;
    if (this.panel) {
      this.panel.reveal();
      this.post();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      ER_PANEL_VIEW_TYPE,
      `Relationships — ${ctx.schema}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = buildErHtml(this.panel.webview, "erPanel.js", "webview.css");
    this.post();
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((msg: unknown) => {
      void this.handle(msg);
    });
  }

  private async handle(msg: unknown): Promise<void> {
    if (!isErPanelMessage(msg) || !this.panel) return;
    if (msg.type === "er_ready") {
      this.post();
      return;
    }
    if (msg.type === "er_zoom") {
      this.zoom = clampZoom(this.zoom * msg.delta);
      this.panel.webview.postMessage({ type: "er_zoom_set", zoom: this.zoom });
      return;
    }
    if (msg.type === "er_export_svg") {
      const schema = msg.schema.replace(/[^\w.-]+/g, "_") || "schema";
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`UnicDB-er-${schema}.svg`),
        filters: { "SVG diagram": ["svg"] },
      });
      if (!target) return;
      const bytes = Buffer.from(msg.svg, "utf8");
      try {
        await vscode.workspace.fs.writeFile(target, bytes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`ER export failed: ${message}`);
        return;
      }
      void vscode.window.showInformationMessage(`ER diagram saved: ${target.fsPath}`);
    }
  }

  private post(): void {
    if (this.panel && this.lastMessage) {
      const layout = this.lastMessage.result.layout;
      void this.panel.webview.postMessage({
        type: "er_model",
        graph: this.lastMessage.result.graph,
        // JSON serialization drops Map contents — post a record instead.
        layout: {
          width: layout.width,
          height: layout.height,
          nodes: Object.fromEntries(layout.nodes),
        },
        truncated: this.lastMessage.result.truncated,
        schema: this.lastMessage.schema,
      });
    }
  }
}
