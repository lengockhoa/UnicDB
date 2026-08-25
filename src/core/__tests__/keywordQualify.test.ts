// src/core/__tests__/keywordQualify.test.ts
// TASK-007 — pure transform tests for qualifyKeywordTables / isPgReservedKeyword.
//
// Cases per the task Test Plan §Test Cases (rows #1, #3-#10) — case #2 lives
// in src/extension.test.ts (runStatement editor-path), case #11 in
// src/ui/__tests__/browseCommands.test.ts.
import { describe, it, expect, vi } from "vitest";
import {
  isPgReservedKeyword,
  qualifyKeywordTables,
  createKeywordTableCache,
} from "../keywordQualify";

const PUBLIC_TABLES = ["order", "user", "select", "table", "users"];

const listTables = vi.fn(async (_schema: string): Promise<string[]> => PUBLIC_TABLES);

describe("isPgReservedKeyword", () => {
  it("#10 keyword list — common reserved words return true", () => {
    expect(isPgReservedKeyword("order")).toBe(true);
    expect(isPgReservedKeyword("user")).toBe(true);
    expect(isPgReservedKeyword("select")).toBe(true);
    expect(isPgReservedKeyword("table")).toBe(true);
    expect(isPgReservedKeyword("ORDER")).toBe(true);
    expect(isPgReservedKeyword("User")).toBe(true);
  });

  it("#10 keyword list — non-reserved names return false", () => {
    expect(isPgReservedKeyword("name")).toBe(false);
    expect(isPgReservedKeyword("orders")).toBe(false);
    expect(isPgReservedKeyword("users")).toBe(false);
    expect(isPgReservedKeyword("")).toBe(false);
  });
});

describe("qualifyKeywordTables", () => {
  it("#1 happy — unquoted + unqualified reserved keyword after FROM is rewritten to \"public\".\"<name>\"", async () => {
    const res = await qualifyKeywordTables(
      "SELECT * FROM order;",
      listTables,
    );
    expect(res.changed).toBe(true);
    expect(res.sql).toBe('SELECT * FROM "public"."order";');
  });

  it("#3 already-qualified untouched — `prd.order`", async () => {
    const res = await qualifyKeywordTables(
      "SELECT * FROM prd.order",
      listTables,
    );
    expect(res.sql).toBe("SELECT * FROM prd.order");
    expect(res.changed).toBe(false);
  });

  it("#3 already-qualified untouched — `public.\"order\"`", async () => {
    const res = await qualifyKeywordTables(
      'SELECT * FROM public."order"',
      listTables,
    );
    expect(res.sql).toBe('SELECT * FROM public."order"');
    expect(res.changed).toBe(false);
  });

  it("#4 quoted identifier untouched — `FROM \"order\"`", async () => {
    const res = await qualifyKeywordTables(
      'SELECT * FROM "order"',
      listTables,
    );
    expect(res.sql).toBe('SELECT * FROM "order"');
    expect(res.changed).toBe(false);
  });

  it("#5 keyword usage as keyword (ORDER BY) — untouched", async () => {
    const res = await qualifyKeywordTables(
      "SELECT 1 FROM t ORDER BY x",
      listTables,
    );
    expect(res.sql).toBe("SELECT 1 FROM t ORDER BY x");
    expect(res.changed).toBe(false);
  });

  it("#6 CTE shadows table — `WITH order AS (...) SELECT * FROM order` keeps CTE reference", async () => {
    const res = await qualifyKeywordTables(
      "WITH order AS (SELECT 1) SELECT * FROM order",
      listTables,
    );
    expect(res.sql).toBe("WITH order AS (SELECT 1) SELECT * FROM order");
    expect(res.changed).toBe(false);
  });

  it("#6b CTE RECURSIVE — WITH RECURSIVE order AS (...) — CTE name still tracked", async () => {
    const res = await qualifyKeywordTables(
      "WITH RECURSIVE order AS (SELECT 1) SELECT * FROM order",
      listTables,
    );
    expect(res.sql).toBe(
      "WITH RECURSIVE order AS (SELECT 1) SELECT * FROM order",
    );
    expect(res.changed).toBe(false);
  });

  it("#7 non-keyword unqualified — `FROM users` left untouched (preserves search_path)", async () => {
    const res = await qualifyKeywordTables(
      "SELECT * FROM users",
      listTables,
    );
    expect(res.sql).toBe("SELECT * FROM users");
    expect(res.changed).toBe(false);
  });

  it("#8 reserved word NOT in listTables — left untouched (no silent retargeting)", async () => {
    const noUser: string[] = [];
    const res = await qualifyKeywordTables(
      "SELECT * FROM user",
      async () => noUser,
    );
    expect(res.sql).toBe("SELECT * FROM user");
    expect(res.changed).toBe(false);
  });

  it("#9 search_path collision — `order` in BOTH public and sales, rewrite still targets public", async () => {
    const both = ["order", "users"];
    const res = await qualifyKeywordTables(
      "SELECT * FROM order JOIN users USING (id)",
      async () => both,
    );
    expect(res.sql).toBe(
      'SELECT * FROM "public"."order" JOIN users USING (id)',
    );
    expect(res.changed).toBe(true);
  });

  it("#9b non-keyword `users` in both schemas — untouched", async () => {
    const both = ["order", "users"];
    const res = await qualifyKeywordTables(
      "SELECT * FROM users",
      async () => both,
    );
    expect(res.sql).toBe("SELECT * FROM users");
    expect(res.changed).toBe(false);
  });

  it("rewrite triggers also after INTO, UPDATE, JOIN", async () => {
    expect(
      (await qualifyKeywordTables("INSERT INTO order VALUES (1)", listTables))
        .sql,
    ).toBe('INSERT INTO "public"."order" VALUES (1)');
    expect(
      (await qualifyKeywordTables("UPDATE order SET col = 1", listTables)).sql,
    ).toBe('UPDATE "public"."order" SET col = 1');
    expect(
      (
        await qualifyKeywordTables(
          "SELECT 1 FROM t JOIN order ON true",
          listTables,
        )
      ).sql,
    ).toBe('SELECT 1 FROM t JOIN "public"."order" ON true');
  });

  it("listTables is invoked with the `public` schema when (and only when) a reserved-keyword candidate is present (lazy — TASK-008)", async () => {
    const spy = vi.fn(async () => ["order"]);
    // No reserved-keyword candidate — `users` is not reserved — listTables must NOT fire.
    await qualifyKeywordTables("SELECT 1 FROM users", spy);
    expect(spy).toHaveBeenCalledTimes(0);

    spy.mockClear();
    await qualifyKeywordTables("SELECT * FROM order", spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("public");
  });

  it("string literals and comments are not parsed for keywords", async () => {
    const res = await qualifyKeywordTables(
      "SELECT 'FROM order', -- FROM order\n 1",
      listTables,
    );
    expect(res.sql).toBe("SELECT 'FROM order', -- FROM order\n 1");
    expect(res.changed).toBe(false);
  });

  it("multi-statement: only the keyword-table statement is rewritten", async () => {
    const res = await qualifyKeywordTables(
      "SELECT 1 FROM users; SELECT * FROM order;",
      listTables,
    );
    expect(res.sql).toBe(
      'SELECT 1 FROM users; SELECT * FROM "public"."order";',
    );
    expect(res.changed).toBe(true);
  });
});

// =============================================================================
// TASK-008 — D1: stop the eager `information_schema.tables` warm-up and add an
// opt-in, caller-owned `KeywordTableCache` so a multi-statement run pays at
// most one catalog round trip. See docs/AI_HANDOFF/tasks/TASK-008.md §Test Cases.
// =============================================================================
describe("TASK-008 — lazy candidate-gated lookup + opt-in cache", () => {
  it("Happy | no candidate — spy called 0 times, sql returned unchanged", async () => {
    const spy = vi.fn(async () => ["order"]);
    const res = await qualifyKeywordTables("SELECT 1", spy);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(res.sql).toBe("SELECT 1");
    expect(res.changed).toBe(false);
  });

  it("Happy | with candidate — spy called exactly 1 time, rewrite applied as today", async () => {
    const spy = vi.fn(async () => ["user"]);
    const res = await qualifyKeywordTables("SELECT * FROM user", spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.sql).toBe('SELECT * FROM "public"."user"');
    expect(res.changed).toBe(true);
  });

  it("Edge (cache reuse) | 20 calls sharing one cache — spy called exactly 1 time in total", async () => {
    const spy = vi.fn(async () => ["order"]);
    const cache = createKeywordTableCache();
    for (let n = 0; n < 20; n += 1) {
      const res = await qualifyKeywordTables("SELECT * FROM order", spy, {
        cache,
      });
      expect(res.sql).toBe('SELECT * FROM "public"."order"');
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("Edge (TTL) | cache entry older than its TTL is refetched (injected clock, no real sleep)", async () => {
    const spy = vi.fn(async () => ["order"]);
    let clock = 1_000;
    const cache = createKeywordTableCache(30_000, () => clock);

    await qualifyKeywordTables("SELECT * FROM order", spy, { cache });
    expect(spy).toHaveBeenCalledTimes(1);

    // Still within TTL — no second fetch.
    clock += 10_000;
    await qualifyKeywordTables("SELECT * FROM order", spy, { cache });
    expect(spy).toHaveBeenCalledTimes(1);

    // Past TTL — must refetch.
    clock += 25_000;
    await qualifyKeywordTables("SELECT * FROM order", spy, { cache });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("Edge (failure) | listTables rejects — qualifyKeywordTables still resolves with the original SQL", async () => {
    const failing = vi.fn(async (): Promise<string[]> => {
      throw new Error("catalog scan failed");
    });
    await expect(
      qualifyKeywordTables("SELECT * FROM order", failing),
    ).resolves.toEqual({ sql: "SELECT * FROM order", changed: false });
  });

  it("Edge (failure, cached) | listTables rejects through a cache handle — still best-effort, original SQL", async () => {
    const failing = vi.fn(async (): Promise<string[]> => {
      throw new Error("catalog scan failed");
    });
    const cache = createKeywordTableCache();
    await expect(
      qualifyKeywordTables("SELECT * FROM order", failing, { cache }),
    ).resolves.toEqual({ sql: "SELECT * FROM order", changed: false });
  });

  it("Edge (isolation) | two different caches — no cross-talk, each triggers its own single fetch", async () => {
    const spyA = vi.fn(async () => ["order"]);
    const spyB = vi.fn(async () => ["order"]);
    const cacheA = createKeywordTableCache();
    const cacheB = createKeywordTableCache();

    await qualifyKeywordTables("SELECT * FROM order", spyA, { cache: cacheA });
    await qualifyKeywordTables("SELECT * FROM order", spyA, { cache: cacheA });
    await qualifyKeywordTables("SELECT * FROM order", spyB, { cache: cacheB });
    await qualifyKeywordTables("SELECT * FROM order", spyB, { cache: cacheB });

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("R (D1) | plain SQL, no candidates — 0 catalog queries (was 1 per call before the fix)", async () => {
    const spy = vi.fn(async () => ["order"]);
    const res = await qualifyKeywordTables("SELECT 1 FROM users WHERE id = 1", spy);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(res.sql).toBe("SELECT 1 FROM users WHERE id = 1");
    expect(res.changed).toBe(false);
  });

  it("2-argument call (no opts) keeps working — no caching, today's semantics", async () => {
    const spy = vi.fn(async () => ["order"]);
    const res = await qualifyKeywordTables("SELECT * FROM order", spy);
    expect(res.sql).toBe('SELECT * FROM "public"."order"');
    expect(spy).toHaveBeenCalledTimes(1);
    // Two calls without a shared cache each pay their own round trip.
    spy.mockClear();
    await qualifyKeywordTables("SELECT * FROM order", spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cache.clear() drops stored entries — next get() refetches", async () => {
    const spy = vi.fn(async () => ["order"]);
    const cache = createKeywordTableCache();
    await qualifyKeywordTables("SELECT * FROM order", spy, { cache });
    cache.clear();
    await qualifyKeywordTables("SELECT * FROM order", spy, { cache });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});