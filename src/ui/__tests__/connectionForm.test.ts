// src/ui/__tests__/connectionForm.test.ts
// Test hợp đồng ConnectionForm — form một chỗ + SSL support (1.1.0):
//   - show() tạo webview panel với CSP strict + script connectionForm.js.
//   - init(edit) gửi existing config sang webview.
//   - submit → gọi onSave với đầy đủ SSL fields, dispose panel.
//   - onSave throw → KHÔNG dispose, gửi testResult(ok:false).
//   - test → factory nhận cfg sslMode/cert paths, gửi testResult.
//   - cancel → dispose.
//   - pickFile → showOpenDialog (được mock) trả path về webview.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { ConnectionForm } from "../connectionForm";
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter } from "../../adapters/types";

// ---- vscode mock (subset cần cho ConnectionForm) ----------------------------
type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const l of this.listeners.slice()) l(data);
  }
}
interface MockPanel {
  webview: {
    html: string;
    postMessage: (msg: unknown) => Promise<unknown>;
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { dispose: () => void };
    asWebviewUri: (u: unknown) => unknown;
    cspSource: string;
  };
  onDidDispose: (cb: () => void) => { dispose: () => void };
  reveal: () => void;
  dispose: () => void;
  visible: boolean;
}
const state = vi.hoisted(() => ({
  panels: [] as Array<Record<string, unknown>>,
  openDialog: vi.fn(),
}));
vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel = {
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => u),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(),
        visible: true,
      };
      state.panels.push(panel);
      return panel;
    }),
    showOpenDialog: state.openDialog,
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

const extUri = vscode.Uri.file("/ext");

function fakeAdapter(ok: boolean): DbAdapter {
  const thrower = () => {
    if (!ok) throw new Error("connection refused");
    return Promise.resolve() as Promise<never>;
  };
  return {
    connect: thrower as never,
    close: (() => Promise.resolve()) as never,
    testConnection: thrower as never,
    listSchemas: thrower as never,
    runQuery: thrower as never,
    loadMore: thrower as never,
    cancel: thrower as never,
    listTables: thrower as never,
    listViews: thrower as never,
    listRoutines: thrower as never,
    listColumns: thrower as never,
  };
}

function makeForm(existing: ConnectionConfig | null, onSave: ConnectionForm["options"]["onSave"]) {
  return new ConnectionForm({
    extensionUri: extUri,
    existing,
    factory: () => fakeAdapter(true),
    getStoredPassword: async () => "stored-pass",
    onSave,
  });
}

const existingCfg: ConnectionConfig = {
  id: "pg-1",
  name: "Prod PG",
  driver: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "app",
  database: "appdb",
  sslMode: "verify-full",
  sslCaPath: "/certs/ca.pem",
  sslCertPath: "/certs/client.pem",
  sslKeyPath: "/certs/client.key",
};

// Flush async handleMessage cho tới khi condition true (condition polling,
// không dùng timer-based sleep — deterministic, fail nhanh khi condition không tới).
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

beforeEach(() => {
  state.panels.length = 0;
  state.openDialog.mockReset().mockResolvedValue(undefined);
});

describe("ConnectionForm", () => {
  it("show() tạo panel với CSP strict + load connectionForm.js", () => {
    makeForm(null, async () => {}).show();
    expect(state.panels).toHaveLength(1);
    const html = state.panels[0].webview.html;
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connectionForm.js");
  });

  it("ready → gửi init với existing config (edit mode)", async () => {
    const form = makeForm(existingCfg, async () => {});
    form.show();
    const post = state.panels[0].webview.postMessage;
    // simulate webview ready message
    const handler = (state.panels[0].webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[Listener<unknown>]> };
    }).mock.calls[0][0];
    handler({ type: "ready" });
    await until(() => (post as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(post).toHaveBeenCalledWith({ type: "init", existing: existingCfg });
  });

  it("submit → onSave đầy đủ SSL fields + dispose", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const form = makeForm(null, onSave);
    form.show();
    const panel = state.panels[0];
    const handler = (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[Listener<unknown>]> };
    }).mock.calls[0][0];
    handler({
      type: "submit",
      name: "Prod",
      driver: "mysql",
      host: "h",
      port: 3306,
      user: "u",
      database: "d",
      password: "pw",
      sslMode: "verify",
      sslCaPath: "/ca.pem",
      sslCertPath: "",
      sslKeyPath: "",
    });
    await until(() => onSave.mock.calls.length > 0);
    await until(() => (panel.dispose as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Prod",
        driver: "mysql",
        sslMode: "verify",
        sslCaPath: "/ca.pem",
        sslCertPath: "",
      }),
      null,
    );
    expect(panel.dispose).toHaveBeenCalled();
  });

  it("onSave throw → KHÔNG dispose, gửi testResult lỗi", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("connect failed"));
    const form = makeForm(null, onSave);
    form.show();
    const panel = state.panels[0];
    const handler = (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[Listener<unknown>]> };
    }).mock.calls[0][0];
    handler({
      type: "submit",
      name: "X",
      driver: "postgres",
      host: "h",
      port: 5432,
      user: "u",
      database: "d",
      password: "pw",
      sslMode: "disable",
      sslCaPath: "",
      sslCertPath: "",
      sslKeyPath: "",
    });
    await until(() => (panel.webview.postMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "testResult", ok: false, message: expect.stringContaining("connect failed") }),
    );
  });

  it("test → factory gọi với sslMode + cert paths, trả testResult ok", async () => {
    const factory = vi.fn(() => fakeAdapter(true));
    const form = new ConnectionForm({
      extensionUri: extUri,
      existing: null,
      factory,
      getStoredPassword: async () => undefined,
      onSave: async () => {},
    });
    form.show();
    const panel = state.panels[0];
    const handler = (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[Listener<unknown>]> };
    }).mock.calls[0][0];
    handler({
      type: "test",
      name: "T",
      driver: "postgres",
      host: "h",
      port: 5432,
      user: "u",
      database: "d",
      password: "pw",
      sslMode: "verify-full",
      sslCaPath: "/ca.pem",
      sslCertPath: "/c.pem",
      sslKeyPath: "/k.pem",
    });
    await until(() => factory.mock.calls.length > 0);
    await until(
      () =>
        (panel.webview.postMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
          (c) => (c[0] as { type?: string }).type === "testResult",
        ),
    );
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        sslMode: "verify-full",
        sslCaPath: "/ca.pem",
        sslCertPath: "/c.pem",
        sslKeyPath: "/k.pem",
      }),
      "pw",
    );
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "testResult", ok: true }),
    );
  });

  it("cancel → dispose panel", async () => {
    const form = makeForm(null, async () => {});
    form.show();
    const panel = state.panels[0];
    const handler = (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[Listener<unknown>]> };
    }).mock.calls[0][0];
    handler({ type: "cancel" });
    await until(() => (panel.dispose as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(panel.dispose).toHaveBeenCalled();
  });

  it("pickFile → showOpenDialog, path trả về webview", async () => {
    state.openDialog.mockResolvedValue([{ fsPath: "/picked/ca.pem" }]);
    const form = makeForm(null, async () => {});
    form.show();
    const panel = state.panels[0];
    const handler = (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[Listener<unknown>]> };
    }).mock.calls[0][0];
    handler({ type: "pickFile", field: "sslCaPath" });
    await until(() => state.openDialog.mock.calls.length > 0);
    await until(
      () => (panel.webview.postMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(state.openDialog).toHaveBeenCalled();
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "pickFileResult",
      field: "sslCaPath",
      path: "/picked/ca.pem",
    });
  });

  // ---- TASK-001 — per-connection manualCommit qua protocol -----------------
  // Submit/test payload phải mang manualCommit (boolean cụ thể); onSave nhận
  // nguyên giá trị; edit-mode init prefill existing config kèm trường mới.
  describe("manualCommit forwarding (TASK-001)", () => {
    function submitMsg(manualCommit: boolean): Record<string, unknown> {
      return {
        type: "submit",
        name: "Prod",
        driver: "postgres" as const,
        host: "h",
        port: 5432,
        user: "u",
        database: "d",
        password: "pw",
        sslMode: "disable" as const,
        sslCaPath: "",
        sslCertPath: "",
        sslKeyPath: "",
        manualCommit,
      };
    }

    it("submit manualCommit:true → onSave nhận true + dispose", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const form = makeForm(null, onSave);
      form.show();
      const panel = state.panels[0];
      const handler = (panel.webview.onDidReceiveMessage as unknown as {
        mock: { calls: Array<[Listener<unknown>]> };
      }).mock.calls[0][0];
      handler(submitMsg(true));
      await until(() => onSave.mock.calls.length > 0);
      await until(() => (panel.dispose as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.type).toBeUndefined();
      expect(payload.manualCommit).toBe(true);
      expect(panel.dispose).toHaveBeenCalled();
    });

    it("submit manualCommit:false → onSave nhận false (không bao giờ undefined)", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const form = makeForm(null, onSave);
      form.show();
      const panel = state.panels[0];
      const handler = (panel.webview.onDidReceiveMessage as unknown as {
        mock: { calls: Array<[Listener<unknown>]> };
      }).mock.calls[0][0];
      handler(submitMsg(false));
      await until(() => onSave.mock.calls.length > 0);
      const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
      expect("manualCommit" in payload).toBe(true);
      expect(payload.manualCommit).toBe(false);
    });

    it("test message manualCommit:true → host chấp nhận, factory vẫn nhận cfg như cũ", async () => {
      const factory = vi.fn(() => fakeAdapter(true));
      const form = new ConnectionForm({
        extensionUri: extUri,
        existing: null,
        factory,
        getStoredPassword: async () => undefined,
        onSave: async () => {},
      });
      form.show();
      const panel = state.panels[0];
      const handler = (panel.webview.onDidReceiveMessage as unknown as {
        mock: { calls: Array<[Listener<unknown>]> };
      }).mock.calls[0][0];
      handler({
        type: "test",
        name: "T",
        driver: "postgres",
        host: "h",
        port: 5432,
        user: "u",
        database: "d",
        password: "pw",
        sslMode: "disable",
        sslCaPath: "",
        sslCertPath: "",
        sslKeyPath: "",
        manualCommit: true,
      });
      await until(() => factory.mock.calls.length > 0);
      await until(
        () =>
          (panel.webview.postMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
            (c) => (c[0] as { type?: string }).type === "testResult",
          ),
      );
      // Protocol symmetry: the extra field is accepted; existing factory/test
      // behavior is retained.
      expect(panel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "testResult", ok: true }),
      );
    });

    it("edit init gửi existing config kèm manualCommit:true cho webview", async () => {
      const withManual: ConnectionConfig = { ...existingCfg, manualCommit: true };
      const form = makeForm(withManual, async () => {});
      form.show();
      const post = state.panels[0].webview.postMessage;
      const handler = (state.panels[0].webview.onDidReceiveMessage as unknown as {
        mock: { calls: Array<[Listener<unknown>]> };
      }).mock.calls[0][0];
      handler({ type: "ready" });
      await until(() => (post as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      expect(post).toHaveBeenCalledWith({ type: "init", existing: withManual });
    });
  });
});
