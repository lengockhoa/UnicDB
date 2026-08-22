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
import {
  buildSaveStatements,
  parseFromClause,
  quoteIdent,
  type Dialect,
} from "../core/saveStatements";
import { sqlLiteral, composeRequery } from "./resultsGridModel";

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
  /** Host-derived (schema?, table) per statement index, populated by
   *  render() so handleSaveEdits can derive metadata without trusting the
   *  webview-supplied tableName / pkColumns (Fix R1 critical #1). */
  private tableByStatement: Map<number, { schema?: string; table: string }> =
    new Map();

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
    this.lastResults = results;
    // Derive (schema?, table) per statement FROM the parsed SQL — host-side
    // truth. The webview's tableName/pkColumns message is IGNORED (Fix R1
    // critical #1). Statements whose SQL has no FROM/INSERT/UPDATE have no
    // addressable table and trigger a hard refusal.
    this.tableByStatement.clear();
    for (const r of results) {
      const parsed = parseFromClause(r.sql);
      if (parsed) {
        this.tableByStatement.set(r.index, parsed);
      }
    }
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
      case "requery":
        await this.handleRequery(msg.index, msg.where, msg.orderBy);
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
   * TASK-503 Fix R1 — Save edits. Host derives the table name FROM the
   * statement SQL via parseFromClause (webview-supplied tableName is
   * IGNORED, see critical #1). Host also derives PK columns via
   * saveContext.listPkColumns (webview-supplied pkColumns is IGNORED).
   *
   * SQL is emitted with INLINE LITERAL values (option B per reviewer's
   * plan) so the statements can be shipped straight to adapter.runQuery
   * without a parameter channel.
   *
   * Ack honesty (critical #3): if edits.length > 0 but every produced
   * statement was refused (no_pk, ambiguous ctid, invalid identifier,
   * unknown column), ack is ok:false with errors[] explaining why.
   * Never silent ok:true.
   *
   * Partial failure: each per-statement error is collected into errors[].
   * ack is ok:false when ANY statement failed; the webview keeps the
   * dirty state so the user can retry.
   */
  private async handleSaveEdits(
    index: number,
    _webviewTableName: string | null,
    _webviewPkColumns: string[],
    edits: Array<{ rowId: number; colIndex: number; value: unknown }>,
  ): Promise<void> {
    if (!this.saveContext) {
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        errors: [
          "Save context not wired — extension.ts must pass saveContext when constructing ResultsPanel.",
        ],
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

    // Critical #1: HOST derives table + pkColumns. Webview values are
    // ignored on purpose — VS Code webview is semi-trusted and a
    // mis-targeted UPDATE is the worst possible silent failure.
    const parsed = this.tableByStatement.get(index);
    if (!parsed) {
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        errors: [
          `Cannot save: statement #${index} has no addressable table (no FROM/INSERT INTO/UPDATE clause in the SQL).`,
        ],
      });
      return;
    }
    const tableName = parsed.table;
    const pkColumns =
      edits.length === 0
        ? []
        : await this.saveContext.listPkColumns(parsed.schema ?? "", tableName);

    const columns = r.result.columns;
    const serverRows = r.result.rows;

    // Postgres no-PK fallback: pre-fetch ctids per row. fetchPostgresCtids
    // uses quoted identifiers + safe literal escape; ambiguous matches
    // (count > 1) are refused.
    let ctidByRowId: ReadonlyMap<number, string> | undefined;
    if (
      driver === "postgres" &&
      pkColumns.length === 0 &&
      edits.length > 0
    ) {
      const ctidRes = await this.fetchPostgresCtids(
        tableName,
        parsed.schema,
        columns,
        serverRows,
      );
      if (!ctidRes.ok) {
        const reason =
          ctidRes.reason === "ambiguous_only"
            ? `Cannot save: postgres no-PK + ctid lookup is ambiguous (multiple rows match the dirty cells). Add a PRIMARY KEY or refine edits.`
            : `Cannot save: postgres no-PK + ctid lookup failed for every dirty row.`;
        this.postMessage({
          type: "saveResult",
          index,
          ok: false,
          refused: true,
          reason,
          errors: [reason],
        });
        return;
      }
      ctidByRowId = ctidRes.map;
    }

    const built = buildSaveStatements(
      driver as Dialect,
      tableName,
      pkColumns,
      columns,
      edits,
      serverRows,
      ctidByRowId ? { ctidByRowId } : {},
    );

    // Refusal from build (no_pk / invalid_identifier). Banner with reason.
    if (built.ok === false) {
      const reason =
        built.reason === "no_pk"
          ? `Cannot save: ${driver} has no PRIMARY KEY for "${tableName}". Switch to UPDATE via raw SQL or define a PRIMARY KEY.`
          : `Save refused: ${built.warnings.join(" ")}`;
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        refused: true,
        reason,
        errors: built.warnings,
      });
      return;
    }

    // Critical #3: edits present but every statement was skipped →
    // ack ok:false with warnings. Never silent ok:true.
    if (built.statements.length === 0 && edits.length > 0) {
      const errText =
        built.warnings.length > 0
          ? built.warnings.join(" ")
          : "Save produced no statements (every row was skipped).";
      this.postMessage({
        type: "saveResult",
        index,
        ok: false,
        refused: true,
        reason: errText,
        errors: built.warnings,
      });
      return;
    }

    // Empty edits → no-op success (webview's dirtyCount gate should
    // already have prevented this, but be defensive).
    if (built.statements.length === 0) {
      this.postMessage({ type: "saveResult", index, ok: true });
      return;
    }

    this.setBusy(true);
    const errors: string[] = [];
    try {
      for (const stmt of built.statements) {
        try {
          await this.runner.runSql(stmt);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          errors.push(m);
        }
      }
      if (errors.length > 0) {
        // Partial-failure path: ack ok:false with per-statement errors
        // so the banner shows exactly which statement(s) failed. The
        // webview keeps dirty state so the user can retry.
        this.postMessage({
          type: "saveResult",
          index,
          ok: false,
          errors,
        });
        return;
      }
      // Re-run the original SQL to refresh the grid.
      const refreshed = await this.runner.runSql(r.sql);
      const freshResult = refreshed.results[0];
      if (freshResult) {
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
   * TASK-504 — WHERE/ORDER BY "Re-Run" handler.
   *
   * Looks up `lastResults[index]`, composes a new SQL via
   * `composeRequery(r.sql, where, orderBy)`, runs it through the same
   * `runner.runSql` path used by the SAVE-edits refresh, and swaps the
   * statement at `index` in `lastResults` with the new result. The webview
   * gets a fresh `state` message and the grid re-renders.
   *
   * Errors are surfaced as a host-side notification AND as a synthetic
   * error StatementResult so the webview shows the error in the existing
   * `vsdb-error` placeholder (no new banner needed).
   *
   * Cancel-during-requery is treated like cancel-during-loadMore: the
   * runner reports `cancelled` and we re-post the previous state silently
   * — no toast.
   */
  private async handleRequery(
    index: number,
    where: string,
    orderBy: string,
  ): Promise<void> {
    const r = this.lastResults[index];
    if (!r) {
      void vscode.window.showErrorMessage(
        `VSDB: requery failed — no statement at index ${index}.`,
      );
      return;
    }
    const composed = composeRequery(r.sql, where, orderBy);
    this.setBusy(true);
    try {
      const refreshed = await this.runner.runSql(composed);
      const freshResult = refreshed.results[0];
      const next = this.lastResults.slice();
      // Synthesize the new StatementResult. We keep `index`, `sql` (the
      // ORIGINAL — what the user wrote) and `durationMs` from the prior
      // run so the toolbar / Messages tab continue to show the user's
      // authored SQL.
      next[index] = {
        index: r.index,
        sql: r.sql,
        status: "done",
        result: freshResult,
        durationMs: Date.now(),
      };
      this.lastResults = next;
      // Re-derive table map for the index — the wrapped SQL still
      // references the same table; parseFromClause on the original
      // keeps the addressable table valid.
      const parsed = parseFromClause(r.sql);
      if (parsed) this.tableByStatement.set(r.index, parsed);
      else this.tableByStatement.delete(r.index);
      this.postMessage({
        type: "state",
        header: this.header,
        results: next,
        busy: this.busy,
      });
    } catch (err) {
      const cancelled =
        this.runner.isCancelled?.() === true ||
        /cancel/i.test(err instanceof Error ? err.message : String(err));
      if (!cancelled) {
        const m = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`VSDB requery failed: ${m}`);
        // Surface as a per-statement error so the webview grid shows the
        // existing error placeholder instead of the stale result.
        const next = this.lastResults.slice();
        next[index] = {
          index: r.index,
          sql: r.sql,
          status: "error",
          error: m,
          durationMs: Date.now(),
        };
        this.lastResults = next;
        this.postMessage({
          type: "state",
          header: this.header,
          results: next,
          busy: this.busy,
        });
      } else {
        // Re-post the prior state so the webview drops its in-flight flag.
        this.postMessage({
          type: "state",
          header: this.header,
          results: this.lastResults,
          busy: this.busy,
        });
      }
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Postgres no-PK support: fetch ctid for every row currently in view so
   * UPDATE WHERE ctid = '<literal>' can address the row.
   *
   * Fix R1 important #1: identifiers are quoted per dialect (postgres
   * plain); values use sqlLiteral (single-quote doubling, NO backslash
   * escape). Ambiguous rows (multiple matches → ambiguous ctid) are
   * REFUSED — that row is dropped from the map so buildSaveStatements
   * sees a missing ctid and skips it with a warning.
   *
   * Returns undefined only when EVERY row's lookup failed (caller treats
   * that as a hard refusal). Otherwise returns the partial map.
   */
  private async fetchPostgresCtids(
    tableName: string,
    schema: string | undefined,
    columns: string[],
    serverRows: unknown[][],
  ): Promise<
    | { ok: true; map: ReadonlyMap<number, string> }
    | { ok: false; reason: "all_failed" | "ambiguous_only" }
  > {
    const map = new Map<number, string>();
    let anySucceeded = false;
    let anyAmbiguous = false;
    const qSchema = schema ? quoteIdent(schema, "postgres") : null;
    const qTable = quoteIdent(tableName, "postgres");
    const fullTable = qSchema ? `${qSchema}.${qTable}` : qTable;
    try {
      for (let i = 0; i < serverRows.length; i++) {
        const row = serverRows[i];
        if (!row) continue;
        const conds: string[] = [];
        for (let c = 0; c < columns.length && c < row.length; c++) {
          const col = columns[c];
          const v = row[c];
          if (v === null || v === undefined) {
            conds.push(`${quoteIdent(col, "postgres")} IS NULL`);
          } else {
            conds.push(
              `${quoteIdent(col, "postgres")} IS NOT DISTINCT FROM ${sqlLiteral(v)}`,
            );
          }
        }
        const sql = `SELECT ctid FROM ${fullTable} WHERE ${conds.join(" AND ")}`;
        const res = await this.runner.runSql(sql);
        const rows = res.results[0]?.rows ?? [];
        if (rows.length === 1) {
          map.set(i, String(rows[0][0]));
          anySucceeded = true;
        } else if (rows.length > 1) {
          // Ambiguous — refuse this row.
          anyAmbiguous = true;
        }
      }
    } catch {
      // Best-effort: missing ctids will surface as per-row warnings in
      // buildSaveStatements.
    }
    if (anySucceeded) return { ok: true, map };
    if (anyAmbiguous) return { ok: false, reason: "ambiguous_only" };
    return { ok: false, reason: "all_failed" };
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
