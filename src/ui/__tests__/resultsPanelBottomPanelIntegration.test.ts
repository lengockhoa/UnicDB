// src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts
// TASK-RP-004 — cycle gate. 6 regression cases that, together with
// `resultsPanelViewProvider.test.ts` (TASK-RP-001) and
// `resultsPanelViewManifest.test.ts` (TASK-RP-003), prove the SQL Results
// home lives in the bottom panel — never the editor area — and that the
// `UnicDB.resultsPlacement` setting is fully gone.
//
// What this file adds on top of the two upstream suites:
//   * case 1 — raw source scan of resultsPanel.ts: after stripping
//     JSDoc/block/line comments, none of the legacy editor-area placement
//     tokens may remain. Comments documenting the deletion are allowed
//     (they're not "machinery"), but real code references would fail.
//   * case 2 — manifest scan: panel container present, view id and
//     activation event wired, no `resultsPlacement` substring anywhere.
//   * case 3 — happy end-to-end: render REAL StatementResult fixtures
//     through the bottom-panel view's ready handshake, assert the posted
//     state payload is exactly what the user would see.
//   * case 4 — show() boundary: twice → exactly two container-focus
//     commands, zero createWebviewPanel calls (mock throws on use).
//   * case 5 — consistency: registered viewId === manifest view id
//     === ResultsPanel.viewId; container + ".focus" matches the
//     command show() actually fires.
//   * case 6 — stale-guard preservation: render(v1), render(v2) before
//     resolve, then resolve + ready → exactly ONE posted state with
//     rows equal to v2 (buffer-overwrite semantics survived).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type MessageHandler = (msg: unknown) => void;
type DisposeHandler = () => void;
type ChangeVisibilityHandler = (e: { visible: boolean }) => void;

class FakeWebview {
  html = "";
  cspSource = "vscode-webview://test";
  options: {
    enableScripts?: boolean;
    retainContextWhenHidden?: boolean;
    localResourceRoots?: unknown[];
  } = {};
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  asWebviewUriCalls: unknown[] = [];
  onDidReceiveMessage = (h: MessageHandler) => {
    this.handler = h;
    return { dispose: () => undefined };
  };
  asWebviewUri = (u: unknown) => {
    this.asWebviewUriCalls.push(u);
    return u;
  };
  /** Test-only: dispatch a message into the host handler. */
  dispatch(msg: unknown) {
    if (this.handler) this.handler(msg);
  }
  private handler: MessageHandler | null = null;
}

class FakeWebviewView {
  webview = new FakeWebview();
  description: string | undefined;
  title: string | undefined;
  viewType = "UnicDB.results";
  visible = true;
  /** Disposable spy for the view's dispose(). */
  dispose = vi.fn();
  private didDisposeHandlers: DisposeHandler[] = [];
  private didChangeVisibilityHandlers: ChangeVisibilityHandler[] = [];
  onDidDispose(h: DisposeHandler) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  onDidChangeVisibility(h: ChangeVisibilityHandler) {
    this.didChangeVisibilityHandlers.push(h);
    return { dispose: () => undefined };
  }
  fireDidDispose() {
    for (const h of this.didDisposeHandlers) h();
  }
}

type RegisteredProviderEntry = {
  viewId: string;
  provider: {
    resolveWebviewView: (view: unknown, ctx: unknown, token: unknown) => unknown;
  };
  options?: unknown;
};

const registeredProviders: RegisteredProviderEntry[] = [];

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        fsPath: parts
          .map((p: unknown) => {
            if (typeof p === "string") return p;
            if (!p) return "";
            const obj = p as { fsPath?: string; path?: string };
            return obj.fsPath ?? obj.path ?? "";
          })
          .join("/"),
        path: parts
          .map((p: unknown) => {
            if (typeof p === "string") return p;
            if (!p) return "";
            const obj = p as { fsPath?: string; path?: string };
            return obj.fsPath ?? obj.path ?? "";
          })
          .join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      // Throws on use — if `show()` ever tries to spin up an editor-area
      // panel, case 4 will surface it as a thrown error.
      createWebviewPanel: vi.fn(() => {
        throw new Error(
          "createWebviewPanel must not be called — Results home is the bottom panel",
        );
      }),
      registerWebviewViewProvider: vi.fn(
        (viewId: string, provider: unknown, options?: unknown) => {
          registeredProviders.push({
            viewId,
            provider: provider as RegisteredProviderEntry["provider"],
            options,
          });
          return { dispose: vi.fn() };
        },
      ),
      showErrorMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
    },
    commands: {
      executeCommand: vi.fn(
        async (_cmd: string, ..._rest: unknown[]) => undefined,
      ),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string, def?: unknown) => def,
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
    CancellationToken: class {},
    EventEmitter: class {
      event = () => ({ dispose: () => undefined });
    },
  };
});

import * as vscode from "vscode";
import { ResultsPanel } from "../resultsPanel";
import type { QueryRunner, StatementResult } from "../../core/queryRunner";

function makeRunnerStub(): QueryRunner {
  return {
    loadMore: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    isCancelled: vi.fn(() => false),
  } as unknown as QueryRunner;
}

type Manifest = {
  contributes: {
    views?: Record<string, Array<Record<string, unknown>>>;
    viewsContainers?: Record<string, Array<Record<string, unknown>>>;
    configuration?: { properties?: Record<string, unknown> };
    menus?: Record<string, unknown>;
    commands?: unknown[];
    keybindings?: unknown[];
    grammars?: unknown[];
  };
  activationEvents?: string[];
};

function loadResultsPanelSource(): string {
  return readFileSync(
    resolve(process.cwd(), "src/ui/resultsPanel.ts"),
    "utf8",
  );
}

function loadManifest(): { raw: string; json: Manifest } {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const json = JSON.parse(raw) as Manifest;
  return { raw, json };
}

/**
 * Strip JSDoc/block comments and line comments so a positive token scan
 * doesn't trip over a `// removed in TASK-RP-001` reference in the
 * surviving doc block. Replaces comment bodies with spaces (preserving
 * line/column offsets for clearer error messages if a check fails).
 */
function stripComments(src: string): string {
  // Block comments (/* ... */ and JSDoc /** ... */). Non-greedy, multiline.
  // Using a single replacement that preserves newlines so error messages
  // still report the original line number.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  // Line comments (// ...). Stop at newline.
  const noLine = noBlock.replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix: string) =>
    (prefix ?? "") + " ".repeat(Math.max(0, m.length - (prefix?.length ?? 0))),
  );
  return noLine;
}

beforeEach(() => {
  registeredProviders.length = 0;
  vi.clearAllMocks();
});

describe("TASK-RP-004 — Bottom-panel regression net", () => {
  // ---- Case 1 — regression (source scan) -------------------------------
  it("case 1: resultsPanel.ts (post-strip-comments) contains no editor-area placement tokens", () => {
    const raw = loadResultsPanelSource();
    const code = stripComments(raw);

    const forbidden = [
      "createWebviewPanel",
      "moveEditorToBelowGroup",
      "moveEditorToAboveGroup",
      "resultsPlacement",
      "readPlacementSetting",
    ];

    const hits = forbidden.filter((tok) => code.includes(tok));
    expect(
      hits,
      `resultsPanel.ts still references editor-area placement machinery: ${hits.join(
        ", ",
      )}`,
    ).toEqual([]);

    // Sanity: the legacy `show()` no longer takes a `placement` arg and
    // does not call `vscode.window.createWebviewPanel`. The actual code
    // path is a one-liner `executeCommand("UnicDB.results.focus")`.
    expect(code).toContain('executeCommand("UnicDB.results.focus")');
  });

  // ---- Case 2 — regression (manifest scan) -----------------------------
  it("case 2: package.json has a panel container, the onView activation event, and zero placement config", () => {
    const { raw, json } = loadManifest();

    // 2a — panel container declared with id "UnicDB-results".
    const containers = json.contributes.viewsContainers ?? {};
    const panelContainerList = containers.panel as
      | Array<Record<string, unknown>>
      | undefined;
    expect(Array.isArray(panelContainerList)).toBe(true);
    const panelContainer = panelContainerList?.find(
      (c) => c.id === "UnicDB-results",
    );
    expect(panelContainer).toBeDefined();

    // 2b — activation event is present.
    expect(Array.isArray(json.activationEvents)).toBe(true);
    expect(json.activationEvents).toContain("onView:UnicDB.results");

    // 2c — the `resultsPlacement` token does NOT exist anywhere in the
    // raw manifest (covers descriptions, command titles, accidental
    // re-introductions under a renamed property).
    expect(raw.includes("resultsPlacement")).toBe(false);

    // 2d — settings: properties should NOT contain the legacy key
    // (JSON.parse-level double-check on top of the raw scan).
    const props =
      json.contributes.configuration?.properties ?? {};
    expect("UnicDB.resultsPlacement" in props).toBe(false);
  });

  // ---- Case 3 — happy end-to-end render --------------------------------
  it("case 3: results render rows through the bottom-panel view's ready handshake", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    panel.setExtensionUri({
      fsPath: "/ext",
      path: "/ext",
    } as unknown as vscode.Uri);

    // Render before resolve (buffered state).
    const sample: StatementResult = {
      index: 0,
      sql: "SELECT id, name FROM t",
      status: "done",
      result: {
        columns: ["id", "name"],
        rows: [
          [1, "a"],
          [2, "b"],
        ],
        rowCount: 2,
        durationMs: 1,
      },
      durationMs: 1,
    };
    panel.render([sample], "q at T");

    // Capture the provider from the extension's registration call.
    // We register one explicitly here so the test is self-contained
    // (we do NOT depend on the order in which extension.ts wires it).
    const viewId = ResultsPanel.viewId;
    vscode.window.registerWebviewViewProvider(viewId, panel);
    const captured = registeredProviders[registeredProviders.length - 1];
    expect(captured).toBeDefined();
    expect(captured.viewId).toBe(viewId);

    // Resolve the view via the captured provider.
    const fakeView = new FakeWebviewView();
    captured.provider.resolveWebviewView(fakeView, {}, {});

    // Fire the webview's `ready` handshake.
    fakeView.webview.postMessage.mockClear();
    fakeView.webview.dispatch({ type: "ready" });

    // Find the posted state message.
    const calls = fakeView.webview.postMessage.mock.calls.map(
      (c) => c[0],
    ) as Array<Record<string, unknown>>;
    const state = calls.find(
      (m) => (m as { type?: string }).type === "state",
    ) as
      | {
          type: string;
          header: string;
          busy: boolean;
          results: StatementResult[];
        }
      | undefined;
    expect(state).toBeDefined();
    expect(state!.header).toBe("q at T");
    expect(state!.busy).toBe(false);
    expect(Array.isArray(state!.results)).toBe(true);
    expect(state!.results.length).toBe(1);
    expect(state!.results[0]!.result!.rows).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

  // ---- Case 4 — edge (boundary/count) ----------------------------------
  it("case 4: show() executes exactly the container focus command and never creates a panel", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });

    const cwvpMock = vi.mocked(vscode.window.createWebviewPanel);
    const execMock = vi.mocked(vscode.commands.executeCommand);
    cwvpMock.mockClear();
    execMock.mockClear();

    panel.show();
    panel.show();

    // 4a — createWebviewPanel was never called. The mock throws on use,
    // so any call would have failed the test at the call site.
    expect(cwvpMock).not.toHaveBeenCalled();

    // 4b — executeCommand was called exactly twice, both with the
    // container's built-in focus command.
    expect(execMock).toHaveBeenCalledTimes(2);
    const focusCalls = execMock.mock.calls.filter(
      (c) => c[0] === "UnicDB.results.focus",
    );
    expect(focusCalls).toHaveLength(2);

    // 4c — the focus command string is derived from the manifest's
    // panel view id, so the code and the on-disk manifest stay in sync.
    const { json } = loadManifest();
    const panelContainerList = json.contributes.viewsContainers?.panel as
      | Array<Record<string, unknown>>
      | undefined;
    const container = panelContainerList?.find(
      (c) => c.id === "UnicDB-results",
    );
    expect(container).toBeDefined();
    const views = json.contributes.views?.["UnicDB-results"] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(Array.isArray(views)).toBe(true);
    const derivedCommand = `${views![0]!.id}.focus`;
    expect(derivedCommand).toBe("UnicDB.results.focus");
    // The executed command matches the derived command for every call.
    for (const call of focusCalls) {
      expect(call[0]).toBe(derivedCommand);
    }
  });

  // ---- Case 5 — edge (consistency) --------------------------------------
  it("case 5: registered viewId, manifest view id and ResultsPanel.viewId all agree", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    panel.setExtensionUri({
      fsPath: "/ext",
      path: "/ext",
    } as unknown as vscode.Uri);

    const viewId = ResultsPanel.viewId;
    expect(viewId).toBe("UnicDB.results");

    vscode.window.registerWebviewViewProvider(viewId, panel);
    const captured = registeredProviders[registeredProviders.length - 1]!;
    expect(captured.viewId).toBe(viewId);

    const { json } = loadManifest();
    const manifestViews = json.contributes.views?.["UnicDB-results"] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(Array.isArray(manifestViews)).toBe(true);
    expect(manifestViews![0]!.id).toBe(viewId);

    // View focus command (`<viewId>.focus`) is what `show()` executes —
    // VS Code registers focus commands per view, not per container.
    expect(`${manifestViews![0]!.id}.focus`).toBe("UnicDB.results.focus");
  });

  // ---- Case 6 — regression (stale buffer overwrite) ---------------------
  it("case 6: hidden view + two renders + resolve + ready still delivers the LATEST state once", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    panel.setExtensionUri({
      fsPath: "/ext",
      path: "/ext",
    } as unknown as vscode.Uri);

    const v1: StatementResult = {
      index: 0,
      sql: "SELECT 1 AS one",
      status: "done",
      result: {
        columns: ["one"],
        rows: [[1]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    };
    const v2: StatementResult = {
      index: 0,
      sql: "SELECT 2 AS two",
      status: "done",
      result: {
        columns: ["two"],
        rows: [[2]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    };

    // Two renders while the view is unresolved (hidden / not yet attached).
    panel.render([v1], "hdr v1");
    panel.render([v2], "hdr v2");

    // Now resolve the view + fire ready.
    const view = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown, ctx?: unknown, token?: unknown): unknown;
    }).resolveWebviewView(view, {}, {});
    view.webview.postMessage.mockClear();
    view.webview.dispatch({ type: "ready" });

    // Exactly ONE state message; its results equal v2 (not v1).
    const stateCalls = view.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === "state",
    );
    expect(stateCalls).toHaveLength(1);
    const posted = stateCalls[0]![0] as {
      header: string;
      results: StatementResult[];
    };
    expect(posted.header).toBe("hdr v2");
    expect(posted.results).toHaveLength(1);
    expect(posted.results[0]!.sql).toBe("SELECT 2 AS two");
    expect(posted.results[0]!.result!.rows).toEqual([[2]]);
  });
});
