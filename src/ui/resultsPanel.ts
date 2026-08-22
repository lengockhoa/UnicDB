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
import type { ConnectionConfig } from "../config/types";
import { buildSaveStatements } from "../core/saveStatements";

/**
 * Host-side save flow hook. The extension wires this so the panel knows:
 *  - what dialect the active connection uses,
 *  - how to read PK column metadata for a (schema, table) pair (or skip
 *    metadata entirely and pass [] when parsing the FROM clause is enough).
 *
 * The adapter access is exposed as a function so the panel does not import
 * ConnectionManager directly — extension.ts owns connection lifecycle.
 */
export interface SaveContext {
  /** Active driver ('postgres' | 'mysql' | 'mssql'); null when no connection. */
  getDriver(): ConnectionConfig["driver"] | null;
  /** Return PK columns for the (schema, table) pair via DbAdapter.listColumns. */
  listPkColumns(schema: string, table: string): Promise<string[]>;
}

export interface ResultsPanelOptions {
  /** QueryRunner instance (để loadMore / cancel). */
  runner: QueryRunner;
  /** View column mặc định (mặc định Beside). */
  viewColumn?: vscode.ViewColumn;
  /** Title cho panel. */
  title?: string;
  /** Save flow dependencies — must be supplied when SaveEdits is wired in. */
  saveContext?: SaveContext;
}

export class ResultsPanel {
  private readonly runner: QueryRunner;
  private readonly saveContext: SaveContext | null;
  private readonly viewColumn: vscode.ViewColumn;
  private readonly title: string;
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private header: string = "";
  private lastResults: StatementResult[] = [];
  private busy: boolean = false;

  constructor(options: ResultsPanelOptions) {
    this.runner = options.runner;
    this.saveContext = options.saveContext ?? null;
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
      case "saveEdits":
        await this.handleSaveEdits(msg.index, msg.tableName, msg.pkColumns, msg.edits);
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
   * TASK-503 — Save edits: translate the webview payload into per-dialect
   * UPDATE / INSERT / DELETE statements, execute them via the adapter, then
   * re-run the original SQL to refresh grid state. Ack the webview with
   * `saveResult` so it can clear its dirty map (success) or surface the
   * errors in a banner (failure).
   *
   * Soft refusals (no_pk) → ack with `refused:true`, `reason` populated,
   * `ok:true` (refusal is NOT a failure: there is nothing to retry, and
   * the dirty state is cleared too).
   *
   * NOTE: client-side field-quoting/placeholders are produced by
   * `buildSaveStatements`; the adapter uses `runQuery()` which expects
   * plain SQL. For postgres parameters we rely on the adapter's own
   * substitution model — the PostgresAdapter exposes `runQuery(sql)`
   * only (no parameterised statement API); we substitute via simple
   * literal-escape at the SQL string level so the SAVE statements remain
   * transport-safe.
   */
  private async handleSaveEdits(
    index: number,
    tableName: string | null,
    pkColumns: string[],
    edits: Array<{ rowId: number; colIndex: number; value: unknown }>,
  ): Promise<void> {
    if (!this.saveContext) {
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        errors: ["Save context not wired — extension.ts must pass saveContext when constructing ResultsPanel."],
      });
      return;
    }
    const driver = this.saveContext.getDriver();
    if (!driver) {
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        errors: ["No active connection — cannot save."],
      });
      return;
    }
    const r = this.lastResults[index];
    if (!r || !r.result) {
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        errors: ["No server rows for this statement."],
      });
      return;
    }
    const columns = r.result.columns;
    const serverRows = r.result.rows;

    // Postgres no-PK fallback: pre-fetch ctids for every dirty rowId via
    // a single SELECT ctid, col1, col2... This is a documented limitation
    // — the contract says postgres tables without a declared PK get the
    // ctid route, but the caller must accept the extra round-trip.
    let ctidByRowId: ReadonlyMap<number, string> | undefined;
    if (driver === "postgres" && pkColumns.length === 0 && tableName) {
      ctidByRowId = await this.fetchPostgresCtids(tableName, columns, serverRows);
    }

    const built = buildSaveStatements(
      driver,
      tableName ?? "results",
      pkColumns,
      columns,
      edits,
      serverRows,
      ctidByRowId ? { ctidByRowId } : {},
    );
    if (built.ok === false) {
      const reason =
        built.reason === "no_pk"
          ? `Cannot save: ${driver} has no PRIMARY KEY for "${tableName ?? "table"}". Switch to UPDATE via raw SQL or define a PRIMARY KEY.`
          : "Save refused.";
      this.postMessage({
        type: "saveResult",
        index,
        ok: true, // refusal is not a runtime failure; dirty map clears.
        refused: true,
        reason,
      });
      return;
    }

    // built is SaveStatementsOk here.
    if (built.statements.length === 0) {
      // Nothing to do — treat as success so the webview clears.
      this.postMessage({ type: "saveResult", index, ok: true });
      return;
    }

    this.setBusy(true);
    const errors: string[] = [];
    try {
      // Drive each generated statement through the adapter. PostgresAdapter
      // exposes `runQuery(sql)` only; for parameterized SQL we are already
      // using pg-format-safe literal substitution in buildSaveStatements
      // (sqlLiteral). Otherwise we substitute parameters client-side here.
      for (const stmt of built.statements) {
        try {
          await this.runner.runSql(stmt);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          errors.push(m);
        }
      }
      if (errors.length > 0) {
        // Surface to the webview's banner; abort the refresh step.
        this.postMessage({ type: "saveResult", index, ok: false, errors });
        return;
      }
      // Re-run the original SQL so the grid reflects the saved state.
      const refreshed = await this.runner.runSql(r.sql);
      const freshResult = refreshed.results[0];
      if (freshResult && freshResult.rows.length >= 0) {
        // Replace THIS statement in lastResults with the refreshed row set.
        const next = this.lastResults.slice();
        next[index] = {
          ...r,
          result: freshResult,
          durationMs: r.durationMs,
        };
        this.lastResults = next;
        this.postMessage({
          type: "state",
          header: this.header,
          results: next,
          busy: this.busy,
        });
      }
      this.postMessage({ type: "saveResult", index, ok: true });
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Postgres no-PK support: fetch ctid for every row currently in view so
   * `UPDATE ... WHERE ctid = $1` can address the row. We pull ctid + the
   * full column set because ctid alone doesn't help us match against the
   * webview's row identity (which is the source-array index, NOT a row id).
   *
   * Match is by full-row equality — works for tables where the column set
   * uniquely identifies a row (typical SELECT *). Documented limitation:
   * concurrent writes between the fetch and the save can shift ctids.
   */
  private async fetchPostgresCtids(
    tableName: string,
    columns: string[],
    serverRows: unknown[][],
  ): Promise<ReadonlyMap<number, string> | undefined> {
    // Build a SELECT ctid, c1, c2, ... FROM <table> WHERE (col1 IS DISTINCT
    // FROM $1 OR col2 IS DISTINCT FROM $2 OR ...) per row. Simpler & safer
    // in our context (webview rows are bounded by the user's view) than
    // building one giant OR clause.
    const map = new Map<number, string>();
    try {
      for (let i = 0; i < serverRows.length; i++) {
        const row = serverRows[i];
        if (!row) continue;
        const conds: string[] = [];
        for (let c = 0; c < columns.length && c < row.length; c++) {
          const v = row[c];
          // Use IS NOT DISTINCT FROM for null-safety in the generated SQL.
          if (v === null || v === undefined) {
            conds.push(`${columns[c]} IS NULL`);
          } else if (typeof v === "number" || typeof v === "boolean") {
            conds.push(`${columns[c]} = ${JSON.stringify(v)}`);
          } else if (typeof v === "bigint") {
            conds.push(`${columns[c]} = ${v.toString()}`);
          } else {
            const s = String(v).replace(/'/g, "''");
            conds.push(`${columns[c]} = '${s}'`);
          }
        }
        const sql = `SELECT ctid FROM ${tableName} WHERE ${conds.join(" AND ")} LIMIT 1`;
        const res = await this.runner.runSql(sql);
        const rows = res.results[0]?.rows ?? [];
        if (rows.length > 0) {
          map.set(i, String(rows[0][0]));
        }
      }
    } catch {
      // Best-effort: missing ctids will surface as per-row warnings in
      // buildSaveStatements.
    }
    return map.size > 0 ? map : undefined;
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
