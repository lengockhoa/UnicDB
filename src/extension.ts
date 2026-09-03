// src/extension.ts
// VSDB extension entry — TASK-007 wires all commands + tree view + CodeLens + status bar.
import * as vscode from "vscode";
import { ConnectionManager } from "./core/connectionManager";
import { createAdapter } from "./adapters/factory";
import { hasAdapterCapability } from "./adapters/types";
import { QueryRunner } from "./core/queryRunner";
import { ResultsPanel, type SaveContext } from "./ui/resultsPanel";
import { createStatusBar } from "./ui/statusBar";
import {
  SchemaTreeProvider,
  generateSelectForTable,
  qualifiedName,
  registerSchemaTreeProvider,
} from "./ui/schemaTree";
import { AdminTreeProvider } from "./ui/adminTree";
import {
  AdminSessionsPanel,
  ADMIN_UNSUPPORTED_MESSAGE,
} from "./ui/adminSessionsPanel";
import { openImportWizard } from "./ui/importWizard";
import { runCompare } from "./ui/compareService";
import { ComparePanel } from "./ui/comparePanel";
import { runErExplorer } from "./ui/erService";
import { ErPanel } from "./ui/erPanel";
import {
  getLargeValueProvider,
  LARGE_VALUE_SCHEME,
  openLargeValueEditor,
} from "./ui/largeValueEditor";
import { commandOpenGrantWizard } from "./ui/adminWizard";
import { registerDdlView } from "./ui/ddlView";
import { VsdbCodeLensProvider } from "./ui/codeLensProvider";
import { registerTableCommands } from "./ui/tableCommands";
import { ConnectionForm } from "./ui/connectionForm";
import { sqlToRun, type SqlDialect } from "./core/statementParser";
import { stampBqDialect } from "./core/bqDialect";
import {
  createKeywordTableCache,
  qualifyKeywordTables,
} from "./core/keywordQualify";
import { completedSchemaImpact } from "./core/schemaImpact";

import { analyzeStatement, guardTier } from "./core/dangerousStatement";
import { truncateAtBoundary } from "./core/text";
import { AiConfigStore } from "./ai/config";
import { AiSettingsForm } from "./ui/aiSettingsForm";
import { createProviderClient } from "./ai/provider";
import type { AdapterFactory } from "./ai/tools/types";
import type { AgentDeps } from "./ai/agent";
import { AiChatPanel, type AcpPanelDeps } from "./ui/aiChatPanel";
import { ConsolePanel } from "./ui/consolePanel";
import { HelpGridPanel } from "./ui/helpGridPanel";
import { AcpProcess, type AcpProcessHandle, type OmpEngineState } from "./ai/omp/acpProcess";
import { detectOmp, OMP_INSTALL_HINT, OMP_UPDATE_HINT } from "./ai/omp/detect";
import { resolveEngine } from "./ai/engineChoice";
import {
  createOmpChatEngine,
  type AcpSession,
  type OmpChatEngine,
} from "./ai/omp/ompChatEngine";
import { createMcpBridge } from "./ai/omp/mcpBridge";
import {
  createHostMcp,
  type HostMcpTool,
} from "./ai/omp/hostMcp";
import { createDbAwareTools } from "./ai/tools/dbAwareTools";
import { resolvePolicy, type EffectivePolicy } from "./ai/policy";
import { serializeAuditExport } from "./ai/auditExport";
import { registerBrowseCommands } from "./ui/browseCommands";
import { SchemaCache } from "./ui/schemaCache";
import { createCatalogResolver } from "./ui/sqlCatalog";
import { SqlCompletionProvider } from "./ui/sqlCompletionProvider";
import { SqlCatalogDocumentProvider } from "./ui/sqlCatalogDocumentProvider";
import { SqlNavigationProvider } from "./ui/sqlNavigationProvider";
import { SqlReferenceProvider } from "./ui/sqlReferenceProvider";
import {
  SQL_SEMANTIC_LEGEND,
  SqlSemanticTokensProvider,
} from "./ui/sqlSemanticTokens";
import { defaultAiSettings, type AiSettings } from "./ai/settings";
import type { ConnectionConfig, ParsedStatement } from "./config/types";
import { writeVsdbAiConfig } from "./extensionConfigExport";
import { SqlAutocompleteService, type ProviderFn, type SchemaContext } from "./ai/sqlAutocomplete";
import { createSchemaContextCache, type SchemaContextCache } from "./ai/schemaContextCache";
import { registerSqlAutocomplete, type AutocompleteRegistration } from "./extensionAutocomplete";
import {
  logLine,
  type DiagCategory,
  type DiagSeverity,
} from "./core/diagnostics";
let disposables: vscode.Disposable[] = [];
let state: ExtensionState | null = null;
/**
 * TASK-ARP02-004 — teardown sentinel. Set synchronously at deactivate()
 * entry and reset at activate() entry (reload ⇒ new session), so any
 * in-flight `runStatements` continuation that settles after teardown
 * started short-circuits its panel writes (render/setBusy) instead of
 * rendering into a disposed panel or resurrecting the webview.
 */
let deactivating = false;
/** Cached single-instance AiSettingsForm (TASK-004). Reused across calls. */
let aiSettingsForm: AiSettingsForm | null = null;
/** Cached single-instance AiChatPanel (TASK-004). Reused across calls. */
let aiChatPanel: AiChatPanel | null = null;
let consolePanel: ConsolePanel | null = null;
/** TASK-OC4O-002 — VSDB Help Grid singleton. Created on first open. */
let helpGridPanel: HelpGridPanel | null = null;
/** Cycle AIC TASK-AIC-005 — singletons for the autocomplete wiring. */
let autocompleteService: SqlAutocompleteService | null = null;
let autocompleteRegistration: AutocompleteRegistration | null = null;
let extensionUriForForm: vscode.Uri = vscode.Uri.file("/");
let runScriptTerminal: vscode.Terminal | null = null;
/**
 * TASK-ARP07-004 — host seam for successful-DDL cache invalidation. Assigned
 * in `activate()` after `schemaCache` + `acSchemaCache` are constructed; the
 * shared `runStatements` path calls it from the success branch ONLY after the
 * run settled and ONLY under `!deactivating` (composes with the ARP-02
 * teardown sentinel). Null before activation / after deactivate → no-op.
 */
let invalidateAfterSchemaDdl:
  | ((completed: readonly string[], dialect?: SqlDialect) => void)
  | null = null;

// =====================================================================
// BQ01-001 — narrow DriverType → SqlDialect. BigQuery's path is wired by
// BQ01-002/003 (adapter + factory admission); until then, this layer
// treats a bigquery driver as "no SQL splitter dialect" and the BQ
// runQuery path (when added) will own its own SQL handling. The narrowing
// is local to extension.ts because that's where `mgr.getActive()?.driver`
// crosses into the SqlDialect-typed boundary; the SqlDialect type itself
// stays narrow so statementParser / confirmDangerous don't gain unknown
// branches.
// =====================================================================
function toSqlDialect(
  driver: ConnectionConfig["driver"] | undefined,
): SqlDialect | undefined {
  return driver === "bigquery" ? undefined : driver;
}

// =====================================================================
// TASK-ARP09-003 — Lazy redacted Output Channel wiring.
// The diagnostic channel is module-level, LAZY (no createOutputChannel at
// activate), and the activate-end lifecycle `info` line is BUFFERED so a
// plain activation never allocates a channel. The first REAL diagnostic
// write (any non-lifecycle line, OR a lifecycle `warn`/`error`) creates
// the channel exactly once, flushes the pending buffer, and appends
// subsequent lines directly. `deactivate()` disposes the channel exactly
// once and clears the singleton so a second deactivate is a no-op.
// =====================================================================

/** Hard cap on the bounded pending buffer (drop-oldest when full). */
const DIAG_PENDING_MAX = 100;

/** Lazy Output Channel singleton. Null before first real write + after deactivate. */
let diagOutputChannel: vscode.OutputChannel | null = null;

/** Bounded pending buffer of pre-create log lines. Drop-oldest on overflow. */
let diagPendingLines: string[] = [];

/**
 * Lazy channel creation + pending buffer flush. Idempotent — calling after
 * the channel already exists is a no-op (apart from flushing the pending
 * buffer, which is also a no-op once it is empty). No-op after deactivate
 * so a post-deactivate `logDiagnostic` cannot resurrect the channel.
 */
function ensureDiagChannel(): void {
  if (deactivating) return;
  if (diagOutputChannel === null) {
    diagOutputChannel = vscode.window.createOutputChannel("VSDB");
  }
  if (diagPendingLines.length > 0) {
    const pending = diagPendingLines;
    diagPendingLines = [];
    for (const line of pending) {
      // `line` was produced by logLine at the write site (see logDiagnostic);
      // the source-level pin in src/ai/__tests__/trace.test.ts covers this
      // pattern (`appendLine(line)` after `const line = logLine(...)`).
      diagOutputChannel.appendLine(line);
    }
  }
}

/**
 * Host-side helper: write one redacted diagnostic line to the VSDB Output
 * Channel. Public so other modules / future cycles can drive the same
 * channel without re-importing `logLine` or knowing about the lazy holder.
 *
 * Routing:
 *   - After deactivate (`deactivating === true`): no-op.
 *   - Channel already created: appendLine directly.
 *   - Channel absent + the line is the activate-end lifecycle `info`
 *     signal (the only lifecycle line the host emits at activation time):
 *     buffer it (drop-oldest when full), do NOT create the channel.
 *   - Channel absent + ANY other line (real diagnostic OR lifecycle
 *     `warn`/`error`): ensureDiagChannel() creates it exactly once, then
 *     appends the line directly.
 *
 * Byte-scan invariant: the message is formatted through `logLine`, which
 * runs the imported `redact()` (secrets / bearer / basic / long-runs)
 * BEFORE assembly and bounds the final line to MAX_DIAG_LINE_CHARS. The
 * formatter never throws and never emits a raw secret, SQL fragment, or
 * long opaque run; the test suite pins this at the channel boundary.
 */
export function logDiagnostic(
  category: DiagCategory,
  severity: DiagSeverity,
  message: unknown,
  correlationId?: string,
): void {
  if (deactivating) return;
  const line = logLine(category, severity, message, correlationId);
  if (diagOutputChannel !== null) {
    diagOutputChannel.appendLine(line);
    return;
  }
  // Channel absent. The ONLY line we buffer (no-create) is the
  // activate-end lifecycle `info` signal — every other write is a real
  // diagnostic, which must create the channel exactly once and flush
  // whatever was buffered.
  const isActivateEndLifecycle =
    category === "lifecycle" && severity === "info";
  if (isActivateEndLifecycle) {
    if (diagPendingLines.length >= DIAG_PENDING_MAX) {
      diagPendingLines.shift();
    }
    diagPendingLines.push(line);
    return;
  }
  ensureDiagChannel();
  diagOutputChannel!.appendLine(line);
}

/** Get-or-create the diagnostic channel (for the show/clear commands). */
function getDiagChannel(): vscode.OutputChannel | null {
  if (deactivating) return null;
  ensureDiagChannel();
  return diagOutputChannel;
}

interface ExtensionState {
  mgr: ConnectionManager;
  runner: QueryRunner;
  panel: ResultsPanel;
  tree: SchemaTreeProvider;
  codeLens: VsdbCodeLensProvider;
  statusBar: vscode.StatusBarItem;
}

// AIX-01: opt-in workspace grounding. Default OFF so the pre-AIX-01
// turn path is unchanged. Hosts gate on `vsdb.ai.grounding` so a
// setting change takes effect on the next panel open.
function isGroundingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("vsdb")
    .get<boolean>("ai.grounding", false);
}
// AIX-02 — host-curated workspace allowlist for grounding + file ops.
// Refreshed when grounding is enabled and on workspace/config changes.
// Text-like files only, capped at 200 entries; exact relative-ish fsPaths
// (the same strings grounding readFile/workspace_write use as keys).
const GROUNDING_MAX_FILES = 200;
const GROUNDING_EXCLUDE_GLOBS = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vsdb/**,**/*.min.*,**/*.lock,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.ico,**/*.webp,**/*.pdf,**/*.zip,**/*.gz,**/*.exe,**/*.dll,**/*.so,**/*.dylib,**/*.woff,**/*.woff2,**/*.ttf,**/*.mp3,**/*.mp4,**/*.sqlite,**/*.db}";
let groundingFiles: readonly string[] = [];
async function refreshGroundingFiles(): Promise<void> {
  try {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      groundingFiles = [];
      return;
    }
    const uris = await vscode.workspace.findFiles(
      "**/*",
      GROUNDING_EXCLUDE_GLOBS,
      GROUNDING_MAX_FILES,
    );
    // Keep the full URI STRING (scheme preserved — file:, vscode-remote:,
    // untitled:) so scope keys round-trip through Uri.parse losslessly.
    // fsPath reconstruction would silently coerce remote/virtual schemes.
    groundingFiles = uris.map((u) => u.toString()).sort();
  } catch {
    groundingFiles = [];
  }
}
function readActiveSelection(): { path: string; text: string; startLine?: number; endLine?: number } | null {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const sel = ed.selection;
  if (sel.isEmpty) return null;
  return {
    path: ed.document.uri.fsPath,
    text: ed.document.getText(sel),
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
  };
}
async function readWorkspaceFile(p: string): Promise<string> {
  // p is a full URI string from the allowlist (scheme preserved).
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(p));
  return new TextDecoder().decode(bytes);
}
/**
 * AIX-02 — atomic write: write to a temp sibling, then rename over the
 * target. vscode.workspace.fs.rename never leaves a half-written target —
 * the original stays intact when anything throws before the rename.
 */
async function writeWorkspaceFileAtomic(
  p: string,
  content: string,
  expectedOld?: string,
): Promise<void> {
  const target = vscode.Uri.parse(p);
  // CAS: when the caller pins the previewed snapshot, re-read the target
  // immediately before the rename and refuse the swap when it changed —
  // the approval the user gave described DIFFERENT bytes.
  if (expectedOld !== undefined) {
    const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    if (current !== expectedOld) {
      throw new Error("conflict: file changed since the approved preview");
    }
  }
  const tmp = target.with({
    path: `${target.path}.vsdb-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  });
  await vscode.workspace.fs.writeFile(tmp, new TextEncoder().encode(content));
  try {
    await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
  } catch (err) {
    // Rename failed — remove the temp so no litter remains.
    try {
      await vscode.workspace.fs.delete(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  disposables = [];
  // TASK-ARP02-004 — a reload re-activates in the same JS realm: clear the
  // teardown sentinel set by the previous deactivate().
  deactivating = false;
  extensionUriForForm = context.extensionUri;

  // AIX-02: keep the grounding allowlist fresh on workspace structure
  // changes (best-effort — panel open re-checks anyway).
  if (isGroundingEnabled()) {
    void refreshGroundingFiles();
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (isGroundingEnabled()) void refreshGroundingFiles();
    }),
    vscode.workspace.onDidCreateFiles(() => {
      if (isGroundingEnabled()) void refreshGroundingFiles();
    }),
    vscode.workspace.onDidDeleteFiles(() => {
      if (isGroundingEnabled()) void refreshGroundingFiles();
    }),
  );

  // ---- ConnectionManager ----
  const mgr = new ConnectionManager(context, createAdapter);
  context.subscriptions.push(mgr);

  // ---- Schema tree ----
  const tree = new SchemaTreeProvider(mgr);
  registerSchemaTreeProvider(tree);
  const treeView = vscode.window.createTreeView("vsdb.schemaTree", {
    treeDataProvider: tree,
  });
  disposables.push(treeView);
  // TASK-005 — 6 table-utility commands (New/Modify/Copy DDL/Sample Data/Analyze/Vacuum).
  // TASK-CL-002 — thread the existing `invalidateAfterSchemaDdl` closure into
  // the form-view DDL seam. The thunk reads the module-private binding at
  // fire time (not at registration time), so the closure assignment at
  // :863-867 — which happens AFTER this site — is correctly observed by
  // the panel/form callbacks. The closure itself stays byte-identical.
  registerTableCommands({
    mgr,
    tree,
    treeView,
    context,
    onSchemaDdl: (statements, dialect) => {
      invalidateAfterSchemaDdl?.(statements, dialect);
    },
  });

  // TASK-AF-002 — vsdb-ddl: virtual document provider for "Open DDL" on
  // view/routine/trigger nodes. Registers content provider + vsdb.openDdl +
  // vsdb.refreshDdl. Disposables go to ctx.subscriptions for clean teardown.
  registerDdlView(mgr, context.subscriptions);

  // ---- Status bar ----
  const statusBar = createStatusBar(mgr);
  context.subscriptions.push(statusBar);

  // ---- Results panel + query runner ----
  const runner = new QueryRunner(() => mgr.getAdapter(), {
    batchSize:
      vscode.workspace.getConfiguration("vsdb").get<number>("batchSize") ??
      500,
  });
  // TASK-503 — Save flow dependencies: dialect (from active connection) +
  // PK metadata via DbAdapter.listColumns. Cached at construction; the
  // adapter is fetched lazily (matches QueryRunner.adapterProvider pattern).
  const saveContext: SaveContext = {
    getDriver: () => mgr.getActive()?.driver ?? null,
    getManualCommit: () => mgr.getActive()?.manualCommit === true,
    listPkColumns: async (schema: string, table: string): Promise<string[]> => {
      try {
        const adapter = await mgr.getAdapter();
        const cols = await adapter.listColumns(table, schema || undefined);
        return cols.filter((c) => c.isPrimaryKey === true).map((c) => c.name);
      } catch {
        return [];
      }
    },
    // TASK-004 — declared column types (name → ColumnInfo.dataType) for the
    // (Blanks) predicate. Resolves to {} on any failure ⇒ cycle-V IS NULL.
    listColumnTypes: async (
      schema: string,
      table: string,
    ): Promise<Record<string, string>> => {
      try {
        const adapter = await mgr.getAdapter();
        const cols = await adapter.listColumns(table, schema || undefined);
        const types: Record<string, string> = {};
        for (const c of cols) types[c.name] = c.dataType;
        return types;
      } catch {
        return {};
      }
    },
  };
  const panel = new ResultsPanel({ runner, saveContext });
  panel.setExtensionUri(context.extensionUri);
  context.subscriptions.push(panel);

  // TASK-002 — wire `vsdb.browseTableData` (double-click/Enter on table/view nodes
  // in the schema tree). Consumes TASK-001's registerBrowseCommands; the tree
  // node (with .meta) is passed as the command argument.
  registerBrowseCommands({ mgr, runner, panel });

  // ---- CodeLens ----
  // (review fix round C, Finding #3) — resolver reads the LIVE active
  // connection at lens-render time (not captured once at construction), so
  // switching connections re-dialects the next `provideCodeLenses` call.
  const codeLens = new VsdbCodeLensProvider(() => toSqlDialect(mgr.getActive()?.driver));
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", language: "sql" },
      codeLens,
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", language: "shellscript" },
      codeLens,
    ),
  );

  // ---- TASK-008 — SQL schema-aware completion (SchemaCache 60s TTL) ----
  const schemaCache = new SchemaCache(async () => {
    if (!mgr.getActive()) return null;
    try {
      return await mgr.getAdapter();
    } catch {
      // No password / testConnection fail → completion im lặng, không crash.
      return null;
    }
  });
  const sqlSemanticTokens = new SqlSemanticTokensProvider({
    cache: schemaCache,
    hasConnection: () => mgr.getActive() !== null,
  });
  context.subscriptions.push(
    mgr.onDidChangeActive(() => {
      schemaCache.invalidate();
      sqlSemanticTokens.refresh();
    }),
  );
  const sqlCompletion = new SqlCompletionProvider({
    cache: schemaCache,
    catalog: createCatalogResolver(schemaCache, {
      // DBX-08 — admission is the DECLARED catalog capability of the active
      // adapter, never `driver === "postgres"`. No active adapter → false.
      declaresCatalog: async () => {
        if (!mgr.getActive()) return false;
        try {
          return hasAdapterCapability(await mgr.getAdapter(), "catalog");
        } catch {
          return false;
        }
      },
    }),
    hasConnection: () => mgr.getActive() !== null,
  });
  // Guard: partial `vscode` test mocks (extension.test.ts) chỉ stub
  // registerCodeLensProvider — real VS Code luôn có API này.
  if (typeof vscode.languages.registerCompletionItemProvider === "function") {
    disposables.push(
      vscode.languages.registerCompletionItemProvider(
        { scheme: "file", language: "sql" },
        sqlCompletion,
        ".",
      ),
    );
  }

  // 15c. Cycle DBX-02 — SQL intelligence navigation: shared catalog
  // document provider backs hover/definition virtual documents; navigation
  // (hover + definition) and find-usages (references) reuse the SAME
  // schemaCache — no second cache/debounce/controller.
  const catalogDocuments = new SqlCatalogDocumentProvider();
  disposables.push(catalogDocuments);
  if (
    typeof vscode.workspace.registerTextDocumentContentProvider === "function"
  ) {
    disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        "vsdb-sql-catalog",
        catalogDocuments,
      ),
    );
  }
  const sqlNavigation = new SqlNavigationProvider({
    cache: schemaCache,
    catalog: createCatalogResolver(schemaCache, {
      // DBX-08 — declared catalog capability of the active adapter (same
      // predicate as the completion resolver above).
      declaresCatalog: async () => {
        if (!mgr.getActive()) return false;
        try {
          return hasAdapterCapability(await mgr.getAdapter(), "catalog");
        } catch {
          return false;
        }
      },
    }),
    documentProvider: catalogDocuments,
  });
  if (typeof vscode.languages.registerHoverProvider === "function") {
    disposables.push(
      vscode.languages.registerHoverProvider(
        { scheme: "file", language: "sql" },
        sqlNavigation,
      ),
    );
  }
  if (typeof vscode.languages.registerDefinitionProvider === "function") {
    disposables.push(
      vscode.languages.registerDefinitionProvider(
        { scheme: "file", language: "sql" },
        sqlNavigation,
      ),
    );
  }
  const sqlReferences = new SqlReferenceProvider();
  if (typeof vscode.languages.registerReferenceProvider === "function") {
    disposables.push(
      vscode.languages.registerReferenceProvider(
        { scheme: "file", language: "sql" },
        sqlReferences,
      ),
    );
  }

  // TASK-002 — schema-aware semantic tokens (coloring by live identity).
  // Guard: partial `vscode` test mocks chỉ stub registerCodeLensProvider.
  // Selector khớp CodeLens/completion selectors ở trên.
  if (
    typeof vscode.languages.registerDocumentSemanticTokensProvider === "function"
  ) {
    disposables.push(
      vscode.languages.registerDocumentSemanticTokensProvider(
        { scheme: "file", language: "sql" },
        sqlSemanticTokens,
        SQL_SEMANTIC_LEGEND,
      ),
    );
  }
  // Emitter được release khi deactivate.
  disposables.push(sqlSemanticTokens);

  state = { mgr, runner, panel, tree, codeLens, statusBar };

  // ---- Register all 12 package commands + 1 internal tree command -----------

  // 1. vsdb.runQuery — Cmd+Enter
  disposables.push(
    vscode.commands.registerCommand("vsdb.runQuery", () => runQueryFromEditor(mgr, runner, panel)),
  );

  // 2. vsdb.runStatement — CodeLens click
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.runStatement",
      (stmt: ParsedStatement) => runStatement(mgr, runner, panel, stmt),
    ),
  );

  // 3. vsdb.addConnection
  disposables.push(
    vscode.commands.registerCommand("vsdb.addConnection", () =>
      commandAddConnection(mgr),
    ),
  );

  // 4. vsdb.editConnection
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.editConnection",
      (arg?: { id?: string }) => commandEditConnection(mgr, arg),
    ),
  );

  // 5. vsdb.deleteConnection
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.deleteConnection",
      (arg?: { id?: string }) => commandDeleteConnection(mgr, arg),
    ),
  );

  // 6. vsdb.selectConnection
  disposables.push(
    vscode.commands.registerCommand("vsdb.selectConnection", () =>
      commandSelectConnection(mgr),
    ),
  );

  // 7. vsdb.cancelQuery
  // TASK-RLX02-003 — AWAIT runner.cancel() before clearing busy state: the
  // runner's cancel performs best-effort dialect cleanup through
  // `adapter.cancelActiveQuery()` (MySQL/MSSQL KILL / ATTENTION). A
  // fire-and-forget here let `panel.setBusy(false)` outrun that cleanup, so
  // the UI claimed completion while the seam was still in flight.
  // runner.cancel() never rejects (seam failures are swallowed inside), so
  // awaiting cannot turn a late cancel into a command error.
  disposables.push(
    vscode.commands.registerCommand("vsdb.cancelQuery", async () => {
      await runner.cancel();
      panel.setBusy(false);
    }),
  );

  // 8. vsdb.generateSelect — Generate SELECT for current node (table/view).
  // The view/item/context menus forwards the qualified name as the command argument.
  // If invoked from command palette (no arg), fall back to prompting.
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.generateSelect",
      (qualifiedOrNode?: unknown) =>
        commandGenerateSelect(mgr, qualifiedOrNode),
    ),
  );

  // 9. vsdb.copyQualifiedName
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.copyQualifiedName",
      (qualifiedOrNode?: unknown) =>
        commandCopyQualifiedName(qualifiedOrNode),
    ),
  );

  // 10. vsdb.refreshSchema — TASK-008: invalidate completion schema cache
  // trước khi refresh tree để completion không phục vụ data cũ.
  disposables.push(
    vscode.commands.registerCommand("vsdb.refreshSchema", () => {
      schemaCache.invalidate();
      sqlSemanticTokens.refresh();
      tree.refresh();
    }),
  );

  // 11. vsdb.filterSchemaTree — open input box, apply filter (TASK-303).
  disposables.push(
    vscode.commands.registerCommand("vsdb.filterSchemaTree", async () => {
      const text = await vscode.window.showInputBox({
        prompt: "Filter schemas, tables, columns, routines…",
        placeHolder: "Filter…",
        value: tree.getFilter(),
      });
      if (text === undefined) return;
      tree.setFilter(text);
      await vscode.commands.executeCommand(
        "setContext",
        "vsdb.schemaTreeFilterActive",
        text.length > 0,
      );
    }),
  );

  // 12. vsdb.clearSchemaTreeFilter — clear filter (TASK-303).
  disposables.push(
    vscode.commands.registerCommand("vsdb.clearSchemaTreeFilter", async () => {
      tree.setFilter("");
      await vscode.commands.executeCommand(
        "setContext",
        "vsdb.schemaTreeFilterActive",
        false,
      );
    }),
  );
  // 13. vsdb.selectConnectionFromTree — click connection node → set active.
  // (Không thuộc 12 command khai báo trong package.json; command này được trigger
  // từ TreeItem.command trên connection node. StatusBar + tree badges auto-update
  // qua mgr.onDidChangeActive.)
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.selectConnectionFromTree",
      async (id?: string) => {
        if (!id) return;
        try {
          await mgr.setActive(id);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `VSDB: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),
  );

  // 14. vsdb.runScript — send active .sh file to a reused terminal (TASK-505).
  disposables.push(
    vscode.commands.registerCommand("vsdb.runScript", () => commandRunScript()),
  );

  // 15. vsdb.openAiSettings — TASK-004: open AI Settings form (single instance).
  // TASK-003 cycle AE — read the user-toggled `vsdb.ai.engine` setting.
  // When "omp", detect OMP once at activation. If the binary is missing
  // or too old, show a one-time install/update info notice, flip the
  // setting back to "builtin" so the chat panel uses the OpenAI path on
  // the first invocation (and stays there until the user re-selects
  // "omp" after installing). PLAN_AE.md §Acceptance 0.
  const initialEngine = vscode.workspace
    .getConfiguration("vsdb")
    .get<string>("ai.engine", "builtin");
  // Cycle AE.5 — perform only the lightweight availability gate at activation.
  // AcpProcess is intentionally created when the user opens chat, not here,
  // so activating VS Code without opening chat never leaks a child process.
  if (initialEngine === "omp") {
    void (async () => {
      const detection = await detectOmp();
      if (!detection.ok) {
        const hint = detection.available ? OMP_UPDATE_HINT : OMP_INSTALL_HINT;
        void vscode.window.showInformationMessage(
          `VSDB: omp engine unavailable — falling back to builtin. ${hint}`,
        );
        await vscode.workspace
          .getConfiguration("vsdb")
          .update("ai.engine", "builtin", vscode.ConfigurationTarget.Global);
      }
    })();
  }
  const aiStore = new AiConfigStore(context);
  disposables.push(
    vscode.commands.registerCommand("vsdb.openAiSettings", () =>
      commandOpenAiSettings(aiStore),
    ),
  );
  // 16. vsdb.aiChat — TASK-004: AI chat panel with real deps.
  // Spec: store.loadConfig() (flat AiConfig), createProviderClient per
  // complete() call, adapterFactory resolves ConnectionManager's active
  // POSTGRES adapter (else null). Unconfigured → info + open AI Settings.
  const adapterFactory: AdapterFactory = async () => {
    const active = mgr.getActive();
    if (!active || active.driver !== "postgres") return null;
    try {
      return await mgr.getAdapter();
    } catch {
      // No password / testConnection fail → treat as no connection. Panel
      // continues with empty schema context, never crashes.
      return null;
    }
  };
  const aiChatDeps: AgentDeps = {
    loadConfig: () => aiStore.loadConfig(),
    complete: (cfg, _role, req) =>
      createProviderClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        method: cfg.method,
        timeoutMs: cfg.timeoutMs,
      }).complete(req),
    streamComplete: (cfg, _role, req, onText, signal) =>
      createProviderClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        method: cfg.method,
        timeoutMs: cfg.timeoutMs,
      }).streamComplete(req, { onText, signal }),
  };
  disposables.push(
    vscode.commands.registerCommand("vsdb.aiChat", () =>
      // TASK-AIX03-102 — thread the activation-scoped `mgr` so the
      // panel can subscribe to `onDidChangeRecoveryStatus` and fail-close
      // any in-flight turn against a recovering or failed connection.
      // Do NOT re-import or re-create a ConnectionManager here.
      commandOpenAiChat(aiStore, adapterFactory, aiChatDeps, mgr),
    ),
  );

  // AIX-07 — governance command surface: show effective policy, export the
  // redacted trace (policy-gated, user-selected destination), clear the
  // trace. All three derive/consume the central policy; no new policy rule
  // lives here.
  disposables.push(
    vscode.commands.registerCommand("vsdb.ai.showPolicy", () =>
      commandShowPolicy(aiStore),
    ),
  );
  disposables.push(
    vscode.commands.registerCommand("vsdb.ai.exportTrace", () =>
      commandExportTrace(aiStore),
    ),
  );
  disposables.push(
    vscode.commands.registerCommand("vsdb.ai.clearTrace", () =>
      commandClearTrace(),
    ),
  );

  // 16b. Cycle AIC TASK-AIC-005 — register the SQL InlineCompletionItemProvider
  // AND the Console panel's onAutocomplete adapter. Both share the AIC-002
  // service singleton; the service is the sole debounce/cancel/cache owner.
  const acProvider: ProviderFn = (cfg, role, req) =>
    createProviderClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      method: cfg.method,
      timeoutMs: cfg.timeoutMs,
    }).complete(req);
  // Race-safe + bounded schema context cache for the AIC SQL autocomplete.
  // The cache is keyed by the active connection identity, so a connection
  // change triggers re-hydration automatically. explicit invalidate() is
  // also wired to ConnectionManager.onDidChangeActive below as belt-and-
  // suspenders for the (rare) case where two callers fire events for the
  // same active id within the same tick.
  const acSchemaCache: SchemaContextCache = createSchemaContextCache({
    getActive: () => mgr.getActive(),
    getAdapter: () => mgr.getAdapter(),
  });
  const acResolveSchema = async (_scope: string): Promise<SchemaContext> => {
    // The cache hydrates lazily and re-hydrates on connection identity
    // change; the service downstream sanitizes the result defensively.
    return acSchemaCache.resolve(_scope);
  };
  autocompleteService = new SqlAutocompleteService({
    provider: acProvider,
    resolveSchema: acResolveSchema,
  });
  autocompleteRegistration = registerSqlAutocomplete({
    service: autocompleteService,
    loadConfig: () => aiStore.loadConfig(),
  });
  // Invalidate the AIC schema context + every in-flight autocomplete scope
  // on connection change. The service is the sole debounce/cache owner per
  // caller scope; invalidating every known scope makes stale cache keys
  // and any in-flight request safe to discard.
  context.subscriptions.push(
    mgr.onDidChangeActive(() => {
      acSchemaCache.invalidate();
      autocompleteService?.invalidateAll();
    }),
  );

  // TASK-ARP07-004 — successful-DDL invalidation seam. Fired by the shared
  // `runStatements` path after a run settles with at least one COMPLETED
  // (`status === "done"`) schema-impacting statement: drop both schema-aware
  // caches (completion SchemaCache + AIC schema context cache) and refresh
  // the tree in one place. DML-only runs classify false → no-op (no tree
  // churn for data changes). The closure reads `state?.tree` lazily so a
  // deactivate between run-start and seam-fire cannot resurrect the tree.
  invalidateAfterSchemaDdl = (completed, dialect) => {
    if (!completedSchemaImpact(completed, dialect)) return;
    schemaCache.invalidate();
    acSchemaCache.invalidate();
    state?.tree.refresh();
  };

  // 17. vsdb.openConsole — TASK-003 cycle Z: DataGrip-style SQL Console.
  // TASK-AF-004 cycle AF: passes `globalState` Memento so query history
  // (capped at 200 entries) persists across panel reloads.
  // ARP-08 TASK-ARP08-004: also passes `workspaceState` as the draft
  // memento so Console drafts stay workspace-scoped (history stays global).
  disposables.push(
    vscode.commands.registerCommand("vsdb.openConsole", () =>
      commandOpenConsole(
        mgr,
        runner,
        panel,
        context.globalState,
        context.workspaceState,
      ),
    ),
  );
  // 17b. vsdb.consoleNewTab — TASK-AF-004: add a new tab to the existing
  // Console panel (no-op if the user hasn't opened the panel yet).
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.consoleNewTab",
      () => commandOpenConsoleCreateTab(),
    ),
  );
  // 17c. vsdb.openConsoleForObject — open the SQL Console with a fresh tab
  // pre-filled with a driver-aware SELECT for the picked table/view.
  // Wired to the right-click `view/item/context` menu on schema-tree
  // table/view nodes (see package.json contributes.menus.view/item/context).
  // The handler reuses commandOpenConsole so the singleton panel and its
  // existing onRun / draft / autocomplete wiring stay unchanged; if the
  // active connection has no driver yet (none picked or add-connection
  // flow not finished), we fall back to a plain postgres-style snippet.
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.openConsoleForObject",
      (qualifiedOrNode?: unknown) =>
        commandOpenConsoleForObject(mgr, runner, panel, qualifiedOrNode, {
          globalState: context.globalState,
          workspaceState: context.workspaceState,
        }),
    ),
  );
  // 17d. vsdb.openHelpGrid — TASK-OC4O-002: open the VSDB Help Grid webview
  // (a responsive grid of feature cards). Also wired into the webview's
  // `...` (more actions) menu via package.json contributes.menus. The
  // singleton uses the live `disposables` registered-commands set so cards
  // for missing registrations are filtered out before the panel renders.
  disposables.push(
    vscode.commands.registerCommand("vsdb.openHelpGrid", () =>
      commandOpenHelpGrid(disposables),
    ),
  );
  // surfaces a copy-pasteable `omp` command line (Copy button puts it on
  // the clipboard). apiKey is NEVER written to disk; the YAML carries an
  // env-var hint so OMP picks it up from the user's `OPENAI_API_KEY`.
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.ai.useWithOmp",
      async () => commandUseWithOmp(aiStore, adapterFactory),
    ),
  );

  // 19. vsdb.ai.refreshDbContext — cycle AD TASK-003 §9 (refresh path).
  // Re-runs the DB introspection that powers `vsdb-db-context.md` so the
  // appended system-prompt OMP loads is current. Same write path as
  // `vsdb.ai.useWithOmp` minus the on-screen notification (silent refresh).
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.ai.refreshDbContext",
      async () => commandRefreshDbContext(aiStore, adapterFactory),
    ),
  );

  // ── TASK-AHL-004 — admin features (PG-only; mysql/mssql degrade).
  // ADDITIVE: never modifies runStatements body or resultsPanel construction.
  // The admin tree is a sibling view registered alongside vsdb.schemaTree;
  // the sessions/locks panel is a separate webview panel opened by command.
  const adminTree = new AdminTreeProvider(mgr);
  const adminTreeView = vscode.window.createTreeView("vsdb.adminTree", {
    treeDataProvider: adminTree,
  });
  disposables.push(adminTreeView);
  context.subscriptions.push({ dispose: () => adminTree.dispose() });

  // vsdb.refreshAdmin — invalidate the admin tree cache.
  disposables.push(
    vscode.commands.registerCommand("vsdb.refreshAdmin", () => {
      adminTree.refresh();
    }),
  );

  // vsdb.openSessionsPanel — open the sessions/locks webview for the
  // active connection. Reuses the existing single-instance pattern.
  // DBX-08 — after the select-connection warning, admission is the DECLARED
  // admin capability of the active adapter: false/missing declaration shows
  // the concise unsupported message and never creates a panel or resolves an
  // AdminApi member.
  disposables.push(
    vscode.commands.registerCommand("vsdb.openSessionsPanel", async () => {
      const active = mgr.getActive();
      if (!active) {
        void vscode.window.showWarningMessage(
          "VSDB: select a connection first to open the Sessions panel.",
        );
        return;
      }
      let sessionsAdapter: Awaited<ReturnType<typeof mgr.getAdapter>> | null =
        null;
      try {
        sessionsAdapter = await mgr.getAdapter();
      } catch {
        sessionsAdapter = null;
      }
      if (!hasAdapterCapability(sessionsAdapter, "admin")) {
        void vscode.window.showInformationMessage(ADMIN_UNSUPPORTED_MESSAGE);
        return;
      }
      await AdminSessionsPanel.show(mgr, active);
    }),
  );

  // vsdb.killSession / vsdb.terminateSession — drive the same path the
  // panel buttons do. Self-pid detection + confirm modal are owned by
  // AdminSessionsPanelCore, so these stay thin wrappers.
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.killSession",
      async (pid: number) => {
        const panel = AdminSessionsPanel.current;
        if (!panel) {
          void vscode.window.showInformationMessage(
            "VSDB: open the Sessions panel first.",
          );
          return;
        }
        await panel.runKill(pid);
      },
    ),
  );
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.terminateSession",
      async (pid: number) => {
        const panel = AdminSessionsPanel.current;
        if (!panel) {
          void vscode.window.showInformationMessage(
            "VSDB: open the Sessions panel first.",
          );
          return;
        }
        await panel.runTerminate(pid);
      },
    ),
  );

  // vsdb.runGrantSql — host-driven grant/revoke wizard entry. The wizard
  // (adminWizard.ts) opens vscode quickPicks, previews the SQL via
  // adapter.admin.buildGrantSql / buildRevokeSql, and posts the result
  // through the existing confirmDangerousStatements gate (now extended
  // for admin-red). Imported statically at top of file via the same
  // import as AdminTreeProvider/AdminSessionsPanel.
  // DBX-08 — the DECLARED admin capability gates the whole wizard: a
  // false/missing declaration shows the concise unsupported message BEFORE
  // any wizard input, AdminApi builder call, or SQL execution. No active
  // connection is a distinct case — the wizard keeps its own
  // select-connection warning (capability of a non-existent adapter is not
  // the truthful reason there).
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.runGrantSql",
      async (kind: "grant" | "revoke") => {
        if (mgr.getActive()) {
          let grantAdapter: Awaited<
            ReturnType<typeof mgr.getAdapter>
          > | null = null;
          try {
            grantAdapter = await mgr.getAdapter();
          } catch {
            grantAdapter = null;
          }
          if (!hasAdapterCapability(grantAdapter, "admin")) {
            void vscode.window.showInformationMessage(
              ADMIN_UNSUPPORTED_MESSAGE,
            );
            return;
          }
        }
        await commandOpenGrantWizard(mgr, kind, async (sql: string) => {
          // Re-review fix: route the wizard SQL through the SAME guarded
          // pipeline as the editor (admin-red gate + runQuery) instead of
          // a bare adapter.runQuery that bypassed the admin confirmation.
          const parsed = [{ text: sql, start: 0, end: sql.length }];
          const ok = await confirmDangerousStatements(parsed, "postgres");
          if (!ok) {
            throw new Error("Cancelled at the admin confirmation gate.");
          }
          const adapter = await mgr.getAdapter();
          await adapter.runQuery(sql);
        });
      },
    ),
  );

  // ── DBX-01 TASK-DBX01-004 — data workbench: CSV/JSON import wizard,
  // form view, and large-value editor. PostgreSQL only; the importer
  // funnel through confirmDangerousStatements (see runImport).
  const importCtx = {
    getAdapter: async () => {
      try {
        return await mgr.getAdapter();
      } catch {
        return undefined;
      }
    },
    getActiveDriver: () => mgr.getActive()?.driver,
    confirm: async (statements: string[], driver?: string) => {
      const dialect = driver === "postgres" ? "postgres" : driver === "mysql" ? "mysql" : "mssql";
      const parsedStatements = statements.map((text) => ({
        text,
        start: 0,
        end: text.length,
      }));
      return confirmDangerousStatements(parsedStatements, dialect);
    },
    batchSize: vscode.workspace
      .getConfiguration("vsdb")
      .get<number>("import.batchSize", 1000),
  };
  disposables.push(
    vscode.commands.registerCommand("vsdb.importCsv", async () => {
      await openImportWizard("csv", importCtx);
    }),
  );
  disposables.push(
    vscode.commands.registerCommand("vsdb.importJson", async () => {
      await openImportWizard("json", importCtx);
    }),
  );
  const largeValueProvider = getLargeValueProvider();
  disposables.push(largeValueProvider);
  if (
    typeof vscode.workspace.registerTextDocumentContentProvider === "function"
  ) {
    disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        LARGE_VALUE_SCHEME,
        largeValueProvider,
      ),
    );
  }
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.editLargeValue",
      async (cell: { label: string; value: string }) => {
        await openLargeValueEditor(cell);
      },
    ),
  );
  disposables.push(
    vscode.commands.registerCommand("vsdb.openFormView", () => {
      void vscode.window.showInformationMessage(
        "VSDB Form View: select a cell in a results grid and choose 'Open Form'",
      );
    }),
  );
  // ── DBX-03 TASK-DBX03-004 — Schema & Data Compare. Preview-only:
  // the panel never executes the sync plan; clipboard copy hands off
  // to the SQL Console (dangerous-confirm applies there).
  disposables.push(
    vscode.commands.registerCommand("vsdb.compareTables", async () => {
      const adapter = await importCtx.getAdapter();
      const driver = importCtx.getActiveDriver();
      if (!adapter) {
        void vscode.window.showErrorMessage(
          "Schema & Data Compare requires an active PostgreSQL connection.",
        );
        return;
      }
      const source = await promptTableRef("Source table");
      const target = await promptTableRef("Target table");
      if (!source || !target) return;
      const result = await runCompare(
        { source, target },
        adapter,
        driver,
      );
      ComparePanel.get({ extensionUri: context.extensionUri }).show(
        result,
        { source, target },
      );
    }),
  );

  // ── DBX-04 TASK-DBX04-003 — Relationship Explorer. Preview-only FK
  // diagram; export saves a static SVG. PostgreSQL only.
  disposables.push(
    vscode.commands.registerCommand("vsdb.relationshipExplorer", async () => {
      // Driver gate FIRST (no adapter acquisition for mysql/mssql),
      // matching the service's own gate ordering.
      const driver = importCtx.getActiveDriver();
      if (driver !== "postgres") {
        void vscode.window.showErrorMessage(
          "Relationship Explorer requires an active PostgreSQL connection.",
        );
        return;
      }
      const adapter = await importCtx.getAdapter();
      if (!adapter) {
        void vscode.window.showErrorMessage(
          "Relationship Explorer requires an active PostgreSQL connection.",
        );
        return;
      }
      const schemas = await adapter.listSchemas(false).catch(() => []);
      const picks = schemas.map((s) => ({ label: s.name }));
      const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: "Schema to explore",
      });
      if (!picked) return;
      const result = await runErExplorer(adapter, driver, picked.label);
      ErPanel.get({ extensionUri: context.extensionUri }).show(result, {
        schema: picked.label,
      });
    }),
  );

  context.subscriptions.push({ dispose: () => tree.dispose() });
  context.subscriptions.push({ dispose: () => codeLens.dispose() });
  context.subscriptions.push({ dispose: () => aiSettingsForm?.dispose() });
  // TASK-003 cycle Z — console panel teardown with activation.
  context.subscriptions.push({ dispose: () => consolePanel?.dispose() });

  // TASK-ARP09-003 — connection lifecycle seam. Subscribe to the live
  // mgr event AFTER the schema/autocomplete invalidators so our log
  // listener is the one that takes the `cfg` argument. The log message
  // is the literal "connection changed" / "connection closed" — the
  // config object itself is NEVER appended (privacy pin). The severity
  // `info` is a REAL diagnostic write → first such fire creates the
  // Output Channel exactly once, flushes the buffered activate-end
  // lifecycle line, then appends the connection summary directly.
  context.subscriptions.push(
    mgr.onDidChangeActive((cfg) =>
      logDiagnostic(
        "connection",
        "info",
        cfg ? "connection changed" : "connection closed",
      ),
    ),
  );

  // TASK-ARP09-003 — register the lazy diagnostic-channel commands. Both
  // are palette-only and lazy: they flush the pending buffer and reveal
  // / clear the channel on first invocation, creating it if absent.
  // (No new callback plumbing into modules owned by other tasks.)
  disposables.push(
    vscode.commands.registerCommand("vsdb.diagnostics.show", () => {
      getDiagChannel()?.show();
    }),
  );
  disposables.push(
    vscode.commands.registerCommand("vsdb.diagnostics.clear", () => {
      getDiagChannel()?.clear();
    }),
  );

  // TASK-ARP09-003 — buffer the activate-end lifecycle line. The lazy
  // holder treats this single line as the "no-create" signal: it sits
  // in the bounded pending buffer until the first real diagnostic write
  // (or a `vsdb.diagnostics.show` invocation) flushes it through the
  // freshly-created channel. Strict pin #20 — a plain activation with
  // no events/commands never calls `createOutputChannel`.
  logDiagnostic("lifecycle", "info", "VSDB activated");

  disposables.forEach((d) => context.subscriptions.push(d));
}

export async function deactivate(): Promise<void> {
  // TASK-ARP02-004 — post-RLX-02 ordering: in-flight runner work is NOT
  // awaited here (cancel stays user/command-scoped), but every runStatements
  // continuation that settles from this synchronous point on must not write
  // into a disposed panel (render → show() would even recreate the webview).
  deactivating = true;
  for (const d of disposables) {
    try {
      d.dispose();
    } catch {
      // ignore
    }
  }
  disposables = [];
  state = null;
  aiSettingsForm?.dispose();
  aiSettingsForm = null;
  aiChatPanel?.dispose();
  aiChatPanel = null;
  consolePanel?.dispose();
  consolePanel = null;
  helpGridPanel?.dispose();
  helpGridPanel = null;
  // Cycle AIC TASK-AIC-005 — drop the autocomplete wiring.
  autocompleteRegistration?.dispose();
  autocompleteRegistration = null;
  autocompleteService = null;
  if (runScriptTerminal) {
    try {
      runScriptTerminal.dispose();
    } catch {
      /* ignore */
    }
    runScriptTerminal = null;
  }
  // TASK-ARP07-004 — drop the DDL-invalidation seam with its caches.
  invalidateAfterSchemaDdl = null;
  // TASK-ARP09-003 — exactly-once dispose of the lazy diagnostic channel.
  // Additive: runs after every other disposal. A second `deactivate()`
  // (or a post-deactivate `logDiagnostic`) sees `diagOutputChannel === null`
  // and is a no-op. The `deactivating` flag set at function entry keeps
  // `logDiagnostic`/`getDiagChannel` from recreating the channel.
  if (diagOutputChannel) {
    try {
      diagOutputChannel.dispose();
    } catch {
      /* best-effort */
    }
    diagOutputChannel = null;
  }
  diagPendingLines = [];
}

/**
 * TASK-004 — vsdb.openAiSettings: open the AI Settings form (single instance).
 * Reveals existing panel when present; builds a fresh one bound to the
 * store + provider client otherwise.
 */
function commandOpenAiSettings(aiStore: AiConfigStore): void {
  if (!aiSettingsForm) {
    aiSettingsForm = new AiSettingsForm({
      extensionUri: extensionUriForForm,
      store: aiStore,
      complete: (cfg, role, req) =>
        createProviderClient({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          method: cfg.method,
          timeoutMs: cfg.timeoutMs,
        }).complete(req).then((r) => {
          // role is captured by the closure to be consistent with the
          // AiSettingsFormOptions contract — currently the form always uses
          // "work" for the test button smoke call.
          void role;
          return r;
        }),
    });
  }
  aiSettingsForm.show();
}

/**
 * TASK-004 — Build the AcpPanelDeps closure that AiChatPanel consumes in
 * ACP mode. Wires AcpProcess (spawn + handshake) and surfaces the
 * AcpProcessHandle to the panel's permission coordinator. The session/prompt
 * call is server-driven from this point.
 *
 * TASK-012 (B11): the panel now builds an in-process `McpBridge` (see
 * `ensureAcpSession()` in aiChatPanel.ts) exposing the SAME DB tool registry
 * the builtin engine uses (createDbTools + run_sql + export_structure), and
 * passes its ACP `McpServer` descriptor through here as `mcpServers` so the
 * omp engine gets real database access instead of `mcpServers: []`.
 */

function buildAcpDeps(): AcpPanelDeps {
  return {
    // TASK-AIX05-103 cancellable construction seam: `create()` returns the
    // UNSTARTED AcpProcess synchronously via the pinned TASK-AIX05-101
    // constructor so the panel can call `process.start(...)` and, for a
    // same-generation Stop during the handshake, `process.cancel()` on
    // that SAME instance.
    create: (
      ompPath: string,
      cwd: string,
      mcpServers: ReadonlyArray<Record<string, unknown>> = [],
    ) =>
      new AcpProcess({
        ompPath,
        cwd,
        supportCwdFlag: true,
        mcpServers,
      }),
    // Backward compatibility: `start()` is implemented via `create()` —
    // one code path only.
    start: async (
      ompPath: string,
      cwd: string,
      mcpServers?: ReadonlyArray<Record<string, unknown>>,
    ) => {
      const proc = buildAcpDepsCreate(ompPath, cwd, mcpServers);
      return await proc.start();
    },
  };
}

function buildAcpDepsCreate(
  ompPath: string,
  cwd: string,
  mcpServers?: ReadonlyArray<Record<string, unknown>>,
): AcpProcess {
  return new AcpProcess({
    ompPath,
    cwd,
    supportCwdFlag: true,
    mcpServers,
  });
}
async function commandOpenAiChat(
  aiStore: AiConfigStore,
  adapterFactory: AdapterFactory,
  deps: AgentDeps,
  // TASK-AIX03-102 — activation-scoped ConnectionManager; threaded so
  // the panel can subscribe to `mgr.onDidChangeRecoveryStatus` and fail-
  // close any in-flight turn against a recovering or failed connection.
  mgr: ConnectionManager,
): Promise<void> {
  // Cycle AE R4.5/AE.5 — `vsdb.ai.engine` is the user's source of truth.
  // One path: fresh detectOmp() per open; when detection ok, the panel
  // runs the ACP runtime (AcpProcess-backed) with omp's real binary —
  // `resolveEngine()` gates omp-vs-builtin and the config interstitial
  // applies to the builtin engine only. The activation IIFE only does
  // the install-hint gate; no engine object is built at activation.
  if (aiChatPanel) {
    aiChatPanel.show();
    return;
  }
  const engine = vscode.workspace
    .getConfiguration("vsdb")
    .get<string>("ai.engine", "builtin");
  const [detection, cfg] = await Promise.all([
    detectOmp(),
    aiStore.loadConfig(),
  ]);
  if (engine === "omp" && !detection.ok) {
    // User chose omp but binary is missing/too old at open-time — flip
    // back and continue on the builtin path this invocation.
    const hint = detection.available ? OMP_UPDATE_HINT : OMP_INSTALL_HINT;
    void vscode.window.showInformationMessage(
      `VSDB: omp engine unavailable — falling back to builtin. ${hint}`,
    );
    await vscode.workspace
      .getConfiguration("vsdb")
      .update("ai.engine", "builtin", vscode.ConfigurationTarget.Global);
  }
  const choice = resolveEngine({ detection, config: cfg });
  if (choice.requiresConfig) {
    void vscode.window.showInformationMessage(
      "VSDB: Configure AI settings first.",
    );
    await vscode.commands.executeCommand("vsdb.openAiSettings");
    return;
  }
  // AIX-02: refresh the workspace allowlist right before opening the panel
  // so workspace_write's exact-string scope is fresh and non-empty for real
  // workspaces. Registration stays gated on grounding + writeFile.
  if (isGroundingEnabled()) {
    await refreshGroundingFiles();
  }
  aiChatPanel = new AiChatPanel({
    extensionUri: extensionUriForForm,
    deps,
    adapterFactory,
    // AIX-07: feed the RAW configured engine preference into the panel so
    // its funnels consume the central policy — migrated/invalid values
    // fail closed inside resolvePolicy (never re-derived here).
    configuredEngine: vscode.workspace
      .getConfiguration("vsdb")
      .get<unknown>("ai.engine", "builtin"),
    // AIX-01/AIX-02: opt-in workspace grounding + gated file writes.
    // `vsdb.ai.grounding` defaults to false so the pre-AIX-01 turn path is
    // unchanged; writeFile absent → workspace_write is never registered.
    grounding: isGroundingEnabled()
      ? {
          getSelection: readActiveSelection,
          readFile: readWorkspaceFile,
          writeFile: writeWorkspaceFileAtomic,
          filesToRead: groundingFiles,
        }
      : undefined,
    // AIX-02: workspace trust gates grounding reads AND workspace_write
    // registration — untrusted workspaces get neither.
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    acp: choice.engine === "omp" ? buildAcpDeps() : undefined,
    // TASK-AIX05-103: the resolved OMP route gets the production engine
    // adapter (one bridge-owned descriptor/runtime); builtin fallback gets
    // none. See buildOmpChatEngine below for the adapter contract.
    // R4.5 fix (critical_block): the panel's `handleEngineState` is the
    // single restart/fallback owner — AcpProcess lifecycle events MUST
    // reach it. The `onEngineState` closure is resolved LAZILY at event
    // time (not at call time) so the panel reference is valid even
    // though this `commandOpenAiChat` returns BEFORE the panel finishes
    // its first `show()`.
    ompChatEngine:
      choice.engine === "omp"
        ? await buildOmpChatEngine(
            adapterFactory,
            choice.path ?? "omp",
            (state, generation) => {
              const panel = aiChatPanel;
              if (panel !== null) panel.driveEngineState(state, generation);
            },
            // R4.5 fix round 2: closures resolve the LIVE panel at call
            // time (not at commandOpenAiChat time). `installGeneration`
            // bumps the panel's `engineGeneration` via
            // `installOmpEngineObserver` so the captured id matches the
            // LIVE stale-generation guard value. The returned id is
            // captured by `getGeneration`; every state transition
            // threads that id into `driveEngineState`.
            () => {
              const panel = aiChatPanel;
              if (panel !== null) return panel.installOmpEngineObserver();
              return 0;
            },
            (id: number) => id,
          )
        : undefined,
    engineVersion: choice.version,
    engineHint: choice.hint,
    engineOmpPath: choice.path,
    // TASK-AIX03-102 — pass the activation-scoped `mgr` event reference.
    // The panel owns its subscription; we never re-import or re-create a
    // ConnectionManager at this site.
    onDidChangeRecoveryStatus: mgr.onDidChangeRecoveryStatus,
    // TASK-CL-002 — ARP-07 invalidation wiring for the AI plan-apply seam.
    // Lazy thunk: reads the module-private closure at fire time so the
    // :863-867 assignment (which is already in effect by the time the user
    // approves a plan) is observed. The panel's callback shape intentionally
    // omits the dialect param because the panel only holds AdapterFactory
    // (no driver field); the host closure already derives dialect from
    // `mgr.getActive()?.driver` exactly as `runStatements` does at :1982.
    onSchemaDdl: (statements) => {
      invalidateAfterSchemaDdl?.(
        statements,
        toSqlDialect(mgr.getActive()?.driver),
      );
    },
    onDispose: () => {
      aiChatPanel = null;
    },
  });
  aiChatPanel.show();
}

/**
 * TASK-AIX05-103 — production OMP engine adapter for `commandOpenAiChat`.
 *
 * One runtime per panel-open: HostMcp (authoritative standard+curated
 * registry) → McpBridge composition overload (bearer descriptor owner) →
 * AcpProcess (create()-captured UNSTARTED) → the engine's `AcpSession`
 * adapter backed by the process handle's AcpClient → `createOmpChatEngine`
 * with `mcpServers` threaded VERBATIM (no `headers: []` reconstruction).
 * Bridge disposal via engine shutdown is the only remote descriptor
 * deregistration boundary (TASK-AIX05-102).
 *
 * The HostMcp permission `gatePost` is deferred: the panel is constructed
 * AFTER this factory runs, so the sink captures `aiChatPanel` at call time
 * — permission cards reach the live webview through the same wire message
 * the panel already owns.
 */
async function buildOmpChatEngine(
  adapterFactory: AdapterFactory,
  ompPath: string,
  // R4.5 fix (critical_block): the panel's `driveEngineState` is the
  // single restart/fallback owner. AcpProcess's state machine must
  // surface to it; without this wire, the production OMP route never
  // reaches the lifecycle/restart machinery (the six engine_state
  // literals, MAX_ENGINE_RESTARTS=2 + sleep(1000) restart, terminal
  // "fallback-builtin", and same-instance handshake cancel would all
  // be dead on the real route).
  onEngineState: (state: OmpEngineState, generation: number) => void,
  // R4.5 fix round 2: generation installed via panel-owned
  // `installOmpEngineObserver` (bumps `engineGeneration` and returns
  // the LIVE id). `getGeneration(id)` captures the id; every state
  // transition routes that id into `driveEngineState`, where the
  // stale-generation guard matches it against the live
  // `engineGeneration`.
  installGeneration: () => number,
  getGeneration: (id: number) => number,
): Promise<OmpChatEngine> {
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  // Standard registry — the SAME adapterFactory-backed DB tools the builtin
  // engine registers (AgentTool is structurally identical to HostMcpTool).
  const tools: ReadonlyArray<HostMcpTool> = createDbAwareTools(adapterFactory);
  const gatePost: Parameters<typeof createHostMcp>[0]["gatePost"] = (msg) => {
    const panel = aiChatPanel;
    if (panel !== null) {
      // Post the card via the panel (registers the answer resolver) and
      // complete the loop: the user's optionId resolves the gate's pending
      // promise through hostMcp.respond. Deny/timeout/close → undefined.
      void panel.requestHostPermission(msg).then((optionId) => {
        hostMcp.respond(msg.requestId, optionId);
      });
    }
  };
  const hostMcp = createHostMcp({ gatePost, tools });
  await hostMcp.start();
  const bridge = await createMcpBridge(hostMcp);
  // Bridge owns the descriptor; thread it verbatim — the engine must not
  // manufacture a headerless fallback for the production route.
  const mcpServers: ReadonlyArray<Record<string, unknown>> = [bridge.descriptor];
  // create()-captured UNSTARTED process — the pinned cancellable seam. The
  // child spawns LAZILY on the engine's first session/new (the handshake);
  // a same-generation panel Stop before that handshake resolves cancels
  // the captured instance (AcpPanelDeps.create contract).
  const acpProcess = buildAcpDepsCreate(ompPath, cwd, mcpServers);
  // R4.5 fix round 2: capture the installed generation ONCE (the
  // panel's `installOmpEngineObserver` returns the LIVE id that
  // matches the panel's `engineGeneration`). Captured by the
  // `setOnStateChange` closure, threaded into every transition.
  let capturedGeneration = 0;
  const ensureHandle = (): Promise<AcpProcessHandle> => {
    if (handlePromise === null) {
      capturedGeneration = installGeneration();
      acpProcess.setOnStateChange((state) =>
        onEngineState(state, getGeneration(capturedGeneration)),
      );
      handlePromise = acpProcess.start();
    }
    return handlePromise;
  };
  let handlePromise: Promise<AcpProcessHandle> | null = null;
  return createOmpChatEngine({
    acp: adaptProcessToSession(acpProcess, ensureHandle),
    hostMcp,
    cwd,
    mcpServers,
  });
}

/**
 * TASK-AIX05-103 — map the real `AcpProcess` + its `AcpProcessHandle`
 * (AcpClient-backed) onto the engine's `AcpSession` surface. Thin 1:1
 * delegation — no second protocol implementation. The handle materializes
 * on the FIRST session call (lazy `start()`); `notify` is best-effort and
 * silently skips before the handshake exists (matching the engine's
 * contract that cancel() before a session is a no-op latch).
 */
function adaptProcessToSession(
  acpProcess: AcpProcess,
  ensureHandle: () => Promise<AcpProcessHandle>,
): AcpSession {
  const withHandle = async <T>(
    op: (handle: AcpProcessHandle) => Promise<T>,
  ): Promise<T> => op(await ensureHandle());
  return {
    sessionNew: (params) =>
      withHandle((h) =>
        h.acp
          .request<{ sessionId?: unknown }>("session/new", params)
          .then((r) => ({
            sessionId: typeof r.sessionId === "string" ? r.sessionId : "",
          })),
      ),
    sessionPrompt: (sessionId, text) =>
      withHandle((h) =>
        h.acp
          .request<{ stopReason?: unknown }>(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text }] },
            { timeoutMs: 0 },
          )
          .then((r) => ({
            stopReason:
              typeof r.stopReason === "string" ? r.stopReason : undefined,
          })),
      ),
    sessionLoad: (sessionId, sessionCwd, mcpServers) =>
      withHandle((h) =>
        h.acp
          .sessionLoad(sessionId, sessionCwd, mcpServers)
          .then((r) => ({ sessionId, replay: r.replay })),
      ),
    onNotification: (handler) => {
      void ensureHandle().then(
        (h) => h.acp.onNotification(handler),
        () => {
          /* process gone before handshake — no events to forward */
        },
      );
    },
    onClose: (listener) => {
      void ensureHandle().then(
        (h) => h.acp.onClose(listener),
        () => {
          /* process gone before handshake — nothing to close */
        },
      );
    },
    dispose: () => {
      try {
        // AcpProcess.dispose is private; the public idempotent cancel() is
        // the pinned teardown seam — it transitions to "stopped", sends
        // the terminal signal, and settles the bounded teardown.
        acpProcess.cancel();
      } catch {
        /* best-effort */
      }
    },
    notify: (method, params) => {
      void ensureHandle().then(
        (h) => h.acp.notify(method, params),
        () => {
          /* process gone — best-effort notify is a no-op */
        },
      );
    },
  };
}

// ============================================================================
// TASK-AIX07-003 — vsdb.ai.showPolicy / vsdb.ai.exportTrace / vsdb.ai.clearTrace
// ============================================================================

/**
 * Derive the ONE effective AI policy from live host state:
 *   - `vscode.workspace.isTrusted` (AIX-02 seam),
 *   - the RAW configured `vsdb.ai.engine` preference (un-validated; migrated
 *     values must reach resolvePolicy un-trusted and fail closed there),
 *   - the existing `resolveEngine()` choice — its valid
 *     `EngineChoice.engine` IS the effective route (locked decision #2:
 *     configured `builtin` + resolver-selected omp stays ADMITTED).
 * No policy rule is duplicated here — every decision comes from
 * `src/ai/policy.ts`.
 */
async function deriveEffectivePolicy(aiStore: AiConfigStore): Promise<EffectivePolicy> {
  const configuredEngine = vscode.workspace
    .getConfiguration("vsdb")
    .get<unknown>("ai.engine", "builtin");
  const [detection, cfg] = await Promise.all([
    detectOmp(),
    aiStore.loadConfig(),
  ]);
  const choice = resolveEngine({ detection, config: cfg });
  return resolvePolicy({
    workspaceTrusted: vscode.workspace.isTrusted,
    configuredEngine,
    resolvedEngine: choice,
  });
}

/** Format the policy posture for `vsdb.ai.showPolicy` — concise, one line
 * per capability class, no secret-shaped content (policy text only). */
function formatPolicySummary(policy: EffectivePolicy): string {
  const on = "allowed";
  const off = "blocked";
  return [
    `VSDB AI policy — provider: ${policy.provider ?? "unavailable"}`,
    `context: schema ${policy.context.schema ? on : off}, rows ${policy.context.rows ? on : off}, workspace ${policy.context.workspace ? on : off}`,
    `tools: database ${policy.tools.database ? on : off}, workspace ${policy.tools.workspace ? on : off}`,
    `audit export: ${policy.auditExportAllowed ? on : off}`,
    ...(policy.notice ? [policy.notice] : []),
  ].join(" | ");
}

/**
 * TASK-AIX07-003 — vsdb.ai.showPolicy: report the effective provider,
 * context/tool class admission, and audit-export permission. Read-only —
 * no side effects, no picks, no writes.
 */
async function commandShowPolicy(aiStore: AiConfigStore): Promise<void> {
  const policy = await deriveEffectivePolicy(aiStore);
  void vscode.window.showInformationMessage(formatPolicySummary(policy));
  // TASK-ARP09-003 — AI summary seam: read-only command, engine name only.
  logDiagnostic("ai", "info", "policy reported");
}

/**
 * TASK-AIX07-003 — vsdb.ai.exportTrace: write the active AI panel's
 * redacted in-memory trace to a USER-SELECTED file. Order is load-bearing:
 * policy admission is checked BEFORE the save dialog and any bytes touch
 * the filesystem, and an absent active panel is a safe no-op with a
 * concrete notice. The written envelope is `serializeAuditExport()`'s
 * final-redacted JSON — no other trace persistence exists.
 */
async function commandExportTrace(aiStore: AiConfigStore): Promise<void> {
  const policy = await deriveEffectivePolicy(aiStore);
  if (!policy.auditExportAllowed) {
    // Denial BEFORE the picker and BEFORE any write — default deny.
    void vscode.window.showInformationMessage(
      policy.notice || "VSDB AI policy: audit trace export is unavailable.",
    );
    return;
  }
  const panel = aiChatPanel;
  if (!panel) {
    void vscode.window.showInformationMessage(
      "VSDB: no active AI Chat panel — open one with 'VSDB: Open AI Chat' first.",
    );
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    title: "Export VSDB AI audit trace",
    defaultUri: vscode.Uri.file("vsdb-ai-audit.json"),
    filters: { "JSON trace": ["json"] },
  });
  if (!uri) {
    return; // user cancelled — nothing written
  }
  const envelope = serializeAuditExport(panel.dumpAll());
  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(envelope),
  );
  void vscode.window.showInformationMessage(
    "VSDB: AI audit trace exported (redacted).",
  );
}

/**
 * TASK-AIX07-003 — vsdb.ai.clearTrace: drop the active AI panel's recorded
 * turns. Absent panel ⇒ safe no-op with a concrete notice; nothing throws.
 */
async function commandClearTrace(): Promise<void> {
  const panel = aiChatPanel;
  if (!panel) {
    void vscode.window.showInformationMessage(
      "VSDB: no active AI Chat panel — open one with 'VSDB: Open AI Chat' first.",
    );
    return;
  }
  panel.clearTrace();
  void vscode.window.showInformationMessage(
    "VSDB: AI chat trace cleared.",
  );
}
/**
 * TASK-003 cycle Z — vsdb.openConsole: open the SQL Console (single instance).
 * Reveal-on-reshow while live; onDispose drops the module singleton so a
 * closed tab leads to fresh empty state on the next open (AiChatPanel
 * Finding 7 precedent). The injected run callback is explicitly FULL-BUFFER
 * execution: sqlToRun(sql, { start: 0, end: sql.length }, 0, dialect) parses
 * every statement in the Console editor (the `0` cursorOffset is required but
 * unused on the selection branch), and the results delegate to the EXISTING
 * shared runStatements flow — dangerous confirm, keyword qualify, busy state,
 * runner updates, ResultsPanel rendering all retained unchanged.
 */
function commandOpenConsole(
  mgr: ConnectionManager,
  runner: QueryRunner,
  panel: ResultsPanel,
  memento: vscode.Memento,
  draftMemento: vscode.Memento,
): void {
  if (!consolePanel) {
    consolePanel = new ConsolePanel({
      extensionUri: extensionUriForForm,
      memento,
      // ARP-08 TASK-ARP08-004 — workspace-scoped draft persistence. Drafts
      // ride `workspaceState` under CONSOLE_DRAFTS_KEY while query history
      // stays global under CONSOLE_HISTORY_KEY (the `memento` option above).
      draftMemento,
      // Cycle AIC TASK-AIC-005 — Console ghost-text autocomplete. Routes
      // through the AIC-002 service via the AIC-005 registration; per-tab
      // sequence and cancellation stay on the host.
      onAutocomplete: autocompleteRegistration
        ? (req) => autocompleteRegistration!.consoleAutocomplete(req)
        : undefined,
      onRun: async (sql: string) => {
        if (!mgr.getActive()) {
          await promptToAddConnectionOrSelect();
          if (!mgr.getActive()) {
            void vscode.window.showInformationMessage(
              "VSDB: chưa chọn connection. Dùng 'Add Connection' để tạo.",
            );
            return;
          }
        }
        // Full-buffer parse with the ACTIVE connection's dialect so MySQL/MSSQL
        // splitting rules apply to the whole Console editor content.
        const { statements } = sqlToRun(
          sql,
          { start: 0, end: sql.length },
          0,
          toSqlDialect(mgr.getActive()?.driver),
        );
        if (statements.length === 0) {
          void vscode.window.showInformationMessage(
            "VSDB: không có statement để chạy.",
          );
          return;
        }
        await runStatements(mgr, runner, panel, statements);
      },
      // Tab closed by the user → drop the singleton so reopening rebuilds.
      onDispose: () => {
        consolePanel = null;
      },
    });
  }
  consolePanel.show();
}

/**
 * TASK-AF-004 — vsdb.openConsole.createTab: open a fresh tab in an existing
 * Console panel. No-op when the panel hasn't been opened yet (the user must
 * run `vsdb.openConsole` first to seed the singleton).
 */
function commandOpenConsoleCreateTab(): void {
  consolePanel?.createTab();
  consolePanel?.show();
}

/**
 * Resolve a qualified name out of the argument shape used by view/item
 * context-menu commands (string when invoked from a programmatic caller,
 * `{ meta: { schema, objectName } }` when invoked from the schema tree).
 * Returns undefined when the shape doesn't carry an objectName.
 */
function resolveQualifiedFromArg(
  qualifiedOrNode: unknown,
): { qualified: string; schema: string; table: string } | undefined {
  if (typeof qualifiedOrNode === "string" && qualifiedOrNode.length > 0) {
    const lastDot = qualifiedOrNode.lastIndexOf(".");
    if (lastDot < 0) {
      return { qualified: qualifiedOrNode, schema: "", table: qualifiedOrNode };
    }
    return {
      qualified: qualifiedOrNode,
      schema: qualifiedOrNode.slice(0, lastDot),
      table: qualifiedOrNode.slice(lastDot + 1),
    };
  }
  if (
    qualifiedOrNode &&
    typeof qualifiedOrNode === "object" &&
    "meta" in qualifiedOrNode
  ) {
    const meta = (qualifiedOrNode as {
      meta?: { schema?: string; objectName?: string };
    }).meta;
    if (meta?.objectName) {
      const schema = meta.schema ?? "";
      return {
        qualified: schema ? `${schema}.${meta.objectName}` : meta.objectName,
        schema,
        table: meta.objectName,
      };
    }
  }
  return undefined;
}

/**
 * Open the Console (singleton) with a fresh tab pre-filled with a
 * driver-aware SELECT * ... LIMIT/TOP 100 snippet for the picked table/view.
 * Falls back to a plain postgres-style snippet if the active connection has
 * no driver yet — the snippet is editable, never auto-executed.
 */
function commandOpenConsoleForObject(
  mgr: ConnectionManager,
  runner: QueryRunner,
  panel: ResultsPanel,
  qualifiedOrNode: unknown,
  mem: { globalState: vscode.Memento; workspaceState: vscode.Memento },
): void {
  const resolved = resolveQualifiedFromArg(qualifiedOrNode);
  if (!resolved) {
    void vscode.window.showInformationMessage(
      "VSDB: right-click a table or view in the schema tree to open the Console for it.",
    );
    return;
  }
  // Reuse the singleton seeder so the panel + onRun + draft/autocomplete
  // wiring stays exactly the same as `vsdb.openConsole`.
  commandOpenConsole(
    mgr,
    runner,
    panel,
    mem.globalState,
    mem.workspaceState,
  );
  if (!consolePanel) {
    // commandOpenConsole is sync and sets the singleton; defensive guard.
    return;
  }
  const driver = mgr.getActive()?.driver ?? "postgres";
  const snippet = generateSelectForTable({
    driver,
    table: resolved.table,
    schema: resolved.schema,
  });
  // seedTab creates a new tab + pre-fills the buffer + pushes one `state`
  // postMessage so the webview editor shows the snippet. setBuffer would be
  // the WRONG call here — it is the silent webview→host echo path (ARP-08
  // #30) and the snippet would never reach the visible webview.
  consolePanel.seedTab(`Query ${resolved.qualified}`, snippet);
  consolePanel.show();
}

/**
 * TASK-OC4O-002 — open the VSDB Help Grid webview. Singleton lifecycle
 * (mirrors `commandOpenConsole`): create on first call, reveal on
 * subsequent calls, drop the singleton when the user closes the panel.
 * The live `disposables` set is the source of truth for "which command
 * ids are currently registered" — cards whose command id is not in that
 * set are filtered out by the registry before the panel renders.
 */
function commandOpenHelpGrid(
  disposables: readonly vscode.Disposable[],
): void {
  const registered = new Set<string>();
  for (const d of disposables) {
    // `disposables` is typed loosely in this codebase; the registered
    // entries are vscode.CommandDispose shapes whose `command` field carries
    // the command id. Anything else is skipped.
    const cmd = (d as unknown as { command?: unknown }).command;
    if (typeof cmd === "string" && cmd.startsWith("vsdb.")) {
      registered.add(cmd);
    }
  }
  if (!helpGridPanel) {
    helpGridPanel = new HelpGridPanel({
      extensionUri: extensionUriForForm,
      registeredCommandIds: registered,
    });
  }
  helpGridPanel.show();
}

async function runQueryFromEditor(
  mgr: ConnectionManager,
  runner: QueryRunner,
  panel: ResultsPanel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "sql") {
    return;
  }
  // Nếu không có connection active → QuickPick gợi ý Add.
  if (!mgr.getActive()) {
    await promptToAddConnectionOrSelect();
    if (!mgr.getActive()) {
      void vscode.window.showInformationMessage(
        "VSDB: chưa chọn connection. Dùng 'Add Connection' để tạo.",
      );
      return;
    }
  }

  const sql = editor.document.getText();
  const selection = editor.selection;
  const cursor = selection.active;
  const cursorOffset = editor.document.offsetAt(cursor);
  const sel = !selection.isEmpty
    ? {
        start: editor.document.offsetAt(selection.start),
        end: editor.document.offsetAt(selection.end),
      }
    : undefined;
  // (review fix round C, Finding #3) — pass the active connection's real
  // dialect through so MSSQL `GO` batch separators / MySQL backslash string
  // escaping actually apply instead of always splitting as if Postgres.
  const { statements } = sqlToRun(sql, sel, cursorOffset, toSqlDialect(mgr.getActive()?.driver));
  if (statements.length === 0) {
    void vscode.window.showInformationMessage("VSDB: không có statement để chạy.");
    return;
  }
  await runStatements(mgr, runner, panel, statements);
}

/** Run a specific statement (from CodeLens click). */
async function runStatement(
  mgr: ConnectionManager,
  runner: QueryRunner,
  panel: ResultsPanel,
  stmt: ParsedStatement,
): Promise<void> {
  if (!mgr.getActive()) {
    await promptToAddConnectionOrSelect();
    if (!mgr.getActive()) return;
  }
  await runStatements(mgr, runner, panel, [stmt]);
}

// =====================================================================
// TASK-BQ03-005 — BigQuery header composition.
//
// For `driver === "bigquery"` the header carries, after the standard
// "Run at <ISO> — " prefix:
//   bigquery@<dataProject>/<billingProject> @ <location> — job <link-or-id> (GoogleSQL)
// Missing segments render as `—` (em-dash) per format pin; the line is
// always present so users can copy it without ambiguity. Job identity
// is the canonical console link
//   https://console.cloud.google.com/bigquery?project=<billing>&j=bq:<location>:<jobId>
// when jobId is known, falling back to the raw jobId when location is
// missing, and to `—` when neither is known.
//
// The header string is rendered into the webview as textContent
// (webview/main.ts:588) so escapeHtml at this layer is defense-in-depth,
// matching the posture of `escapeHtml` in src/ui/resultsPanel.ts:2259
// (which escapes `& < > " '`). The em-dash placeholder is intentionally
// NOT escaped — it must render literally so the format-pinned missing
// marker stays readable.
//
// Data project precedence: jobRef.projectId (job-time truth) > cfg.bigquery
// .datasetProject (override) > cfg.bigquery.billingProject (legacy fallback).
// =====================================================================

/** Minimal shape we read from `StatementResult.batched.jobRef` (BQ-03.1). */
interface BigQueryJobRefLite {
  projectId: string;
  location: string;
  jobId: string;
}

/** HTML-escape the five entities `escapeHtml` covers in resultsPanel.ts:2259. */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal escape for the link's `project=` query param — escapes `&` only. */
function escape(s: string): string {
  return s.replace(/&/g, "%26");
}

/**
 * Build the per-run header. Non-BigQuery drivers keep the byte-identical
 * `Run at <ISO> — <driver>@<host>/<database>` format (test #6 regression pin).
 * BigQuery: replace the bare driver@host/database with the BQ identity line —
 * host/database are empty strings for BQ connections, so the legacy form
 * would render `bigquery@/` which carries no information. The BQ format
 * pinned by the task spec:
 *   Run at <ISO> — bigquery@<dataProj>/<billingProj> @ <location> — job <link-or-id> (GoogleSQL)
 */
function buildRunHeader(
  isoTime: string,
  active: ConnectionConfig | null | undefined,
  jobRef: BigQueryJobRefLite | null,
): string {
  if (!active || active.driver !== "bigquery") {
    return `Run at ${isoTime} — ${active ? `${active.driver}@${active.host}/${active.database}` : "no connection"}`;
  }
  const billing = active.bigquery?.billingProject ?? "";
  const configured = active.bigquery?.datasetProject ?? "";
  const dataProject = jobRef?.projectId || configured || billing;
  const location =
    jobRef?.location || active.bigquery?.location || "";
  const jobId = jobRef?.jobId ?? "";
  const safeData = escapeHtmlText(dataProject || "—");
  const safeBilling = escapeHtmlText(billing || "—");
  const safeLocation = escapeHtmlText(location || "—");
  const jobSegment = jobId
    ? `job ${escapeHtmlText(
        `https://console.cloud.google.com/bigquery?project=${escape(billing || jobRef?.projectId || "")}&j=bq:${location}:${jobId}`,
      )} (${escapeHtmlText(jobId)})`
    : `job —`;
  return `Run at ${isoTime} — bigquery@${safeData}/${safeBilling} @ ${safeLocation} — ${jobSegment} (GoogleSQL)`;
}

/**
 * Walk THIS run's statement results (`results.slice(appendBase)`) and pick
 * the first one whose `batched` handle exposes a usable `jobRef`. Returns
 * `null` when no statement of this run owns a live jobRef — header then
 * degrades to `—` for the job segment without crashing.
 *
 * BQ-03.1 surfaces the job identity as `batched.jobRef: { projectId, location,
 * jobId }` on the returned handle. The handle is ALSO a BatchedQuery with
 * `fetchBatch`/`cancel`/`close` methods — we read only the `jobRef` field
 * here.
 */
function pickJobRefFromRun(
  runSlice: ReadonlyArray<{ batched?: unknown }>,
): BigQueryJobRefLite | null {
  for (const stmt of runSlice) {
    const batched = stmt.batched as
      | { jobRef?: BigQueryJobRefLite | null }
      | undefined;
    const j = batched?.jobRef;
    if (j && typeof j.jobId === "string" && j.jobId.length > 0) {
      return {
        projectId: j.projectId ?? "",
        location: j.location ?? "",
        jobId: j.jobId,
      };
    }
  }
  return null;
}

/**
 * TASK-007 — Qualify reserved-keyword table names in `statements` against the
 * active adapter's public schema. Returns the original array reference if no
 * rewrite happened. On adapter error (no active connection, missing password,
 * etc) the original statements pass through — never block the run.
 */
async function applyKeywordQualify(
  mgr: ConnectionManager,
  statements: ParsedStatement[],
): Promise<ParsedStatement[]> {
  // Skip transform when no adapter is reachable (QuickPick path / unconfigured).
  const adapter = await mgr.getAdapter().catch(() => null);
  if (!adapter) return statements;
  // Only Postgres supports unquoted reserved-keyword ambiguity — skip others.
  const active = mgr.getActive();
  if (active?.driver !== "postgres") return statements;
  // D1: one cache for the WHOLE run, not one catalog round-trip per
  // statement — a multi-statement script previously paid `listTables` once
  // per statement even though the schema can't change mid-run.
  const cache = createKeywordTableCache();
  const rewritten: ParsedStatement[] = [];
  for (const stmt of statements) {
    const res = await qualifyKeywordTables(
      stmt.text,
      (schema) => adapter.listTables(schema).then((rows) => rows.map((r) => r.name)),
      { cache },
    );
    rewritten.push(res.changed ? { ...stmt, text: res.sql } : stmt);
  }
  return rewritten;
}

 async function runStatements(
  mgr: ConnectionManager,
  runner: QueryRunner,
  panel: ResultsPanel,
  statements: ParsedStatement[],
): Promise<void> {
  const active = mgr.getActive();
  // TASK-606 — Confirm guard TRƯỚC mọi side-effect (kể cả busy state): cancel
  // huỷ toàn bộ lô, không statement nào được submit.
  // (review fix round C, Finding #3/#5) — pass the active dialect through so
  // `analyzeStatement`'s literal/comment masking matches whatever dialect
  // `splitStatements` used to produce `statements` in the first place; else
  // the guard can misclassify a MySQL backslash-escaped string body (see
  // `dangerousStatement.ts` Finding #5) and silently skip a confirm dialog.
  if (!(await confirmDangerousStatements(statements, toSqlDialect(active?.driver)))) {
    return;
  }
  // TASK-007 — Rewrite reserved-keyword table names after FROM/INTO/UPDATE/JOIN
  // to `public.<name>` so Postgres doesn't reject `SELECT * FROM order;` with a
  // `syntax error at or near "order"`. Only touches identifiers that resolve to
  // actual tables in `public` (see core/keywordQualify).
  const rewritten = await applyKeywordQualify(mgr, statements);
  const isoTime = new Date().toISOString();
  // TASK-BQ03-005 — BigQuery runs carry a richer header (data project / billing
  // project / location / job identity + GoogleSQL marker). Built ONCE here for
  // the streaming onUpdate path with placeholders for the live jobRef, then
  // rebuilt once more after `runner.run` settles so the live jobRef (BATCH-3.1's
  // `BigQueryJobRef` shape on `StatementResult.batched.jobRef`) reaches the
  // panel. Non-BigQuery header remains byte-identical to the prior format.
  const header = buildRunHeader(isoTime, active, /* jobRef */ null);
  const appendBase = runner.getResults().length;
  // TASK-ARP02-004 — host-side ownership gates. Two gaps the panel-internal
  // session epoch (TASK-ARP02-002) cannot close, because these calls are
  // extension code calling INTO the panel, not panel continuations:
  //   1. Overlap: the shared QueryRunner rejects a second concurrent run()
  //      with "already running"; this invocation's finally would still fire
  //      panel.setBusy(false) WHILE the first run is in flight — clearing
  //      the live session's busy state (the re-created/newest panel then
  //      renders as not-busy while a query is still running). Snapshot the
  //      runner's in-flight state BEFORE this invocation claims busy: only
  //      an invocation that found the runner idle — and therefore owns this
  //      run — may clear busy in its finally. There is no await between the
  //      snapshot and runner.run(), so the snapshot cannot go stale before
  //      run() validates it again internally.
  //   2. Deactivate: a run settling after teardown started must not render
  //      into / restyle the panel VS Code is disposing (a late render would
  //      even resurrect a webview via ResultsPanel.show()).
  const ownsRun = !runner.isRunning();
  panel.setBusy(true);
  try {
    const results = await runner.run(rewritten, () => {
      // Each onUpdate re-render the panel (skip after teardown started).
      if (!deactivating) {
        panel.render(runner.getResults(), header, { appendBase });
      }
    }, { append: true });
    if (!deactivating) {
      // TASK-BQ03-005 R4.5 — `runner.run(..., { append: true })` returns the
      // FULL accumulated array (queryRunner.ts:281 — `return this.results.slice()`),
      // not this invocation's slice. On a 2nd BigQuery run in-session, the
      // post-settle re-render must read from THIS run's slice only —
      // `results.slice(appendBase)` — so the new run's jobRef is what reaches
      // the panel header (the prior run's batched handle is what
      // `results[0]?.batched` would point at). Among THIS run's statements,
      // pick the first one with a live `batched.jobRef` so a multi-statement
      // run where statement 0 errors doesn't degrade the header to `—`.
      const runSlice = results.slice(appendBase);
      // TASK-BQ04-001 — stamp `dialect: "bigquery"` (+ structural
      // `schemaFields`) on every settled statement of THIS run when the
      // active connection is BigQuery. The helper is pure / dependency-
      // light (see `src/core/bqDialect.ts`) and a no-op on every non-BQ
      // driver — `dialect` stays `undefined` so the formatCell path
      // TASK-BQ04-002 reads stays byte-identical on postgres/mysql/mssql.
      // Stamping happens AFTER `runner.run()` settles and BEFORE
      // `panel.render(...)` so the post-settle render carries the marker;
      // the streaming `onUpdate` path above intentionally does NOT stamp
      // (running/pending states don't need the marker and the slice at
      // that point may be partial).
      stampBqDialect(runSlice, active);
      const liveJobRef = pickJobRefFromRun(runSlice);
      const finalHeader = buildRunHeader(isoTime, active, liveJobRef);
      panel.render(results, finalHeader, { appendBase });
      // TASK-ARP07-004 — feed ONLY the statements that actually completed
      // (`status === "done"`, original text on `.sql` per queryRunner.ts:49-52)
      // to the classifier; failed/cancelled statements must not invalidate.
      // Inside the `!deactivating` gate: a run settling after teardown must
      // not invalidate either (no post-deactivation resurrected writes).
      const completed = results
        .filter((r) => r.status === "done")
        .map((r) => r.sql);
      invalidateAfterSchemaDdl?.(completed, toSqlDialect(active?.driver));
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `VSDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // TASK-ARP02-004 — gates above: a stale invocation's finally must NOT
    // clear the live run's busy state (the live run's own finally does);
    // after deactivate() started, no panel write at all.
    if (ownsRun && !deactivating) {
      panel.setBusy(false);
    }
  }
}

/** Cap detail modal để dialog không tràn (VS Code không scroll detail). */
const RED_DETAIL_CAP = 2000;
const AMBER_DETAIL_CAP = 500;

/**
 * DBX-03 — prompt for a schema-qualified table reference
 * ("schema.table" or "table"; schema defaults to "public").
 * Undefined when the user cancels.
 */
async function promptTableRef(
  label: string,
): Promise<{ schema: string; table: string } | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt: `${label} (schema.table)`,
    placeHolder: "public.users",
    validateInput: (v) =>
      /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/.test(v)
        ? undefined
        : "Expected table or schema.table identifier",
  });
  if (!raw) return undefined;
  const [schemaOrTable, table] = raw.split(".");
  return table
    ? { schema: schemaOrTable, table }
    : { schema: "public", table: schemaOrTable };
}

// TASK-AIX04-003 — consent gate moved to src/ui/confirmDangerous.ts so the
// AI chat panel's plan-apply path uses the SAME modal logic. Re-exported
// here to keep existing call sites (runStatements, runImport, adminWizard
// flows) intact.
import { confirmDangerousStatements } from "./ui/confirmDangerous";
export { confirmDangerousStatements, RED_DETAIL_CAP, AMBER_DETAIL_CAP } from "./ui/confirmDangerous";

async function promptToAddConnectionOrSelect(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "$(add) Add Connection", action: "add" },
      { label: "$(list-unordered) Select existing", action: "select" },
    ],
    { placeHolder: "VSDB: chưa chọn connection. Chọn thao tác:" },
  );
  if (!pick) return;
  if (pick.action === "add") {
    await vscode.commands.executeCommand("vsdb.addConnection");
  } else {
    await vscode.commands.executeCommand("vsdb.selectConnection");
  }
}

async function commandAddConnection(mgr: ConnectionManager): Promise<void> {
  await openConnectionForm(mgr, null);
}

function openConnectionForm(
  mgr: ConnectionManager,
  existing: ConnectionConfig | null,
): void {
  const form = new ConnectionForm({
    extensionUri: extensionUriForForm,
    existing,
    factory: createAdapter,
    getStoredPassword: (id) => mgr.getStoredPassword(id),
    onSave: async (payload, existingId) => {
      if (existingId === null) {
        const cfg: ConnectionConfig = {
          id: `${payload.driver}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: payload.name,
          driver: payload.driver,
          host: payload.host,
          port: payload.port,
          user: payload.user,
          database: payload.database,
          sslMode: payload.sslMode,
          sslCaPath: payload.sslCaPath || undefined,
          sslCertPath: payload.sslCertPath || undefined,
          sslKeyPath: payload.sslKeyPath || undefined,
          manualCommit: payload.manualCommit,
          folder: payload.folder || undefined,
          color: payload.color || undefined,
          readOnly: payload.readOnly,
          tunnel: payload.tunnelHost
            ? {
                host: payload.tunnelHost,
                port: payload.tunnelPort || undefined,
                user: payload.tunnelUser || undefined,
                identityFile: payload.tunnelIdentityFile || undefined,
              }
            : undefined,
         };
        await mgr.addConnection(cfg, payload.password);
        // Tree hiện connection list ngay (root nodes) — không cần chờ user refresh.
        state?.tree.refresh();
        void vscode.window.showInformationMessage(`VSDB: added "${cfg.name}"`);
      } else {
        await mgr.editConnection(
          existingId,
          {
            name: payload.name,
            driver: payload.driver,
            host: payload.host,
            port: payload.port,
            user: payload.user,
            database: payload.database,
            sslMode: payload.sslMode,
            sslCaPath: payload.sslCaPath || undefined,
            sslCertPath: payload.sslCertPath || undefined,
            manualCommit: payload.manualCommit,
            folder: payload.folder || undefined,
            color: payload.color || undefined,
            readOnly: payload.readOnly,
            tunnel: payload.tunnelHost
              ? {
                  host: payload.tunnelHost,
                  port: payload.tunnelPort || undefined,
                  user: payload.tunnelUser || undefined,
                  identityFile: payload.tunnelIdentityFile || undefined,
                }
              : undefined,
          },
          payload.password.length > 0 ? payload.password : undefined,
        );
        state?.tree.refresh();
        void vscode.window.showInformationMessage(`VSDB: updated "${payload.name}"`);
      }
    },
  });
  form.show();
}

async function commandEditConnection(
  mgr: ConnectionManager,
  arg?: { id?: string },
): Promise<void> {
  let id = arg?.id;
  if (!id) {
    const cs = mgr.listConnections();
    if (cs.length === 0) {
      void vscode.window.showInformationMessage("VSDB: chưa có connection.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      cs.map((c) => ({ label: c.name, id: c.id })),
      { placeHolder: "Select connection to edit" },
    );
    if (!pick) return;
    id = pick.id;
  }
  const current = mgr.listConnections().find((c) => c.id === id);
  if (!current) return;
  openConnectionForm(mgr, current);
}

async function commandDeleteConnection(
  mgr: ConnectionManager,
  arg?: { id?: string },
): Promise<void> {
  let id = arg?.id;
  if (!id) {
    const cs = mgr.listConnections();
    if (cs.length === 0) {
      void vscode.window.showInformationMessage("VSDB: chưa có connection.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      cs.map((c) => ({ label: c.name, id: c.id })),
      { placeHolder: "Select connection to delete" },
    );
    if (!pick) return;
    id = pick.id;
  }
  const cs = mgr.listConnections();
  const target = cs.find((c) => c.id === id);
  if (!target) return;
  const confirm = await vscode.window.showQuickPick(
    [
      { label: "Yes, delete", value: true },
      { label: "Cancel", value: false },
    ],
    { placeHolder: `Delete "${target.name}"?` },
  );
  if (!confirm || !confirm.value) return;
  await mgr.deleteConnection(id!);
  state?.tree.refresh();
  void vscode.window.showInformationMessage(`VSDB: deleted "${target.name}"`);
}

async function commandSelectConnection(mgr: ConnectionManager): Promise<void> {
  const cs = mgr.listConnections();
  if (cs.length === 0) {
    void vscode.window.showInformationMessage(
      "VSDB: chưa có connection. Add Connection trước.",
    );
    return;
  }
  const active = mgr.getActive();
  const pick = await vscode.window.showQuickPick(
    cs.map((c) => ({
      label: `${active?.id === c.id ? "$(pass-filled) " : ""}${c.name} [${c.driver}]`,
      id: c.id,
      description: `${c.host}:${c.port}/${c.database}`,
    })),
    { placeHolder: "Select active connection" },
  );
  if (!pick) return;
  await mgr.setActive(pick.id);
}

async function commandGenerateSelect(
  mgr: ConnectionManager,
  qualifiedOrNode?: unknown,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("VSDB: no active editor.");
    return;
  }
  // Resolve the meta from arg, or — most reliably — the package.json view/item/context
  // menu passes the qualified name string directly. Otherwise pick from active
  // connection's tables.
  let driver: ConnectionConfig["driver"] | undefined;
  let qualified: string | undefined;
  if (typeof qualifiedOrNode === "string") {
    qualified = qualifiedOrNode;
    // Không có meta → fallback dialect theo ACTIVE connection (giữ hành vi cũ).
    const active = mgr.getActive();
    driver = active?.driver;
  } else if (
    qualifiedOrNode &&
    typeof qualifiedOrNode === "object" &&
    "meta" in qualifiedOrNode
  ) {
    const meta = (
      qualifiedOrNode as {
        meta?: {
          schema?: string;
          objectName?: string;
          connection?: ConnectionConfig;
        };
      }
    ).meta;
    if (meta && meta.objectName) {
      qualified = qualifiedName({ table: meta.objectName, schema: meta.schema ?? "" });
      // Dialect phải theo NODE's connection (không phải ACTIVE). Đây chính là fix
      // cho việc right-click bảng MySQL trong khi active là Postgres → template
      // sai driver trước fix này.
      if (meta.connection) {
        driver = meta.connection.driver;
      }
    }
  }
  if (!qualified) {
    void vscode.window.showInformationMessage(
      "VSDB: right-click a table/view to generate SELECT.",
    );
    return;
  }
  if (!driver) {
    // Fallback cuối: nếu không resolve được driver, dùng ACTIVE hoặc refuse.
    const active = mgr.getActive();
    if (!active) {
      void vscode.window.showInformationMessage("VSDB: no active connection.");
      return;
    }
    driver = active.driver;
  }
  const sql = generateSelectForTable({
    driver,
    table: qualified.includes(".") ? qualified.split(".").slice(-1)[0] : qualified,
    schema: qualified.includes(".")
      ? qualified.split(".").slice(0, -1).join(".")
      : "",
  });
  await editor.insertSnippet(new vscode.SnippetString(sql));
}

async function commandCopyQualifiedName(qualifiedOrNode?: unknown): Promise<void> {
  let text: string | undefined;
  if (typeof qualifiedOrNode === "string") {
    text = qualifiedOrNode;
  } else if (
    qualifiedOrNode &&
    typeof qualifiedOrNode === "object" &&
    "meta" in qualifiedOrNode
  ) {
    const meta = (qualifiedOrNode as {
      meta?: { schema?: string; objectName?: string; column?: { name: string } };
    }).meta;
    if (meta?.objectName) {
      text = qualifiedName({ table: meta.objectName, schema: meta.schema ?? "" });
    } else if (meta?.column?.name) {
      text = meta.column.name;
    }
  }
  if (!text) return;
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(
    `VSDB: copied "${text}"`,
    2000,
  );
}

/**
 * TASK-505 — Send the active shell script's full text to a reused terminal
 * ("VSDB Script"). Behaves like pasting the entire file into the shell.
 */
async function commandRunScript(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  // TASK-605: no editor (palette invocation without open file) → warn, KHÔNG gửi text vào terminal.
  if (!editor) {
    void vscode.window.showWarningMessage(
      "VSDB: open a .sh file to run",
    );
    return;
  }
  const text = editor.document.getText();
  // Terminal còn sống (exitStatus undefined) → reuse; ngược lại tạo mới.
  if (!runScriptTerminal || runScriptTerminal.exitStatus !== undefined) {
    runScriptTerminal = vscode.window.createTerminal({ name: "VSDB Script" });
  }
  runScriptTerminal.sendText(text + "\n");
  runScriptTerminal.show();
}

/**
 * TASK-003 cycle AD §9/§10 — `vsdb.ai.useWithOmp`.
 *
 * Writes `.vscode/vsdb-ai-config.yml` + `.vscode/vsdb-db-context.md` and
 * shows an information message containing the copy-pasteable `omp` command
 * line. The "Copy" button puts the command line on the clipboard.
 *
 * Falls back gracefully when no workspace folder is open (info message
 * + no-op). Falls back to defaults when AI settings haven't been saved
 * (so the user can still try the command — `omp` will pick up
 * `OPENAI_API_KEY` from the env).
 */
async function commandUseWithOmp(
  aiStore: AiConfigStore,
  adapterFactory: AdapterFactory,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage(
      "VSDB: open a folder before running `Use with OMP`.",
    );
    return;
  }
  const live = await aiStore.loadSettings();
  const settings: AiSettings = live ?? defaultAiSettings();
  const history: ReadonlyArray<never> = [];
  const result = await writeVsdbAiConfig(folder, settings, adapterFactory, history);
  // Surface a Copy button so the user can paste into a terminal.
  const choice = await vscode.window.showInformationMessage(
    `VSDB: OMP config written. Run this in a terminal:\n\n${result.ompCommandLine}`,
    { modal: false },
    "Copy",
  );
  if (choice === "Copy") {
    await vscode.env.clipboard.writeText(result.ompCommandLine);
  }
}

/**
 * TASK-003 cycle AD §9 — `vsdb.ai.refreshDbContext`.
 *
 * Re-runs DB introspection and rewrites `.vscode/vsdb-db-context.md`. The
 * YAML is not rewritten (provider / model settings haven't changed) but
 * we route through `writeVsdbAiConfig` to keep a single write path — the
 * YAML overwrite is idempotent.
 *
 * No notification on success (silent refresh per the command spec).
 * Errors surface as a status-bar message so they don't interrupt flow.
 */
async function commandRefreshDbContext(
  aiStore: AiConfigStore,
  adapterFactory: AdapterFactory,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage(
      "VSDB: open a folder before refreshing the DB context.",
    );
    return;
  }
  const live = await aiStore.loadSettings();
  const settings: AiSettings = live ?? defaultAiSettings();
  const history: ReadonlyArray<never> = [];
  try {
    await writeVsdbAiConfig(folder, settings, adapterFactory, history);
  } catch (err) {
    void vscode.window.setStatusBarMessage(
      `VSDB: refresh failed — ${err instanceof Error ? err.message : String(err)}`,
      5000,
    );
  }
}
