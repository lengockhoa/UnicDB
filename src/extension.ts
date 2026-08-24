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
import { sqlToRun } from "./core/statementParser";
import { analyzeStatement, guardTier } from "./core/dangerousStatement";
import { truncateAtBoundary } from "./core/text";
import { AiConfigStore } from "./ai/config";
import { AiSettingsForm } from "./ui/aiSettingsForm";
import { createProviderClient } from "./ai/provider";
import type { AdapterFactory } from "./ai/tools/types";
import type { AgentDeps } from "./ai/agent";
import { AiChatPanel, type AcpPanelDeps } from "./ui/aiChatPanel";
import { AcpProcess } from "./ai/omp/acpProcess";
import type { ConnectionConfig } from "./config/types";
import type { ParsedStatement } from "./config/types";
let disposables: vscode.Disposable[] = [];
let state: ExtensionState | null = null;
/** Cached single-instance AiSettingsForm (TASK-004). Reused across calls. */
let aiSettingsForm: AiSettingsForm | null = null;
/** Cached single-instance AiChatPanel (TASK-004). Reused across calls. */
let aiChatPanel: AiChatPanel | null = null;
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
    listPkColumns: async (schema: string, table: string): Promise<string[]> => {
      try {
        const adapter = await mgr.getAdapter();
        const cols = await adapter.listColumns(table, schema || undefined);
        return cols.filter((c) => c.isPrimaryKey === true).map((c) => c.name);
      } catch {
        return [];
      }
    },
  };
  const panel = new ResultsPanel({ runner, saveContext });
  panel.setExtensionUri(context.extensionUri);
  context.subscriptions.push(panel);

  // ---- CodeLens ----
  const codeLens = new VsdbCodeLensProvider();
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

  // 10. vsdb.refreshSchema
  disposables.push(
    vscode.commands.registerCommand("vsdb.refreshSchema", () => tree.refresh()),
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

  // Dispose schemaTree + codeLens on deactivate to drop subscriptions + cache.
  context.subscriptions.push({ dispose: () => tree.dispose() });
  context.subscriptions.push({ dispose: () => codeLens.dispose() });
  context.subscriptions.push({ dispose: () => aiSettingsForm?.dispose() });

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
 * call is server-driven from this point; tool definitions are registered
 * out-of-band by the ACP server, so no toolDefs/toolExecutor callbacks are
 * needed here. The DB access boundary is unchanged — still via the
 * createDbTools + createSqlTool registry, but invoked from the host's own
 * agent loop (builtin mode) when ACP falls back.
 */
function buildAcpDeps(): AcpPanelDeps {
  return {
    start: async (ompPath: string, cwd: string) => {
      const proc = new AcpProcess({
        ompPath,
        cwd,
        supportCwdFlag: true,
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
  const cfg = await aiStore.loadConfig();
  if (!cfg) {
    void vscode.window.showInformationMessage(
      "VSDB: Configure AI settings first.",
    );
    await vscode.commands.executeCommand("vsdb.openAiSettings");
    return;
  }
  if (!aiChatPanel) {
    aiChatPanel = new AiChatPanel({
      extensionUri: extensionUriForForm,
      deps,
      adapterFactory,
      acp: buildAcpDeps(),
    });
  }
  aiChatPanel.show();
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
  const { statements } = sqlToRun(sql, sel, cursorOffset);
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

async function runStatements(
  mgr: ConnectionManager,
  runner: QueryRunner,
  panel: ResultsPanel,
  statements: ParsedStatement[],
): Promise<void> {
  // TASK-606 — Confirm guard TRƯỚC mọi side-effect (kể cả busy state): cancel
  // huỷ toàn bộ lô, không statement nào được submit.
  if (!(await confirmDangerousStatements(statements))) {
    return;
  }
  const active = mgr.getActive();
  const header = `Run at ${new Date().toISOString()} — ${active ? `${active.driver}@${active.host}/${active.database}` : "no connection"}`;
  panel.setBusy(true);
  try {
    const results = await runner.run(statements, () => {
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
): Promise<boolean> {
  const enabled =
    vscode.workspace
      .getConfiguration("vsdb")
      .get<boolean>("confirmDestructive") ?? true;
  if (!enabled) return true;

  const red: string[] = [];
  const amber: string[] = [];
  for (const stmt of statements) {
    const tier = guardTier(analyzeStatement(stmt.text));
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
