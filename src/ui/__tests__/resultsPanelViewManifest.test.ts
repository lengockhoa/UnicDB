// src/ui/__tests__/resultsPanelViewManifest.test.ts
// TASK-RP-003 — manifest guards for the Results panel home.
//
// Asserts that `package.json` declares:
//   - `contributes.viewsContainers.panel` containing { id: "UnicDB-results", ... }
//   - `contributes.views["UnicDB-results"]` containing the webview view
//   - `activationEvents` includes "onView:UnicDB.results"
//   - `contributes.configuration.properties["UnicDB.resultsPlacement"]` is gone
//   - existing `contributes.views.UnicDB` (schemaTree, adminTree) is intact
//   - the help-grid menu key `webview/UnicDB.results/context` is intact
//   - the view id matches `ResultsPanel.viewId === "UnicDB.results"`
//   - and that the panel container id + ".focus" === "UnicDB-results.focus".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal vscode mock — only the surface that `resultsPanel.ts` touches at
// module-load time (constructor + class shape). The ResultsPanel itself is
// not constructed in these tests (only `ResultsPanel.viewId` is read), so we
// can keep the mock minimal. We still register `Uri`, `window`, `commands`,
// `workspace`, `env`, `CancellationToken`, and `EventEmitter` defensively in
// case the module reads anything at import time.
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
      createWebviewPanel: vi.fn(),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      showErrorMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
    },
    commands: {
      executeCommand: vi.fn(async (_cmd: string, ..._rest: unknown[]) => undefined),
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

import { ResultsPanel } from "../resultsPanel";

type Manifest = {
  contributes: {
    views?: Record<string, Array<Record<string, unknown>>>;
    viewsContainers?: Record<string, Array<Record<string, unknown>>>;
    configuration?: {
      properties?: Record<string, unknown>;
    };
    menus?: Record<string, unknown>;
    commands?: unknown[];
    keybindings?: unknown[];
    grammars?: unknown[];
  };
  activationEvents?: string[];
};

function loadManifest(): { raw: string; json: Manifest } {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  // JSON.parse must not throw — that's also asserted in case 3.
  const json = JSON.parse(raw) as Manifest;
  return { raw, json };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TASK-RP-003 — package.json manifest guards for Results panel home", () => {
  // ---- Case 1 — happy ----------------------------------------------------
  it("case 1: panel views container + webview view are declared", () => {
    const { json } = loadManifest();
    const containers = json.contributes.viewsContainers ?? {};
    const views = json.contributes.views ?? {};

    // 1. panel container exists with the right shape
    expect(Array.isArray(containers.panel)).toBe(true);
    const panelContainer = (containers.panel as Array<Record<string, unknown>>).find(
      (c) => c.id === "UnicDB-results",
    );
    expect(panelContainer).toBeDefined();
    expect(panelContainer!.title).toBe("UnicDB Results");
    expect(typeof panelContainer!.icon).toBe("string");
    expect((panelContainer!.icon as string).length).toBeGreaterThan(0);

    // 2. the webview view is registered into that container
    const panelViews = views["UnicDB-results"];
    expect(Array.isArray(panelViews)).toBe(true);
    const resultsView = (panelViews as Array<Record<string, unknown>>).find(
      (v) => v.id === "UnicDB.results",
    );
    expect(resultsView).toBeDefined();
    expect(resultsView!.type).toBe("webview");

    // 3. existing UnicDB activitybar container + views are untouched.
    const activityBar = containers.activitybar;
    expect(Array.isArray(activityBar)).toBe(true);
    const activityContainer = (activityBar as Array<Record<string, unknown>>).find(
      (c) => c.id === "UnicDB",
    );
    expect(activityContainer).toBeDefined();

    const unicDBViews = views.UnicDB;
    expect(Array.isArray(unicDBViews)).toBe(true);
    const ids = (unicDBViews as Array<Record<string, unknown>>).map((v) => v.id);
    expect(ids).toContain("UnicDB.schemaTree");
    expect(ids).toContain("UnicDB.adminTree");
  });

  // ---- Case 2 — edge (negative) ------------------------------------------
  it("case 2: resultsPlacement configuration property is gone", () => {
    const { json, raw } = loadManifest();
    const props = json.contributes.configuration?.properties ?? {};
    expect("UnicDB.resultsPlacement" in props).toBe(false);
    // Catches leftovers in descriptions / titles / anywhere in the file.
    expect(raw.includes("resultsPlacement")).toBe(false);
  });

  // ---- Case 3 — edge (consistency / malformed guard) ---------------------
  it("case 3: manifest is valid JSON with activation event and intact UnicDB config keys", () => {
    const { json } = loadManifest();
    // JSON.parse already ran in loadManifest; throwing in it would fail this
    // test before the expect() block. Also sanity-check the activation event.
    expect(Array.isArray(json.activationEvents)).toBe(true);
    expect(json.activationEvents).toContain("onView:UnicDB.results");

    // Pre-existing config keys still present.
    const props = json.contributes.configuration?.properties ?? {};
    expect("UnicDB.batchSize" in props).toBe(true);
    expect("UnicDB.showRunLens" in props).toBe(true);

    // Help-Grid menu for the results webview is preserved.
    const menus = json.contributes.menus ?? {};
    expect("webview/UnicDB.results/context" in menus).toBe(true);
  });

  // ---- Case 4 — unit (cross-check with code) -----------------------------
  it("case 4: view id matches ResultsPanel.viewId from TASK-RP-001", () => {
    const { json } = loadManifest();
    const viewIdFromCode = ResultsPanel.viewId;
    expect(viewIdFromCode).toBe("UnicDB.results");

    const views = json.contributes.views ?? {};
    const panelViews = views["UnicDB-results"] as Array<Record<string, unknown>>;
    expect(panelViews).toBeDefined();
    expect(panelViews[0]!.id).toBe(viewIdFromCode);

    // The container id + ".focus" is what `show()` executes to reveal the view.
    const containers = json.contributes.viewsContainers ?? {};
    const panelContainer = (containers.panel as Array<Record<string, unknown>>).find(
      (c) => c.id === "UnicDB-results",
    );
    expect(panelContainer).toBeDefined();
    expect(`${panelContainer!.id}.focus`).toBe("UnicDB-results.focus");
  });
});