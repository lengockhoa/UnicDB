// src/ui/renameForm.ts — TASK-DBX06-003
// RenameForm — Safe Rename dialog (DBX-06). Host wraps a webview panel:
//  - analyze: validateNewName → 4 parameterized catalog queries →
//    buildRenamePlan → posts analysis {report, statements, errors}
//  - approve: runRenameStatements with per-statement progress; cancel
//    stops BEFORE the next statement; failure reports applied/failedAt.
// Mirror NewTableForm (CSP strict, typed messages, dispose pattern).
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import {
  validateNewName,
  type RenameCatalogRows,
} from "../core/ddl/renameAnalysis";
import { buildRenamePlan } from "../core/ddl/renameCatalog";
import type { RenameUsageApi } from "../adapters/types";
import { runRenameStatements, type RunOutcome } from "../core/ddl/renameRunner";
import type {
  RenameFormWebviewMessage,
  RenameFormHostMessage,
} from "./renameFormMessages";

const PANEL_ID = "vsdb.renameForm";

export interface RenameFormOptions {
  extensionUri: vscode.Uri;
  mode: "table" | "column";
  schema: string;
  table: string;
  oldName: string;
  mgr: ConnectionManager;
  conn: ConnectionConfig;
  /** After a successful table rename — reveal the renamed table node. */
  onRenamed?: (newName: string) => void;
}

export class RenameForm {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** Statements from the last successful analysis — approve runs these. */
  private lastStatements: string[] | null = null;
  /** Set while a run is in flight → cancel requests flip this flag. */
  private cancelRequested = false;

  constructor(private readonly options: RenameFormOptions) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const noun = this.options.mode === "table" ? "Table" : "Column";
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      `Rename ${noun} — ${this.options.schema}.${this.options.table}`,
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
        (msg: RenameFormWebviewMessage) => this.handleMessage(msg),
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
    this.cancelRequested = true;
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ---- host message handling ------------------------------------------------

  private post(msg: RenameFormHostMessage): void {
    this.panel?.webview.postMessage(msg);
  }

  private async handleMessage(msg: RenameFormWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({
          type: "init",
          mode: this.options.mode,
          schema: this.options.schema,
          table: this.options.table,
          oldName: this.options.oldName,
        });
        return;
      case "analyze":
        await this.handleAnalyze(typeof msg.newName === "string" ? msg.newName : "");
        return;
      case "approve":
        await this.handleApprove();
        return;
      case "cancel":
        this.cancelRequested = true;
        return;
    }
  }

  private async usage(): Promise<RenameUsageApi> {
    const a = await this.options.mgr.getAdapterFor(this.options.conn);
    if (!a.renameUsage) {
      throw new Error("Rename usage analysis requires a PostgreSQL adapter.");
    }
    return a.renameUsage;
  }

  /** Run the 4 catalog lookups + build the plan. */
  async analyzeName(newName: string): Promise<{
    report: RenameCatalogRows;
    statements: string[];
    errors: string[];
  }> {
    const invalid = validateNewName(newName);
    if (invalid !== null) {
      return { report: EMPTY_ROWS(), statements: [], errors: [invalid] };
    }
    const { schema, table, mode, oldName } = this.options;
    try {
      const u = await this.usage();
      // DBX06-005 — trigger/index lookups take the CURRENT column name in
      // column mode and "" in table mode (table-wide usage).
      const columnKey = mode === "table" ? "" : oldName;
      const [viewRows, fkRows, routineRows, collisionRows, triggerRows, indexRows] =
        await Promise.all([
          u.dependentViews(schema, table),
          u.referencingFks(schema, table),
          u.routines(schema, table),
          // Column renames cannot collide (same relation); table renames check
          // the candidate name across the schema.
          mode === "table"
            ? u.nameCollision(schema, newName)
            : Promise.resolve([] as Array<{ name: string; kind: string }>),
          u.triggers(schema, table, columnKey),
          u.indexes(schema, table, columnKey),
        ]);
      const rows: RenameCatalogRows = {
        dependentViews: viewRows,
        referencingFks: fkRows,
        routines: routineRows,
        triggers: triggerRows,
        indexes: indexRows,
        collisions:
          mode === "table"
            ? collisionRows.map((r) => `${r.name} (${r.kind})`)
            : [],
      };
      const plan = buildRenamePlan({
        kind: mode,
        schema,
        table,
        oldName,
        newName,
        rows,
      });
      return { report: rows, statements: plan.statements, errors: plan.errors };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { report: EMPTY_ROWS(), statements: [], errors: [`Catalog analysis failed: ${m}`] };
    }
  }

  private async handleAnalyze(newName: string): Promise<void> {
    const a = await this.analyzeName(newName);
    this.lastStatements = a.errors.length === 0 ? a.statements : null;
    this.post({
      type: "analysis",
      report: {
        views: a.report.dependentViews,
        fks: a.report.referencingFks,
        routines: a.report.routines,
        triggers: a.report.triggers,
        indexes: a.report.indexes,
        collisions: a.report.collisions,
      },
      statements: a.statements,
      errors: a.errors,
    });
  }

  private async handleApprove(): Promise<void> {
    const statements = this.lastStatements;
    if (!statements || statements.length === 0) return;
    this.cancelRequested = false;
    try {
      const outcome: RunOutcome = await runRenameStatements(
        statements,
        async (sql) => {
          const a = await this.options.mgr.getAdapterFor(this.options.conn);
          await a.runQuery(sql);
        },
        (index, total, statement) => {
          this.post({ type: "progress", index, total, statement });
        },
        () => this.cancelRequested,
      );
      if ("failedAt" in outcome) {
        this.post({
          type: "done",
          applied: outcome.applied,
          total: statements.length,
          failedAt: outcome.failedAt,
          failedStatement: outcome.failedStatement,
          error: outcome.error,
        });
        return;
      }
      if ("cancelledAfter" in outcome) {
        this.post({
          type: "done",
          applied: outcome.applied,
          total: statements.length,
          cancelled: true,
          remaining: outcome.remaining,
        });
        return;
      }
      this.post({
        type: "done",
        applied: outcome.applied,
        total: statements.length,
      });
      if (this.options.mode === "table" && this.options.onRenamed) {
        // Extract the new name from the single statement we just ran.
        const m = statements[statements.length - 1]!.match(/RENAME TO ("((?:[^"]|"")*)"|.+);$/);
        if (m && m[2] !== undefined) {
          this.options.onRenamed(m[2].replace(/""/g, '"'));
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.post({
        type: "done",
        applied: 0,
        total: statements.length,
        error: m,
      });
    }
  }

  // ---- html ------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "renameForm.js"),
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
  <title>VSDB Rename</title>
</head>
<body class="vsdb-form-body">
  <div id="vsdb-root" class="vsdb-form"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function EMPTY_ROWS(): RenameCatalogRows {
  return {
    dependentViews: [],
    referencingFks: [],
    routines: [],
    triggers: [],
    indexes: [],
    collisions: [],
  };
}
