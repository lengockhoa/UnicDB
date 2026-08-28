// `aiChatPanel.ts` imports `vscode` at module top — stub it before any
// production import so vitest's module loader does not try to resolve the
// real vscode package. We only test the pure buildMessages() export;
// nothing in this file touches window/webview APIs.
vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: (...parts: unknown[]) => ({
      toString: () => parts.map((p) => String(p)).join("/"),
    }),
  },
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: "",
        postMessage: vi.fn().mockResolvedValue(undefined),
        onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
        asWebviewUri: (u: unknown) => u,
        cspSource: "vscode-webview://test",
      },
      onDidDispose: vi.fn(() => ({ dispose: () => {} })),
      reveal: vi.fn(),
      dispose: vi.fn(),
      visible: true,
      disposed: false,
    })),
  },
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: undefined },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// src/ui/__tests__/aiChatPanelPrivacy.test.ts — TASK-004 privacy regression
// lock.
//
// HARD invariant under test: buildMessages (src/ui/aiChatPanel.ts:186-325) is
// the single context funnel for BOTH engines (runBuiltinTurn + runAcpTurn).
// Auto-context MUST be schema structure (DDL) only. Row/data content must NEVER
// be pulled by the context path. Sentinel strings planted in adapter
// `runQuery` results MUST NOT appear anywhere in the assembled messages, and
// `runQuery` MUST NOT be called at all during buildMessages.
//
// These tests are TEST-ONLY. If they ever go RED against current production
// code, the invariant is broken — report FAIL, do not patch production code.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { buildMessages } from "../aiChatPanel";
import type { ChatMessage } from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import type {
  DbAdapter,
  SchemaInfo,
  TableInfo,
  ViewInfo,
  ColumnInfo,
} from "../../adapters/types";

const SENTINEL_ROW = "SENTINEL-ROW-DATA-7c4f";
const SENTINEL_VIEW = "XSECRETROWDATA42X";

interface SpyAdapterOptions {
  schemas?: SchemaInfo[];
  tables?: TableInfo[];
  views?: ViewInfo[];
  columns?: ColumnInfo[];
  /** If true, runQuery resolves with rows containing SENTINEL_ROW. */
  sentinelRows?: boolean;
  /** If true, runQuery throws "row access forbidden in context build". */
  throwOnRun?: boolean;
  /** If true, listSchemas rejects. */
  schemasReject?: boolean;
  /** If true, listTables rejects (per-schema). */
  tablesReject?: boolean;
}

interface SpyAdapter extends DbAdapter {
  calls: {
    runQuery: string[];
    listSchemas: number;
    listTables: number;
    listViews: number;
    listColumns: number;
  };
  runQueryMock: Mock;
}

function createSpyAdapter(opts: SpyAdapterOptions = {}): SpyAdapter {
  const calls = {
    runQuery: [] as string[],
    listSchemas: 0,
    listTables: 0,
    listViews: 0,
    listColumns: 0,
  };

  const schemas: SchemaInfo[] =
    opts.schemas ?? ([{ name: "public" }] as unknown as SchemaInfo[]);
  const tables: TableInfo[] =
    opts.tables ??
    ([
      { schema: "public", name: "users", type: "table" },
      { schema: "public", name: "orders", type: "table" },
    ] as unknown as TableInfo[]);
  const views: ViewInfo[] = opts.views ?? [];
  const columns: ColumnInfo[] =
    opts.columns ??
    ([
      {
        name: "id",
        dataType: "integer",
        nullable: false,
        isPrimaryKey: true,
        schema: "public",
        table: "users",
      },
      {
        name: "email",
        dataType: "text",
        nullable: false,
        schema: "public",
        table: "users",
      },
      {
        name: "id",
        dataType: "integer",
        nullable: false,
        isPrimaryKey: true,
        schema: "public",
        table: "orders",
      },
    ] as unknown as ColumnInfo[]);

  const runQueryMock = opts.throwOnRun
    ? vi.fn(async (sql: string) => {
        calls.runQuery.push(sql);
        throw new Error("row access forbidden in context build");
      })
    : vi.fn(async (sql: string) => {
        calls.runQuery.push(sql);
        if (opts.sentinelRows) {
          return {
            results: [
              {
                columns: ["id", "secret"],
                rows: [
                  [1, `${SENTINEL_ROW}-payload-A`],
                  [2, `${SENTINEL_ROW}-payload-B`],
                ],
              },
            ],
          };
        }
        return { results: [{ columns: [], rows: [] }] };
      });

  const listSchemasMock = opts.schemasReject
    ? vi.fn(async () => {
        calls.listSchemas++;
        throw new Error("introspection denied");
      })
    : vi.fn(async (_includeSystem: boolean) => {
        calls.listSchemas++;
        return schemas;
      });

  const listTablesMock = opts.tablesReject
    ? vi.fn(async (_schema: string) => {
        calls.listTables++;
        throw new Error("listTables denied");
      })
    : vi.fn(async (schema: string) => {
        calls.listTables++;
        return tables.filter((t) => t.schema === schema);
      });

  const listViewsMock = vi.fn(async (schema: string) => {
    calls.listViews++;
    return views.filter((v) => v.schema === schema);
  });

  const listColumnsMock = vi.fn(async (table: string, schema?: string) => {
    calls.listColumns++;
    return columns.filter(
      (c) => c.table === table && (schema === undefined || c.schema === schema),
    );
  });

  return {
    calls,
    runQueryMock,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runQuery: runQueryMock as unknown as DbAdapter["runQuery"],
    listSchemas: listSchemasMock as unknown as DbAdapter["listSchemas"],
    listTables: listTablesMock as unknown as DbAdapter["listTables"],
    listViews: listViewsMock as unknown as DbAdapter["listViews"],
    listRoutines: vi.fn(async () => []),
    listColumns: listColumnsMock as unknown as DbAdapter["listColumns"],
    estimateTableRows: vi.fn(async () => null),
    listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
    testConnection: vi.fn(async () => {}),
  } as unknown as SpyAdapter;
}

function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}

beforeEach(() => {
  // Each test gets a fresh spy; no shared mutable state across cases.
});

describe("AiChatPanel.buildMessages — privacy regression lock (TASK-004)", () => {
  it("[#1 DDL-only] system prompt carries CREATE TABLE DDL; runQuery NEVER invoked", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const history: ChatMessage[] = [
      { role: "user", content: "earlier turn" },
      { role: "assistant", content: "earlier reply" },
    ];

    const messages = await buildMessages(
      factory,
      history,
      userMsg("describe my tables"),
      {
        contextBudgetChars: 200_000,
        contextTableLimit: 200,
      },
    );

    expect(messages.length).toBe(1 + history.length + 1);
    const system = messages[0];
    expect(system?.role).toBe("system");

    const systemText = typeof system?.content === "string" ? system.content : "";
    // DDL present:
    expect(systemText).toContain("CREATE TABLE");
    // export_structure hint present (src/ui/aiChatPanel.ts:323):
    expect(systemText).toContain("export_structure");
    // History + user message pass through verbatim:
    expect(messages.slice(1)).toEqual([
      ...history,
      { role: "user", content: "describe my tables" },
    ]);

    // The privacy-critical assertion: row-bearing methods NEVER invoked.
    expect(adapter.calls.runQuery.length).toBe(0);
    expect(adapter.runQueryMock).not.toHaveBeenCalled();

    // Sanity: introspection methods WERE called (otherwise DDL would be empty
    // and the test would be vacuous).
    expect(adapter.calls.listSchemas).toBeGreaterThan(0);
    expect(adapter.calls.listTables).toBeGreaterThan(0);
    expect(adapter.calls.listColumns).toBeGreaterThan(0);
  });

  it("[#2 sentinel] sentinel strings planted in DATA positions never appear in messages", async () => {
    const adapter = createSpyAdapter({ sentinelRows: true });
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const history: ChatMessage[] = [{ role: "user", content: "show me everything" }];

    const messages = await buildMessages(factory, history, userMsg("dump all rows"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });

    // The spy would feed sentinels if anyone called runQuery during context
    // build. buildMessages must not call it at all.
    expect(adapter.calls.runQuery.length).toBe(0);

    const blob = JSON.stringify(messages);
    expect(blob).not.toContain(SENTINEL_ROW);
    expect(blob).not.toContain(SENTINEL_VIEW);
    // Per-message sweep so a single leaking entry cannot hide behind others.
    for (const m of messages) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      expect(text).not.toContain(SENTINEL_ROW);
      expect(text).not.toContain(SENTINEL_VIEW);
    }
  });

  it("[#3 factory null / introspection failure] empty context, no crash, runQuery untouched", async () => {
    // factory rejects (adapter resolution failure):
    const rejectingFactory: AdapterFactory = vi.fn(async () => {
      throw new Error("adapter unavailable");
    });
    const messages = await buildMessages(rejectingFactory, [], userMsg("hi"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });
    const systemText =
      typeof messages[0]?.content === "string" ? messages[0].content : "";
    expect(systemText).not.toContain("CREATE TABLE");
    expect(systemText).not.toContain("Database structure (DDL)");
    expect(systemText.length).toBeGreaterThan(0);

    // listSchemas rejects (adapter resolves but introspection fails):
    const adapter2 = createSpyAdapter({ schemasReject: true });
    const factory2: AdapterFactory = vi.fn(async () => adapter2);
    const messages2 = await buildMessages(factory2, [], userMsg("hi"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });
    const sys2 =
      typeof messages2[0]?.content === "string" ? messages2[0].content : "";
    expect(sys2).not.toContain("CREATE TABLE");
    expect(adapter2.calls.runQuery.length).toBe(0);

    // listTables rejects per-schema:
    const adapter3 = createSpyAdapter({ tablesReject: true });
    const factory3: AdapterFactory = vi.fn(async () => adapter3);
    const messages3 = await buildMessages(factory3, [], userMsg("hi"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });
    const sys3 =
      typeof messages3[0]?.content === "string" ? messages3[0].content : "";
    expect(sys3).not.toContain("CREATE TABLE");
    expect(adapter3.calls.runQuery.length).toBe(0);

    // factory returns null (no adapter wired):
    const nullFactory: AdapterFactory = vi.fn(async () => null);
    const messages4 = await buildMessages(nullFactory, [], userMsg("hi"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });
    const sys4 =
      typeof messages4[0]?.content === "string" ? messages4[0].content : "";
    expect(sys4).not.toContain("CREATE TABLE");
  });

  it("[#4 budget cut] oversize single table kept; footer appended when blocks trimmed", async () => {
    // Each table has many wide columns so each block is hundreds of chars;
    // with budget=400 the cut path drops trailing blocks and appends the
    // footer. The first block is always kept even when alone oversize.
    const wideCols: ColumnInfo[] = [];
    const tables: TableInfo[] = [];
    for (let t = 0; t < 6; t++) {
      for (let i = 0; i < 8; i++) {
        wideCols.push({
          name: `col_${i}_of_table_${t}`,
          dataType: "varchar(255)",
          nullable: true,
          schema: "public",
          table: `wide_${t}`,
        });
      }
      tables.push({ schema: "public", name: `wide_${t}`, type: "table" } as unknown as TableInfo);
    }

    const adapter = createSpyAdapter({
      tables,
      columns: wideCols,
    });
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const messages = await buildMessages(factory, [], userMsg("hi"), {
      contextBudgetChars: 600,
      contextTableLimit: 50,
    });
    const systemText =
      typeof messages[0]?.content === "string" ? messages[0].content : "";
    expect(systemText).toContain("CREATE TABLE");
    expect(systemText).toContain("more objects omitted");
    expect(systemText).toContain("export_structure");
    expect(adapter.calls.runQuery.length).toBe(0);
    expect(systemText).not.toContain(SENTINEL_ROW);
    expect(systemText).not.toContain(SENTINEL_VIEW);
  });

  it("[#5 history passthrough] history array unmodified after buildMessages", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const history: ChatMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const snapshot = JSON.parse(JSON.stringify(history)) as ChatMessage[];

    await buildMessages(factory, history, userMsg("u3"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });

    expect(history).toEqual(snapshot);
  });

  it("[#6 malformed metadata] empty schema/table names tolerated, context non-empty", async () => {
    const adapter = createSpyAdapter({
      schemas: [{ name: "" } as unknown as SchemaInfo],
      tables: [{ schema: "", name: "", type: "table" } as unknown as TableInfo],
      columns: [
        {
          name: "id",
          dataType: "integer",
          nullable: false,
          isPrimaryKey: true,
          schema: "",
          table: "",
        } as unknown as ColumnInfo,
      ],
    });
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const messages = await buildMessages(factory, [], userMsg("hi"), {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });
    const systemText =
      typeof messages[0]?.content === "string" ? messages[0].content : "";
    expect(systemText.length).toBeGreaterThan(0);
    expect(adapter.calls.runQuery.length).toBe(0);
    expect(systemText).not.toContain(SENTINEL_ROW);
  });

  // ---- cycle AB acceptance #6: privacy sentinel + 2 valid attachments --
  it("[#7 cycle AB] sentinel-seeded adapter + 2 valid image attachments: SENTINEL_* absent from system AND user parts; runQuery spy 0", async () => {
    const adapter = createSpyAdapter({ sentinelRows: true });
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const pngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpegHead = new Uint8Array([0xff, 0xd8, 0xff]);
    function b64(bytes: Uint8Array): string {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return (globalThis as { btoa: (s: string) => string }).btoa(bin);
    }
    const pngB64 = b64(pngHead);
    const jpegB64 = b64(jpegHead);

    const userMsgParts: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe these" },
        { type: "image_url", imageUrl: "data:image/png;base64," + pngB64 },
        { type: "image_url", imageUrl: "data:image/jpeg;base64," + jpegB64 },
      ],
    };

    const messages = await buildMessages(factory, [], userMsgParts, {
      contextBudgetChars: 200000,
      contextTableLimit: 200,
    });

    expect(adapter.calls.runQuery.length).toBe(0);
    const allText = JSON.stringify(messages);
    expect(allText).not.toContain(SENTINEL_ROW);
    expect(allText).not.toContain(SENTINEL_VIEW);

    const lastUser = messages[messages.length - 1] as ChatMessage;
    expect(lastUser.role).toBe("user");
    const parts = lastUser.content as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBe(3);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image_url");
    expect(parts[2].type).toBe("image_url");
  });
});