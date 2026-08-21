// src/extension.ts
// VSDB extension entry — TASK-007 wires all commands + tree view + CodeLens + status bar.
import * as vscode from "vscode";
import { ConnectionManager } from "./core/connectionManager";
import { createAdapter } from "./adapters/factory";
import { QueryRunner } from "./core/queryRunner";
import { ResultsPanel } from "./ui/resultsPanel";
import { createStatusBar } from "./ui/statusBar";
import {
  SchemaTreeProvider,
  generateSelectForTable,
  qualifiedName,
} from "./ui/schemaTree";
import { VsdbCodeLensProvider } from "./ui/codeLensProvider";
import { sqlToRun } from "./core/statementParser";
import type { ConnectionConfig } from "./config/types";
import type { ParsedStatement } from "./config/types";

// Track disposables for deactivate().
let disposables: vscode.Disposable[] = [];
let state: ExtensionState | null = null;

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

  // ---- ConnectionManager ----
  const mgr = new ConnectionManager(context, createAdapter);
  context.subscriptions.push(mgr);

  // ---- Schema tree ----
  const tree = new SchemaTreeProvider(mgr);
  const treeView = vscode.window.createTreeView("vsdb.schemaTree", {
    treeDataProvider: tree,
  });
  disposables.push(treeView);

  // ---- Status bar ----
  const statusBar = createStatusBar(mgr);
  context.subscriptions.push(statusBar);

  // ---- Results panel + query runner ----
  const runner = new QueryRunner(() => mgr.getAdapter(), {
    batchSize:
      vscode.workspace.getConfiguration("vsdb").get<number>("batchSize") ??
      500,
  });
  const panel = new ResultsPanel({ runner });
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

  state = { mgr, runner, panel, tree, codeLens, statusBar };

  // ---- Register all 10 commands ---------------------------------------------

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
}

// ---- Command implementations -----------------------------------------------

/** Run from editor (Cmd+Enter / Ctrl+Enter / title button). */
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
  const driver = await vscode.window.showQuickPick(
    [
      { label: "postgres", value: "postgres" as const },
      { label: "mysql", value: "mysql" as const },
      { label: "mssql", value: "mssql" as const },
    ],
    { placeHolder: "Driver" },
  );
  if (!driver) return;

  const defaultPort = driver.value === "mysql" ? 3306 : driver.value === "mssql" ? 1433 : 5432;

  const name = await vscode.window.showInputBox({
    prompt: "Connection name",
    placeHolder: "Local PG",
  });
  if (!name) return;
  const host = await vscode.window.showInputBox({
    prompt: "Host",
    value: "127.0.0.1",
  });
  if (!host) return;
  const portStr = await vscode.window.showInputBox({
    prompt: "Port",
    value: String(defaultPort),
    validateInput: (v) => (/^\d+$/.test(v) ? undefined : "Phải là số"),
  });
  if (!portStr) return;
  const user = await vscode.window.showInputBox({ prompt: "User" });
  if (!user) return;
  const password = await vscode.window.showInputBox({
    prompt: "Password",
    password: true,
  });
  if (password === undefined) return;
  const database = await vscode.window.showInputBox({
    prompt: "Database",
  });
  if (!database) return;

  const cfg: ConnectionConfig = {
    id: `${driver.value}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    driver: driver.value,
    host,
    port: parseInt(portStr, 10),
    user,
    database,
    ssl: false,
  };
  try {
    await mgr.addConnection(cfg, password);
    void vscode.window.showInformationMessage(`VSDB: added "${cfg.name}"`);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `VSDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  const newName = await vscode.window.showInputBox({
    prompt: "Name",
    value: current.name,
  });
  if (newName === undefined) return;
  const newHost = await vscode.window.showInputBox({
    prompt: "Host",
    value: current.host,
  });
  if (newHost === undefined) return;
  const newPortStr = await vscode.window.showInputBox({
    prompt: "Port",
    value: String(current.port),
    validateInput: (v) => (/^\d+$/.test(v) ? undefined : "Phải là số"),
  });
  if (newPortStr === undefined) return;
  const newUser = await vscode.window.showInputBox({
    prompt: "User",
    value: current.user,
  });
  if (newUser === undefined) return;
  const newDatabase = await vscode.window.showInputBox({
    prompt: "Database",
    value: current.database,
  });
  if (newDatabase === undefined) return;
  const newPassword = await vscode.window.showInputBox({
    prompt: "Password (để trống để giữ)",
    password: true,
  });
  try {
    await mgr.editConnection(
      id!,
      {
        name: newName,
        host: newHost,
        port: parseInt(newPortStr, 10),
        user: newUser,
        database: newDatabase,
      },
      newPassword && newPassword.length > 0 ? newPassword : undefined,
    );
    void vscode.window.showInformationMessage(`VSDB: updated "${newName}"`);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `VSDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  const active = mgr.getActive();
  if (!active) {
    void vscode.window.showInformationMessage("VSDB: no active connection.");
    return;
  }
  let qualified: string | undefined;
  if (typeof qualifiedOrNode === "string") {
    qualified = qualifiedOrNode;
  } else if (
    qualifiedOrNode &&
    typeof qualifiedOrNode === "object" &&
    "meta" in qualifiedOrNode
  ) {
    const meta = (qualifiedOrNode as { meta?: { schema?: string; objectName?: string } }).meta;
    if (meta && meta.objectName) {
      qualified = qualifiedName({ table: meta.objectName, schema: meta.schema ?? "" });
    }
  }
  if (!qualified) {
    void vscode.window.showInformationMessage(
      "VSDB: right-click a table/view to generate SELECT.",
    );
    return;
  }
  const sql = generateSelectForTable({
    driver: active.driver,
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
