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
import { AdminTreeProvider } from "./ui/adminTree";
import { AdminSessionsPanel } from "./ui/adminSessionsPanel";
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
let disposables: vscode.Disposable[] = [];
let state: ExtensionState | null = null;
/** Cached single-instance AiSettingsForm (TASK-004). Reused across calls. */
let aiSettingsForm: AiSettingsForm | null = null;
/** Cached single-instance AiChatPanel (TASK-004). Reused across calls. */
let aiChatPanel: AiChatPanel | null = null;
let consolePanel: ConsolePanel | null = null;
/** Cycle AIC TASK-AIC-005 — singletons for the autocomplete wiring. */
let autocompleteService: SqlAutocompleteService | null = null;
let autocompleteRegistration: AutocompleteRegistration | null = null;
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

// AIX-01: opt-in workspace grounding. Default OFF so the pre-AIX-01
// turn path is unchanged. Hosts gate on `vsdb.ai.grounding` so a
// setting change takes effect on the next panel open.
function isGroundingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("vsdb")
    .get<boolean>("ai.grounding", false);
}
// Host-curated file list (empty for now — the model can request
// retrieval via the `workspace_search` AgentTool at runtime).
let groundingFiles: readonly string[] = [];
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
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
  return new TextDecoder().decode(bytes);
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
    catalog: createCatalogResolver(schemaCache, {
      isPostgres: () => mgr.getActive()?.driver === "postgres",
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
      isPostgres: () => mgr.getActive()?.driver === "postgres",
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
      commandOpenAiChat(aiStore, adapterFactory, aiChatDeps),
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

  // 17. vsdb.openConsole — TASK-003 cycle Z: DataGrip-style SQL Console.
  // TASK-AF-004 cycle AF: passes `globalState` Memento so query history
  // (capped at 200 entries) persists across panel reloads.
  disposables.push(
    vscode.commands.registerCommand("vsdb.openConsole", () =>
      commandOpenConsole(mgr, runner, panel, context.globalState),
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
  disposables.push(
    vscode.commands.registerCommand("vsdb.openSessionsPanel", async () => {
      const active = mgr.getActive();
      if (!active) {
        void vscode.window.showWarningMessage(
          "VSDB: select a connection first to open the Sessions panel.",
        );
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
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.runGrantSql",
      async (kind: "grant" | "revoke") => {
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
    // AIX-01: opt-in workspace grounding. `vsdb.ai.grounding` defaults
    // to false so the pre-AIX-01 turn path is unchanged.
    grounding: isGroundingEnabled()
      ? {
          getSelection: readActiveSelection,
          readFile: readWorkspaceFile,
          filesToRead: groundingFiles,
        }
      : undefined,
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
  memento: vscode.Memento,
): void {
  if (!consolePanel) {
    consolePanel = new ConsolePanel({
      extensionUri: extensionUriForForm,
      memento,
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

/**
 * TASK-AF-004 — vsdb.openConsole.createTab: open a fresh tab in an existing
 * Console panel. No-op when the panel hasn't been opened yet (the user must
 * run `vsdb.openConsole` first to seed the singleton).
 */
function commandOpenConsoleCreateTab(): void {
  consolePanel?.createTab();
  consolePanel?.show();
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
  const appendBase = runner.getResults().length;
  panel.setBusy(true);
  try {
    const results = await runner.run(rewritten, () => {
      // Each onUpdate re-render the panel.
      panel.render(runner.getResults(), header, { appendBase });
    }, { append: true });
    panel.render(results, header, { appendBase });
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

/**
 * TASK-606 — Hỏi lại user trước khi chạy statement phá hoại.
 * Trả `true` = proceed, `false` = user cancel (huỷ CẢ LÔ).
 * Tier đỏ (DELETE/UPDATE không WHERE, mọi TRUNCATE/DROP) thắng tier amber.
 */
async function confirmDangerousStatements(
  statements: ParsedStatement[],
  dialect?: SqlDialect,
): Promise<boolean> {
  // TASK-AHL-004 re-review fix: classify FIRST. `vsdb.confirmDestructive=false`
  // may skip the red/amber prompts, but admin DCL is a distinct risk class and
  // must still reach its own `vsdb.admin.confirmGrant` gate below.
  const enabled =
    vscode.workspace
      .getConfiguration("vsdb")
      .get<boolean>("confirmDestructive") ?? true;

  const red: string[] = [];
  const amber: string[] = [];
  const admin: string[] = [];
  for (const stmt of statements) {
    const tier = guardTier(analyzeStatement(stmt.text, dialect));
    if (tier === "red") red.push(stmt.text.trim());
    else if (tier === "amber") amber.push(stmt.text.trim());
    else if (tier === "admin-red") admin.push(stmt.text.trim());
  }
  if (!enabled) {
    // Non-admin prompts suppressed — but admin DCL still gated below.
    red.length = 0;
    amber.length = 0;
  }

  // TASK-AHL-004 — admin DCL (GRANT/REVOKE/KILL/TERMINATE) always prompts.
  // Gated by `vsdb.admin.confirmGrant` (default true) — separate from
  // `vsdb.confirmDestructive` because admin DCL is a distinct risk class
  // (changes who-can-do-what, or kills another user's session).
  if (admin.length > 0) {
    const adminEnabled =
      vscode.workspace
        .getConfiguration("vsdb.admin")
        .get<boolean>("confirmGrant") ?? true;
    if (adminEnabled) {
      const picked = await vscode.window.showWarningMessage(
        "VSDB: ADMIN DCL — câu lệnh này thay đổi quyền (GRANT/REVOKE) hoặc kết thúc session khác (KILL/TERMINATE). Chắc chắn chưa?",
        { modal: true, detail: capDetail(admin, RED_DETAIL_CAP) },
        "Vẫn chạy (admin)",
      );
      if (picked !== "Vẫn chạy (admin)") return false;
    }
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
