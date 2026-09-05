// src/ai/__tests__/config.test.ts
// Unit tests cho src/ai/config.ts (vscode-backed AiConfigStore) — TASK-001 §Test Cases #8..#13.
//
// Strategy: instantiate AiConfigStore trực tiếp với fake { secrets, globalState } object
// (giống pattern trong src/core/__tests__/connectionManager.test.ts). Không cần vi.mock('vscode').
import { describe, it, expect, beforeEach } from "vitest";
import {
  AiConfigStore,
  KEY_AI_SETTINGS,
  KEY_AI_API_KEY,
} from "../config";
import type { AiSettings } from "../settings";
import { defaultAiSettings } from "../settings";

// ---- Fake SecretStorage / Memento -------------------------------------------

class FakeSecretStorage {
  private data = new Map<string, string>();
  // Optional injection: nếu set, store(key,value) sẽ reject.
  throwOnStore = false;
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }
  store(key: string, value: string): Promise<void> {
    if (this.throwOnStore) {
      return Promise.reject(new Error("SecretStorage unavailable"));
    }
    this.data.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
  _raw(): Map<string, string> {
    return this.data;
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
  // For corrupt-JSON test, we need to bypass typing by setting raw value.
  _setRaw(key: string, value: unknown): void {
    this.data.set(key, value);
  }
  _raw(): Map<string, unknown> {
    return this.data;
  }
}

// ---- Helpers ---------------------------------------------------------------

function makeStore(opts: {
  throwOnStore?: boolean;
} = {}): {
  store: AiConfigStore;
  secrets: FakeSecretStorage;
  global: FakeMemento;
} {
  const secrets = new FakeSecretStorage();
  if (opts.throwOnStore) secrets.throwOnStore = true;
  const global = new FakeMemento();
  const ctx = { secrets, globalState: global } as never;
  return {
    store: new AiConfigStore(ctx),
    secrets,
    global,
  };
}

function validSettings(): AiSettings {
  return {
    ...defaultAiSettings(),
    models: {
      work: { modelId: "gpt-4o-mini", vision: true },
      smart: { modelId: "gpt-4o", vision: false },
      autocomplete: { modelId: "", vision: false },
    },
  };
}

// ---- Tests -----------------------------------------------------------------

describe("ai/config — AiConfigStore (SecretStorage + globalState)", () => {
  beforeEach(() => {
    expect(KEY_AI_SETTINGS).toBe("UnicDB.ai.settings");
    expect(KEY_AI_API_KEY).toBe("UnicDB.ai.apiKey");
  });

  it("Test #8 — save → load round-trip", async () => {
    const { store, secrets, global } = makeStore();
    const s = validSettings();
    await store.save(s, "sk-1");

    const loaded = await store.loadConfig();
    expect(loaded).toEqual({ ...s, apiKey: "sk-1" });

    // Secret stored under exactly the canonical key.
    expect(secrets.has("UnicDB.ai.apiKey")).toBe(true);
    expect(await secrets.get("UnicDB.ai.apiKey")).toBe("sk-1");

    // Settings stored under exactly the canonical key — and apiKey NOT leaked.
    const stored = global.get<unknown>("UnicDB.ai.settings");
    expect(stored).toBeDefined();
    const obj = stored as Record<string, unknown>;
    expect(obj.apiKey).toBeUndefined();
    expect(obj.baseUrl).toBe(s.baseUrl);
    expect(obj.method).toBe(s.method);
    expect(obj.timeoutMs).toBe(s.timeoutMs);
    expect(obj.maxSteps).toBe(s.maxSteps);
    expect(obj.models).toEqual(s.models);
  });

  it("Test #9 — invalid save persists NOTHING to either store", async () => {
    const { store, secrets, global } = makeStore();
    const bad = {
      ...validSettings(),
      baseUrl: "", // invalid
    };
    await expect(store.save(bad, "sk-1")).rejects.toThrow(
      /Base URL is required/,
    );
    expect(secrets._raw().size).toBe(0);
    expect(global._raw().size).toBe(0);
  });

  it("Test #10 — SecretStorage.store rejects → save rejects, settings NOT in globalState", async () => {
    const { store, secrets, global } = makeStore({ throwOnStore: true });
    const s = validSettings();
    await expect(store.save(s, "sk-1")).rejects.toThrow(
      /SecretStorage unavailable/,
    );
    // Secret was rejected → nothing went in.
    expect(secrets._raw().size).toBe(0);
    // Critical: settings MUST NOT be persisted (secret-first ordering).
    expect(global.get("UnicDB.ai.settings")).toBeUndefined();
  });

  it("Test #11 — unconfigured: loadConfig null, loadSettings null, loadApiKey undefined", async () => {
    const { store } = makeStore();
    expect(await store.loadConfig()).toBeNull();
    expect(await store.loadSettings()).toBeNull();
    expect(await store.loadApiKey()).toBeUndefined();
  });

  it("Test #12 — no stale cache: secret-side mutation visible; corrupt JSON → null", async () => {
    const { store, secrets, global } = makeStore();
    const s = validSettings();

    // save với key "k1".
    await store.save(s, "k1");
    expect((await store.loadConfig())!.apiKey).toBe("k1");

    // Mutate secret store bên ngoài (simulate secret rotation / different code path).
    await secrets.store("UnicDB.ai.apiKey", "k2");
    const after = await store.loadConfig();
    expect(after).not.toBeNull();
    expect(after!.apiKey).toBe("k2"); // reading FRESH, no stale cache.

    // Corrupt settings JSON: ghi raw string bị hỏng vào globalState.
    global._setRaw("UnicDB.ai.settings", "{oops");
    expect(await store.loadSettings()).toBeNull();
  });

  it("Test #13 — clear empties both stores and loadConfig becomes null", async () => {
    const { store, secrets, global } = makeStore();
    await store.save(validSettings(), "sk-1");
    expect((await store.loadConfig())!.apiKey).toBe("sk-1");

    await store.clear();

    expect(secrets._raw().size).toBe(0);
    expect(global._raw().size).toBe(0);
    expect(await store.loadConfig()).toBeNull();
    expect(await store.loadSettings()).toBeNull();
    expect(await store.loadApiKey()).toBeUndefined();
  });

  it("Test #9b — empty apiKey is rejected before any store is touched", async () => {
    const { store, secrets, global } = makeStore();
    const s = validSettings();
    await expect(store.save(s, "")).rejects.toThrow(/API key is required/);
    expect(secrets._raw().size).toBe(0);
    expect(global._raw().size).toBe(0);
  });

  it("AE — legacy settings without `engine` field normalize to 'builtin' before validation", async () => {
    // Pre-cycle-AE configs persisted before the engine field was added
    // (no engine key at all). loadSettings must normalize engine to
    // "builtin" so aiSettingsErrors() does NOT flag it as invalid and
    // the user's saved config remains usable.
    const { store, global } = makeStore();
    const legacy = {
      baseUrl: "https://api.openai.com/v1",
      method: "chat/completions" as const,
      timeoutMs: 60000,
      maxSteps: 12,
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
      },
      // engine intentionally absent (legacy shape)
    };
    global._setRaw("UnicDB.ai.settings", legacy);
    const loaded = await store.loadSettings();
    expect(loaded).not.toBeNull();
    expect(loaded!.engine).toBe("builtin");
  });
});
