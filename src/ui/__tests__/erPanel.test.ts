// erPanel.ts imports the runtime vscode module; mock it BEFORE the
// import so the test runs standalone (reviewer finding 6).
vi.mock("vscode", () => ({
  window: {},
  workspace: {},
  env: {},
  Uri: { file: (p: string) => ({ fsPath: p }) },
  ViewColumn: { Active: 1 },
}));

import { describe, expect, it, vi } from "vitest";
import { isErPanelMessage, ZOOM_MIN, ZOOM_MAX, clampZoom } from "../erPanel";
import { buildErHtml } from "../erPanelHtml";

describe("erPanel message guard", () => {
  it("accepts the known message types with valid payloads", () => {
    expect(isErPanelMessage({ type: "er_ready" })).toBe(true);
    expect(isErPanelMessage({ type: "er_export_request" })).toBe(true);
    expect(
      isErPanelMessage({ type: "er_export_svg", svg: "<svg/>", schema: "public" }),
    ).toBe(true);
    expect(isErPanelMessage({ type: "er_zoom", delta: 1.2 })).toBe(true);
  });

  it("rejects unknown types and malformed payloads", () => {
    expect(isErPanelMessage({ type: "exec" })).toBe(false);
    expect(isErPanelMessage(null)).toBe(false);
    expect(isErPanelMessage("zoom")).toBe(false);
    expect(isErPanelMessage({ type: "er_export_svg", svg: 42 })).toBe(false);
    expect(isErPanelMessage({ type: "er_zoom", delta: "x" })).toBe(false);
  });
});

describe("zoom clamp", () => {
  it("clamps to [0.25, 4]", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
  });
});

describe("erPanelHtml CSP shell", () => {
  it("renders cspSource-scoped script/style with no nonce", () => {
    const fake = {
      asWebviewUri: (u: unknown) => `mock:${String(u)}`,
      cspSource: "mock-csp:",
    } as never;
    const html = buildErHtml(fake, "erPanel.js", "webview.css");
    expect(html).toContain("style-src mock-csp: 'unsafe-inline'");
    expect(html).toContain("script-src mock-csp:");
    expect(html).not.toContain("nonce");
  });
});

describe("erPanel host (mocked vscode)", () => {
  it("posts layout as a serializable record, not a Map", async () => {
    const { ErPanel } = await import("../erPanel");
    const posted: unknown[] = [];
    const { buildErGraph } = await import("../../core/er/fkGraph");
    const { layoutErGraph } = await import("../../core/er/layout");
    const graph = buildErGraph([]);
    const layout = layoutErGraph(graph);
    const panel = ErPanel.get({ extensionUri: {} as never });
    // Drive post() through show() with a fake panel that captures messages.
    const fakeWebview = {
      postMessage: (m: unknown) => {
        posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: () => undefined,
      asWebviewUri: (u: unknown) => String(u),
      cspSource: "test:",
    };
    const fakePanel = {
      webview: fakeWebview,
      reveal: () => undefined,
      onDidDispose: () => undefined,
    };
    (panel as unknown as { panel: unknown }).panel = fakePanel;
    (panel as unknown as { lastMessage: unknown }).lastMessage = {
      result: { ok: true, graph, layout, truncated: false },
      schema: "public",
    };
    // @ts-expect-error private method access for the wire-format test
    panel.post();
    const msg = JSON.parse(JSON.stringify(posted[0])) as { layout: { nodes: Record<string, unknown> } };
    expect(msg.layout.nodes).toBeTypeOf("object");
    expect(Array.isArray(msg.layout.nodes)).toBe(false);
  });
});
