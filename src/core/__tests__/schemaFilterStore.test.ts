// src/core/__tests__/schemaFilterStore.test.ts
// Unit tests cho SchemaFilterStore (per-connection schema filter for Schema Explorer).
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
  get listenerCount(): number {
    return this.listeners.length;
  }
  dispose(): void {
    this.listeners = [];
  }
}

class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
  _raw(): Map<string, unknown> {
    return this.data;
  }
}

vi.mock("vscode", () => ({
  EventEmitter: vi.fn(() => new FakeEventEmitter<unknown>()),
}));

import { SchemaFilterStore } from "../schemaFilterStore";

describe("core/schemaFilterStore — per-connection schema filter", () => {
  let mem: FakeMemento;
  let store: SchemaFilterStore;

  beforeEach(() => {
    mem = new FakeMemento();
    store = new SchemaFilterStore(mem as unknown as import("vscode").Memento);
  });

  it("returns null for an unknown connection (no filter = show all)", () => {
    expect(store.get("c1")).toBeNull();
  });

  it("set then get round-trips the same set of schema names", () => {
    store.set("c1", ["public", "app", "billing"]);
    const got = store.get("c1");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(3);
    expect(got!.has("public")).toBe(true);
    expect(got!.has("app")).toBe(true);
    expect(got!.has("billing")).toBe(true);
  });

  it("set persists to the underlying memento under the namespaced key", () => {
    store.set("c1", ["public", "app"]);
    const raw = mem.get<string[]>("unicDb.schemaFilter.c1");
    expect(raw).toBeDefined();
    // The store sorts internally so equality is stable; check as a set.
    expect(new Set(raw!)).toEqual(new Set(["public", "app"]));
  });

  it("clear restores null (show all) and removes the memento key", () => {
    store.set("c1", ["public", "app"]);
    store.clear("c1");
    expect(store.get("c1")).toBeNull();
    expect(mem.get("unicDb.schemaFilter.c1")).toBeUndefined();
  });

  it("two different connectionIds have independent state", () => {
    store.set("c1", ["public", "app"]);
    store.set("c2", ["mysql"]);
    expect(store.get("c1")!.has("mysql")).toBe(false);
    expect(store.get("c2")!.has("public")).toBe(false);
    expect(store.get("c2")!.has("mysql")).toBe(true);
    store.clear("c1");
    // c2 unaffected
    expect(store.get("c2")!.has("mysql")).toBe(true);
  });

  it("empty iterable means 'show none' (Set size 0, distinct from null)", () => {
    store.set("c1", []);
    const got = store.get("c1");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(0);
  });

  it("hydrates pre-existing memento keys on construction", () => {
    // Pre-populate the memento BEFORE the store is built.
    const mem2 = new FakeMemento();
    void mem2.update("unicDb.schemaFilter.c9", ["public", "app"]);
    const store2 = new SchemaFilterStore(
      mem2 as unknown as import("vscode").Memento,
    );
    const got = store2.get("c9");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(2);
    expect(got!.has("public")).toBe(true);
    expect(got!.has("app")).toBe(true);
  });

  it("ignores memento keys outside the namespace prefix on hydrate", () => {
    const mem2 = new FakeMemento();
    void mem2.update("UnicDB.connections", [{ id: "x" }]);
    void mem2.update("unicDb.unrelated", ["nope"]);
    const store2 = new SchemaFilterStore(
      mem2 as unknown as import("vscode").Memento,
    );
    expect(store2.get("UnicDB.connections")).toBeNull();
    expect(store2.get("unicDb.unrelated")).toBeNull();
    expect(store2.get("connections")).toBeNull();
    expect(store2.get("unrelated")).toBeNull();
  });

  it("onDidChange fires exactly once per real set", () => {
    let count = 0;
    let lastId: string | null = null;
    store.onDidChange((e) => {
      count += 1;
      lastId = e.connectionId;
    });
    store.set("c1", ["public"]);
    store.set("c1", ["public", "app"]);
    store.set("c1", ["public", "app"]);
    expect(count).toBe(2);
    expect(lastId).toBe("c1");
  });

  it("onDidChange fires exactly once per clear and is silent when nothing to clear", () => {
    let count = 0;
    store.onDidChange(() => {
      count += 1;
    });
    store.clear("c1"); // no-op
    expect(count).toBe(0);
    store.set("c1", ["public"]);
    count = 0;
    store.clear("c1");
    expect(count).toBe(1);
  });

  it("dispose removes listeners; set after dispose does not throw", () => {
    const fired: string[] = [];
    const sub = store.onDidChange((e) => fired.push(e.connectionId));
    store.set("c1", ["public"]);
    expect(fired).toEqual(["c1"]);
    sub.dispose();
    store.dispose();
    // set after dispose should not throw — change emitter is closed but
    // memento write should still complete (sync update returns Promise.resolve).
    expect(() => store.set("c1", ["app"])).not.toThrow();
    expect(fired).toEqual(["c1"]);
  });
});
