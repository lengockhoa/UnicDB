// src/core/activeSchemaStore.ts
// Per-connection "selected schema" — the schema every subsequent SQL run on
// this connection will run inside (DataGrip-style).
//
// Why a separate store (instead of a field on `ConnectionConfig`):
//   - Schema is a runtime choice that follows the user across reconnects.
//     Putting it on `ConnectionConfig` would force users to edit a
//     connection to change schemas, and would mix connection-shape
//     metadata with session-scoped state.
//   - The store stays decoupled from `ConnectionManager`, which lets
//     tests construct it without spinning a manager.
//
// Semantics:
//   - `get(id) === undefined`        → no schema pinned → SQL runs with
//     the server's default `search_path` (typically `public`).
//   - `get(id) === "<name>"`         → all `adapter.runQuery` calls for
//     this connection are wrapped to set `search_path` to `<name>` first.
//   - `set(id, null | undefined)`    → clear the pin → revert to default.
//   - `set(id, "<name>")`            → pin to `<name>`. Fire onDidChange.
//
// Persistence:
//   key   = `unicDb.activeSchema.<connectionId>`
//   value = "<name>" (string) or absent (no pin)
//   store hydrated from existing keys at construction (matches the
//   `SchemaFilterStore` discipline so a fresh store on a fresh window
//   still sees previously-pinned schemas).
//
// Event semantics: `onDidChange` fires exactly once per real mutation
// (id + schema both changed). No-op writes do NOT fire (mirrors the
// `SchemaFilterStore` "no event on equal value" rule).
import * as vscode from "vscode";

const KEY_PREFIX = "unicDb.activeSchema.";

export interface ActiveSchemaChangeEvent {
  /** Connection id whose active schema changed. */
  connectionId: string;
  /** New active schema (undefined = cleared). */
  schema: string | undefined;
}

export class ActiveSchemaStore {
  private readonly mem: vscode.Memento;
  /** In-memory mirror so reads are sync (no memento round-trip per call). */
  private readonly state = new Map<string, string>();
  private readonly _onDidChange =
    new vscode.EventEmitter<ActiveSchemaChangeEvent>();
  readonly onDidChange: vscode.Event<ActiveSchemaChangeEvent> =
    this._onDidChange.event;

  constructor(memento: vscode.Memento) {
    this.mem = memento;
    // Hydrate from existing keys so subsequent get() calls are synchronous.
    // Tolerate a missing `keys()` (some test mocks only stub get/update) —
    // in that case the in-memory map starts empty, and any pre-existing
    // pinned schema is loaded lazily on the next get() / set() cycle.
    const keys =
      typeof memento.keys === "function" ? memento.keys() : [];
    for (const key of keys) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const id = key.slice(KEY_PREFIX.length);
      const raw = memento.get<string>(key);
      if (typeof raw === "string" && raw.length > 0) {
        this.state.set(id, raw);
      }
    }
  }

  /** Return the schema currently pinned for `connectionId`, or undefined
   *  when no schema is pinned (SQL runs with the server default). */
  get(connectionId: string): string | undefined {
    return this.state.get(connectionId);
  }

  /**
   * Pin a schema for `connectionId`. Passing `undefined` / empty string /
   * whitespace clears the pin and restores the server default. Fires
   * `onDidChange` exactly once on a real change. No-op writes (same id
   * + same schema) do NOT fire.
   */
  set(connectionId: string, schema: string | undefined): void {
    const normalized =
      typeof schema === "string" && schema.trim().length > 0
        ? schema.trim()
        : undefined;
    const current = this.state.get(connectionId);
    if (current === normalized) return;
    if (normalized === undefined) {
      this.state.delete(connectionId);
      void this.mem.update(this.keyFor(connectionId), undefined);
    } else {
      this.state.set(connectionId, normalized);
      void this.mem.update(this.keyFor(connectionId), normalized);
    }
    this._onDidChange.fire({ connectionId, schema: normalized });
  }

  /** Clear the pin for `connectionId` (convenience for `set(id, undefined)`). */
  clear(connectionId: string): void {
    this.set(connectionId, undefined);
  }

  /** Dispose the change emitter. The memento itself is owned by the caller. */
  dispose(): void {
    this._onDidChange.dispose();
  }

  private keyFor(connectionId: string): string {
    return KEY_PREFIX + connectionId;
  }
}