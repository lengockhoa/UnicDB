// src/ui/__tests__/sqlSemanticTokens.test.ts
// TASK-002 §Test Cases #1-#10 — SqlSemanticTokensProvider unit tests.
// Light vscode mock: SemanticTokensLegend / SemanticTokensBuilder recorder /
// Position / Range / EventEmitter recorder, mirroring sqlCompletionProvider.test.ts.
import { describe, it, expect, vi } from "vitest";
import type { DbAdapter, ColumnInfo, TableInfo } from "../../adapters/types";

vi.mock("vscode", () => {
  class SemanticTokensLegend {
    tokenTypes: string[];
    tokenModifiers: string[];
    constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
      this.tokenTypes = tokenTypes;
      this.tokenModifiers = tokenModifiers;
    }
  }
  class SemanticTokensBuilder {
    pushes: Array<[number, number, number, number]>;
    constructor() {
      this.pushes = [];
    }
    push(line: number, char: number, length: number, tokenType: number) {
      this.pushes.push([line, char, length, tokenType]);
    }
    build() {
      return { data: this.pushes.flat() };
    }
  }
  class Position {
    line: number;
    character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    start: Position;
    end: Position;
    constructor(start: Position, end: Position) {
      this.start = start;
      this.end = end;
    }
  }
  class EventEmitter<T> {
    listeners: Array<(e: T) => void>;
    constructor() {
      this.listeners = [];
    }
    event(listener: (e: T) => void) {
      this.listeners.push(listener);
      return { dispose: () => {} };
    }
    fire(e: T) {
      for (const l of this.listeners.slice()) l(e);
    }
    dispose() {}
  }
  return {
    SemanticTokensLegend,
    SemanticTokensBuilder,
    Position,
    Range,
    EventEmitter,
    SemanticTokens: class {
      data: number[];
      constructor(data: Uint32Array) {
        this.data = Array.from(data);
      }
    },
  };
});

import * as vscode from "vscode";
import { SqlSemanticTokensProvider } from "../sqlSemanticTokens";
import { SchemaCache } from "../schemaCache";

const USERS_TABLES: TableInfo[] = [{ name: "users", schema: "public" }];
const USERS_COLUMNS: ColumnInfo[] = [
  { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
  { name: "email", dataType: "text", nullable: true },
];

interface AdapterMocks {
  adapter: DbAdapter;
  listSchemas: ReturnType<typeof vi.fn>;
  listTables: ReturnType<typeof vi.fn>;
  listColumns: ReturnType<typeof vi.fn>;
}

function makeAdapter(): AdapterMocks {
  const listSchemas = vi.fn(async () => [{ name: "public" }]);
  const listTables = vi.fn(async () => USERS_TABLES.slice());
  const listColumns = vi.fn(async () => USERS_COLUMNS.slice());
  const adapter = { listSchemas, listTables, listColumns } as unknown as DbAdapter;
  return { adapter, listSchemas, listTables, listColumns };
}

function makeProvider(
  adapterProvider: () => Promise<DbAdapter | null> | DbAdapter | null,
  hasConnection = true,
): SqlSemanticTokensProvider {
  const cache = new SchemaCache(adapterProvider);
  return new SqlSemanticTokensProvider({ cache, hasConnection: () => hasConnection });
}

function doc(text: string): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    languageId: "sql",
    getText: () => text,
    lineAt: (l: number) => ({ text: lines[l] ?? "" }),
    positionAt: (offset: number) => {
      let line = 0;
      let col = 0;
      for (let k = 0; k < offset && k < text.length; k += 1) {
        if (text[k] === "\n") {
          line += 1;
          col = 0;
        } else {
          col += 1;
        }
      }
      return new vscode.Position(line, col);
    },
  } as unknown as vscode.TextDocument;
}

describe("SqlSemanticTokensProvider — TASK-002 §Test Cases", () => {
  const LEGEND = () =>
    new vscode.SemanticTokensLegend(
      ["namespace", "class", "property", "keyword"],
      [],
    );
  const chunks = (data: number[]): number[][] => {
    const out: number[][] = [];
    for (let k = 0; k < data.length; k += 4) {
      out.push(data.slice(k, k + 4) as number[]);
    }
    return out;
  };

  it("#1 known table is tokenized as class", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM users"),
      LEGEND(),
    );
    const tokens = chunks(res.data);
    const classIdx = LEGEND().tokenTypes.indexOf("class");
    expect(tokens).toEqual([[0, 14, 5, classIdx]]);
  });

  it("#2 known column is tokenized as property", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT email FROM users"),
      LEGEND(),
    );
    const tokens = chunks(res.data);
    const classIdx = LEGEND().tokenTypes.indexOf("class");
    const propIdx = LEGEND().tokenTypes.indexOf("property");
    const email = tokens.find((t) => t[1] === 7 && t[2] === 5);
    expect(email).toBeDefined();
    expect(email![3]).toBe(propIdx);
    expect(tokens).toContainEqual([0, 18, 5, classIdx]);
  });

  it("#3 known schema is tokenized as namespace", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM public.users"),
      LEGEND(),
    );
    const tokens = chunks(res.data);
    const nsIdx = LEGEND().tokenTypes.indexOf("namespace");
    const classIdx = LEGEND().tokenTypes.indexOf("class");
    expect(tokens).toContainEqual([0, 14, 6, nsIdx]);
    expect(tokens).toContainEqual([0, 21, 5, classIdx]);
  });

  it("#4 no active connection returns zero tokens without throwing", async () => {
    const provider = makeProvider(() => null, false);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM users"),
      LEGEND(),
    );
    expect(res.data.length).toBe(0);
  });

  it("#5 adapter provider rejecting resolves to empty tokens", async () => {
    const { adapter, listTables } = makeAdapter();
    listTables.mockRejectedValue(new Error("connection lost"));
    const provider = makeProvider(() => adapter);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM users"),
      LEGEND(),
    );
    expect(res.data.length).toBe(0);
  });

  it("#6 identifier not in the schema emits no token", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM not_a_table"),
      LEGEND(),
    );
    expect(res.data.length).toBe(0);
  });

  it("#7 identifier inside a string literal or comment is not tokenized", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    const res = await provider.provideDocumentSemanticTokens(
      doc("SELECT 'users' -- users"),
      LEGEND(),
    );
    expect(res.data.length).toBe(0);
  });

  it("#9 cold cache: first call empty, refresh fires once, second call returns class", async () => {
    let release!: (a: DbAdapter) => void;
    const deferred = new Promise<DbAdapter>((resolve) => {
      release = resolve;
    });
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => deferred);
    const spy = vi.fn();
    provider.onDidChangeSemanticTokens(spy);

    // Call 1: adapter pending → provider times out → empty, schedules refresh.
    const res1 = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM users"),
      LEGEND(),
    );
    expect(res1.data.length).toBe(0);

    // Adapter settles → in-flight lookup lands → scheduled refresh fires once.
    release(adapter);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // Second call sees a warm cache → users token typed class.
    const res2 = await provider.provideDocumentSemanticTokens(
      doc("SELECT * FROM users"),
      LEGEND(),
    );
    const classIdx = LEGEND().tokenTypes.indexOf("class");
    expect(chunks(res2.data)).toContainEqual([0, 14, 5, classIdx]);
  });

  it("#10 refresh() fires the event each call and never throws with zero listeners", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);

    // Zero listeners: 3 refreshes must not throw.
    expect(() => {
      provider.refresh();
      provider.refresh();
      provider.refresh();
    }).not.toThrow();

    // One listener: 3 refreshes → 3 firings (no coalescing).
    const spy = vi.fn();
    provider.onDidChangeSemanticTokens(spy);
    provider.refresh();
    provider.refresh();
    provider.refresh();
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
