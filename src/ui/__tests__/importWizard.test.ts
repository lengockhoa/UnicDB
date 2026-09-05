// src/ui/__tests__/importWizard.test.ts
// DBX-01-004 — host flow: auto-mapping, confirm-before-execute,
// no-connection refusal.

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showQuickPick: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => 1000) })),
    fs: { readFile: vi.fn(async () => new Uint8Array()) },
  },
  commands: { executeCommand: vi.fn() },
  Uri: { parse: (s: string) => ({ toString: () => s, scheme: "UnicDB-lv" }) },
}));

import { runImport, type ImportWizardContext } from "../importWizard";
function makeAdapter(driver: string, columns: Array<{ name: string; dataType: string }>): DbAdapter {
  const adapter = {
    driver,
    connect: vi.fn(),
    close: vi.fn(),
    runQuery: vi.fn(async (): Promise<RunResult> => ({ results: [] })),
    beginTransaction: vi.fn(async () => ({
      runQuery: vi.fn(async (): Promise<RunResult> => ({ results: [] })),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    })),
    listTables: vi.fn(async () => [{ name: "users", schema: "public" }]),
    listColumns: vi.fn(async () => columns),
  };
  return adapter as unknown as DbAdapter;
}

function makeCtx(
  adapter: DbAdapter | undefined,
  opts?: { confirm?: boolean },
): ImportWizardContext & { confirmCalls(): number } {
  const state = { confirmCount: 0 };
  const ctx = {
    getAdapter: async () => adapter,
    getActiveDriver: () => (adapter ? (adapter as { driver?: string }).driver : undefined),
    confirm: async () => {
      state.confirmCount++;
      return opts?.confirm ?? true;
    },
    batchSize: 1000,
  };
  const withCount = ctx as ImportWizardContext & { confirmCalls(): number };
  withCount.confirmCalls = () => state.confirmCount;
  return withCount;
}

const columns = [
  { name: "id", dataType: "integer" },
  { name: "name", dataType: "text" },
];

describe("runImport — happy path", () => {
  it("auto-maps matching headers, confirms once, then executes", async () => {
    const adapter = makeAdapter("postgres", columns);
    const ctx = makeCtx(adapter);
    const result = await runImport("id,name\n1,Ann\n2,Bob", "csv", { schema: "public", table: "users" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(ctx.confirmCalls()).toBe(1);
  });

  it("does not execute when the user declines confirmation", async () => {
    const adapter = makeAdapter("postgres", columns);
    const ctx = makeCtx(adapter, { confirm: false });
    const result = await runImport("id,name\n1,Ann", "csv", { schema: "public", table: "users" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("cancel"))).toBe(true);
  });
});

describe("runImport — guards", () => {
  it("refuses when there is no active connection", async () => {
    const ctx = makeCtx(undefined);
    const result = await runImport("id\n1", "csv", { schema: "public", table: "users" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.toLowerCase()).toMatch(/no active connection/);
  });

  it("refuses non-PostgreSQL drivers", async () => {
    const adapter = makeAdapter("mysql", columns);
    const ctx = makeCtx(adapter);
    const result = await runImport("id\n1", "csv", { schema: "public", table: "users" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/PostgreSQL/);
  });

  it("reports parse errors for an empty CSV", async () => {
    const adapter = makeAdapter("postgres", columns);
    const ctx = makeCtx(adapter);
    const result = await runImport("", "csv", { schema: "public", table: "users" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("empty"))).toBe(true);
  });
});
