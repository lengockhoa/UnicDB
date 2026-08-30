import { describe, expect, it } from "vitest";
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
