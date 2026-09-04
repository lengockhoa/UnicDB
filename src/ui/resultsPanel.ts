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
import type { DbTransaction, QueryResult } from "../adapters/types";
import { pickResult } from "../core/queryRunner";
import type {
  HostMessage,
  StateMessage,
  WebviewMessage,
  ExportFileMessage,
  RequeryMessage,
  RequestDistinctValuesMessage,
} from "./messages";
import type { ConnectionConfig } from "../config/types";
import {
  buildSaveStatements,
  parseFromClause,
  quoteIdent,
  type Dialect,
} from "../core/saveStatements";
import { sqlLiteral, composeRequery } from "./resultsGridModel";
import {
  buildFilterWhere,
  buildOrderByClause,
  buildPagedQuery,
  buildPagedQueryTerms,
  composeSortQuery,
  parseOrderBy,
  type ColumnFilterModel,
  type OrderByTerm,
} from "./queryComposer";
import { composeKeysetQuery, assertBrowseShape } from "./keysetPaging";
import {
  DISTINCT_VALUES_LIMIT,
  buildDistinctValuesQuery,
  takeDistinctValues,
} from "./distinctValues";

/** Page size used when a server-side filter/paging requery omits `limit`
 *  (matches the adapters' DEFAULT_BATCH_SIZE of 500). */
const DEFAULT_PAGE_SIZE = 500;

/**
 * BQ01-001 — narrow `DriverType` → `Dialect`. BigQuery's requery / save /
 * distinct / ORDER-BY path is owned by BQ01-002 (adapter) + future cycles;
 * until then a bigquery driver is treated as "no save-statement dialect",
 * so the panel falls through to the no-dialect rendering branch that
 * already existed for connections without an active driver. The Dialect
 * type itself stays narrow (statementParser / saveStatements don't gain
 * unknown branches).
 */
function toDialect(
  driver: ConnectionConfig["driver"] | null,
): Dialect | null {
  return driver === "bigquery" ? null : driver;
}

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
  /** Whether the active connection uses the explicit manual-commit save flow. */
  getManualCommit?(): boolean;
  /** Return PK columns for the (schema, table) pair via DbAdapter.listColumns. */
  listPkColumns(schema: string, table: string): Promise<string[]>;
  /** TASK-004 — optional: column name → declared DB type
   *  (ColumnInfo.dataType). Absent ⇒ no columnTypes ⇒ cycle-V `(Blanks)`
   *  stays bare `IS NULL`. Resolves to {} on any failure. */
  listColumnTypes?(schema: string, table: string): Promise<Record<string, string>>;
}

export interface ResultsPanelOptions {
  /** QueryRunner instance (để loadMore / cancel). */
  runner: QueryRunner;
  /** View column hint used at CREATE time when `resultsPlacement` is
   *  "beside" (mặc định Beside). Ignored on later show() calls — an existing
   *  panel is revealed without a column so the user's dragged group wins. */
  viewColumn?: vscode.ViewColumn;
  /** AI-001 — "below" (default): newly created panels open in a vertical
   *  split under the active editor; "beside": classic side-by-side; "top"
   *  (R8a, opt-in): vertical split above the active editor. Read fresh
   *  at every panel creation, so dispose+recreate picks up the current
   *  setting (a live panel is never moved). */
  resultsPlacement?: "below" | "beside" | "top";
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
  /** AI-001 — effective placement applied at panel CREATION: "below" opens
   *  a vertical split under the active editor, "beside" is classic
   *  side-by-side, "top" opens a vertical split above the active editor
   *  (R8a opt-in). Null until the next show() CREATE resolves it from the
   *  explicit option or the vsdb.resultsPlacement setting (whitelisted;
   *  unknown → "below") — resolved fresh per creation, never cached, so a
   *  dispose+recreate picks up the latest setting while a LIVE panel is
   *  never moved. */
  private resultsPlacement: "below" | "beside" | "top" | null;
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private header: string = "";
  /** TASK-007 — table identity extracted from a browse header
   *  ("Browse <schema>.<table> at <ISO>", built by browseCommands) and
   *  attached as the per-statement `label` in every outgoing state message
   *  so the webview's result tabs show the table name instead of
   *  "Statement N". Null for non-browse headers (editor runs etc.) — those
   *  keep the generic tab title. */
  private browseLabel: string | null = null;
  private lastResults: StatementResult[] = [];
  private busy: boolean = false;
  /** A session-pinned manual transaction owned by this panel. */
  private transaction: DbTransaction | null = null;
  /** TASK-006 P1-4 — statement index whose save opened the manual window.
   *  The host tracks no active tab, so this recorded index IS "the active
   *  statement": the Commit/Rollback BUTTON paths requery exactly this
   *  statement after the transaction closes (a broadcast refresh of every
   *  lastResults entry was rejected — N extra queries on a pool.max=1
   *  connection). Set when beginTransaction() opens the window, cleared
   *  once consumed. */
  private manualStatementIndex: number | null = null;
  /** Monotonic requery sequence. Each handleRequery increments it and
   *  captures the current value; a completion whose captured seq is stale
   *  (a newer requery already started) drops its result so an out-of-order
   *  slow requery can never overwrite a newer one. */
  private requerySeq = 0;
  /** TASK-ARP02-002 — session epoch. Bumped synchronously in dispose() and
   *  in the onDidDispose handler (both paths can run). Every deferred
   *  continuation captures the epoch before its first await and re-checks
   *  after EVERY await, before any postMessage / setBusy / toast, returning
   *  silently when stale. Without this, a deferred completion that settles
   *  after dispose()+render() posts the OLD results into the RE-CREATED
   *  panel (this.panel is non-null again) and clears the new session's busy
   *  state — postMessage's `if (!this.panel) return` guard does not cover
   *  the re-created panel. Distinct from requerySeq (per-requery ordering)
   *  and statementGeneration (per-statement-set identity): the epoch is
   *  per-PANEL-LIFETIME and checked ADDITIONALLY to both. */
  private sessionEpoch = 0;
  /** Host-derived (schema?, table) per statement index, populated by
   *  render() so handleSaveEdits can derive metadata without trusting the
   *  webview-supplied tableName / pkColumns (Fix R1 critical #1). */
  private tableByStatement: Map<number, { schema?: string; table: string }> =
    new Map();
  /** TASK-004 — cached DISTINCT-values replies keyed by `${index}::${column}`.
   *  Cleared wholesale in render(): a new result set invalidates every
   *  dropdown list. Populated only by completed, non-stale requests. */
  private distinctCache: Map<string, { values: unknown[]; truncated: boolean }> =
    new Map();
  /** TASK-004 — statement identity generation. Incremented in render() (and
   *  when a requery replaces a statement) so an in-flight DISTINCT response
   *  for a replaced statement can be detected and dropped: its captured
   *  generation no longer matches, and its index may even point at a
   *  different statement. Mirrors the requerySeq stale guard. */
  private statementGeneration = 0;
  /** TASK-007 (cycle Y) — per-statement POSITIONAL declared-type maps
   *  (statement index → {numeric-string ordinal → dataType}). Cleared in
   *  render(); filled only for gate-passing statements via
   *  SaveContext.listColumnTypes. */
  private columnTypesByStatement: Map<number, Record<string, string>> =
    new Map();
  /** TASK-006 (cycle Y) — SOURCE state a distinct request rebuilds its WHERE
   *  from, keyed by statement index like distinctCache. Written in
   *  handleRequery where msg.where (the free-form requery bar) and
   *  msg.filters (structured set-filter model) are already in hand and the
   *  typed columnTypes are resolved. NOT the final combined WHERE string —
   *  that would bake in the requested column's own predicate, which must be
   *  excludable on a distinct request for that column. Cleared in render()
   *  alongside distinctCache; when absent, handleRequestDistinctValues keeps
   *  today's `where=""` byte-identical behaviour. */
  private whereByStatement: Map<
    number,
    { barWhere: string; filters: ColumnFilterModel; columnTypes?: Record<string, string> }
  > = new Map();

  constructor(options: ResultsPanelOptions) {
    this.runner = options.runner;
    this.saveContext = options.saveContext ?? null;
    this.viewColumn = options.viewColumn ?? vscode.ViewColumn.Beside;
    this.title = options.title ?? "VSDB Results";
    this.resultsPlacement = options.resultsPlacement ?? null;
  }

  /**
   * AI-001 — đọc setting `vsdb.resultsPlacement` ("below" | "beside" | "top")
   * lúc CREATE panel. Whitelist: giá trị lạ → "below", không bao giờ
   * throw (partial vscode mock / host lạ cũng an toàn). Không cache —
   * dispose + recreate áp dụng setting mới nhất; panel đang sống thì
   * KHÔNG bao giờ bị di chuyển.
   *
   * TASK-UX1-006 (R8a) — `top` is the new opt-in value. The default-config
   * first-open still lands at `below` (R8a's P2.5 YAGNI guard) — only an
   * explicit `vsdb.resultsPlacement: "top"` flips the panel up.
   */
  private static readPlacementSetting(): "below" | "beside" | "top" {
    try {
      const workspace = vscode.workspace as unknown;
      if (
        !workspace ||
        typeof workspace !== "object" ||
        !("getConfiguration" in workspace) ||
        typeof workspace.getConfiguration !== "function"
      ) {
        return "below";
      }
      const cfg = workspace.getConfiguration("vsdb");
      if (!cfg || typeof cfg !== "object" || !("get" in cfg)) {
        return "below";
      }
      const raw: unknown = cfg.get("resultsPlacement", "below");
      if (raw === "beside") return "beside";
      if (raw === "top") return "top";
      return "below";
    } catch {
      return "below";
    }
  }

  /** AI-001 — partial vscode mock / host lạ có thể không export `commands`;
   *  move-below là enhancement placement, không bao giờ được phép crash
   *  việc mở panel. */
  private static canExecuteCommands(): boolean {
    try {
      const commands = vscode.commands as unknown;
      return (
        !!commands &&
        typeof commands === "object" &&
        "executeCommand" in commands &&
        typeof commands.executeCommand === "function"
      );
    } catch {
      return false;
    }
  }

  /**
   * Hiện (hoặc tạo) panel. TÁI SỬ DỤNG panel cũ nếu còn mở.
   */
  show(): void {
    if (this.panel) {
      // AI-001 — reveal() KHÔNG kèm column: giữ nguyên group người dùng đã
      // kéo panel tới, không bao giờ ép panel về column cấu hình.
      this.panel.reveal();
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
    const placement =
      this.resultsPlacement ?? ResultsPanel.readPlacementSetting();
    if (placement !== "beside" && ResultsPanel.canExecuteCommands()) {
      // AI-001 — ViewColumn không có "Below"/"Above" trong VS Code API, nên
      // vị trí "dưới/trên editor" (vertical split) được đặt bằng lệnh
      // built-in: panel vừa tạo đang active → moveEditorToBelowGroup /
      // moveEditorToAboveGroup chuyển nó vào group NGAY DƯỚI / TRÊN editor.
      // Chỉ chạy lúc CREATE — panel sống lại (reveal) và panel "beside"
      // không bao giờ bị di chuyển.
      //
      // TASK-UX1-006 (R8a) — `top` was added in this cycle. The
      // moveEditorToAboveGroup command is NOT guaranteed across VS Code
      // versions (similar to its `Below` sibling, which we also guard via
      // canExecuteCommands). On the rare hosts that lack it the placement
      // degrades silently: no executeCommand call is made, the panel
      // stays where `createWebviewPanel` put it (Beside), and the user is
      // not interrupted.
      const cmd =
        placement === "top"
          ? "workbench.action.moveEditorToAboveGroup"
          : "workbench.action.moveEditorToBelowGroup";
      void vscode.commands.executeCommand(cmd);
    }
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    // Listen messages từ webview.
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg)),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        // TASK-ARP02-002 — the webview session ended: in-flight deferred
        // continuations must never write to a LATER panel session.
        this.sessionEpoch += 1;
        // Closing the webview is a connection lifecycle boundary for its
        // manual transaction. Do not leave an open transaction behind.
        void this.rollbackOpenTransaction();
        this.panel = null;
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
      }),
    );
  }

  /**
   * Render results mới vào panel. Nếu panel chưa mở → show().
   */
  render(
    results: StatementResult[],
    header: string,
    opts?: { appendBase?: number },
  ): void {
    // A14 — this.header was never assigned, so every later post (loadMore,
    // requery, saveEdits refresh, ready) sent an empty header and the query
    // duration/title was always blank.
    this.header = header;
    // TASK-007 — browse headers carry the table identity; mine it once per
    // render so every later state post (loadMore / requery / save refresh /
    // ready) re-applies the same label without the caller threading it.
    const browseMatch = /^Browse (.+) at /.exec(header);
    this.browseLabel = browseMatch ? browseMatch[1] : null;
    this.lastResults = results;

    const appendBase = opts?.appendBase;
    const appendAware = typeof appendBase === "number" && appendBase >= 0;
    // An append render only has new statement slots when appendBase falls
    // inside the displayed array. At the edge (or beyond it), no statement
    // identity changed, so in-flight metadata requests remain valid too.
    const hasNewEntries = appendAware && appendBase < results.length;

    if (!appendAware) {
      // TASK-004 — new statement set: every cached DISTINCT list is stale and
      // every in-flight DISTINCT response must be dropped on arrival.
      this.distinctCache.clear();
      this.statementGeneration += 1;
      // TASK-004 (cycle Y) — a fresh render invalidates the recorded manual
      // window's statement index: the slot it pointed at now belongs to an
      // unrelated statement, and a later Commit/Rollback must not requery it.
      this.manualStatementIndex = null;
      this.tableByStatement.clear();
      this.columnTypesByStatement.clear();
      this.whereByStatement.clear();
    } else {
      // Preserve all old-tab caches, dropping only entries whose statement
      // slots belong to the appended portion of the accumulated array.
      if (hasNewEntries) {
        for (const key of this.distinctCache.keys()) {
          const separator = key.indexOf("::");
          const index = Number(separator < 0 ? key : key.slice(0, separator));
          if (Number.isInteger(index) && index >= appendBase) {
            this.distinctCache.delete(key);
          }
        }
        for (const index of this.columnTypesByStatement.keys()) {
          if (index >= appendBase) this.columnTypesByStatement.delete(index);
        }
        for (const index of this.whereByStatement.keys()) {
          if (index >= appendBase) this.whereByStatement.delete(index);
        }
        for (const index of this.tableByStatement.keys()) {
          if (index >= appendBase) this.tableByStatement.delete(index);
        }
        // Drop in-flight DISTINCT responses for replaced/new statement slots;
        // old-tab responses remain valid against their preserved identities.
        this.statementGeneration += 1;
      }
      if (
        this.manualStatementIndex !== null &&
        this.manualStatementIndex >= appendBase
      ) {
        this.manualStatementIndex = null;
      }
    }

    // Derive (schema?, table) per statement FROM the parsed SQL — host-side
    // truth. The webview's tableName/pkColumns message is IGNORED (Fix R1
    // critical #1). Statements whose SQL has no FROM/INSERT/UPDATE have no
    // addressable table and trigger a hard refusal.
    for (const r of results) {
      const parsed = parseFromClause(r.sql);
      if (
        parsed &&
        (!appendAware || r.index >= appendBase || !this.tableByStatement.has(r.index))
      ) {
        this.tableByStatement.set(r.index, parsed);
      }
    }
    // TASK-007 (cycle Y) — resolve only new entries during append renders;
    // preserved old entries already have valid declared-type maps.
    const metadataResults = appendAware
      ? results.filter((r) => r.index >= appendBase)
      : results;
    void this.refreshColumnTypes(metadataResults);
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
    // TASK-ARP02-002 — end this panel session BEFORE any deferred work can
    // observe teardown: every continuation that captured the previous epoch
    // becomes inert from this synchronous point on.
    this.sessionEpoch += 1;
    // A panel may be disposed while a manual transaction is still open.
    // Fire-and-forget because VS Code's Disposable contract is synchronous;
    // the adapter call is still attempted before connection teardown.
    void this.rollbackOpenTransaction();
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

  /**
   * TASK-ARP02-002 — true when `captured` no longer matches the live epoch,
   * i.e. the panel was disposed (or its webview was closed) after this
   * continuation started. Stale continuations must return silently: no
   * postMessage, no setBusy, no toast — even if a NEWER panel session has
   * since been created by render().
   */
  private isStaleSession(captured: number): boolean {
    return captured !== this.sessionEpoch;
  }

  /**
   * TASK-007 — attach the browse-derived tab label to a statement that does
   * not carry one. `sanitizeStatementResult` spreads the result, so the
   * label survives sanitization; statements that already have a `label`
   * (even an explicit empty one) are passed through untouched.
   */
  private withBrowseLabel(r: StatementResult): StatementResult {
    if (!this.browseLabel || r.label !== undefined) return r;
    return { ...r, label: this.browseLabel };
  }

  private postMessage(msg: HostMessage): void {
    if (!this.panel) return;
    // IMPORTANT #5 (fix round 1): sanitize rows trước khi postMessage.
    // webview.postMessage dùng structured clone — THROWs trên BigInt.
    let payload: HostMessage = msg;
    if (msg.type === "state") {
      payload = {
        ...msg,
        results: msg.results.map((r) =>
          sanitizeStatementResult(this.withBrowseLabel(r)) as unknown as StatementResult,
        ),
      };
      // TASK-007 (cycle Y) — typed dialect + declared columnTypes ride on
      // EVERY state post here, so all 11 post sites inherit the fields
      // through this single interception point. Sanitize already produced a
      // fresh object, so mutating `payload` never aliases a caller's literal.
      this.decorateStateMessage(payload);
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

  private isManualCommitEnabled(): boolean {
    return this.saveContext?.getManualCommit?.() === true;
  }

  /**
   * TASK-007 (cycle Y) — ONE private helper every `state` post flows through
   * (all 11 post sites funnel into postMessage). Fills `dialect` from the
   * live connection; when there is none the key stays ABSENT so the webview
   * falls back to legacy header-string parsing rather than trusting an
   * invented value. Declared types travel positionally only under the strict
   * conditions spelled out on `columnTypes` (see refreshColumnTypes): a
   * single-statement message whose cached map matches the CURRENT displayed
   * projection exactly — otherwise the key is omitted entirely.
   */
  private decorateStateMessage(msg: StateMessage): void {
    const dialect = toDialect(this.saveContext?.getDriver() ?? null);
    if (dialect) {
      msg.dialect = dialect;
    }
    // Only an UNAMBIGUOUS message may carry a positional map: with several
    // statements in flight, one flat {ordinal → type} record cannot say
    // WHICH statement it describes, so it stays off (webview keeps sample
    // inference for multi-statement runs).
    if (msg.results.length !== 1) return;
    const stmt = msg.results[0];
    const byOrdinal =
      stmt === undefined
        ? undefined
        : this.columnTypesByStatement.get(stmt.index);
    const columns = stmt?.result?.columns;
    if (!byOrdinal || !columns) return;
    // Ordinal alignment must hold against the LIVE displayed projection —
    // e.g. TASK-004's widening lane strips injected hidden PK columns right
    // after a requery, changing positions relative to the fill-time cache.
    if (Object.keys(byOrdinal).length !== columns.length) return;
    msg.columnTypes = byOrdinal;
  }

  /**
   * TASK-007 (cycle Y) — resolve declared DB types for gate-passing
   * statements and remember them POSITIONALLY (ordinal → dataType) so a
   * duplicated output column name can never mislabel its twin's values.
   *
   * Armed ONLY when BOTH provenance gates hold for the statement:
   *   1. `tableByStatement` parsed a concrete (schema?, table) FROM target,
   *   2. `assertBrowseShape` accepts the statement as a plain
   *      single-table projection (no DISTINCT/aggregates/joins/expressions),
   * so the output columns ARE the table's own columns in the projected
   * order. Anything else — and any listColumnTypes rejection — simply leaves
   * the statement uncached (⇒ key omitted on the wire, sampled inference).
   *
   * `render()` clears the cache and fires this WITHOUT awaiting (render is
   * synchronous inside runner.onUpdate); the generation guard mirrors the
   * DISTINCT lane: a fill landing after a newer render/requery-worth of
   * state is dropped. When fresh maps land they re-post the current state so
   * the webview upgrades classification without user action.
   */
  private async refreshColumnTypes(results: StatementResult[]): Promise<void> {
    const listColumnTypes = this.saveContext?.listColumnTypes;
    if (!listColumnTypes) return;
    const gen = this.statementGeneration;
    // TASK-ARP02-002 — checked ADDITIONALLY to the generation guard: a
    // generation can survive while the panel session it belonged to is gone.
    const epoch = this.sessionEpoch;
    for (const r of results) {
      if (gen !== this.statementGeneration) return;
      const meta = this.tableByStatement.get(r.index);
      if (!meta || assertBrowseShape(r.sql) === null) continue;
      try {
        const byName = await listColumnTypes(meta.schema ?? "", meta.table);
        if (gen !== this.statementGeneration) return;
        const columns = r.result?.columns ?? [];
        if (columns.length === 0) continue;
        const positional: Record<string, string> = {};
        let complete = true;
        for (let i = 0; i < columns.length; i++) {
          const t = byName[columns[i]!];
          // A projected column with no known declared type makes ANY
          // positional claim unreliable ⇒ refuse rather than partially label.
          if (!t) {
            complete = false;
            break;
          }
          positional[String(i)] = t;
        }
        if (!complete) continue;
        this.columnTypesByStatement.set(r.index, positional);
      } catch {
        // Metadata unavailable ⇒ no map for this statement; not fatal.
      }
    }
    if (
      gen === this.statementGeneration &&
      !this.isStaleSession(epoch) &&
      this.columnTypesByStatement.size > 0 &&
      this.panel
    ) {
      // Fresh declared types arrived — re-post so the live grid upgrades.
      this.postMessage({
        type: "state",
        header: this.header,
        results: this.lastResults,
        busy: this.busy,
      });
    }
  }

  private postTransactionStatus(): void {
    this.postMessage({ type: "transactionStatus", open: this.transaction !== null });
  }

  /** Roll back the active manual transaction, including during panel teardown.
   *  TASK-006 P1-4 — `fromMessage: true` (the webview's Rollback BUTTON)
   *  also requeries the manual window's statement; the two teardown callers
   *  (`onDidDispose`, `dispose`) must NOT issue further queries — the
   *  connection may already be tearing down and no UI remains to update.
   *  TASK-ARP02-002 — the rollback itself ALWAYS runs (connection-lifecycle
   *  boundary, never skipped for a newer session), but the `transactionStatus`
   *  UI write is epoch-guarded: teardown callers bump the epoch before this
   *  runs, so their captured epoch is stale by the time the rollback settles
   *  and the post is suppressed (no write into a re-created panel). */
  private async rollbackOpenTransaction(options?: {
    fromMessage?: boolean;
  }): Promise<void> {
    const epoch = this.sessionEpoch;
    const transaction = this.transaction;
    if (!transaction) return;
    // Clear first so every error and teardown path has an honest local state.
    this.transaction = null;
    try {
      await transaction.rollback();
    } catch {
      // The connection may already have been closed by its owner.
    } finally {
      if (!this.isStaleSession(epoch)) {
        this.postTransactionStatus();
      }
      if (options?.fromMessage) {
        // P1-4 — after the rollback lands, the grid still shows the
        // uncommitted values; requery the manual window's statement.
        await this.refreshManualStatement();
      }
    }
  }

  /** TASK-006 P1-4 — requery the manual window's statement after the
   *  transaction closed (Commit/Rollback BUTTON paths only — never the
   *  teardown rollback). The webview has no hook for button clicks (unlike
   *  saveResult.ok → auto-requery), so without this the grid keeps showing
   *  rolled-back rows. Mirrors the non-manual save refresh: runSql(r.sql)
   *  → pickResult → new StatementResult → lastResults swap → adopt → one
   *  `state` post. Transaction is already closed, so the plain runner path
   *  is correct (no pinned session to route through). Best-effort: a failed
   *  refresh is surfaced as a host notification, never rethrows. */
  private async refreshManualStatement(): Promise<void> {
    const epoch = this.sessionEpoch;
    const index = this.manualStatementIndex;
    this.manualStatementIndex = null;
    if (index === null) return;
    const r = this.lastResults[index];
    if (!r || !r.result) return;
    const start = Date.now();
    try {
      // Close the statement's cursor first (P1-1/P1-5 ordering): the requery
      // SELECT itself opens a cursor on the same max=1 pool.
      await this.closeStatementCursor(r);
      const refreshed = await this.runner.runSql(r.sql);
      const freshResult = await pickResult(refreshed);
      if (!freshResult || this.isStaleSession(epoch)) return;
      // TASK-ARP03-003 (leak pin) — strip the budget markers before the
      // spread: copying `resultLimited`/`cursorClosed` onto a statement whose
      // cursor is NEW and open would gate a later loadMore forever (the
      // runner's limited-entry guard) and exclude the fresh cursor from
      // run()'s stale-cursor sweep — pinning the pool client. Destructuring
      // leaves both fields undefined (falsy) on the fresh statement.
      // handleRequery builds fresh without `...r` and is the correct model.
      const { resultLimited, cursorClosed, ...rest } = r;
      const newStmt: StatementResult = {
        ...rest,
        result: freshResult,
        batched: refreshed.batched,
        durationMs: Date.now() - start,
      };
      const next = this.lastResults.slice();
      next[index] = newStmt;
      this.lastResults = next;
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
    } catch (err) {
      if (this.isStaleSession(epoch)) return;
      const m = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `VSDB: refreshing after transaction close failed: ${m}`,
      );
    }
  }

  private async handleCommitTransaction(): Promise<void> {
    const epoch = this.sessionEpoch;
    const transaction = this.transaction;
    if (!transaction) return;
    this.setBusy(true);
    try {
      await transaction.commit();
      this.transaction = null;
      if (!this.isStaleSession(epoch)) {
        this.postTransactionStatus();
      }
      // P1-4 — button-path refresh: the webview has no auto-requery hook
      // for a manual COMMIT click, so the grid would stay stale.
      await this.refreshManualStatement();
    } catch (err) {
      // A failed COMMIT must not leave an ambiguous manual window open.
      this.transaction = null;
      try {
        await transaction.rollback();
      } catch {
        // The connection may already be unusable after a failed commit.
      }
      if (!this.isStaleSession(epoch)) {
        this.postTransactionStatus();
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Commit failed: ${message}`);
      }
    } finally {
      // TASK-ARP02-002 — clear busy only for the session that started it.
      if (!this.isStaleSession(epoch)) {
        this.setBusy(false);
      }
    }
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "loadMore": {
        // TASK-ARP02-002 — capture the session epoch before the first await;
        // re-check after EVERY await so a continuation that outlives the
        // panel (dispose mid-run) never posts into a re-created session.
        const epoch = this.sessionEpoch;
        const stmt = this.lastResults[msg.index];
        // TASK-BQ03-004 — token-less / closed-cursor statements have NO
        // continuation capability (BigQuery token-less final page: the
        // handle is `false`; a closed-cursor post-budget/EOF statement:
        // `cursorClosed: true`). The panel-level gate makes loadMore a
        // SILENT no-op for these: do not call the runner (it would throw
        // "no batched cursor" / "cursor closed after its run finished"),
        // do not flip the busy flag, do not toast — just re-post the
        // current state so the webview clears any in-flight UI flag it
        // may have set. Mirrors the cancel-suppression shape; distinct
        // from the ARP03-003 limited-only catch path (which only fires
        // when the runner is actually called).
        // The `batched` field is typed `BatchedQuery | undefined` on the
        // base StatementResult; BigQuery's token-less sentinel is `false`
        // (a planned 03.3 widening — the panel reads both shapes without
        // re-deriving a boolean from the handle's truthiness).
        const batchedField = stmt?.batched as unknown;
        const noContinuation =
          !stmt ||
          batchedField === false ||
          stmt.cursorClosed === true;
        if (noContinuation) {
          this.postMessage({
            type: "state",
            header: this.header,
            results: this.lastResults,
            busy: this.busy,
          });
          break;
        }
        // TASK-BQ03-004 — capture the statement generation BEFORE the
        // first await. A render()/requery() that lands while the loadMore
        // is in flight bumps statementGeneration; the stale completion
        // then must NOT overwrite the newer lastResults (mirrors the
        // requerySeq guard in handleRequery).
        const generation = this.statementGeneration;
        // Mark busy TRƯỚC await để webview enable Cancel button ngay khi batch
        // bắt đầu fetch qua mạng. finally đảm bảo busy:false kể cả khi reject,
        // tránh kẹt disable vĩnh viễn.
        this.setBusy(true);
        // TASK-ARP03-003 — capture the limited marker BEFORE the await:
        // a budget-limited statement is a graceful no-op in the runner
        // (queryRunner.ts loadMoreImpl), so a rejection here is
        // stale/defensive and must NOT surface as "Load more failed" —
        // the limit is neither an error nor a false EOF. Mirrors the
        // cancel branch below.
        const limited = stmt.resultLimited === true;
        try {
          const updated = await this.runner.loadMore(msg.index);
          if (this.isStaleSession(epoch)) break;
          if (generation !== this.statementGeneration) break;
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
          // TASK-ARP03-003 — a limited statement suppresses the toast the
          // same way: no "Load more failed" for a budget close.
          const cancelled = this.runner.isCancelled?.() === true ||
            /cancel/i.test(err instanceof Error ? err.message : String(err));
          if (
            !cancelled &&
            !limited &&
            !this.isStaleSession(epoch) &&
            generation === this.statementGeneration
          ) {
            void vscode.window.showErrorMessage(
              `Load more failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (
            !this.isStaleSession(epoch) &&
            generation === this.statementGeneration
          ) {
            this.postMessage({
              type: "state",
              header: this.header,
              results: this.lastResults,
              busy: this.busy,
            });
          }
        } finally {
          // TASK-ARP02-002 — the stale session's finally must not clear a
          // NEWER session's busy flag (case 5).
          if (
            !this.isStaleSession(epoch) &&
            generation === this.statementGeneration
          ) {
            this.setBusy(false);
          }
        }
        break;
      }
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
      case "retryFailedRows":
        await this.handleRetryFailedRows(
          msg.index,
          msg.rowIds,
          msg.edits,
          msg.serverIndexByRowId,
        );
        break;
      case "requery":
        await this.handleRequery(msg);
        break;
      case "requestDistinctValues":
        await this.handleRequestDistinctValues(msg);
        break;
      case "commitTransaction":
        await this.handleCommitTransaction();
        break;
      case "rollbackTransaction":
        await this.rollbackOpenTransaction({ fromMessage: true });
        break;
      case "ready":
        // Send initial state khi webview ready.
        this.postMessage({
          type: "state",
          header: this.header,
          results: this.lastResults,
          busy: this.busy,
        });
        this.postTransactionStatus();
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
    // TASK-ARP02-002 — export dialogs/writes outlive the click; the failure
    // toast must not fire for a session that no longer exists.
    const epoch = this.sessionEpoch;
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
      if (this.isStaleSession(epoch)) return;
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
    // TASK-006 P1-1 — close the statement's browse cursor BEFORE the first
    // metadata/ctid await. `saveContext.listPkColumns` (right below),
    // `fetchPostgresCtids`, and `listColumnTypes` all go through the same
    // pooled client; on Postgres/MySQL (pool max=1) the live cursor holds
    // that only client, so an aux SELECT would wait on pool.connect() until
    // the connection timeout. Idempotent with the later manual-branch close
    // and the refresh path's displaced-cursor close (P1-5). The audit's
    // rejected alternative — a `runSql(sql, { noCursor: true })` protocol
    // option — would change QueryRunner + all three adapters (out of scope).
    // TASK-ARP02-002 (fix round 1) — capture the epoch ONCE before the first
    // await. The previous `isStaleSession(this.sessionEpoch)` checks re-read
    // the CURRENT epoch (always equal to itself — a no-op that could never
    // fire), so a dispose during the cursor close / listPkColumns await left
    // the save running and posted stale acks into a re-created panel.
    const epoch = this.sessionEpoch;
    await this.closeStatementCursor(r);
    // TASK-ARP02-002 — disposed while closing the cursor: return silently,
    // no pkColumns query, no saveResult ack into a later panel session.
    if (this.isStaleSession(epoch)) return;
    const pkColumns =
      edits.length === 0
        ? []
        : await this.saveContext.listPkColumns(parsed.schema ?? "", tableName);
    if (this.isStaleSession(epoch)) return;

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
        // TASK-ARP02-002 (fix round 1) — post-await ack: a dispose during the
        // ctid lookup must not post a refusal into a re-created panel.
        if (!this.isStaleSession(epoch)) {
          this.postMessage({
            type: "saveResult",
            index,
            ok: false,
            refused: true,
            reason,
            errors: [reason],
          });
        }
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
      // TASK-ARP02-002 (fix round 1) — post-await ack (listPkColumns await
      // above): stale sessions stay silent.
      if (!this.isStaleSession(epoch)) {
        this.postMessage({
          type: "saveResult",
          index,
          ok: false,
          refused: true,
          reason,
          errors: built.warnings,
        });
      }
      return;
    }

    // Critical #3: edits present but every statement was skipped →
    // ack ok:false with warnings. Never silent ok:true.
    if (built.statements.length === 0 && edits.length > 0) {
      const errText =
        built.warnings.length > 0
          ? built.warnings.join(" ")
          : "Save produced no statements (every row was skipped).";
      // TASK-ARP02-002 (fix round 1) — post-await ack: stale sessions stay
      // silent.
      if (!this.isStaleSession(epoch)) {
        this.postMessage({
          type: "saveResult",
          index,
          ok: false,
          refused: true,
          reason: errText,
          errors: built.warnings,
        });
      }
      return;
    }

    // Empty edits → no-op success (webview's dirtyCount gate should
    // already have prevented this, but be defensive).
    if (built.statements.length === 0) {
      // TASK-ARP02-002 (fix round 1) — post-await ack: stale sessions stay
      // silent.
      if (!this.isStaleSession(epoch)) {
        this.postMessage({ type: "saveResult", index, ok: true });
      }
      return;
    }

    // TASK-ARP02-002 (fix round 1) — setBusy is a UI write after the
    // listPkColumns / ctid-lookup awaits: a stale session must not flip a
    // re-created panel's busy flag (mirrors the stale finally's guard).
    if (this.isStaleSession(epoch)) return;
    this.setBusy(true);
    // TASK-ARP02-002 — the save continuation awaits beginTransaction / runSql
    // / refresh SELECT; a dispose mid-save must not post acks, toasts, or
    // busy writes into a re-created panel session. The epoch itself is
    // captured ONCE at the top of this flow (before the first await).
    const refreshStart = Date.now();
    const kw = transactionKeywords(driver as Dialect);
    const manualCommit = this.isManualCommitEnabled();
    try {
      if (manualCommit) {
        // TASK-009 manual-commit mode — the manual transaction owns the
        // pooled client for the whole window (Postgres pool.max=1). Every
        // save statement runs through the pinned DbTransaction so all
        // statements share ONE server session. This is the R1 fix: the old
        // path issued BEGIN via a pooled runSql call whose client was then
        // released, so the post-save requery landed on a DIFFERENT client
        // and Postgres rejected it with "cannot run inside a transaction
        // block", silently rolling back the successful save. Close any open
        // browse cursor FIRST — with pool.max=1 the cursor holds the only
        // client, so beginTransaction() would deadlock waiting for it.
        if (!this.transaction) {
          await this.closeStatementCursor(r);
          this.transaction = await this.runner.beginTransaction();
          this.manualStatementIndex = index;
        }
        try {
          await this.transaction.runQuery(built.statements.join(";\n") + ";");
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          // Explicit invariant: rollback completes before the save error is
          // acknowledged, so a failed manual window is never left dangling.
          await this.rollbackOpenTransaction();
          if (!this.isStaleSession(epoch)) {
            this.postMessage({
              type: "saveResult",
              index,
              ok: false,
              errors: [m],
            });
          }
          return;
        }
        if (!this.isStaleSession(epoch)) {
          this.postTransactionStatus();
        }
      } else {
        // Automatic mode — A15: bundle BEGIN + every generated statement +
        // COMMIT into a SINGLE combined runner.runSql call. The adapter
        // contract does NOT guarantee session/connection affinity across
        // separate calls (a fresh call may land on a different pooled
        // connection), so issuing BEGIN and the statements as separate calls
        // made the "transaction" meaningless — a mid-batch failure could not
        // be rolled back because later statements might already be committed
        // autocommit-style on their own connection. Bundling into one call
        // guarantees they share a session.
        try {
          await this.runner.runSql([kw.begin, ...built.statements, kw.commit].join(";\n") + ";");
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          // Best-effort rollback for the pre-existing automatic flow.
          try {
            await this.runner.runSql(kw.rollback);
          } catch {
            // The combined call may already have returned the connection clean.
          }
          if (!this.isStaleSession(epoch)) {
            this.postMessage({
              type: "saveResult",
              index,
              ok: false,
              errors: [m],
            });
          }
          return;
        }
      }
      // Automatic mode only — refresh the grid from server truth. In manual
      // mode the refresh is left to the webview's auto-requery (fires on
      // saveResult ok), which routes through handleRequery → this.transaction
      // so it shares the pinned session instead of deadlocking on
      // pool.connect(). Computed BEFORE the saveResult ack so the ack and the
      // refreshed state land back-to-back: a state posted after separate
      // awaits could race the ack (an observer seeing the ack alone would
      // miss the fresh rows). Mirrors handleRequery: pickResult() handles
      // both batched (Postgres single SELECT → cursor) and non-batched
      // shapes; `.results[0]` is always undefined for the batched case (A4).
      let newStmt: StatementResult | undefined;
      if (!manualCommit) {
        // TASK-006 P1-5 — close the pre-save cursor before the refresh
        // SELECT. `r.sql` is the original browse SELECT; routed to a cursor
        // (postgres single-SELECT), a second pool.connect() on max=1 would
        // stall behind the still-open `r.batched`. Mirrors the manual branch
        // (close before beginTransaction) and handleRequery (:1085). Double
        // close is idempotent (postgres.ts) and `adopt()` below also closes
        // the displaced cursor best-effort.
        await this.closeStatementCursor(r);
        const refreshed = await this.runner.runSql(r.sql);
        const freshResult = await pickResult(refreshed);
        if (this.isStaleSession(epoch)) {
          // Dispose mid-save: skip the ack/state posts entirely (finally
          // below also skips the busy write). The commit itself already ran.
          return;
        }
        if (freshResult) {
          // TASK-ARP03-003 (leak pin) — strip the budget markers before the
          // spread (see refreshManualStatement): a NEW open cursor must not
          // inherit `resultLimited`/`cursorClosed` from the displaced
          // statement, or loadMore no-ops on a healthy cursor and the fresh
          // cursor escapes run()'s stale sweep. handleRequery (fresh object,
          // no `...r`) is the correct model — do not "fix" it.
          const { resultLimited, cursorClosed, ...rest } = r;
          newStmt = {
            ...rest,
            result: freshResult,
            batched: refreshed.batched,
            // Deferred minor (v1.4.1): elapsed ms of the refresh run — was
            // `r.durationMs` (the ORIGINAL query's duration), so the footer
            // showed a stale number after commit.
            durationMs: Date.now() - refreshStart,
          };
        }
      }
      // Finding 5 (review fix round, cycle T) — `saveResult` MUST be
      // posted before the refreshed `state` message. The webview's
      // `state` handler decides `isReset` off a row-count/columns
      // comparison; on a row-count-changing batch (e.g. Add Row) that
      // branch WIPES editState/undoStack before the (later) saveResult's
      // rowErrors could ever reach clearExceptRowIds to preserve
      // skipped rows' edits. Posting saveResult first lets the webview
      // record rowErrors/preserve-list BEFORE the reset arrives.
      //
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
      // TASK-ARP02-002 (fix round 1) — the success ack is posted after the
      // manual tx.runQuery (or the auto BEGIN/…/COMMIT + refresh) await. The
      // auto-mode refresh path had its own guard (:1210 old numbering), but
      // in MANUAL-commit mode this ack was reached UNguarded — a dispose
      // during runQuery posted ok:true into a re-created panel session.
      if (!this.isStaleSession(epoch)) {
        this.postMessage({
          type: "saveResult",
          index,
          ok: true,
          ...(nonFatalWarnings.length > 0
            ? { warnings: nonFatalWarnings, errors: nonFatalWarnings }
            : {}),
          ...(rowErrors && rowErrors.length > 0 ? { rowErrors } : {}),
        });
      }
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
    } catch (err) {
      // An unexpected error while a manual window is open (e.g. the webview
      // auto-requery raced a commit, or beginTransaction() failed because the
      // active driver has no manual-transaction support). Roll back so the
      // window never dangles, then surface the save failure to the webview.
      if (this.isStaleSession(epoch)) {
        // TASK-ARP02-002 — the rollback in the manual branch below still ran
        // via rollbackOpenTransaction's own path; UI acks stay suppressed.
        if (manualCommit) await this.rollbackOpenTransaction();
        return;
      }
      if (manualCommit) {
        const message = err instanceof Error ? err.message : String(err);
        await this.rollbackOpenTransaction();
        this.postMessage({
          type: "saveResult",
          index,
          ok: false,
          errors: [message],
        });
      } else {
        // TASK-004 (cycle Y) — a failure AFTER the combined transaction
        // committed (in practice: the post-commit refresh SELECT throwing)
        // must not reject out of the un-awaited handleMessage() promise as
        // an unhandled rejection with NO ack at all. The COMMIT itself
        // succeeded, so the honest outcome is ok:true plus the refresh
        // error surfaced as a warning; the grid keeps its previous rows.
        const message = err instanceof Error ? err.message : String(err);
        this.postMessage({
          type: "saveResult",
          index,
          ok: true,
          warnings: [message],
          errors: [message],
        });
      }
    } finally {
      // TASK-ARP02-002 — the stale session's finally must not clear a
      // newer session's busy flag.
      if (!this.isStaleSession(epoch)) {
        this.setBusy(false);
      }
    }
  }

  /**
   * TASK-005 / A19 — "Retry failed rows". The webview clicked the banner's
   * retry button after a partial save failure; `edits` carries only the
   * failed rows' still-dirty entries (successful rows were cleared by the
   * webview's clearExceptRowIds on the rowErrors ack). The host
   * defensively re-filters `edits` against `rowIds` (the webview is
   * semi-trusted) and runs the subset through the SAME save pipeline as
   * saveEdits — host-derived table + PK, single combined transaction,
   * saveResult ack, post-save refresh. An empty subset (stale or malformed
   * message) is a silent no-op: nothing to run, nothing to ack.
   */
  private async handleRetryFailedRows(
    index: number,
    rowIds: number[],
    edits: Array<{ rowId: number; colIndex: number; value: unknown }>,
    serverIndexByRowId?: Record<string, number>,
  ): Promise<void> {
    const allow = new Set(rowIds);
    const subset = edits.filter((e) => allow.has(e.rowId));
    if (subset.length === 0) return;
    await this.handleSaveEdits(index, null, [], subset, serverIndexByRowId);
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
  /** Close a statement's batched browse cursor (Postgres/MySQL streaming
   *  SELECT). With pool.max=1 a live cursor holds the only pooled client,
   *  so a manual transaction (or any later query) would deadlock waiting
   *  for it. Best-effort — a cursor already closed by an earlier requery
   *  is a silent no-op. */
  private async closeStatementCursor(r: StatementResult): Promise<void> {
    const batched = r.batched;
    if (!batched || r.status !== "done") return;
    try {
      await batched.close();
    } catch {
      // ignore — cursor may already be closed
    }
  }

  /**
   * TASK-004 — answer the webview's requestDistinctValues with a cached
   * `distinctValues` reply.
   *
   * The DISTINCT query is BASE-STATEMENT scoped: built from the statement's
   * own `r.sql` with `where = ""` (the host retains no per-statement WHERE —
   * see PLAN §3.4; a filtered-view-scoped dropdown is a queued follow-up).
   * Replies echo the captured request `index`/`column`.
   *
   * Stale guard: the request's `index`, `column` and the statement
   * generation are captured BEFORE awaiting runSql; a completion whose
   * generation no longer matches (render() or a replacement requery
   * happened while in flight) is dropped — no cache write, no postMessage.
   * Cache hits post the cached list without touching the DB.
   */
  private async handleRequestDistinctValues(
    msg: RequestDistinctValuesMessage,
  ): Promise<void> {
    const { index, column } = msg;
    const r = this.lastResults[index];
    const reply = (values: unknown[], truncated: boolean, error?: string): void => {
      this.postMessage({
        type: "distinctValues",
        index,
        column,
        values,
        truncated,
        ...(error ? { error } : {}),
      });
    };
    if (!r) {
      reply([], false, `No statement at index ${index}.`);
      return;
    }
    const key = `${index}::${column}`;
    const cached = this.distinctCache.get(key);
    if (cached) {
      reply(cached.values, cached.truncated);
      return;
    }
    const dialect = toDialect(this.saveContext?.getDriver() ?? null);
    if (!dialect) {
      reply(
        [],
        false,
        "Distinct values unavailable: no active connection.",
      );
      return;
    }
    // Capture identity BEFORE awaiting: index/column/generation, plus the
    // TASK-ARP02-002 session epoch (guarding a panel dispose/recreate race).
    const generation = this.statementGeneration;
    const epoch = this.sessionEpoch;
    // TASK-006 (cycle Y) — scope the dropdown to the statement's active
    // server-side view: bar WHERE AND every OTHER column's filter predicate,
    // never the requested column's own (its selected values must not narrow
    // the very list the user is re-picking from). The predicates are rebuilt
    // with the pure buildFilterWhere over a shallow copy minus `column` —
    // no SQL string parsing anywhere. No recorded source state (fresh render,
    // non-dialect lane) keeps today's byte-identical where="" behaviour.
    const sourceState = this.whereByStatement.get(index);
    let scopedWhere = "";
    if (sourceState) {
      const filtersWithoutColumn: ColumnFilterModel = { ...sourceState.filters };
      delete filtersWithoutColumn[column];
      const rebuilt =
        Object.keys(filtersWithoutColumn).length > 0
          ? buildFilterWhere(
              filtersWithoutColumn,
              dialect,
              sourceState.columnTypes !== undefined
                ? { columnTypes: sourceState.columnTypes }
                : undefined,
            )
          : "";
      scopedWhere = [sourceState.barWhere.trim(), rebuilt]
        .filter(Boolean)
        .join(" AND ");
    }
    const sql = buildDistinctValuesQuery(r.sql, column, dialect, scopedWhere);
    // FIX R2 — a batched DISTINCT response (postgres/mysql single SELECT →
    // server cursor) must not leak the cursor: pool.max=1 means a live
    // cursor pins the only pooled client and any later query deadlocks.
    // Drain fetchBatch() through the probe limit, then close in finally —
    // best-effort, idempotent (closeStatementCursor pattern).
    try {
      const runResult = this.transaction
        ? await this.transaction.runQuery(sql)
        : await this.runner.runSql(sql);
      let rows: unknown[][];
      if (runResult.batched) {
        const batched = runResult.batched;
        try {
          rows = (await pickResult(runResult)).rows as unknown[][];
          // Probe is LIMIT cap+1 — keep fetching pages until we have more
          // than the cap, or the cursor hits EOF (fetchBatch → null).
          while (rows.length <= DISTINCT_VALUES_LIMIT) {
            const batch = await batched.fetchBatch();
            if (!batch || batch.length === 0) break;
            rows = rows.concat(batch);
          }
        } finally {
          try {
            await batched.close();
          } catch {
            // ignore — cursor may already be closed
          }
        }
      } else {
        rows = (await pickResult(runResult)).rows as unknown[][];
      }
      // Stale completion (statement replaced OR panel disposed while in
      // flight): drop entirely.
      if (generation !== this.statementGeneration || this.isStaleSession(epoch)) {
        return;
      }
      const { values, truncated } = takeDistinctValues(rows);
      this.distinctCache.set(key, { values, truncated });
      reply(values, truncated);
    } catch (err) {
      if (generation !== this.statementGeneration || this.isStaleSession(epoch)) {
        return;
      }
      const m = err instanceof Error ? err.message : String(err);
      reply([], false, `Distinct values failed: ${m}`);
    }
  }

  /** Compose the requery SQL for a message, dispatching per PLAN §3.1:
   *
   *  - No live dialect (no active connection): never guess quoting against
   *    a live DB — keep the `composeRequery` path.
   *  - Empty ORDER BY, filter-less requery: `composeRequery(sql, where, "")`
   *    — byte-identical to cycle V.
   *  - Single bare term (no NULLS), filter-less, no offset: cycle-V
   *    `composeSortQuery` path with its own quoting and `vsdb_sort` alias.
   *  - ≥2 terms (or 1 term with NULLS), filter-less, no offset: multi-term
   *    wrap `SELECT * FROM (<stripped sql>) AS vsdb_sub[ WHERE …] ORDER BY
   *    <buildOrderByClause(terms, dialect)>` — no LIMIT/OFFSET.
   *  - `filters` or `offset` present: the paging lane. Two sub-lanes:
   *      · legacy — cycle-W `buildPagedQueryTerms(pkTiebreakers)` when the
   *        full declared PK is already projected OR nothing proves a stable
   *        key. Byte-identical to before TASK-004 cycle Y.
   *      · widened — gated missing-PK browse projection (assertBrowseShape)
   *        gets `widenPkWithHidden`: hiddenColumns ride back on the result
   *        so handleRequery can strip them from the DISPLAYED columns while
   *        their values stay positionally available for the paging key.
   *    A webview-supplied `lastKey` plus proven total order swaps OFFSET for
   *    the keyset predicate; without one the webview keeps today's OFFSET.
   *
   *  A parse failure (`parseOrderBy`) is surfaced by the caller, not here.
   */
  private composeRequerySql(
    r: StatementResult,
    msg: RequeryMessage & { lastKey?: Array<{ column: string; value: unknown }> },
    dialect: Dialect | null,
    terms: OrderByTerm[],
    pkTiebreakers: string[],
    columnTypes?: Record<string, string>,
  ): { sql: string; hiddenColumns?: string[] } {
    const where = msg.where ?? "";
    const orderBy = msg.orderBy ?? "";
    if (!dialect) return { sql: composeRequery(r.sql, where, orderBy) };

    const filterWhere = msg.filters
      ? buildFilterWhere(msg.filters, dialect, { columnTypes })
      : "";
    const combinedWhere = [where.trim(), filterWhere]
      .filter(Boolean)
      .join(" AND ");

    // Filter-less, no-offset requeries: pure-sort lane.
    if (msg.offset === undefined && !msg.filters) {
      if (terms.length === 0) {
        return { sql: composeRequery(r.sql, where, "") };
      }
      const first = terms[0]!;
      // TASK-007 (cycle Y): a POSITIONAL ordinal term (`ORDER BY 2`) must
      // bypass composeSortQuery — its helpers quote-wrap ANY column token,
      // which would turn ordinal 2 into the inert identifier `"2"`. Ordinals
      // fall through to the buildOrderByClause wrap below, which emits them
      // bare exactly as the webview sent them.
      const firstIsOrdinal = first.ordinal === true;
      if (terms.length === 1 && !first.nulls && !firstIsOrdinal) {
        // Cycle-V single-term path — keeps composeSortQuery's quoting.
        return {
          sql: composeSortQuery(dialect, r.sql, where, first.column, first.direction),
        };
      }
      // Multi-term (or NULLS) wrap — pinned alias matches composeRequery's.
      const inner = r.sql.replace(/\s*;\s*$/, "").trim();
      const whereClause = where.trim().length ? ` WHERE ${where.trim()}` : "";
      return {
        sql: `SELECT * FROM (${inner}) AS vsdb_sub${whereClause} ORDER BY ${buildOrderByClause(terms, dialect)}`,
      };
    }

    // Paging lane. The legacy lane keeps frozen resultsPanelOrderBy
    // case-12/13/13b semantics untouched: case 12 (full PK projected) appends
    // the visible tiebreaker pair; case 13b (PARTIAL PK visible) falls back to
    // no-tiebreaker OFFSET — so the cycle-Y widening lane may arm ONLY when
    // ZERO PK columns are visible. A partial projection means the user chose
    // their column list deliberately; rewriting it would surprise them and a
    // hidden-only injection under an explicit partial list is ambiguous about
    // which rows the visible values belong to.
    const projected = r.result?.columns ?? [];
    const fullPkProjected =
      pkTiebreakers.length > 0 &&
      pkTiebreakers.every((c) => projected.includes(c));
    const zeroPkVisible =
      pkTiebreakers.length > 0 &&
      !pkTiebreakers.some((c) => projected.includes(c));
    const mayWiden =
      zeroPkVisible && !fullPkProjected && assertBrowseShape(r.sql) !== null;

    const composed = composeKeysetQuery({
      baseSql: r.sql,
      where: combinedWhere,
      terms,
      tiebreakers: pkTiebreakers,
      ...(mayWiden ? { widenPkWithHidden: true } : {}),
      ...(msg.lastKey ? { lastKey: msg.lastKey } : {}),
      offset: msg.offset ?? 0,
      limit: msg.limit ?? DEFAULT_PAGE_SIZE,
      dialect,
    });
    // When neither keyset nor widening applies this is byte-identical to the
    // legacy buildPagedQueryTerms output (guarded by keysetPaging's tests).
    return composed;
  }

  private async handleRequery(msg: RequeryMessage): Promise<void> {
    // TASK-ARP02-002 — the requery continuation is deferred across runSql;
    // if the panel is disposed (and re-created) mid-run, every post/toast
    // below must be suppressed. requerySeq orders requeries against EACH
    // OTHER; the epoch guards them against the PANEL being replaced.
    const epoch = this.sessionEpoch;
    const index = msg.index;
    const where = msg.where ?? "";
    const orderBy = msg.orderBy ?? "";
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
    await this.closeStatementCursor(r);
    // TASK-ARP02-002 — dispose landed while the cursor close was pending:
    // do not start the requery (nor its busy write) for a dead session.
    if (this.isStaleSession(epoch)) return;
    // Concurrency guard: a stale (slower) in-flight requery must never
    // overwrite a newer one that already started.
    const seq = ++this.requerySeq;
    const dialect = toDialect(this.saveContext?.getDriver() ?? null);

    // TASK-004 — parse ORDER BY with the LIVE dialect (that is what rejects
    // NULLS on mysql/mssql). A parse failure is surfaced to the user AND as
    // a synthetic error StatementResult; nothing is run. There is exactly
    // one rejection path in this task.
    const parsed = dialect ? parseOrderBy(orderBy, dialect) : null;
    if (parsed && !parsed.ok) {
      void vscode.window.showErrorMessage(
        `VSDB: invalid ORDER BY — ${parsed.error}`,
      );
      const next = this.lastResults.slice();
      next[index] = {
        index: r.index,
        sql: r.sql,
        status: "error",
        result: undefined,
        error: `Invalid ORDER BY: ${parsed.error}`,
        durationMs: 0,
      };
      this.lastResults = next;
      this.postMessage({
        type: "state",
        header: this.header,
        results: next,
        busy: this.busy,
      });
      return;
    }
    const terms = parsed ? parsed.terms : [];

    // TASK-004 — host-derived PK tiebreakers (paging lane only). Resolve
    // BEFORE composing so the composer stays sync (the requerySeq guard at
    // the awaits below keeps its ordering). Full projected PK in declared
    // order, or [] (cycle-V byte-identical path).
    // TASK-004 (cycle Y, contract A ii) — the tiebreaker list now arms for a
    // MISSING-PK projection too, but ONLY when the statement passes the
    // structural browse gate: composeKeysetQuery widens that gated
    // projection with hiddenColumns instead of appending visible tiebreakers.
    let pkTiebreakers: string[] = [];
    let widenHidden = false;
    const tableMeta = this.tableByStatement.get(index);
    if (msg.offset !== undefined && tableMeta && this.saveContext) {
      try {
        const pk = await this.saveContext.listPkColumns(
          tableMeta.schema ?? "",
          tableMeta.table,
        );
        if (this.isStaleSession(epoch)) return;
        if (pk.length > 0) {
          const projected = r.result?.columns ?? [];
          if (pk.every((c) => projected.includes(c))) {
            pkTiebreakers = pk; // cycle-W lane: full PK already visible.
          } else if (
            !pk.some((c) => projected.includes(c)) &&
            assertBrowseShape(r.sql) !== null
          ) {
            // Gated direct browse with ZERO PK columns visible: widen the
            // projection and hide the appended columns. A PARTIAL projection
            // stays legacy (frozen case 13b pins it byte-identical).
            pkTiebreakers = pk;
            widenHidden = true;
          }
          // Any other shape stays ungated: no tiebreakers, safe OFFSET.
        }
      } catch {
        pkTiebreakers = [];
      }
    }

    // TASK-004 — declared column types for the (Blanks) predicate. Any miss
    // (no table, method absent, rejection) ⇒ no columnTypes ⇒ cycle V.
    let columnTypes: Record<string, string> | undefined;
    if (msg.filters && tableMeta && this.saveContext?.listColumnTypes) {
      try {
        columnTypes = await this.saveContext.listColumnTypes(
          tableMeta.schema ?? "",
          tableMeta.table,
        );
        if (this.isStaleSession(epoch)) return;
      } catch {
        columnTypes = undefined;
      }
    }

    const composed = this.composeRequerySql(
      r,
      msg,
      dialect,
      terms,
      pkTiebreakers,
      columnTypes,
    );
    // TASK-006 (cycle Y) — source state {barWhere, filters, columnTypes} is
    // recorded AFTER the run succeeds and the stale-seq guard passes (below),
    // so a failed or superseded requery never leaves a WHERE the next
    // distinct request would re-run and fail again.
    // TASK-004 (cycle Y) — hidden columns appended by the widening lane:
    // keep their values positionally for the paging key but strip them from
    // the DISPLAYED result so visible columns stay exactly what the user
    // wrote in the projection.
    const hiddenColumns = widenHidden ? (composed.hiddenColumns ?? []) : [];
    const stripHidden = (result: QueryResult): QueryResult => {
      if (hiddenColumns.length === 0) return result;
      return {
        ...result,
        columns: result.columns.filter((c) => !hiddenColumns.includes(c)),
        rows: result.rows.map((row) =>
          row.filter(
            (_, i) => !hiddenColumns.includes(result.columns[i] ?? ""),
          ),
        ),
      };
    };
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
      // Manual mode — an open DbTransaction holds the pooled client
      // (pool.max=1), so `runner.runSql` would deadlock on pool.connect().
      // Route the requery through the transaction handle so it shares the
      // pinned session (and correctly sees uncommitted manual-window
      // changes). Non-manual requeries keep the plain runner path.
      const composedSql = composed.sql;
      const runResult = this.transaction
        ? await this.transaction.runQuery(composedSql)
        : await this.runner.runSql(composedSql);
      // FIX R1 critical #2 — `refreshed.results[0]` is always undefined
      // when the adapter returns a batched handle (Postgres single
      // SELECT). pickResult() handles both shapes: batched → initial
      // fetchBatch + columns; non-batched → first populated result.
      // Without this the entry swapped to `{ status:"done", result: undefined }`
      // and the grid blanked.
      const picked = await pickResult(runResult);
      // TASK-ARP02-002 — panel disposed (and possibly re-created) while the
      // requery was in flight: drop everything, silently.
      if (this.isStaleSession(epoch)) return;
      // TASK-004 (cycle Y) — hide the injected PK columns in the displayed
      // result. The FULL row (hidden values included) stays reachable only
      // through this closure for the paging key below; everything posted to
      // the webview goes through stripHidden.
      const freshResult = stripHidden(picked);
      // A newer requery already started while we were awaiting the run →
      // drop this (stale) result entirely; it must not clobber the newer
      // entry (nor adopt its cursor into the runner).
      if (seq !== this.requerySeq) return;
      // TASK-006 — only now (run succeeded + not superseded) record the
      // requery's source state for later distinct requests. Shallow copy of
      // the incoming filter model (the webview never mutates a posted model,
      // and buildFilterWhere reads it without writing); `filters` may be
      // undefined (bar-only requery). Only a LIVE-dialect requery records
      // state — the no-dialect path inside composeRequerySql is the legacy
      // composer whose semantics the distinct lane does not model. Cleared
      // with render().
      if (dialect) {
        this.whereByStatement.set(index, {
          barWhere: where,
          filters: msg.filters ? { ...msg.filters } : {},
          ...(columnTypes !== undefined ? { columnTypes } : {}),
        });
      }
      const next = this.lastResults.slice();
      // TASK-005 — `append:true` concatenates the fresh page onto the
      // existing rows instead of replacing (server-side "Load More"). The
      // combined rowCount is unknown across pages → null keeps hasMore
      // honest so the next paged requery still fires.
      const newResult =
        msg.append && r.result
          ? {
              columns: freshResult.columns,
              rows: [...r.result.rows, ...freshResult.rows],
              rowCount: null,
              durationMs: freshResult.durationMs,
            }
          : freshResult;
      // Synthesize the new StatementResult. We keep `index`, `sql` (the
      // ORIGINAL — what the user wrote). `batched` is the NEW cursor
      // (mirrors QueryRunner.executeAll behaviour) so loadMore still
      // works.
      // NOTE (reviewer minor, TASK-004): after a widening requery the cursor's
      // rows stay WIDE (hidden PK columns included) while `result.rows` here is
      // stripped — so a later loadMore APPENDS wide rows onto the narrow ones,
      // making the buffer ragged. Benign today: the webview materializes every
      // row through rowsToObjects against the visible `specs`, which reads only
      // columns [0..specs.length), so the trailing hidden values are dropped on
      // render. Do not assume row width equality when changing this path.
      const newStmt: StatementResult = {
        index: r.index,
        sql: r.sql,
        status: "done",
        result: newResult,
        batched: runResult.batched,
        durationMs: Date.now() - start,
      };
      next[index] = newStmt;
      this.lastResults = next;
      // TASK-004 — this statement's data was just replaced: drop any
      // in-flight DISTINCT response and clear the cached lists (the new
      // rows may contain values the old cache never saw).
      this.statementGeneration += 1;
      this.distinctCache.clear();
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
      // TASK-ARP02-002 — stale session: silent return, no toast, no state
      // post, no busy write.
      if (this.isStaleSession(epoch)) return;
      const cancelled =
        this.runner.isCancelled?.() === true ||
        /cancel/i.test(err instanceof Error ? err.message : String(err));
      if (!cancelled) {
        if (seq !== this.requerySeq) return;
        const m = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`VSDB requery failed: ${m}`);
        // Surface as a per-statement error so the webview grid shows the
        // existing error placeholder instead of the stale result. On an
        // append failure the ORIGINAL rows are preserved (no row loss) —
        // the error rides along on the still-valid loaded result.
        const next = this.lastResults.slice();
        next[index] = {
          index: r.index,
          sql: r.sql,
          status: "error",
          result: msg.append ? r.result : undefined,
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
        if (this.isStaleSession(epoch)) return;
        this.postMessage({
          type: "state",
          header: this.header,
          results: this.lastResults,
          busy: this.busy,
        });
      }
    } finally {
      // TASK-ARP02-002 — only the live session clears its own busy flag; a
      // stale continuation must not unlock a re-created panel's UI.
      if (!this.isStaleSession(epoch)) {
        this.setBusy(false);
      }
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
 *
 * TASK-006 P3-3 — `batched` is normalized to `!!r.batched`. The host-side
 * `StatementResult.batched` is the live BatchedQuery cursor handle
 * (fetchBatch/close/cancel functions); the webview-facing wire type declares
 * `batched?: boolean`. Spreading `...r` shipped the whole handle, which
 * structured clone cannot carry (functions) — at best the webview received
 * junk, at worst the post rejected and the panel stopped updating. The
 * early-return branch (`!r.result`) must normalize too: extension.ts posts
 * `runner.getResults()` — real handles — through this function.
 */
export function sanitizeStatementResult(r: StatementResult): StatementResult {
  if (!r.result) {
    return { ...r, batched: !!r.batched } as unknown as StatementResult;
  }
  const result = r.result;
  return {
    ...r,
    batched: !!r.batched,
    result: {
      ...result,
      rows: result.rows.map((row) => sanitizeRow(row)),
    },
  } as unknown as StatementResult;
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
