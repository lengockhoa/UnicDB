// src/core/schemaFilterStore.ts
// Per-connection schema filter for the Schema Explorer tree.
//
// Persistence:
//   key = `unicDb.schemaFilter.<connectionId>`
//   value = string[] (JSON-serialized; sorted for stable equality)
//   absence = no filter applied (show every schema the adapter returns)
//
// Semantics:
//   - get(id) === null     → no filter (show all schemas)
//   - get(id) === Set()    → filter active, show NONE ("No schemas match filter")
//   - get(id) === Set(N..) → filter active, show only schemas in the set
//
// onDidChange fires once per real set/clear; no-op writes do not fire.
import * as vscode from "vscode";

const KEY_PREFIX = "unicDb.schemaFilter.";

export interface SchemaFilterChangeEvent {
  /** Connection id whose filter changed. */
  connectionId: string;
}

export class SchemaFilterStore {
  private readonly mem: vscode.Memento;
  /** In-memory mirror so we never have to round-trip through memento for reads. */
  private readonly state = new Map<string, ReadonlySet<string>>();
  private readonly _onDidChange =
    new vscode.EventEmitter<SchemaFilterChangeEvent>();
  readonly onDidChange: vscode.Event<SchemaFilterChangeEvent> =
    this._onDidChange.event;

  constructor(memento: vscode.Memento) {
    this.mem = memento;
    // Hydrate from existing keys so subsequent get() calls are synchronous.
    // Tolerate a missing `keys()` (some test mocks only stub get/update) —
    // in that case the in-memory map starts empty, and any pre-existing
    // persisted filter is loaded lazily on the next get() / set() cycle.
    const keys =
      typeof memento.keys === "function" ? memento.keys() : [];
    for (const key of keys) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const id = key.slice(KEY_PREFIX.length);
      const raw = memento.get<string[]>(key);
      if (Array.isArray(raw)) {
        this.state.set(id, new Set(raw));
      }
    }
  }

  /**
   * Returns:
   *   null   — no filter applied (caller should show all schemas).
   *   Set    — filter applied; show only schemas whose name is in the set.
   *            An empty Set means "hide everything".
   */
  get(connectionId: string): ReadonlySet<string> | null {
    return this.state.get(connectionId) ?? null;
  }

  /**
   * Replace the filter for a connection. Passing an empty iterable is allowed
   * (means "hide all schemas for this connection"). Fires onDidChange exactly
   * once. No-op writes (filter already equals the new value) do NOT fire.
   */
  set(connectionId: string, schemas: Iterable<string>): void {
    const next = new Set(schemas);
    const current = this.state.get(connectionId);
    if (current && this.setsEqual(current, next)) return;
    this.state.set(connectionId, next);
    void this.mem.update(this.keyFor(connectionId), [...next].sort());
    this._onDidChange.fire({ connectionId });
  }

  /**
   * Clear the filter for a connection (restore "show all" behavior). Fires
   * onDidChange exactly once. No-op if no filter was set.
   */
  clear(connectionId: string): void {
    if (!this.state.has(connectionId)) return;
    this.state.delete(connectionId);
    void this.mem.update(this.keyFor(connectionId), undefined);
    this._onDidChange.fire({ connectionId });
  }

  /** Dispose the change emitter. The memento itself is owned by the caller. */
  dispose(): void {
    this._onDidChange.dispose();
  }

  private keyFor(connectionId: string): string {
    return KEY_PREFIX + connectionId;
  }

  private setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
}
