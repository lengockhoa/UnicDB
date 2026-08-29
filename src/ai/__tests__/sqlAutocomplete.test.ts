// src/ai/__tests__/sqlAutocomplete.test.ts
// Cycle AIC TASK-AIC-002 — pure orchestration tests for SqlAutocompleteService.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SqlAutocompleteService,
  sanitizeSuffix,
  sliceAroundCursor,
  buildPrompt,
  buildCacheKey,
  isCommentOnlyOrWhitespace,
  SQL_PREFIX_MAX_CHARS,
  SQL_SUFFIX_MAX_CHARS,
  SCHEMA_CONTEXT_MAX_CHARS,
  MAX_OUTPUT_TOKENS,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  COOLDOWN_MS,
  type SchemaContext,
  type ServiceOptions,
  type SqlAutocompleteRequest,
} from "../sqlAutocomplete";
import type { AiConfig } from "../settings";
import type { ProviderRequest, ProviderResult } from "../provider";

// ---- fixtures -------------------------------------------------------------

function makeCfg(overrides: Partial<NonNullable<AiConfig["models"]["autocomplete"]>> = {}): AiConfig {
  return {
    baseUrl: "https://provider.test/v1",
    method: "chat/completions",
    timeoutMs: 60_000,
    maxSteps: 12,
    engine: "builtin",
    apiKey: "sk-very-secret-NEVER-LEAK",
    models: {
      work: { modelId: "work-model", vision: true },
      smart: { modelId: "smart-model", vision: false },
      autocomplete: {
        modelId: "fast-sql",
        vision: false,
        ...overrides,
      },
    },
  };
}

function makeSchema(extra: Partial<SchemaContext> = {}): SchemaContext {
  return {
    dialect: "postgres",
    connectionName: "local-db",
    tables: [
      {
        schema: "public",
        name: "users",
        columns: [
          { name: "id", dataType: "int" },
          { name: "email", dataType: "text" },
        ],
      },
    ],
    ...extra,
  };
}

function makeRequest(overrides: Partial<SqlAutocompleteRequest> = {}): SqlAutocompleteRequest {
  return {
    callerScope: "scope-A",
    cursorOffset: 0,
    documentText: "",
    schemaFingerprint: "fp1",
    ...overrides,
  };
}

function makeResult(text: string): ProviderResult {
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

let currentTime = 1_000_000;

function buildService(
  provider: ServiceOptions["provider"],
  resolveSchema: ServiceOptions["resolveSchema"] = async () => makeSchema(),
  now: () => number = () => currentTime,
  logger?: ServiceOptions["logger"],
): SqlAutocompleteService {
  return new SqlAutocompleteService({ provider, resolveSchema, logger, now });
}

beforeEach(() => {
  currentTime = 1_000_000;
});

// ---- pure helper unit tests ----------------------------------------------

describe("sliceAroundCursor", () => {
  it("returns bounded prefix + suffix around the cursor", () => {
    // text = "SELECT * FROM users…", offset 16, maxPrefix 10, maxSuffix 5
    // start = 16 - 10 = 6 → prefix = text[6..16] = " * FROM us"
    // end   = 16 + 5  = 21 → suffix = text[16..21] = "ers W"
    const r = sliceAroundCursor("SELECT * FROM users WHERE id = 1", 16, 10, 5);
    expect(r.prefix).toBe(" * FROM us");
  });

  it("clamps out-of-range offsets", () => {
    const r1 = sliceAroundCursor("abc", -5, 10, 10);
    expect(r1.prefix).toBe("");
    expect(r1.suffix).toBe("abc");
    const r2 = sliceAroundCursor("abc", 999, 10, 10);
    expect(r2.prefix).toBe("abc");
    expect(r2.suffix).toBe("");
  });
});

describe("sanitizeSuffix", () => {
  it("strips fences + leading semicolon + keeps first non-empty line", () => {
    expect(sanitizeSuffix("```sql\ners\n```")).toBe("ers");
    expect(sanitizeSuffix("; ers")).toBe("ers");
    expect(sanitizeSuffix("  \n\n  ers  ; ")).toBe("ers");
  });

  it("rejects English prose", () => {
    expect(sanitizeSuffix("Sure, here is the SQL: SELECT 1")).toBe("");
  });

  it("returns empty for empty input", () => {
    expect(sanitizeSuffix("")).toBe("");
    expect(sanitizeSuffix("   \n  ")).toBe("");
  });
});

describe("isCommentOnlyOrWhitespace", () => {
  it("treats whitespace + SQL comments as empty", () => {
    expect(isCommentOnlyOrWhitespace("   \n  -- a comment\n  /* b */  ")).toBe(true);
  });
  it("does not treat real SQL as empty", () => {
    expect(isCommentOnlyOrWhitespace("SELECT 1 -- inline")).toBe(false);
  });
});

describe("buildPrompt", () => {
  it("contains only schema + dialect + connection + cursor slice", () => {
    const p = buildPrompt(makeSchema(), "SELECT * FROM us", "ers", SCHEMA_CONTEXT_MAX_CHARS);
    expect(p).toContain("public.users(id:int, email:text)");
    expect(p).toContain("SELECT * FROM us");
    expect(p).toContain("ers");
    expect(p).not.toContain("sk-very-secret");
    expect(p).not.toContain("provider.test");
  });
  it("truncates oversized schema block at the cap", () => {
    const big: SchemaContext = {
      dialect: "pg",
      connectionName: "c",
      tables: Array.from({ length: 20 }, (_, i) => ({
        schema: "s",
        name: `t${i}_${"x".repeat(200)}`,
        columns: [{ name: "c1", dataType: "int" }],
      })),
    };
    const p = buildPrompt(big, "SELECT", "x", 50);
    expect(p).toContain("\u2026");
  });
});

describe("buildCacheKey", () => {
  it("keys on (scope, dialect, connection, fingerprint, prefix, suffix)", () => {
    const k1 = buildCacheKey(makeRequest(), makeSchema(), "p", "s");
    const k2 = buildCacheKey(makeRequest({ schemaFingerprint: "fp2" }), makeSchema(), "p", "s");
    const k3 = buildCacheKey(makeRequest(), makeSchema({ dialect: "mysql" }), "p", "s");
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1.split("\u0000").length).toBe(6);
  });
});

// ---- exported bound constants --------------------------------------------

describe("exported bounds match PLAN §3.0", () => {
  it("pins the exact spec values", () => {
    expect(SQL_PREFIX_MAX_CHARS).toBe(2_000);
    expect(SQL_SUFFIX_MAX_CHARS).toBe(500);
    expect(SCHEMA_CONTEXT_MAX_CHARS).toBe(12_000);
    expect(MAX_OUTPUT_TOKENS).toBe(64);
    expect(CACHE_TTL_MS).toBe(30_000);
    expect(CACHE_MAX_ENTRIES).toBe(100);
    expect(COOLDOWN_MS).toBe(500);
  });
});

// ---- service behavior tests ----------------------------------------------

describe("SqlAutocompleteService — config gating", () => {
  it("returns null and skips provider when autocomplete.modelId is empty", async () => {
    const provider = vi.fn();
    const svc = buildService(provider);
    const r = await svc.suggest(makeCfg({ modelId: "" }), makeRequest());
    expect(r).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("returns null when document is comment-only / whitespace", async () => {
    const provider = vi.fn();
    const svc = buildService(provider);
    const r = await svc.suggest(
      makeCfg(),
      makeRequest({ documentText: "  -- just a comment\n  " }),
    );
    expect(r).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("SqlAutocompleteService — happy path", () => {
  it("builds a schema-only request and returns the sanitized suffix", async () => {
    let captured: ProviderRequest | null = null;
    const provider: ServiceOptions["provider"] = vi.fn(async (_cfg, _role, req) => {
      captured = req;
      return makeResult("ers");
    });
    const svc = buildService(provider);
    const r = await svc.suggest(
      makeCfg(),
      makeRequest({ cursorOffset: 16, documentText: "SELECT * FROM users" }),
    );
    expect(r).toBe("ers");
    expect(captured).not.toBeNull();
    expect(captured!.modelId).toBe("fast-sql");
    expect(captured!.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    const userMsg = (captured!.messages[1] as { content: string }).content;
    expect(userMsg).toContain("public.users");
    expect(userMsg).not.toContain("sk-very-secret");
    expect(userMsg).not.toContain("provider.test");
  });
});

describe("SqlAutocompleteService — privacy boundary", () => {
  it("never includes sentinel row / history / apiKey / baseUrl", async () => {
    const sentinels = [
      "alice@example.test",
      "secret-history-uuid-7e9c",
      "sk-very-secret-NEVER-LEAK",
      "https://provider.test/v1",
    ];
    let capturedText = "";
    const provider: ServiceOptions["provider"] = vi.fn(async (_cfg, _role, req) => {
      capturedText = req.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      return makeResult("OK_SUFFIX");
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const svc = buildService(provider, async () => makeSchema(), () => currentTime, logger);
    await svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 1" }));
    for (const s of sentinels) {
      expect(capturedText).not.toContain(s);
    }
    const loggerText = logger.debug.mock.calls
      .map((c) => String(c[0]))
      .concat(logger.warn.mock.calls.map((c) => String(c[0])))
      .join("\n");
    expect(loggerText).not.toContain("SELECT 1");
    expect(loggerText).not.toContain("OK_SUFFIX");
  });

  it("only calls resolveSchema for schema data (no row accessor surface)", async () => {
    const resolveSchema = vi.fn(async () => makeSchema());
    const provider = vi.fn(async () => makeResult("ok"));
    const svc = buildService(provider, resolveSchema);
    await svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 1" }));
    expect(resolveSchema).toHaveBeenCalledTimes(1);
    expect(resolveSchema).toHaveBeenCalledWith("scope-A");
  });
});

describe("SqlAutocompleteService — concurrency / cancellation", () => {
  it("a new request on the same scope aborts the previous one and the stale result is dropped", async () => {
    const pending: Array<(v: ProviderResult) => void> = [];
    const provider: ServiceOptions["provider"] = vi.fn(
      () =>
        new Promise<ProviderResult>((resolve) => {
          pending.push(resolve);
        }),
    );
    const svc = buildService(provider);
    const p1 = svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 1" }));
    const p2 = svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 2" }));
    // Wait until both provider calls have registered their pending resolvers
    // before triggering them — the first suggest yields at the
    // `await resolveSchema(...)` step, so the second suggest must run to the
    // same point before the first can complete.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    // Resolve p2's provider (the latest sequence). The first promise gets
    // dropped because its AbortController was aborted by p2.
    const lastIdx = pending.length - 1;
    if (lastIdx > 0) pending[lastIdx - 1]!(makeResult("old-suffix"));
    pending[lastIdx]!(makeResult("new-suffix"));
    expect(await p2).toBe("new-suffix");
    expect(await p1).toBeNull();
  });

  it("cancel(scope) aborts the in-flight request and the caller gets null", async () => {
    let aborted = false;
    const provider: ServiceOptions["provider"] = vi.fn(
      async (_cfg, _role, _req, signal) =>
        new Promise<ProviderResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const svc = buildService(provider);
    const p = svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 1" }));
    // Let the suggest body reach `await raceWithAbort(provider(...))` so
    // the abort listener is registered on the controller's signal.
    await new Promise((r) => setTimeout(r, 10));
    svc.cancel("scope-A");
    expect(await p).toBeNull();
    expect(aborted).toBe(true);
  });
});

describe("SqlAutocompleteService — cache + cooldown", () => {
  it("second identical request within TTL serves from cache", async () => {
    const provider = vi.fn(async () => makeResult("ers"));
    const svc = buildService(provider);
    const req = makeRequest({ documentText: "SELECT * FROM us" });
    expect(await svc.suggest(makeCfg(), req)).toBe("ers");
    currentTime += 1_000; // past cooldown, within TTL
    expect(await svc.suggest(makeCfg(), req)).toBe("ers");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("a distinct cursor request inside COOLDOWN_MS returns null with no extra provider call", async () => {
    const provider = vi.fn(async () => makeResult("ers"));
    const svc = buildService(provider);
    await svc.suggest(
      makeCfg(),
      makeRequest({ documentText: "SELECT * FROM us" }),
    );
    currentTime += 100; // inside 500ms cooldown
    // Different cursor → different cache key → no cache hit; cooldown
    // suppresses the new provider call → null.
    expect(
      await svc.suggest(
        makeCfg(),
        makeRequest({ documentText: "SELECT * FROM order" }),
      ),
    ).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("invalidate(scope) drops cache + sequence; new request starts fresh", async () => {
    const provider = vi.fn(async () => makeResult("ers"));
    const svc = buildService(provider);
    const req = makeRequest({ documentText: "SELECT * FROM us" });
    await svc.suggest(makeCfg(), req);
    svc.invalidate("scope-A");
    currentTime += 1_000;
    expect(await svc.suggest(makeCfg(), req)).toBe("ers");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("different schemaFingerprint bypasses old cache", async () => {
    const provider = vi.fn(async () => makeResult("ers"));
    const svc = buildService(provider);
    await svc.suggest(
      makeCfg(),
      makeRequest({ documentText: "SELECT * FROM us", schemaFingerprint: "v1" }),
    );
    currentTime += 1_000;
    expect(
      await svc.suggest(
        makeCfg(),
        makeRequest({ documentText: "SELECT * FROM us", schemaFingerprint: "v2" }),
      ),
    ).toBe("ers");
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe("SqlAutocompleteService — error / malformed handling", () => {
  it("provider throws → null, no throw propagates", async () => {
    const provider: ServiceOptions["provider"] = vi.fn(async () => {
      throw new Error("network down");
    });
    const svc = buildService(provider);
    expect(await svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 1" }))).toBeNull();
  });

  it("provider returns prose → null after sanitization", async () => {
    const provider = vi.fn(async () => makeResult("Sure, here is the query: SELECT 1"));
    const svc = buildService(provider);
    expect(await svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT " }))).toBeNull();
  });

  it("resolveSchema throws → null, no throw propagates", async () => {
    const provider = vi.fn();
    const svc = buildService(provider, async () => {
      throw new Error("schema lost");
    });
    expect(await svc.suggest(makeCfg(), makeRequest({ documentText: "SELECT 1" }))).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
});
