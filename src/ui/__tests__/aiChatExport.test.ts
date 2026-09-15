// src/ui/__tests__/aiChatExport.test.ts — TASK-CHATV2-015
//
// Contract tests for the structured Markdown/JSON serializers and the host
// save orchestration. Covers task case #6: exact structured content,
// schemaVersion, and the cancel/fail paths that must NEVER announce success.

import { describe, expect, it, vi } from "vitest";

import {
  AI_CHAT_EXPORT_SCHEMA_VERSION,
  EXPORT_FAILURE_TITLE,
  EXPORT_SUCCESS_LABEL,
  exportFileName,
  exportSession,
  serializeSessionForExport,
  serializeSessionToJson,
  serializeSessionToMarkdown,
  type AiChatExportPort,
} from "../aiChatExport";
import type { AiChatSessionRecord } from "../aiChatSessionStore";

function makeRecord(overrides: Partial<AiChatSessionRecord> = {}): AiChatSessionRecord {
  return {
    schemaVersion: 1,
    id: "sess-exact-123",
    title: "Slow join",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T01:00:00.000Z",
    cwd: "/work",
    engine: "omp",
    model: "unic-sonnet",
    terminalState: "completed",
    diagnosticIds: ["diag-9"],
    messages: [
      {
        id: "u1",
        role: "user",
        text: "Why is the join slow?",
        createdAt: "2026-09-16T00:00:10.000Z",
        context: [{ kind: "table", id: "public.orders", label: "orders", status: "resolved" }],
      },
      {
        id: "a1",
        role: "assistant",
        text: "The join lacks an index.",
        createdAt: "2026-09-16T00:00:20.000Z",
        turnId: "turn-1",
        activities: [
          {
            id: "t1",
            turnId: "turn-1",
            toolId: "sql_tool",
            label: "Run SQL",
            action: "database",
            status: "ok",
            summary: "1 statement",
            durationMs: 12,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makePort(
  destination: { name: string; uri: unknown } | null,
  writeImpl?: () => Promise<void>,
): { port: AiChatExportPort; write: ReturnType<typeof vi.fn>; choose: ReturnType<typeof vi.fn> } {
  const write = vi.fn(writeImpl ?? (async () => undefined));
  const choose = vi.fn(async () => destination);
  return { port: { chooseDestination: choose, write }, write, choose };
}

// ---------------------------------------------------------------------------
// 6. structured content
// ---------------------------------------------------------------------------

describe("CHATV2-015 #6 — export content", () => {
  it("Markdown contains the visible transcript and safe activity summaries only", () => {
    const md = serializeSessionToMarkdown(makeRecord());
    expect(md).toContain("# Slow join");
    expect(md).toContain("Why is the join slow?");
    expect(md).toContain("The join lacks an index.");
    expect(md).toContain("Run SQL (database) — done · 12ms · 1 statement");
    expect(md).toContain("## You");
    expect(md).toContain("## Assistant");
    // Visible transcript + safe metadata only — never raw internals.
    expect(md).not.toMatch(/reasoning|stderr|base64|sk-live/i);
  });

  it("JSON carries schemaVersion and the structured record, not a scraped string", () => {
    const doc = serializeSessionToJson(makeRecord());
    expect(doc.schemaVersion).toBe(AI_CHAT_EXPORT_SCHEMA_VERSION);
    expect(doc.kind).toBe("UnicDB.aiChat.session");
    expect(doc.session.id).toBe("sess-exact-123");
    expect(doc.session.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why is the join slow?"],
      ["assistant", "The join lacks an index."],
    ]);
    expect(doc.session.messages[1]!.activities![0]!.label).toBe("Run SQL");
    const roundTrip = JSON.parse(serializeSessionForExport(makeRecord(), "json")) as {
      schemaVersion: number;
      session: { messages: unknown[] };
    };
    expect(roundTrip.schemaVersion).toBe(1);
    expect(roundTrip.session.messages).toHaveLength(2);
  });

  it("serializes a stopped partial assistant message honestly", () => {
    const rec = makeRecord();
    const partial: AiChatSessionRecord = {
      ...rec,
      terminalState: "stopped",
      messages: [{ id: "a1", role: "assistant", text: "Partial answer", createdAt: rec.createdAt, partial: true }],
    };
    const md = serializeSessionToMarkdown(partial);
    expect(md).toContain("stopped — partial response");
    expect(md).toContain("Partial answer");
    expect(md).not.toContain("## You");
  });

  it("defaults the filename to a safe slug, not the raw title", () => {
    const rec = makeRecord({ title: "../Weird/../Name <script>" });
    expect(exportFileName(rec, "markdown")).toBe("weird-name-script.md");
    expect(exportFileName(rec, "json")).toBe("weird-name-script.json");
    expect(exportFileName(makeRecord({ title: "" }), "json")).toBe("unicdb-chat.json");
  });
});

// ---------------------------------------------------------------------------
// 6. save result — success / cancel / fail
// ---------------------------------------------------------------------------

describe("CHATV2-015 #6 — host save result", () => {
  it("completed result carries the destination name; success copy is exact", async () => {
    const { port, write } = makePort({ name: "slow-join.md", uri: { fsPath: "/tmp/slow-join.md" } });
    const result = await exportSession(makeRecord(), "markdown", port);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.name).toBe("slow-join.md");
    expect(result.format).toBe("markdown");
    expect(EXPORT_SUCCESS_LABEL).toBe("Exported chat");
    expect(write).toHaveBeenCalledTimes(1);
    // The written bytes ARE the structured serializer output.
    const written = write.mock.calls[0]![1] as string;
    expect(written).toBe(serializeSessionForExport(makeRecord(), "markdown"));
  });

  it("cancel writes nothing and reports no success", async () => {
    const { port, write } = makePort(null);
    const result = await exportSession(makeRecord(), "json", port);
    expect(result.status).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("name");
  });

  it("write failure yields the exact title + a safe reason, no raw error echo", async () => {
    const { port } = makePort({ name: "x.json", uri: {} }, async () => {
      throw new Error("EACCES: /secret/path/token=abc");
    });
    const result = await exportSession(makeRecord(), "json", port);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.safeMessage).toBe(EXPORT_FAILURE_TITLE);
    expect(result.safeMessage).toBe("Could not export chat");
    expect(result.safeReason).not.toContain("EACCES");
    expect(result.safeReason).not.toContain("secret");
    expect(result.safeReason).not.toContain("token");
    expect(result.diagnosticId).toMatch(/^exp-[a-z0-9]+$/);
  });

  it("dialog failure is reported as a safe failure, never a throw", async () => {
    const port: AiChatExportPort = {
      chooseDestination: async () => {
        throw new TypeError("dialog broken");
      },
      write: async () => undefined,
    };
    const result = await exportSession(makeRecord(), "markdown", port);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.safeMessage).toBe("Could not export chat");
    expect(result.safeReason).toBe("The chat export destination was not writable.");
  });

  it("fails closed before opening a dialog when the record carries a forbidden key", async () => {
    const poisoned = { ...makeRecord(), reasoning: "private chain of thought" } as unknown as AiChatSessionRecord;
    const { port, choose, write } = makePort({ name: "x.md", uri: {} });
    const result = await exportSession(poisoned, "markdown", port);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.safeMessage).toBe("Could not export chat");
    expect(result.safeReason).not.toContain("chain of thought");
    expect(choose).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
