// src/extension.ts
// VSDB extension entry — TASK-007 wires all commands + tree view + CodeLens + status bar.
import * as vscode from "vscode";
import { ConnectionManager } from "./core/connectionManager";
import { createAdapter } from "./adapters/factory";
import { QueryRunner } from "./core/queryRunner";
import { ResultsPanel, type SaveContext } from "./ui/resultsPanel";
import { createStatusBar } from "./ui/statusBar";
import {
  SchemaTreeProvider,
  generateSelectForTable,
  qualifiedName,
  registerSchemaTreeProvider,
} from "./ui/schemaTree";
import { registerTableCommands } from "./ui/tableCommands";
import { VsdbCodeLensProvider } from "./ui/codeLensProvider";
import { ConnectionForm } from "./ui/connectionForm";
import { sqlToRun, type SqlDialect } from "./core/statementParser";
import {
  createKeywordTableCache,
  qualifyKeywordTables,
} from "./core/keywordQualify";
import { analyzeStatement, guardTier } from "./core/dangerousStatement";
import { truncateAtBoundary } from "./core/text";
import { AiConfigStore } from "./ai/config";
import { AiSettingsForm } from "./ui/aiSettingsForm";
import { createProviderClient } from "./ai/provider";
import type { AdapterFactory } from "./ai/tools/types";
import type { AgentDeps } from "./ai/agent";
import { AiChatPanel, type AcpPanelDeps } from "./ui/aiChatPanel";
import { ConsolePanel } from "./ui/consolePanel";
import { AcpProcess } from "./ai/omp/acpProcess";
import { detectOmp, OMP_INSTALL_HINT, OMP_UPDATE_HINT } from "./ai/omp/detect";
import { resolveEngine } from "./ai/engineChoice";
import { createOmpChatEngine, type OmpChatEngine } from "./ai/omp/ompChatEngine";
import type { AcpSession } from "./ai/omp/ompChatEngine";
import { createHostMcp } from "./ai/omp/hostMcp";
import { registerBrowseCommands } from "./ui/browseCommands";
import { SchemaCache } from "./ui/schemaCache";
import { SqlCompletionProvider } from "./ui/sqlCompletionProvider";
import {
  SQL_SEMANTIC_LEGEND,
  SqlSemanticTokensProvider,
} from "./ui/sqlSemanticTokens";
import { defaultAiSettings, type AiSettings } from "./ai/settings";
import type { ConnectionConfig, ParsedStatement } from "./config/types";
import { writeVsdbAiConfig } from "./extensionConfigExport";
let disposables: vscode.Disposable[] = [];
let state: ExtensionState | null = null;
/** Cached single-instance AiSettingsForm (TASK-004). Reused across calls. */
let aiSettingsForm: AiSettingsForm | null = null;
/** Cached single-instance AiChatPanel (TASK-004). Reused across calls. */
let aiChatPanel: AiChatPanel | null = null;
let consolePanel: ConsolePanel | null = null;

/**
 * Cycle AE R4.5 — Engine source of truth at activation. Constructed during
 * `activate()` when the user-toggled `vsdb.ai.engine` is "omp" AND
 * `detectOmp()` reports a usable binary. `commandOpenAiChat` reads this
 * reference to decide which engine to wire into the panel.
 */
let ompChatEngineRef: OmpChatEngine | null = null;
/** Cached omp version string for the engine banner. */
let ompEngineVersion: string | undefined = undefined;
/** extensionUri capture ở activate() — dùng cho ConnectionForm webview resources. */
let extensionUriForForm: vscode.Uri = vscode.Uri.file("/");
let runScriptTerminal: vscode.Terminal | null = null;

interface ExtensionState {
  mgr: ConnectionManager;
  runner: QueryRunner;
  panel: ResultsPanel;
  tree: SchemaTreeProvider;
  codeLens: VsdbCodeLensProvider;
  statusBar: vscode.StatusBarItem;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  disposables = [];
  extensionUriForForm = context.extensionUri;

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
  registerTableCommands({ mgr, tree, treeView, context });

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
  const codeLens = new VsdbCodeLensProvider(() => mgr.getActive()?.driver);
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
  disposables.push(
    vscode.commands.registerCommand("vsdb.cancelQuery", () => {
      void runner.cancel();
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
  if (initialEngine === "omp") {
    // Cycle AE R4.5 — Engine source of truth at activation. The actual
    // construction is fire-and-forget (matches pre-cycle-AE IIFE pattern
    // for tests that sync-call activate); `commandOpenAiChat` falls
    // back to the builtin path silently if `ompChatEngineRef` is still
    // null when the user opens chat. PLAN_AE.md §Acceptance 0/1/8.
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
        ompChatEngineRef = null;
        return;
      }
      try {
        const hostMcp = createHostMcp({
          gatePost: () => {
            /* see makeActivationAcpShim below — panel rebinds its own gate */
          },
          tools: [],
        });
        ompEngineVersion = detection.version;
        ompChatEngineRef = createOmpChatEngine({
          acp: makeActivationAcpShim(),
          hostMcp,
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "/",
        });
      } catch {
        // Defensive: any failure during engine construction must NOT
        // crash activate(). Fall back to builtin.
        ompChatEngineRef = null;
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
      commandOpenAiChat(aiStore, adapterFactory, aiChatDeps),
    ),
  );

  // 17. vsdb.openConsole — TASK-003 cycle Z: DataGrip-style SQL Console
  // (single instance). Run executes the WHOLE buffer via the shared
  // runStatements flow; Save writes the buffer through an OS save dialog.
  disposables.push(
    vscode.commands.registerCommand("vsdb.openConsole", () =>
      commandOpenConsole(mgr, runner, panel),
    ),
  );

  // 18. vsdb.ai.useWithOmp — cycle AD TASK-003 §9/§10
  // Writes `.vscode/vsdb-ai-config.yml` + `.vscode/vsdb-db-context.md` and
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



  // Dispose schemaTree + codeLens on deactivate to drop subscriptions + cache.
  context.subscriptions.push({ dispose: () => tree.dispose() });
  context.subscriptions.push({ dispose: () => codeLens.dispose() });
  context.subscriptions.push({ dispose: () => aiSettingsForm?.dispose() });
  // TASK-003 cycle Z — console panel teardown with activation.
  context.subscriptions.push({ dispose: () => consolePanel?.dispose() });

  disposables.forEach((d) => context.subscriptions.push(d));
}

export async function deactivate(): Promise<void> {
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
  if (runScriptTerminal) {
    try {
      runScriptTerminal.dispose();
    } catch {
      /* ignore */
    }
    runScriptTerminal = null;
  }
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

/** AcpSession shim used to construct `OmpChatEngine` as a stored
 * reference at activation. The real session needs a live omp process
 * (AcpProcess.start), which must NOT happen here. The shim's rpc
 * methods throw — the first `engine.send()` from `runOmpEngineTurn`
 * will see the rejection, post one error bubble, and flip the setting
 * back to "builtin" via the panel's mid-turn fallback. */
function makeActivationAcpShim(): AcpSession {
  const notImplemented = (): never => {
    throw new Error("AcpSession shim: not wired at activation");
  };
  return {
    sessionNew: notImplemented,
    sessionPrompt: notImplemented,
    sessionLoad: notImplemented,
    onNotification: () => undefined,
    onClose: () => undefined,
    dispose: () => undefined,
  };
}
function buildAcpDeps(): AcpPanelDeps {
  return {
    start: async (
      ompPath: string,
      cwd: string,
      mcpServers: ReadonlyArray<Record<string, unknown>> = [],
    ) => {
      const proc = new AcpProcess({
        ompPath,
        cwd,
        supportCwdFlag: true,
        mcpServers,
      });
      return await proc.start();
    },
  };
}
async function commandOpenAiChat(
  aiStore: AiConfigStore,
  adapterFactory: AdapterFactory,
  deps: AgentDeps,
): Promise<void> {
  // Cycle AE R4.5 — Engine selection. The user-toggled `vsdb.ai.engine`
  // is the source of truth. Three branches:
  //   1. engine="omp" AND ompChatEngineRef set → thread the pre-built
  //      OmpChatEngine through to the panel.
  //   2. engine="omp" AND ompChatEngineRef null → activation's fire-and-
  //      forget init hasn't finished (or it detected a missing binary
  //      and flipped the setting to "builtin"); fall back to the
  //      builtin path silently — no interstitial.
  //   3. engine="builtin" → existing resolveEngine() path with config
  //      interstitial when needed.
  if (aiChatPanel) {
    aiChatPanel.show();
    return;
  }
  const engine = vscode.workspace
    .getConfiguration("vsdb")
    .get<string>("ai.engine", "builtin");
  if (engine === "omp" && ompChatEngineRef !== null) {
    aiChatPanel = new AiChatPanel({
      extensionUri: extensionUriForForm,
      deps,
      adapterFactory,
      acp: buildAcpDeps(),
      ompChatEngine: ompChatEngineRef,
      engineVersion: ompEngineVersion,
      onDispose: () => {
        aiChatPanel = null;
      },
    });
    aiChatPanel.show();
    return;
  }
  // Fallback path (builtin OR engine=omp without a constructed ref).
  // For tests + activation race, do a fresh detectOmp() pass here so
  // the panel can still be wired for omp when activation's IIFE hasn't
  // completed yet.
  const [detection, cfg] = await Promise.all([
    detectOmp(),
    aiStore.loadConfig(),
  ]);
  const choice = resolveEngine({ detection, config: cfg });
  if (choice.requiresConfig) {
    void vscode.window.showInformationMessage(
      "VSDB: Configure AI settings first.",
    );
    await vscode.commands.executeCommand("vsdb.openAiSettings");
    return;
  }
  aiChatPanel = new AiChatPanel({
    extensionUri: extensionUriForForm,
    deps,
    adapterFactory,
    acp: choice.engine === "omp" ? buildAcpDeps() : undefined,
    engineVersion: choice.version,
    engineHint: choice.hint,
    engineOmpPath: choice.path,
    onDispose: () => {
      aiChatPanel = null;
    },
  });
  aiChatPanel.show();
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
): void {
  if (!consolePanel) {
    consolePanel = new ConsolePanel({
      extensionUri: extensionUriForForm,
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
          mgr.getActive()?.driver,
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
  const { statements } = sqlToRun(sql, sel, cursorOffset, mgr.getActive()?.driver);
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
  if (!(await confirmDangerousStatements(statements, active?.driver))) {
    return;
  }
  // TASK-007 — Rewrite reserved-keyword table names after FROM/INTO/UPDATE/JOIN
  // to `public.<name>` so Postgres doesn't reject `SELECT * FROM order;` with a
  // `syntax error at or near "order"`. Only touches identifiers that resolve to
  // actual tables in `public` (see core/keywordQualify).
  const rewritten = await applyKeywordQualify(mgr, statements);
  const header = `Run at ${new Date().toISOString()} — ${active ? `${active.driver}@${active.host}/${active.database}` : "no connection"}`;
  panel.setBusy(true);
  try {
    const results = await runner.run(rewritten, () => {
      // Each onUpdate re-render the panel.
      panel.render(runner.getResults(), header);
    });
    panel.render(results, header);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `VSDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    panel.setBusy(false);
  }
}

/** Cap detail modal để dialog không tràn (VS Code không scroll detail). */
const RED_DETAIL_CAP = 2000;
const AMBER_DETAIL_CAP = 500;

/**
 * TASK-606 — Hỏi lại user trước khi chạy statement phá hoại.
 * Trả `true` = proceed, `false` = user cancel (huỷ CẢ LÔ).
 * Tier đỏ (DELETE/UPDATE không WHERE, mọi TRUNCATE/DROP) thắng tier amber.
 */
async function confirmDangerousStatements(
  statements: ParsedStatement[],
  dialect?: SqlDialect,
): Promise<boolean> {
  const enabled =
    vscode.workspace
      .getConfiguration("vsdb")
      .get<boolean>("confirmDestructive") ?? true;
  if (!enabled) return true;

  const red: string[] = [];
  const amber: string[] = [];
  for (const stmt of statements) {
    const tier = guardTier(analyzeStatement(stmt.text, dialect));
    if (tier === "red") red.push(stmt.text.trim());
    else if (tier === "amber") amber.push(stmt.text.trim());
  }

  if (red.length > 0) {
    const picked = await vscode.window.showWarningMessage(
      "VSDB: CỰC KỲ NGUY HIỂM — câu lệnh sẽ XÓA SẠCH DỮ LIỆU (DELETE không WHERE / TRUNCATE / DROP). Kiểm tra lại query!",
      { modal: true, detail: capDetail(red, RED_DETAIL_CAP) },
      "Vẫn chạy (nguy hiểm)",
    );
    return picked === "Vẫn chạy (nguy hiểm)";
  }

  if (amber.length > 0) {
    const picked = await vscode.window.showWarningMessage(
      "VSDB: DELETE có điều kiện — chạy câu lệnh này?",
      { modal: true, detail: capDetail(amber, AMBER_DETAIL_CAP) },
      "Run",
    );
    return picked === "Run";
  }

  return true;
}

function capDetail(texts: string[], cap: number): string {
  const joined = texts.join("\n\n");
  return truncateAtBoundary(joined, cap);
}

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
            sslKeyPath: payload.sslKeyPath || undefined,
            manualCommit: payload.manualCommit,
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
