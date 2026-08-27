// src/ui/__tests__/aiChatPanelMentions.test.ts — TASK-005 host-side test.
//
// Pure + host-side coverage for the @-mention reference feature:
//   1. parseMentionTokens() pure regex helper (extract, dedupe, order-stable).
//   2. Message shapes: mention_objects (host→webview) + mention_list
//      (webview→host) + mention_miss (host→webview).
//   3. resolveMentionsForTurn(): object tokens → DDL block via
//      buildDatabaseStructure path (DDL-only, no runQuery); file tokens
//      → file content with 100KB cap + truncation notice; unresolved
//      tokens → a list of mention misses (caller posts mention_miss bubbles).
//   4. PRIVACY: resolveMentionsForTurn MUST NOT call runQuery.
//      The TASK-004 sentinel test (aiChatPanelPrivacy.test.ts) covers the
//      buildMessages path; this covers the mention-resolve path.
//
// These tests are PURE — they do not construct an AiChatPanel instance, do
// not open a webview, do not require the vscode runtime. They exercise the
// exported helpers directly so the contract is test-stable.
import type * as Vscode from "vscode";

import { describe, it, expect, vi, type Mock } from "vitest";

/** File-read callable shape — alias avoids `import("vscode")` in annotations. */
type FsReadFile = Vscode.workspace["fs"]["readFile"];
// `vscode` is imported transitively via aiChatPanel.ts; stub it BEFORE the
// production import so vitest's module loader does not try to resolve the
// real package. resolveMentionsForTurn only uses vscode.workspace.fs, which
// is provided through the call site (we stub it per-test).
vi.mock("vscode", () => ({
  workspace: {
    fs: {
      // The host treats a thrown read as ENOENT (best-effort). Tests that
      // want a real file read inject their own `fs` via ResolveMentionsOptions.
      readFile: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    },
    workspaceFolders: undefined,
    findFiles: vi.fn(async () => []),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    parse: (s: string) => ({ fsPath: s.replace(/^file:\/\//, ""), toString: () => s }),
  },
}));

import type { ChatMessage } from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import type {
  DbAdapter,
  SchemaInfo,
  TableInfo,
  ViewInfo,
  ColumnInfo,
  RoutineInfo,
} from "../../adapters/types";

import {
  parseMentionTokens,
  resolveMentionsForTurn,
  MENTION_OBJECT_KINDS,
  MENTION_RESOLVE_FILE_CAP_BYTES,
  type MentionObjectItem,
} from "../aiChatPanel";

// ---- Spy adapter (privacy-aware, mirrors aiChatPanelPrivacy.test.ts) ----

const SENTINEL_ROW = "SENTINEL-ROW-DATA-mention";

interface SpyAdapterOptions {
  schemas?: SchemaInfo[];
  tables?: TableInfo[];
  views?: ViewInfo[];
  routines?: RoutineInfo[];
  columns?: ColumnInfo[];
  /** When true, runQuery would return sentinel rows if anyone called it. */
  sentinelRows?: boolean;
}

interface SpyAdapter extends DbAdapter {
  calls: {
    runQuery: number;
    listSchemas: number;
    listTables: number;
    listViews: number;
    listRoutines: number;
    listColumns: number;
  };
}

function createSpyAdapter(opts: SpyAdapterOptions = {}): SpyAdapter {
  const calls = {
    runQuery: 0,
    listSchemas: 0,
    listTables: 0,
    listViews: 0,
    listRoutines: 0,
    listColumns: 0,
  };
  const schemas = opts.schemas ?? ([{ name: "public" }] as SchemaInfo[]);
  const tables = opts.tables ??
    ([
      { schema: "public", name: "users", type: "table" },
      { schema: "public", name: "orders", type: "table" },
    ] as TableInfo[]);
  const views = opts.views ?? ([] as ViewInfo[]);
  const routines = opts.routines ?? ([] as RoutineInfo[]);
  const columns = opts.columns ??
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
    ] as ColumnInfo[]);

  return {
    calls,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runQuery: vi.fn(async (_sql: string) => {
      calls.runQuery++;
      if (opts.sentinelRows) {
        return {
          results: [
            { columns: ["x"], rows: [[SENTINEL_ROW]] },
          ],
        };
      }
      return { results: [{ columns: [], rows: [] }] };
    }) as unknown as DbAdapter["runQuery"],
    listSchemas: vi.fn(async (_i: boolean) => {
      calls.listSchemas++;
      return schemas;
    }) as unknown as DbAdapter["listSchemas"],
    listTables: vi.fn(async (schema?: string) => {
      calls.listTables++;
      return tables.filter((t) => (schema === undefined ? true : t.schema === schema));
    }) as unknown as DbAdapter["listTables"],
    listViews: vi.fn(async (schema?: string) => {
      calls.listViews++;
      return views.filter((v) => (schema === undefined ? true : v.schema === schema));
    }) as unknown as DbAdapter["listViews"],
    listRoutines: vi.fn(async (schema?: string) => {
      calls.listRoutines++;
      return routines.filter((r) => (schema === undefined ? true : r.schema === schema));
    }) as unknown as DbAdapter["listRoutines"],
    listColumns: vi.fn(async (table: string, schema?: string) => {
      calls.listColumns++;
      return columns.filter(
        (c) => c.table === table && (schema === undefined || c.schema === schema),
      );
    }) as unknown as DbAdapter["listColumns"],
    listRoutineParams: vi.fn(async () => []),
    estimateTableRows: vi.fn(async () => null),
    estimateTableRowsBatch: vi.fn(async () => new Map<string, number | null>()),
    listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
    testConnection: vi.fn(async () => {}),
  };
}

// ---- #1 parseMentionTokens: pure regex + dedupe + order-stable ---------

describe("parseMentionTokens — pure @-token extractor (TASK-005)", () => {
  it("#1a extracts a single @schema.name token", () => {
    expect(parseMentionTokens("look at @public.users please")).toEqual([
      "public.users",
    ]);
  });

  it("#1b extracts a single @name token (no qualifier)", () => {
    expect(parseMentionTokens("what about @users?")).toEqual(["users"]);
  });

  it("#1c extracts a single @path/file token", () => {
    expect(parseMentionTokens("open @src/foo.ts now")).toEqual(["src/foo.ts"]);
  });

  it("#1d multiple + duplicate tokens are deduplicated, order-stable", () => {
    const out = parseMentionTokens("@a @b @a @c @b");
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("#1e emails are NOT extracted (no @-prefix + word boundary)", () => {
    // The regex requires a leading non-word boundary right after the @ —
    // user@host has word chars on both sides of the @, so no match.
    expect(parseMentionTokens("mail me at foo@bar.com")).toEqual([]);
  });

  it("#1f handles empty / no-mention text", () => {
    expect(parseMentionTokens("")).toEqual([]);
    expect(parseMentionTokens("nothing to mention here")).toEqual([]);
  });

  it("#1g adjacent tokens separated only by punctuation", () => {
    expect(parseMentionTokens("@a,@b;@c")).toEqual(["a", "b", "c"]);
  });

  it("#1h token can contain digits, underscores, dots, hyphens", () => {
    expect(parseMentionTokens("see @schema_1.tbl-2 v3")).toEqual([
      "schema_1.tbl-2",
    ]);
  });

  it("#1i token followed by punctuation does not extend", () => {
    // Trailing punctuation should NOT be part of the token.
    expect(parseMentionTokens("@users,@orders.")).toEqual(["users", "orders"]);
  });
});

// ---- #2 resolveMentionsForTurn: object resolution → DDL block --------

describe("resolveMentionsForTurn — object tokens → DDL block (TASK-005)", () => {
  it("#2a @public.users → block carries CREATE TABLE users; listColumns called", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const result = await resolveMentionsForTurn(factory, ["public.users"]);

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("table");
    expect(result.resolved[0]!.token).toBe("public.users");
    expect(result.resolved[0]!.block).toContain("CREATE TABLE");
    expect(result.resolved[0]!.block).toContain("users");
    // The DDL path goes through listSchemas/listTables/listColumns — sanity.
    expect(adapter.calls.listSchemas).toBeGreaterThanOrEqual(1);
    expect(adapter.calls.listTables).toBeGreaterThanOrEqual(1);
    expect(adapter.calls.listColumns).toBeGreaterThanOrEqual(1);
    // No misses, no sentinel leak, no runQuery.
    expect(result.misses).toEqual([]);
    expect(adapter.calls.runQuery).toBe(0);
    expect(result.contextBlock).toContain("CREATE TABLE");
    expect(result.contextBlock).toContain("Referenced context");
  });

  it("#2b view token @public.v → block contains CREATE VIEW", async () => {
    const adapter = createSpyAdapter({
      views: [
        { schema: "public", name: "v", type: "view" },
      ] as ViewInfo[],
    });
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const result = await resolveMentionsForTurn(factory, ["public.v"]);

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("view");
    expect(result.resolved[0]!.block).toMatch(/CREATE VIEW|public\.v/);
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#2c routine token → block contains routine info; listRoutines called", async () => {
    const adapter = createSpyAdapter({
      routines: [
        {
          schema: "public",
          name: "do_thing",
          kind: "function",
          returnType: "void",
        },
      ] as RoutineInfo[],
    });
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const result = await resolveMentionsForTurn(factory, ["public.do_thing"]);

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("routine");
    expect(result.resolved[0]!.block).toContain("do_thing");
    expect(adapter.calls.listRoutines).toBeGreaterThanOrEqual(1);
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#2d unresolved object token → recorded as miss, block absent, no throw", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const result = await resolveMentionsForTurn(factory, ["public.does_not_exist"]);

    expect(result.resolved.length).toBe(0);
    expect(result.misses).toEqual(["public.does_not_exist"]);
    // Empty contextBlock when only misses occurred.
    expect(result.contextBlock).toBe("");
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#2e adapter unavailable (factory throws) → empty resolution, no crash", async () => {
    const factory: AdapterFactory = vi.fn(async () => {
      throw new Error("no connection");
    });

    const result = await resolveMentionsForTurn(factory, ["public.users"]);

    expect(result.resolved.length).toBe(0);
    // Without an adapter, every object token is a miss.
    expect(result.misses).toEqual(["public.users"]);
    expect(result.contextBlock).toBe("");
  });

  it("#2f factory returns null → empty resolution, no crash", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);

    const result = await resolveMentionsForTurn(factory, ["public.users"]);

    expect(result.resolved.length).toBe(0);
    expect(result.misses).toEqual(["public.users"]);
  });

  it("#2g multiple + duplicate tokens → deduped blocks, order-stable", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const result = await resolveMentionsForTurn(
      factory,
      ["public.users", "public.orders", "public.users"],
    );

    expect(result.resolved.map((r) => r.token)).toEqual([
      "public.users",
      "public.orders",
    ]);
    // The DDL header appears once for both blocks.
    expect(result.resolved.length).toBe(2);
    expect(result.misses).toEqual([]);
  });

  it("#2h PRIVACY: resolveMentionsForTurn NEVER calls runQuery even when sentinels planted", async () => {
    const adapter = createSpyAdapter({ sentinelRows: true });
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const result = await resolveMentionsForTurn(factory, [
      "public.users",
      "public.orders",
    ]);

    expect(adapter.calls.runQuery).toBe(0);
    // No sentinel leaks in any block or the contextBlock blob.
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(SENTINEL_ROW);
  });
});

// ---- #3 file token resolution -----------------------------------------

describe("resolveMentionsForTurn — file tokens (TASK-005)", () => {
  function makeFakeFileReader(files: Record<string, string>): {
    readFile: Mock;
  } {
    return {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const content = files[uri.fsPath];
        if (content === undefined) {
          throw new Error(`ENOENT: ${uri.fsPath}`);
        }
        return new Uint8Array(
          content.split("").map((c) => c.charCodeAt(0)),
        );
      }),
    };
  }

  it("#3a @path/to/file.ts → block carries file content verbatim", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeFakeFileReader({
      "/ws/src/foo.ts": "export const x = 1;",
    });

    const result = await resolveMentionsForTurn(
      factory,
      ["src/foo.ts"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("file");
    expect(result.resolved[0]!.token).toBe("src/foo.ts");
    expect(result.resolved[0]!.block).toContain("export const x = 1;");
    expect(result.contextBlock).toContain("export const x = 1;");
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#3b file >100KB → truncated; '[truncated]' notice present", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const huge = "x".repeat(MENTION_RESOLVE_FILE_CAP_BYTES + 5_000);
    const fs = makeFakeFileReader({
      "/ws/big.txt": huge,
    });

    const result = await resolveMentionsForTurn(
      factory,
      ["big.txt"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("file");
    const block = result.resolved[0]!.block;
    // The block carries a truncation notice.
    expect(block).toMatch(/truncated/i);
    // The block body itself is bounded to the cap.
    // We cannot measure the exact body length here (heading + body + notice),
    // but we know the body is at most MENTION_RESOLVE_FILE_CAP_BYTES chars.
    expect(block.length).toBeLessThan(MENTION_RESOLVE_FILE_CAP_BYTES + 500);
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#3c file read error (ENOENT) → miss recorded, no throw", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeFakeFileReader({}); // empty map → all reads fail

    const result = await resolveMentionsForTurn(
      factory,
      ["missing.ts"],
      { fs: fs.readFile as unknown as FsReadFile },
    );

    expect(result.resolved.length).toBe(0);
    expect(result.misses).toEqual(["missing.ts"]);
  });

  it("#3d mixed object + file + unresolved → all three categories recorded", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeFakeFileReader({
      "/ws/src/foo.ts": "let x = 1;",
    });

    const result = await resolveMentionsForTurn(
      factory,
      ["public.users", "src/foo.ts", "public.nope"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );

    expect(result.resolved.map((r) => r.kind)).toEqual(["table", "file"]);
    expect(result.resolved.map((r) => r.token)).toEqual([
      "public.users",
      "src/foo.ts",
    ]);
    expect(result.misses).toEqual(["public.nope"]);
    // Context block carries both DDL + file content.
    expect(result.contextBlock).toContain("CREATE TABLE");
    expect(result.contextBlock).toContain("let x = 1;");
  });

  it("#3e file path with directory components resolves via workspace root + relative path", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeFakeFileReader({
      "/ws/src/nested/deep.ts": "ok",
    });

    const result = await resolveMentionsForTurn(
      factory,
      ["src/nested/deep.ts"],
      {
        fs: fs.readFile as unknown as FsReadFile,
        workspaceRoot: "/ws",
      },
    );

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("file");
  });
});

// ---- #4 message shapes (compile-time + runtime) ----------------------

describe("TASK-005 message shapes — mention_objects / mention_list / mention_miss", () => {
  it("#4a MENTION_OBJECT_KINDS is the literal union", () => {
    // The set is used to validate object-kind discriminators.
    expect(MENTION_OBJECT_KINDS).toEqual(["table", "view", "routine", "file"]);
  });

  it("#4b MentionObjectItem shape: kind/label/detail/token required, no apiKey", () => {
    const item: MentionObjectItem = {
      kind: "table",
      label: "public.users",
      detail: "public · table",
      token: "public.users",
    };
    const blob = JSON.stringify(item);
    expect(blob).not.toMatch(/api_?key/i);
    expect(blob).not.toMatch(/sk-[a-z0-9]/i);
  });

  it("#4c parseMentionTokens output composes into a send-path mentions array (smoke)", () => {
    // The webview ships `{type:"send", text, mentions}`. Confirm parse +
    // mention-list composition is stable (call shape only — message
    // protocol lives in aiChatPanelMessages.ts).
    const text = "explain @public.users and @src/foo.ts vs @nope";
    const tokens = parseMentionTokens(text);
    expect(tokens).toEqual(["public.users", "src/foo.ts", "nope"]);
    // Mention list is order-stable + deduped.
    expect(parseMentionTokens("@a @a @b")).toEqual(["a", "b"]);
  });
});

// ---- #5 contract: per-turn injection shape ---------------------------

describe("TASK-005 resolveMentionsForTurn — contextBlock shape for per-turn injection", () => {
  it("#5a contextBlock is empty when no tokens", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const result = await resolveMentionsForTurn(factory, []);
    expect(result.contextBlock).toBe("");
    expect(result.resolved).toEqual([]);
    expect(result.misses).toEqual([]);
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#5b contextBlock is non-empty and starts with the 'Referenced context' header when any token resolves", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const result = await resolveMentionsForTurn(factory, ["public.users"]);
    expect(result.contextBlock).toMatch(/--- Referenced context ---/);
    expect(result.contextBlock).toContain("CREATE TABLE");
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#5c miss-only tokens still produce empty contextBlock (no fake DDL injection)", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const result = await resolveMentionsForTurn(factory, ["does.not.exist"]);
    expect(result.contextBlock).toBe("");
    expect(result.misses).toEqual(["does.not.exist"]);
  });
});

// ---- #6 fix-round: multi-segment path tokens (TASK-005 R3 review #1) --

describe("parseMentionTokens — multi-segment path tokens (fix round 1)", () => {
  it("#6a @src/ui/aiChatPanel.ts → full multi-segment token (not just 'src/ui')", () => {
    // The reviewer caught that the regex's `(?:[\w.-]+\/)?` allows only ONE
    // path segment, so any @-token with ≥2 slashes was truncating at the
    // second segment. This is the production-export case that motivated the
    // fix — every file ≥2 directories deep always missed.
    expect(parseMentionTokens("check @src/ui/aiChatPanel.ts please")).toEqual([
      "src/ui/aiChatPanel.ts",
    ]);
  });

  it("#6b @a/b/c/d.txt → full four-segment token", () => {
    expect(parseMentionTokens("open @a/b/c/d.txt")).toEqual([
      "a/b/c/d.txt",
    ]);
  });

  it("#6c email 'user@example.com' is NOT extracted (no false positive)", () => {
    // The existing email guard MUST hold under the new regex — the prefix
    // group now matches 0..N segments, but a lookbehind `(?<![\w@])` still
    // blocks word-char-before-@.
    expect(parseMentionTokens("mail me at user@example.com")).toEqual([]);
  });

  it("#6d multiple tokens in one message — full paths preserved", () => {
    expect(
      parseMentionTokens("compare @src/ui/foo.ts and @src/ui/bar.ts"),
    ).toEqual(["src/ui/foo.ts", "src/ui/bar.ts"]);
  });

  it("#6e schema.path still parses (schema prefix unaffected)", () => {
    // The fix replaces `?` with `*` on the prefix group; the trailing
    // identifier group is unchanged. Schema-style tokens still parse.
    expect(parseMentionTokens("explain @public.users")).toEqual([
      "public.users",
    ]);
  });
});

// ---- #7 fix-round: path-traversal rejection in resolveFileBlock -------

describe("resolveMentionsForTurn — rejects '..' segments (fix round 1)", () => {
  // Spy that records every path it gets asked to read; throws if asked
  // outside the staged set so any escape attempt is loud.
  function makeRecordingFs(
    staged: Record<string, string>,
  ): { readFile: Mock; reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        reads.push(uri.fsPath);
        const content = staged[uri.fsPath];
        if (content === undefined) {
          throw new Error(`ENOENT: ${uri.fsPath}`);
        }
        return new Uint8Array(
          content.split("").map((c) => c.charCodeAt(0)),
        );
      }),
    };
  }

  it("#7a @../sibling.txt → mention_miss, NO file read attempt", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeRecordingFs({}); // nothing staged — any read throws

    const result = await resolveMentionsForTurn(
      factory,
      ["../sibling.txt"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );

    expect(result.resolved.length).toBe(0);
    expect(result.misses).toEqual(["../sibling.txt"]);
    // CRITICAL: resolveFileBlock must NOT have attempted any read.
    expect(fs.reads.length).toBe(0);
    // Adapter is untouched (path-traversal token isn't an object token).
    expect(adapter.calls.runQuery).toBe(0);
  });

  it("#7b @../etc/passwd → mention_miss, NO file read attempt", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeRecordingFs({});

    const result = await resolveMentionsForTurn(
      factory,
      ["../etc/passwd"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );

    expect(result.resolved.length).toBe(0);
    expect(result.misses).toEqual(["../etc/passwd"]);
    expect(fs.reads.length).toBe(0);
  });

  it("#7c legitimate @src/nested/deep.ts still resolves (no regression)", async () => {
    // The rejection must be scoped to '..' segments specifically — deep
    // nested paths inside the workspace must keep working.
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeRecordingFs({
      "/ws/src/nested/deep.ts": "ok",
    });

    const result = await resolveMentionsForTurn(
      factory,
      ["src/nested/deep.ts"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]!.kind).toBe("file");
    expect(fs.reads).toEqual(["/ws/src/nested/deep.ts"]);
  });

  it("#7d mid-path '..' is also rejected (@a/../b.txt)", async () => {
    // Defense-in-depth: any '..' segment, not just leading ones.
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    const fs = makeRecordingFs({});

    const result = await resolveMentionsForTurn(
      factory,
      ["a/../b.txt"],
      { fs: fs.readFile as unknown as FsReadFile, workspaceRoot: "/ws" },
    );

    expect(result.resolved.length).toBe(0);
    expect(result.misses).toEqual(["a/../b.txt"]);
    expect(fs.reads.length).toBe(0);
  });
});

// ---- #8 fix-round: byte-cap correctness in truncation (review #3) ----

describe("resolveFileBlock — truncation cap is bytes (fix round 1)", () => {
  // Each char in the multibyte fixture encodes to ≥2 UTF-8 bytes. If the
  // implementation truncates by .length (UTF-16 code units), the resulting
  // block is well under MENTION_RESOLVE_FILE_CAP_BYTES and the encoded
  // representation easily exceeds the byte cap on the wire.
  it("#8a multibyte content is truncated by byte count, not char count", async () => {
    const adapter = createSpyAdapter();
    const factory: AdapterFactory = vi.fn(async () => adapter);
    // 60_000 BMP code points × 3 bytes/char = 180 KB of UTF-8.
    const multibyte = "中".repeat(60_000);
    const encoded = new TextEncoder().encode(multibyte);
    expect(encoded.byteLength).toBeGreaterThan(MENTION_RESOLVE_FILE_CAP_BYTES);
    const fsRead = vi.fn(async () => encoded);
    const fs = { readFile: fsRead };

    const result = await resolveMentionsForTurn(
      factory,
      ["big.txt"],
      {
        fs: fs.readFile as unknown as FsReadFile,
        workspaceRoot: "/ws",
      },
    );

    expect(result.resolved.length).toBe(1);
    const block = result.resolved[0]!.block;
    // Block contains a truncation notice (we know the byte cap is binding).
    expect(block).toMatch(/truncated/i);
    // Encoded body is bounded: without the fix (char-count truncation),
    // the encoded block would be > MENTION_RESOLVE_FILE_CAP_BYTES.
    // With the fix, byte-length ≤ cap + heading + notice slack.
    const reencoded = new TextEncoder().encode(block);
    expect(reencoded.byteLength).toBeLessThanOrEqual(
      MENTION_RESOLVE_FILE_CAP_BYTES + 256,
    );
    expect(adapter.calls.runQuery).toBe(0);
  });
});

// Avoid unused import warning for ChatMessage (kept for future tests).
const _typeMarker: ChatMessage | null = null;
void _typeMarker;
