// src/ui/__tests__/sampleDataAi.test.ts
// TASK-006 — Unit + mocked-deps tests for src/ui/sampleDataAi.ts.
//
// Pure functions (no vscode imports):
//   buildSampleDataPrompt(schema, table, columns, n)
//   pickInsertableColumns(tableName, columns)
//   parseInsertStatements(text, schema, table)
//
// Mocked-deps e2e:
//   aiGenerateSampleData(deps) — drives provider + adapter + returns row count.

import { describe, it, expect, vi } from "vitest";
import {
  buildSampleDataPrompt,
  pickInsertableColumns,
  parseInsertStatements,
  aiGenerateSampleData,
} from "../sampleDataAi";
import type { AiConfig } from "../../ai/settings";
import type { ConnectionConfig } from "../../config/types";
import type { DbAdapter, QueryResult } from "../../adapters/types";
import type {
  ProviderRequest,
  ProviderResult,
} from "../../ai/provider";

interface Col {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
}

const col = (
  name: string,
  type: string,
  nullable = true,
  defaultValue: string | null = null,
): Col => ({
  name,
  type,
  nullable,
  default: defaultValue,
});

describe("sampleDataAi — buildSampleDataPrompt", () => {
  it("case #1: names the table, lists insertable columns with types+nullability, asks for exactly N INSERTs, forbids markdown", () => {
    const prompt = buildSampleDataPrompt(
      "public",
      "users",
      [
        { name: "id_users", type: "integer", nullable: false },
        { name: "name", type: "varchar", nullable: false },
        { name: "email", type: "varchar", nullable: true },
        { name: "created_at", type: "timestamp", nullable: false },
      ],
      10,
    );
    expect(prompt).toMatch(/"public"\."users"/);
    expect(prompt).toMatch(/name/);
    expect(prompt).toMatch(/varchar/);
    expect(prompt).toMatch(/email/);
    expect(prompt).toMatch(/NOT NULL|nullable/i);
    expect(prompt).toMatch(/10/);
    expect(prompt).toMatch(/INSERT/i);
    expect(prompt).toMatch(/10 INSERT statements/i);
    expect(prompt).toMatch(/no markdown|do not wrap|no `|plain sql/i);
  });
});

describe("sampleDataAi — pickInsertableColumns", () => {
  it("case #6: excludes id_<table> (case-insensitive), created_at, nextval defaults; keeps other columns", () => {
    const cols: Col[] = [
      col("id_users", "integer", false),
      col("ID_USERS", "integer", false),
      col("created_at", "timestamp", false),
      col("CREATED_AT", "timestamp", false),
      col("nextval_id", "integer", false, "nextval('users_seq')"),
      col("name", "varchar", false),
      col("status", "varchar", true),
      col("total_amount", "numeric", true),
    ];
    const picked = pickInsertableColumns("users", cols);
    const names = picked.map((c) => c.name);
    expect(names).toEqual(["name", "status", "total_amount"]);
  });
});

describe("sampleDataAi — parseInsertStatements", () => {
  it("case #3 (pure part): rejects DELETE / bare SELECT / wrong table in output", () => {
    const text = [
      `INSERT INTO "public"."users" ("name") VALUES ('a');`,
      `DELETE FROM "public"."users";`,
      `SELECT * FROM "public"."users";`,
      `INSERT INTO "public"."orders" ("qty") VALUES (1);`,
    ].join("\n");
    const result = parseInsertStatements(text, "public", "users");
    expect(result.ok).toBe(false);
  });

  it("case #8: accepts exact qualified table both quoted and unquoted", () => {
    const quoted = [
      `INSERT INTO "public"."users" ("name") VALUES ('a');`,
      `INSERT INTO "public"."users" ("name") VALUES ('b');`,
    ].join("\n");
    const resultQuoted = parseInsertStatements(quoted, "public", "users");
    expect(resultQuoted.ok).toBe(true);
    if (resultQuoted.ok) {
      expect(resultQuoted.statements).toHaveLength(2);
    }

    const bare = `INSERT INTO public.users (name) VALUES ('a');`;
    const resultBare = parseInsertStatements(bare, "public", "users");
    expect(resultBare.ok).toBe(true);
  });
});

describe("sampleDataAi — aiGenerateSampleData e2e", () => {
  const makeCfg = (): AiConfig => ({
    baseUrl: "https://api.example.com/v1",
    method: "chat/completions",
    timeoutMs: 30000,
    maxSteps: 8,
    models: {
      work: { modelId: "work-model-v1", vision: false },
      smart: { modelId: "smart-model-v1", vision: false },
    },
    apiKey: "sk-test",
  });

  const makeConn = (): ConnectionConfig => ({
    id: "c1",
    name: "Test PG",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "vsdb",
    database: "vsdb",
  });

  it("case #2: full flow — provider called with work modelId, runQuery ONCE with joined inserts, info message about N inserted rows", async () => {
    const cfg = makeCfg();
    const conn = makeConn();
    const complete = vi.fn(
      async (_req: ProviderRequest): Promise<ProviderResult> => ({
        text: [
          `INSERT INTO "public"."users" ("name") VALUES ('a');`,
          `INSERT INTO "public"."users" ("name") VALUES ('b');`,
          `INSERT INTO "public"."users" ("name") VALUES ('c');`,
        ].join("\n"),
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    const runQuery = vi.fn(
      async (_sql: string): Promise<QueryResult[]> => [],
    );
    const fakeAdapter = { runQuery } as unknown as DbAdapter;
    const getAdapterFor = vi.fn(async () => fakeAdapter);

    const infoSpy = vi.fn();

    const result = await aiGenerateSampleData({
      cfg,
      conn,
      schema: "public",
      table: "users",
      n: 3,
      complete,
      getAdapterFor,
      columns: [{ name: "name", type: "varchar", nullable: true }],
      showInfo: infoSpy,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0]![0];
    expect(req.modelId).toBe(cfg.models.work.modelId);

    expect(runQuery).toHaveBeenCalledTimes(1);
    const sql = runQuery.mock.calls[0]![0] as string;
    expect(sql).toMatch(/INSERT INTO "public"\."users"/);
    expect(sql).toMatch(/VALUES \('a'\)/);
    expect(sql).toMatch(/VALUES \('b'\)/);
    expect(sql).toMatch(/VALUES \('c'\)/);

    expect(result.inserted).toBe(3);
    expect(infoSpy).toHaveBeenCalledWith(
      "VSDB: inserted 3 sample rows into public.users",
    );
  });

  it("edge (malformed SQL): mixed bad statement — runQuery NOT called (zero partial insert)", async () => {
    const cfg = makeCfg();
    const conn = makeConn();
    const complete = vi.fn(
      async (_req: ProviderRequest): Promise<ProviderResult> => ({
        text: [
          `INSERT INTO "public"."users" ("name") VALUES ('a');`,
          `DELETE FROM "public"."users";`,
        ].join("\n"),
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const runQuery = vi.fn(async (_sql: string) => []);
    const fakeAdapter = { runQuery } as unknown as DbAdapter;
    const getAdapterFor = vi.fn(async () => fakeAdapter);
    const infoSpy = vi.fn();
    const errorSpy = vi.fn();

    await expect(
      aiGenerateSampleData({
        cfg,
        conn,
        schema: "public",
        table: "users",
        n: 3,
        complete,
        getAdapterFor,
        columns: [{ name: "name", type: "varchar", nullable: true }],
        showInfo: infoSpy,
        showError: errorSpy,
      }),
    ).rejects.toBeTruthy();
    expect(runQuery).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("edge (empty insertable set): nothing to insert — info message, provider + runQuery NOT called", async () => {
    const cfg = makeCfg();
    const conn = makeConn();
    const complete = vi.fn();
    const runQuery = vi.fn();
    const fakeAdapter = { runQuery } as unknown as DbAdapter;
    const getAdapterFor = vi.fn(async () => fakeAdapter);
    const infoSpy = vi.fn();

    const result = await aiGenerateSampleData({
      cfg,
      conn,
      schema: "public",
      table: "users",
      n: 5,
      complete,
      getAdapterFor,
      columns: [],
      showInfo: infoSpy,
    });

    expect(result.inserted).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "VSDB: nothing to insert into public.users",
    );
  });
});
