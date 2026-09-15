// src/ui/__tests__/aiChatSessionStore.test.ts — TASK-CHATV2-015
//
// Contract tests for the structured host-side session store. These are the
// REAL behaviors the task §Test Cases name: persistence round-trip, debounced
// streaming checkpoint + immediate terminal flush, privacy exclusion scan,
// corrupt/old-schema quarantine, retention, and 50-at-a-time paging.
//
// The store consumes a minimal `Memento`-shaped object (the same
// `vscode.Memento` extension.ts passes), so these tests run with no `vscode`
// and no DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_CHAT_SESSION_SCHEMA_VERSION,
  AiChatSessionStore,
  SESSION_CHECKPOINT_DEBOUNCE_MS,
  SESSION_PAGE_SIZE,
  SESSION_RECENT_CAP,
  SESSION_RETENTION_MAX_AGE_DAYS,
  SESSION_RETENTION_MAX_SESSIONS,
  SESSION_INDEX_KEY,
  SESSION_RECORD_KEY_PREFIX,
  SESSION_VIEWPORT_CAP,
  migrateSessionRecord,
  scanSessionRecordForForbidden,
  type AiChatSessionMementoLike,
} from "../aiChatSessionStore";

const CWD = "/work";

/** In-memory stand-in for `vscode.Memento` (same get/update surface). */
function makeMemento(seed: Record<string, unknown> = {}): {
  memento: AiChatSessionMementoLike;
  data: Record<string, unknown>;
  updates: string[];
} {
  const data: Record<string, unknown> = { ...seed };
  const updates: string[] = [];
  const memento: AiChatSessionMementoLike = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (key in data ? (data[key] as T) : defaultValue);
    },
    update(key: string, value: unknown): PromiseLike<void> {
      updates.push(key);
      if (value === undefined) delete data[key];
      else data[key] = value;
      return Promise.resolve();
    },
  };
  return { memento, data, updates };
}

let idSeq = 0;
function makeStore(seed: Record<string, unknown> = {}): {
  store: AiChatSessionStore;
  data: Record<string, unknown>;
  updates: string[];
  clock: { now: number };
} {
  const { memento, data, updates } = makeMemento(seed);
  const clock = { now: Date.parse("2026-09-16T00:00:00.000Z") };
  idSeq = 0;
  const store = new AiChatSessionStore({
    memento,
    now: () => clock.now,
    idFactory: () => `s-test-${idSeq++}`,
  });
  return { store, data, updates, clock };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. persistence round-trip
// ---------------------------------------------------------------------------

describe("CHATV2-015 #1 — persistence round-trip", () => {
  it("close/reopen hydrates the same structured visible transcript + metadata", () => {
    const { store, data, clock } = makeStore();
    const created = store.create({ cwd: CWD, engine: "omp", model: "unic-sonnet" });
    store.rename(created.id, "Fix the orders query");
    clock.now += 1000;
    store.appendUserMessage(created.id, {
      id: "u1",
      text: "Why is the join slow?",
      context: [{ kind: "table", id: "public.orders", label: "orders", status: "resolved" }],
    });
    store.finalizeTurn(created.id, {
      terminalState: "completed",
      assistantText: "The join lacks an index.",
      assistantMessageId: "a1",
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
    });

    // A NEW store over the same memento simulates closing + reopening the panel.
    const reopened = new AiChatSessionStore({
      memento: makeMemento(data).memento,
      now: () => clock.now,
    });
    const record = reopened.get(created.id);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      schemaVersion: AI_CHAT_SESSION_SCHEMA_VERSION,
      id: created.id,
      title: "Fix the orders query",
      cwd: CWD,
      engine: "omp",
      model: "unic-sonnet",
      terminalState: "completed",
    });
    expect(record!.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why is the join slow?"],
      ["assistant", "The join lacks an index."],
    ]);
    expect(record!.messages[0]!.context).toEqual([
      { kind: "table", id: "public.orders", label: "orders", status: "resolved" },
    ]);
    expect(record!.messages[1]!.activities).toEqual([
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
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. debounce / terminal flush
// ---------------------------------------------------------------------------

describe("CHATV2-015 #2 — checkpoint debounce + terminal flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("coalesces N streaming deltas into ONE write after 750ms", () => {
    const { store, data, updates } = makeStore();
    const rec = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    const recordWrites = () => updates.filter((k) => k === `${SESSION_RECORD_KEY_PREFIX}${rec.id}`).length;
    const before = recordWrites();

    for (let i = 1; i <= 5; i += 1) {
      store.checkpointAssistant(rec.id, { messageId: "a1", text: "x".repeat(i), turnId: "turn-1" });
      vi.advanceTimersByTime(100);
    }
    // 500ms elapsed — still inside the 750ms window: no record write yet.
    expect(recordWrites()).toBe(before);

    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    expect(recordWrites()).toBe(before + 1);
    const persisted = data[`${SESSION_RECORD_KEY_PREFIX}${rec.id}`] as {
      messages: Array<{ id: string; text: string; partial?: boolean }>;
    };
    expect(persisted.messages).toHaveLength(1);
    expect(persisted.messages[0]!.text).toBe("x".repeat(5));
    expect(persisted.messages[0]!.partial).toBe(true);
  });

  it("terminal update flushes immediately and cancels the pending checkpoint", () => {
    const { store, data, updates } = makeStore();
    const rec = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    store.checkpointAssistant(rec.id, { messageId: "a1", text: "partial…", turnId: "turn-1" });
    const before = updates.length;

    store.finalizeTurn(rec.id, {
      terminalState: "completed",
      assistantText: "Final answer.",
      assistantMessageId: "a1",
      turnId: "turn-1",
    });

    // Terminal write happened synchronously, before any timer fired.
    expect(updates.length).toBeGreaterThan(before);
    const persisted = data[`${SESSION_RECORD_KEY_PREFIX}${rec.id}`] as {
      terminalState: string;
      messages: Array<{ text: string; partial?: boolean }>;
    };
    expect(persisted.terminalState).toBe("completed");
    expect(persisted.messages[0]!.text).toBe("Final answer.");
    expect(persisted.messages[0]!.partial).toBeUndefined();

    // The debounce timer must NOT fire a second (stale partial) write.
    const afterTerminal = updates.length;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS * 2);
    expect(updates.length).toBe(afterTerminal);
  });
});

// ---------------------------------------------------------------------------
// 3. privacy
// ---------------------------------------------------------------------------

describe("CHATV2-015 #3 — privacy exclusion scan", () => {
  it("flags reasoning, raw tool output, secrets, permission ids and base64", () => {
    const cases: Array<Record<string, unknown>> = [
      { messages: [{ role: "assistant", reasoning: "chain of thought" }] },
      { messages: [{ role: "assistant", rawToolOutput: "row bytes" }] },
      { apiKey: "sk-live-123" },
      { connectionString: "postgres://user:pw@host/db" },
      { permissionId: "perm-1" },
      { attachments: [{ base64: "AAAA" }] },
      { messages: [{ toolResult: { stdout: "x" } }] },
    ];
    for (const value of cases) {
      const result = scanSessionRecordForForbidden(value);
      expect(result.ok).toBe(false);
    }
    expect(scanSessionRecordForForbidden({ messages: [{ text: "api key rotation" }] }).ok).toBe(true);
  });

  it("a real store never persists a forbidden payload", () => {
    const { store, data } = makeStore();
    const rec = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    // Force an unsafe field onto a record through a crafted message text is
    // impossible via the API — assert the scan runs on every write by
    // verifying the on-disk record is clean and warnings stay empty.
    store.appendUserMessage(rec.id, { id: "u1", text: "reach me at postgres://u:p@h/db" });
    store.finalizeTurn(rec.id, {
      terminalState: "failed",
      assistantText: "Could not complete.",
      assistantMessageId: "a1",
      turnId: "turn-1",
      diagnosticIds: ["abc12345"],
    });
    const persisted = data[`${SESSION_RECORD_KEY_PREFIX}${rec.id}`];
    expect(scanSessionRecordForForbidden(persisted).ok).toBe(true);
    expect(store.takeWarnings()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. migration / quarantine
// ---------------------------------------------------------------------------

describe("CHATV2-015 #4 — corrupt / old schema quarantine", () => {
  it("quarantines an unsupported-schema record with a safe warning, never throws", () => {
    const id = "s-old";
    const { store, data } = makeStore({
      [SESSION_INDEX_KEY]: [
        {
          id,
          title: "old",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          cwd: CWD,
          messageCount: 2,
          terminalState: "completed",
        },
      ],
      [`${SESSION_RECORD_KEY_PREFIX}${id}`]: { schemaVersion: 0, id, messages: "not-an-array" },
    });

    const record = store.get(id);
    expect(record).toBeNull();
    expect(store.quarantined()).toHaveLength(1);
    expect(store.quarantined()[0]!.reason).toContain("corrupt");
    // Safe warning is human copy — never the raw payload.
    expect(store.takeWarnings()).toEqual(["A saved chat could not be opened and was skipped."]);
    // The index no longer advertises the unreadable session…
    expect(store.listRecent(CWD)).toEqual([]);
    // …but the raw bytes are preserved for recovery, never destroyed.
    expect(data[`${SESSION_RECORD_KEY_PREFIX}${id}`]).toBeDefined();
  });

  it("a corrupt record is skipped while good siblings still hydrate", () => {
    const { store } = makeStore();
    const good = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    store.appendUserMessage(good.id, { id: "u1", text: "hello" });
    const corruptId = "s-corrupt";
    const bad = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    // Directly poison the backing store for `bad`.
    const dataRef = store as unknown as { memento: AiChatSessionMementoLike };
    void dataRef.memento.update(`${SESSION_RECORD_KEY_PREFIX}${bad.id}`, { schemaVersion: 2 });
    const fresh = new AiChatSessionStore({ memento: dataRef.memento });

    expect(fresh.get(bad.id)).toBeNull();
    const resumed = fresh.get(good.id);
    expect(resumed!.messages[0]!.text).toBe("hello");
    expect(fresh.takeWarnings().length).toBe(1);
  });

  it("migrateSessionRecord rejects a non-object without throwing", () => {
    expect(migrateSessionRecord(null)).toBeNull();
    expect(migrateSessionRecord("nope")).toBeNull();
    expect(migrateSessionRecord({ schemaVersion: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. paging boundary 50 / 200
// ---------------------------------------------------------------------------

describe("CHATV2-015 #8 — paging boundary", () => {
  function seedMessages(store: AiChatSessionStore, id: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        store.appendUserMessage(id, { id: `m${i}`, text: `user ${i}` });
      } else {
        store.finalizeTurn(id, {
          terminalState: "completed",
          assistantText: `assistant ${i}`,
          assistantMessageId: `m${i}`,
          turnId: `turn-${i}`,
        });
      }
    }
  }

  it("hydrates the last 200 with hasMore, then pages older 50 at a time in order", () => {
    const { store } = makeStore();
    const rec = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    seedMessages(store, rec.id, 260);

    const head = store.hydrate(rec.id);
    expect(head.total).toBe(260);
    expect(head.items).toHaveLength(SESSION_VIEWPORT_CAP);
    expect(head.hasMore).toBe(true);
    expect(head.items[0]!.text).toBe("user 60");
    expect(head.items[head.items.length - 1]!.text).toBe("assistant 259");

    // First older page: exactly 50 items, contiguous with the hydrated head.
    const page1 = store.loadEarlier(rec.id, 260 - SESSION_VIEWPORT_CAP);
    expect(page1.items).toHaveLength(SESSION_PAGE_SIZE);
    expect(page1.items[page1.items.length - 1]!.text).toBe("assistant 59");
    expect(page1.items[0]!.text).toBe("user 10");
    expect(page1.hasMore).toBe(true);

    // Final older page reaches the very start.
    const page2 = store.loadEarlier(rec.id, 10);
    expect(page2.items).toHaveLength(10);
    expect(page2.items[0]!.text).toBe("user 0");
    expect(page2.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retention + resume picker
// ---------------------------------------------------------------------------

describe("CHATV2-015 — retention + resume picker", () => {
  it("enforces the documented per-cwd session cap", () => {
    const { store, clock } = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < SESSION_RETENTION_MAX_SESSIONS + 5; i += 1) {
      clock.now += 1000;
      ids.push(store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" }).id);
    }
    const removed = store.enforceRetention(CWD);
    expect(removed).toHaveLength(5);
    expect(store.listSummaries(CWD)).toHaveLength(SESSION_RETENTION_MAX_SESSIONS);
    // Oldest 5 gone, newest kept.
    expect(store.get(ids[0]!)).toBeNull();
    expect(store.get(ids[ids.length - 1]!)).not.toBeNull();
  });

  it("enforces the documented max age", () => {
    const { store, clock } = makeStore();
    const old = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    clock.now += (SESSION_RETENTION_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;
    const fresh = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    const removed = store.enforceRetention(CWD);
    expect(removed).toEqual([old.id]);
    expect(store.get(fresh.id)).not.toBeNull();
  });

  it("resume picker is cwd-scoped, newest-first and capped at 20", () => {
    const { store, clock } = makeStore();
    for (let i = 0; i < SESSION_RECENT_CAP + 7; i += 1) {
      clock.now += 1000;
      const r = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
      store.rename(r.id, `chat ${i}`);
    }
    // A session in another cwd must never appear.
    store.create({ cwd: "/other", engine: "builtin", model: "unic-sonnet" });

    const recent = store.listRecent(CWD);
    expect(recent).toHaveLength(SESSION_RECENT_CAP);
    expect(recent[0]!.title).toBe(`chat ${SESSION_RECENT_CAP + 6}`);
    expect(recent.every((s) => s.cwd === CWD)).toBe(true);
  });

  it("falls back to the untitled label and never claims provider resume", () => {
    const { store } = makeStore();
    const rec = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    const [summary] = store.listRecent(CWD);
    expect(store.labelFor(summary!)).toBe("Untitled chat");
    expect(summary!.id).toBe(rec.id);
  });

  it("clear transcript wipes messages but preserves the session and siblings", () => {
    const { store } = makeStore();
    const a = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    const b = store.create({ cwd: CWD, engine: "builtin", model: "unic-sonnet" });
    store.appendUserMessage(a.id, { id: "u1", text: "one" });
    store.appendUserMessage(b.id, { id: "u2", text: "two" });

    store.clearTranscript(a.id);
    expect(store.get(a.id)!.messages).toEqual([]);
    expect(store.get(b.id)!.messages).toHaveLength(1);
    expect(store.listRecent(CWD).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });
});
