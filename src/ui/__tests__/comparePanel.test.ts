// src/ui/__tests__/comparePanel.test.ts
// TASK-DBX03-004 — compare panel host: message guard + html shell
// (vscode mocked; mirrors the dbx01 ui test pattern).

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => {
  const joinPath = (base: unknown, ...parts: string[]) => ({
    fsPath: [base, ...parts].join("/"),
  });
  return {
    window: {
      createWebviewPanel: vi.fn(() => ({
        webview: {
          asWebviewUri: vi.fn((u: unknown) => u),
          postMessage: vi.fn(async () => true),
          onDidReceiveMessage: vi.fn(),
          html: "",
        },
        onDidDispose: vi.fn(),
        reveal: vi.fn(),
      })),
      showInformationMessage: vi.fn(),
    },
    ViewColumn: { Active: 1 },
    Uri: { file: (p: string) => ({ fsPath: p }), joinPath },
    env: { clipboard: { writeText: vi.fn(async () => undefined) } },
  };
});

import { ComparePanel, isCopySqlMessage } from "../comparePanel";
import { buildCompareHtml } from "../comparePanelHtml";
import * as vscode from "vscode";

describe("isCopySqlMessage", () => {
  it("accepts a valid copySql message", () => {
    expect(isCopySqlMessage({ type: "copySql", sql: "SELECT 1;" })).toBe(true);
  });

  it("rejects non-string sql and unknown types", () => {
    expect(isCopySqlMessage({ type: "copySql", sql: 42 })).toBe(false);
    expect(isCopySqlMessage({ type: "other" })).toBe(false);
    expect(isCopySqlMessage(null)).toBe(false);
    expect(isCopySqlMessage("copySql")).toBe(false);
  });
});

describe("buildCompareHtml", () => {
  it("builds a CSP-restricted shell referencing the compare bundle", () => {
    const fakeWebview = {
      asWebviewUri: (u: unknown) => u,
      cspSource: "vscode-webview-resource:",
    };
    const html = buildCompareHtml(fakeWebview, "comparePanel.js", "webview.css");
    expect(html).toContain("style-src vscode-webview-resource: 'unsafe-inline'");
    expect(html).toContain(`script-src vscode-webview-resource:"`);
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).toContain("comparePanel.js");
  });
});

describe("ComparePanel", () => {
  it("show() posts the compare message into the webview", () => {
    const panel = new ComparePanel({ extensionUri: { fsPath: "/ext" } as never });
    const result = { ok: true };
    const req = { source: { schema: "public", table: "a" }, target: { schema: "public", table: "b" } };
    panel.show(result, req);
    const created = (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const posted = created.webview.postMessage as ReturnType<typeof vi.fn>;
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: "UnicDB-compare", result, request: req }));
  });
});
