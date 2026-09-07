// src/core/__tests__/activeSchemaStore.test.ts
// ActiveSchemaStore — per-connection pinned schema state (DataGrip parity).
//
// Pattern: FakeMemento (in-memory map) + vi.mock('vscode') — không cần VS Code thật.
import { describe, it, expect, beforeEach, vi } from "vitest";

type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };
  fire(data: T): void {
    for (const l of this.listeners.slice()) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

class FakeMemento {
  private data = new Map<string, unknown>();
  constructor(initial: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(initial)) this.data.set(k, v);
  }
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
}

vi.mock("vscode", () => ({
  EventEmitter: vi.fn(() => new FakeEventEmitter<unknown>()),
}));

import { ActiveSchemaStore } from "../activeSchemaStore";

type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
};

function fakeMemento(initial: Record<string, unknown> = {}): MementoLike {
  return new FakeMemento(initial) as unknown as MementoLike;
}

describe("ActiveSchemaStore", () => {
  it("get returns undefined when no pin", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    expect(s.get("conn-1")).toBeUndefined();
  });

  it("set pins a schema and fires onDidChange", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    const events: Array<{ id: string; schema: string | undefined }> = [];
    s.onDidChange((e) =>
      events.push({ id: e.connectionId, schema: e.schema }),
    );
    s.set("conn-1", "analytics");
    expect(s.get("conn-1")).toBe("analytics");
    expect(events).toEqual([{ id: "conn-1", schema: "analytics" }]);
  });

  it("set with same value does NOT fire", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    s.set("conn-1", "analytics");
    const fired: string[] = [];
    s.onDidChange((e) => fired.push(e.schema ?? "<undefined>"));
    s.set("conn-1", "analytics"); // identical → no-op
    expect(fired).toEqual([]);
    expect(s.get("conn-1")).toBe("analytics");
  });

  it("set(undefined) clears the pin", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    s.set("conn-1", "analytics");
    const fired: Array<string | undefined> = [];
    s.onDidChange((e) => fired.push(e.schema));
    s.set("conn-1", undefined);
    expect(s.get("conn-1")).toBeUndefined();
    expect(fired).toEqual([undefined]);
  });

  it("set('') and whitespace also clear", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    s.set("conn-1", "  "); // whitespace-only → clear
    expect(s.get("conn-1")).toBeUndefined();
    s.set("conn-1", "analytics");
    s.set("conn-1", ""); // empty → clear
    expect(s.get("conn-1")).toBeUndefined();
  });

  it("set trims surrounding whitespace", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    s.set("conn-1", "  analytics  ");
    expect(s.get("conn-1")).toBe("analytics");
  });

  it("clear() is sugar for set(undefined)", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    s.set("conn-1", "analytics");
    s.clear("conn-1");
    expect(s.get("conn-1")).toBeUndefined();
  });

  it("hydrates from existing memento keys", () => {
    const mem = fakeMemento({
      "unicDb.activeSchema.conn-1": "analytics",
      "unicDb.activeSchema.conn-2": "reporting",
      "unicDb.schemaFilter.conn-3": ["x"], // unrelated key — ignored
    });
    const s = new ActiveSchemaStore(mem as never);
    expect(s.get("conn-1")).toBe("analytics");
    expect(s.get("conn-2")).toBe("reporting");
    expect(s.get("conn-3")).toBeUndefined();
  });

  it("set persists into the memento", async () => {
    const mem = fakeMemento();
    const s = new ActiveSchemaStore(mem as never);
    await s.set("conn-1", "analytics");
    expect(mem.get("unicDb.activeSchema.conn-1")).toBe("analytics");
    await s.set("conn-1", undefined);
    expect(mem.get("unicDb.activeSchema.conn-1")).toBeUndefined();
  });

  it("dispose detaches listeners without throwing", () => {
    const s = new ActiveSchemaStore(fakeMemento() as never);
    const fired: string[] = [];
    s.onDidChange((e) => fired.push(e.schema ?? "<undefined>"));
    s.dispose();
    // After dispose the emitter should not throw on subsequent calls.
    s.set("conn-1", "analytics");
    expect(s.get("conn-1")).toBe("analytics");
    expect(fired).toEqual([]);
  });
});