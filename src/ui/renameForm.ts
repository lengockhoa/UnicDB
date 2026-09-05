// src/ui/renameForm.ts — TASK-DBX06-003 + DBX06-006
// RenameForm — Safe Rename dialog (DBX-06). Host wraps a webview panel:
//  - analyze: validateNewName → 6 parameterized catalog queries (views, FKs,
//    routines, collision, triggers, indexes; triggers/indexes pass `""` in
//    table mode) → buildRenamePlan → posts analysis {report, statements,
//    steps, errors}
//  - approve: runRenameSteps on the typed executable plan; cancel stops
//    BEFORE the next step; failure reports applied/failed with the step's
//    label. The last analyzed plan is cleared on every error analysis so a
//    stale plan cannot be approved after a collision.
import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import {
  validateNewName,
  type RenameCatalogRows,
} from "../core/ddl/renameAnalysis";
import {
  buildRenamePlan,
  type RenamePlanStep,
} from "../core/ddl/renameCatalog";
import type { RenameUsageApi } from "../adapters/types";
import {
  runRenameSteps,
  type NamedStep,
  type RunStepsOutcome,
} from "../core/ddl/renameRunner";
import type {
  RenameFormWebviewMessage,
  RenameFormHostMessage,
} from "./renameFormMessages";

const PANEL_ID = "UnicDB.renameForm";

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

export interface RenameAnalysisResult {
  report: RenameCatalogRows;
  statements: string[];
  steps: RenamePlanStep[];
  errors: string[];
}

export class RenameForm {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** Typed plan steps from the last successful analysis — approve runs these. */
  private lastSteps: RenamePlanStep[] | null = null;
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

  /** Run the 6 catalog lookups + build the typed plan. */
  async analyzeName(newName: string): Promise<RenameAnalysisResult> {
    const invalid = validateNewName(newName);
    if (invalid !== null) {
      return { report: EMPTY_ROWS(), statements: [], steps: [], errors: [invalid] };
    }
    const { schema, table, mode, oldName } = this.options;
    try {
      const u = await this.usage();
      // DBX06-005/006 — trigger/index lookups take the CURRENT column name in
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
      return {
        report: rows,
        statements: plan.statements,
        steps: plan.steps,
        errors: plan.errors,
      };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return {
        report: EMPTY_ROWS(),
        statements: [],
        steps: [],
        errors: [`Catalog analysis failed: ${m}`],
      };
    }
  }

  private async handleAnalyze(newName: string): Promise<void> {
    const a = await this.analyzeName(newName);
    // DBX06-006 — only retain the typed plan for approval when the analysis
    // is clean; an error/collision analysis MUST clear prior executable state
    // so an older clean plan cannot be approved after a failed analysis.
    this.lastSteps = a.errors.length === 0 ? a.steps : null;
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
      steps: a.steps,
      errors: a.errors,
    });
  }

  private async handleApprove(): Promise<void> {
    const steps = this.lastSteps;
    if (!steps || steps.length === 0) return;
    this.cancelRequested = false;
    const execCount = steps.filter((s) => s.executable).length;
    try {
      const outcome: RunStepsOutcome = await runRenameSteps(
        steps,
        async (sql) => {
          const a = await this.options.mgr.getAdapterFor(this.options.conn);
          await a.runQuery(sql);
        },
        (step, total) => {
          this.post({
            type: "progress",
            index: step.index,
            total,
            statement: step.sql,
          });
        },
        () => this.cancelRequested,
      );
      if ("failed" in outcome) {
        this.post({
          type: "done",
          applied: outcome.applied,
          total: execCount,
          failed: outcome.failed,
        });
        return;
      }
      if ("cancelledAfter" in outcome) {
        this.post({
          type: "done",
          applied: outcome.applied,
          total: execCount,
          cancelledAfter: outcome.cancelledAfter,
          remaining: outcome.remaining,
        });
        return;
      }
      this.post({
        type: "done",
        applied: outcome.applied,
        total: execCount,
      });
      if (this.options.mode === "table" && this.options.onRenamed) {
        // Extract the new name from the last applied step's statement.
        const lastApplied: NamedStep | undefined = outcome.applied[outcome.applied.length - 1];
        if (lastApplied) {
          const m = lastApplied.sql.match(
            /RENAME TO ("((?:[^"]|"")*)"|.+);$/,
          );
          if (m && m[2] !== undefined) {
            this.options.onRenamed(m[2].replace(/""/g, '"'));
          }
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.post({
        type: "done",
        applied: [],
        total: execCount,
        failed: {
          index: 0,
          label: "rename",
          sql: "",
          error: m,
        },
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
  <title>UnicDB Rename</title>
</head>
<body class="UnicDB-form-body">
  <div id="UnicDB-root" class="UnicDB-form"></div>
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
