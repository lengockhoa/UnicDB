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
import type {
  QueryRunner,
  StatementResult,
} from "../core/queryRunner";
import type { BatchedQuery } from "../adapters/types";
import { pickResult } from "../core/queryRunner";
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
    // A14 — this.header was never assigned, so every later post (loadMore,
    // requery, saveEdits refresh, ready) sent an empty header and the query
    // duration/title was always blank.
    this.header = header;
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
        await this.handleSaveEdits(
          msg.index,
          msg.tableName,
          msg.pkColumns,
          msg.edits,
          msg.serverIndexByRowId,
        );
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
   * TASK-002 — Postgres no-PK ctid resolution is collapsed to a single
   * lazy resolver pass invoked ONLY when the active driver is postgres,
   * the table has no PRIMARY KEY, and at least one dirty edit is NOT a
   * pure insert-only marker. No result-set `ctid` column is ever
   * trusted (host no longer appends one — TASK-001), and a user-named
   * column called `ctid` is data, not a row address. Pure INSERT saves
   * skip the resolver entirely.
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
    serverIndexByRowId?: Record<string, number>,
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

    // A12 — __rowId (webview's stable per-row id) diverges from the index
    // into serverRows once rows are added/streamed after the initial page.
    // The webview supplies rowId → serverRows-index; without this map the
    // ctid resolver (and buildSaveStatements' own row lookup) silently
    // reads the WRONG server row.
    const serverIndexMap: Map<number, number> | undefined = serverIndexByRowId
      ? new Map(
          Object.entries(serverIndexByRowId).map(([k, v]) => [Number(k), v]),
        )
      : undefined;
    const resolveServerIndex = (rowId: number): number =>
      serverIndexMap?.get(rowId) ?? rowId;

    // TASK-002 — Postgres no-PK lazy ctid resolver. Single collapsed
    // path: no fast-path that trusts a result-set `ctid` column (the
    // host never appends one — TASK-001 — and a user-named column
    // called `ctid` is data, not a row address). The resolver runs ONCE
    // at save time, ONLY for the specific dirty rowIds that actually
    // need a ctid (UPDATE cell edit or DELETE marker); pure INSERT rows
    // (only `__vsdb_new_row__` markers) are excluded.
    let ctidByRowId: ReadonlyMap<number, string> | undefined;
    const rowIdsNeedingCtid: number[] = [];
    if (driver === "postgres" && pkColumns.length === 0) {
      // Finding 2 (review fix round, cycle T) — a locally-added row's
      // insert marker AND its ordinary cell edits (colIndex >= 0, recorded
      // separately by onCellValueChangedHandler) share the same rowId. The
      // old per-EDIT `isPureInsert` check only excluded the marker entry
      // itself, so the row's cell edits still pushed it into
      // rowIdsNeedingCtid. fetchPostgresCtids then found no server row for
      // that (brand-new) rowId and skipped it, and when the batch was
      // insert-only that meant EVERY row failed → hard `all_failed`
      // refusal — Add Row on a no-PK postgres table (the entire point of
      // the ctid path) could never save. Compute the full set of
      // insert-marked rowIds FIRST and exclude them entirely: those rows
      // are addressed by their own INSERT (with cell edits folded in per
      // Finding 1), never by a ctid-addressed UPDATE.
      const insertRowIds = new Set<number>();
      for (const e of edits) {
        const v = e.value;
        if (
          typeof v === "object" &&
          v !== null &&
          (v as Record<string, unknown>)["__vsdb_new_row__"] === true
        ) {
          insertRowIds.add(e.rowId);
        }
      }
      const seen = new Set<number>();
      for (const e of edits) {
        if (insertRowIds.has(e.rowId)) continue;
        if (seen.has(e.rowId)) continue;
        seen.add(e.rowId);
        rowIdsNeedingCtid.push(e.rowId);
      }
    }
    if (rowIdsNeedingCtid.length > 0) {
      const ctidRes = await this.fetchPostgresCtids(
        tableName,
        parsed.schema,
        columns,
        serverRows,
        rowIdsNeedingCtid,
        resolveServerIndex,
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
    const built = buildSaveStatements(driver as Dialect, tableName, pkColumns, columns, edits, serverRows, {
      ...(ctidByRowId ? { ctidByRowId } : {}),
      ...(serverIndexMap ? { serverIndexByRowId: serverIndexMap } : {}),
      ...(parsed.schema ? { schema: parsed.schema } : {}),
    });

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
    const refreshStart = Date.now();
    try {
      // A15 — bundle BEGIN + every generated statement + COMMIT into a
      // SINGLE combined runner.runSql call. The adapter contract does
      // NOT guarantee session/connection affinity across separate calls
      // (a fresh call may land on a different pooled connection), so
      // issuing BEGIN and the statements as separate calls made the
      // "transaction" meaningless — a mid-batch failure could not be
      // rolled back because later statements might already be
      // committed autocommit-style on their own connection. Bundling
      // into one call guarantees they share a session.
      const kw = transactionKeywords(driver as Dialect);
      const combined = [kw.begin, ...built.statements, kw.commit].join(";\n") + ";";
      try {
        await this.runner.runSql(combined);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        // Best-effort rollback — separate call is fine here: the
        // combined call above already failed/aborted server-side, so
        // there is no "must share a session" requirement left to honor.
        try {
          await this.runner.runSql(kw.rollback);
        } catch {
          // ignore — connection may already be back to a clean state
        }
        this.postMessage({
          type: "saveResult",
          index,
          ok: false,
          errors: [m],
        });
        return;
      }
      // Re-run the original SQL to refresh the grid. Mirrors
      // handleRequery: pickResult() handles both batched (Postgres
      // single SELECT → cursor) and non-batched shapes; `.results[0]`
      // is always undefined for the batched case (A4).
      const refreshed = await this.runner.runSql(r.sql);
      const freshResult = await pickResult(refreshed);
      // Finding 5 (review fix round, cycle T) — `saveResult` MUST be
      // posted before the refreshed `state` message. The webview's
      // `state` handler decides `isReset` off a row-count/columns
      // comparison; on a row-count-changing batch (e.g. Add Row) that
      // branch WIPES editState/undoStack before the (later) saveResult's
      // rowErrors could ever reach clearExceptRowIds to preserve
      // skipped rows' edits. Posting saveResult first lets the webview
      // record rowErrors/preserve-list BEFORE the reset arrives.
      let newStmt: StatementResult | undefined;
      if (freshResult) {
        newStmt = {
          ...r,
          result: freshResult,
          batched: refreshed.batched,
          // Deferred minor (v1.4.1): elapsed ms of the refresh run — was
          // `r.durationMs` (the ORIGINAL query's duration), so the footer
          // showed a stale number after commit.
          durationMs: Date.now() - refreshStart,
        };
      }
      // Surface non-fatal warnings (e.g. per-row missing ctid on
      // postgres no-PK — that row was skipped, others saved) so the
      // user knows exactly which row did NOT save. Without this the
      // webview sees a silent ok:true and the user can't tell which
      // edits were dropped. TASK-006 #4.
      const nonFatalWarnings = built.warnings;
      // A19-skip — skippedRows (per-row "this row was NOT included in
      // the save batch" reasons, e.g. no server row for UPDATE) must
      // travel to the webview as rowErrors so clearExceptRowIds keeps
      // those specific rows dirty instead of the ack wiping ALL dirty
      // state on ok:true.
      const rowErrors = built.skippedRows?.map((s) => ({
        rowId: s.rowId,
        error: s.reason,
      }));
      this.postMessage({
        type: "saveResult",
        index,
        ok: true,
        ...(nonFatalWarnings.length > 0
          ? { warnings: nonFatalWarnings, errors: nonFatalWarnings }
          : {}),
        ...(rowErrors && rowErrors.length > 0 ? { rowErrors } : {}),
      });
      if (newStmt) {
        const next = this.lastResults.slice();
        next[index] = newStmt;
        this.lastResults = next;
        // Sync the runner-internal entry so loadMore(index) reaches the
        // NEW cursor (mirrors handleRequery's adopt() call).
        try {
          this.runner.adopt(r.index, newStmt);
        } catch {
          // adopt is best-effort; loadMore path failure is non-fatal here.
        }
        this.postMessage({
          type: "state",
          header: this.header,
          results: next,
          busy: this.busy,
        });
      }
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
    // FIX R1 critical #3 — close the previous batched cursor before
    // starting a new requery. Postgres pool max=1: a leaked cursor holds
    // the client until close(), blocking the next query with a connect
    // timeout. Best-effort — close() alone is sufficient (Fix R2
    // minor); cancel() was redundant.
    const staleCursor: BatchedQuery | undefined = r.batched;
    if (staleCursor && r.status === "done") {
      try {
        await staleCursor.close();
      } catch {
        // ignore — cursor may already be closed
      }
    }
    const composed = composeRequery(r.sql, where, orderBy);
    this.setBusy(true);
    const start = Date.now();
    try {
      // FIX R2 critical #1 — post `status:"running"` for the statement
      // BEFORE the runSql call. The webview's renderGrid detects a
      // same-statement RESET via
      //   lastResultStatus === "running" && r.status !== "running"
      // Without the running post, equal-row-count requeries (ORDER BY
      // change — the headline use case) take the idempotent no-op
      // branch and the grid stays stale. Row-growing requeries take
      // the append-delta branch and KEEP the OLD prefix.
      const runningEntry: StatementResult = {
        index: r.index,
        sql: r.sql,
        status: "running",
        result: r.result,
        batched: r.batched,
        durationMs: Date.now() - start,
      };
      const runningState = this.lastResults.slice();
      runningState[index] = runningEntry;
      this.lastResults = runningState;
      this.postMessage({
        type: "state",
        header: this.header,
        results: runningState,
        busy: this.busy,
      });
      const runResult = await this.runner.runSql(composed);
      // FIX R1 critical #2 — `refreshed.results[0]` is always undefined
      // when the adapter returns a batched handle (Postgres single
      // SELECT). pickResult() handles both shapes: batched → initial
      // fetchBatch + columns; non-batched → first populated result.
      // Without this the entry swapped to `{ status:"done", result: undefined }`
      // and the grid blanked.
      const freshResult = await pickResult(runResult);
      const next = this.lastResults.slice();
      // Synthesize the new StatementResult. We keep `index`, `sql` (the
      // ORIGINAL — what the user wrote). `batched` is the NEW cursor
      // (mirrors QueryRunner.executeAll behaviour) so loadMore still
      // works.
      const newStmt: StatementResult = {
        index: r.index,
        sql: r.sql,
        status: "done",
        result: freshResult,
        batched: runResult.batched,
        durationMs: Date.now() - start,
      };
      next[index] = newStmt;
      this.lastResults = next;
      // FIX R2 critical #2 — sync the runner-internal entry so that
      // `runner.loadMore(index)` reaches the NEW batched cursor. Without
      // this, the runner still holds the PRE-requery cursor and a
      // subsequent loadMore would fetch OLD rows.
      try {
        this.runner.adopt(r.index, newStmt);
      } catch {
        // adopt is best-effort; loadMore path failure is non-fatal here.
      }
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
          durationMs: Date.now() - start,
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
   * TASK-002 — Postgres no-PK ctid resolution. Iterates every row in the
   * current view and issues a value-match lookup (`WHERE col IS NOT
   * DISTINCT FROM <literal>`) to find that row's ctid. Returns a
   * partial map indexed by rowId (serverRows index) for use by
   * buildSaveStatements to address UPDATE / DELETE statements directly.
   *
   * Identifiers are quoted per dialect (postgres plain); values use
   * sqlLiteral (single-quote doubling, NO backslash escape). Ambiguous
   * rows (multiple matches → ambiguous ctid) are REFUSED — that row is
   * dropped from the map so buildSaveStatements sees a missing ctid and
   * skips it with a warning.
   *
   * Result:
   *   - `{ ok: true, map }` → at least one row's ctid resolved; partial
   *     success is fine — missing keys surface as warnings in build.
   *   - `{ ok: false, reason: "all_failed" }` → NO row resolved (caller
   *     treats this as a hard refusal with the existing banner copy).
   *   - `{ ok: false, reason: "ambiguous_only" }` → only ambiguous
   *     matches (no row produced exactly one match) — caller treats
   *     this as a hard refusal with the existing banner copy.
   */
  private async fetchPostgresCtids(
    tableName: string,
    schema: string | undefined,
    columns: string[],
    serverRows: unknown[][],
    rowIds: number[],
    resolveServerIndex: (rowId: number) => number,
  ): Promise<
    | { ok: true; map: ReadonlyMap<number, string> }
    | { ok: false; reason: "all_failed" | "ambiguous_only" }
  > {
    // A12 — the map MUST be keyed by rowId (the webview's stable id),
    // NOT by the loop index into serverRows. Once rows are added/streamed
    // after the initial page, rowId and serverRows-index diverge; keying
    // by loop index silently attached the wrong row's ctid to a later
    // save. resolveServerIndex(rowId) is the ONLY place serverRows is
    // indexed.
    const map = new Map<number, string>();
    let anySucceeded = false;
    let anyAmbiguous = false;
    // Finding 2 — rows with no resolvable server row (e.g. a stray dirty
    // entry for a rowId that was never actually inserted server-side) are
    // NOT a ctid-lookup failure; they were simply never attempted.
    // buildSaveStatements' own per-row "no server row" check surfaces the
    // right message for them. Only rows that WERE attempted (a server row
    // was found and a lookup actually ran) count towards `all_failed`.
    let anyAttempted = false;
    const qSchema = schema ? quoteIdent(schema, "postgres") : null;
    const qTable = quoteIdent(tableName, "postgres");
    const fullTable = qSchema ? `${qSchema}.${qTable}` : qTable;
    for (const rowId of rowIds) {
      // Finding 6 — the try/catch used to wrap the ENTIRE loop, so a
      // column type with no equality operator (json, xml, point, ...)
      // throwing on ONE row's predicate aborted every remaining row's
      // lookup too, refusing the whole save. Scope the try/catch to a
      // single row's body so one bad probe can't poison the batch.
      try {
        const serverIndex = resolveServerIndex(rowId);
        const row = serverRows[serverIndex];
        if (!row) continue;
        anyAttempted = true;
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
        // A3 — runSql may return a batched (cursor) RunResult for a
        // single-SELECT-no-semicolon query on postgres. pickResult()
        // fetches the initial page from either shape; the batched
        // handle is then closed (best-effort) so the pooled (max:1)
        // connection is released immediately instead of leaking a live
        // cursor that starves every subsequent save/query.
        const res = await this.runner.runSql(sql);
        try {
          const picked = await pickResult(res);
          const rows = picked?.rows ?? [];
          if (rows.length === 1) {
            map.set(rowId, String(rows[0][0]));
            anySucceeded = true;
          } else if (rows.length > 1) {
            // Ambiguous — refuse this row.
            anyAmbiguous = true;
          }
        } finally {
          if (res.batched) {
            try {
              await res.batched.close();
            } catch {
              // best-effort — connection may already be released
            }
          }
        }
      } catch {
        // Best-effort: this row's ctid lookup failed (bad predicate, no
        // equality operator for its column type, etc). Skip it and keep
        // going — it will surface as a per-row warning in
        // buildSaveStatements when its ctid is missing from the map.
      }
    }
    if (anySucceeded) return { ok: true, map };
    if (anyAmbiguous) return { ok: false, reason: "ambiguous_only" };
    if (!anyAttempted) return { ok: true, map };
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

/**
 * A15 — dialect-aware transaction keywords. Postgres/mysql use plain
 * BEGIN/COMMIT/ROLLBACK. MSSQL's plain `BEGIN` is T-SQL BLOCK syntax
 * (BEGIN...END), not a transaction start — it must be `BEGIN
 * TRANSACTION` / `COMMIT TRANSACTION` / `ROLLBACK TRANSACTION`.
 */
function transactionKeywords(
  dialect: Dialect,
): { begin: string; commit: string; rollback: string } {
  if (dialect === "mssql") {
    return {
      begin: "BEGIN TRANSACTION",
      commit: "COMMIT TRANSACTION",
      rollback: "ROLLBACK TRANSACTION",
    };
  }
  return { begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
