// src/ui/__tests__/aiChatContext.test.ts — TASK-CHATV2-011
//
// Pure coverage for the structured context layer: identity (no duplicate
// collisions), search correlation + race rejection, status resolution
// (ready/changed/missing/forbidden), the structured turn payload, one-id
// removal under duplicate labels, resolution-dialog choices and the
// metadata-only preview.
//
// No `vscode`, no DOM, no timers: every dependency is injected. Determinism is
// explicit (fixed clock + fixed ids), so a failure is never a flake.
import { describe, expect, it, vi } from "vitest";

import {
  applyResolutionChoice,
  buildContextRefs,
  buildTurnContext,
  contextDisplayToken,
  contextResolutionChoices,
  contextRefId,
  isContextSearchResponseCurrent,
  previewContextRef,
  removeContextRef,
  resolveContextRef,
  resolveContextRefs,
  searchContext,
  type ContextCandidate,
  type ContextProbe,
  type ContextRef,
  type ContextSearchDeps,
} from "../aiChatContext";

// ---- Fixtures --------------------------------------------------------------

const FIXED_NOW = 1_700_000_000_000;

function candidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    kind: "file",
    label: "index.vue",
    detail: "a/index.vue",
    source: { type: "uri", uri: "file:///ws/a/index.vue" },
    revision: "rev-a",
    ...overrides,
  };
}

function probe(overrides: Partial<ContextProbe> = {}): ContextProbe {
  return {
    fileRevision: vi.fn(async () => "rev-a"),
    objectSignature: vi.fn(async () => "sig-1"),
    isPermitted: () => true,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function deps(overrides: Partial<ContextSearchDeps> = {}): ContextSearchDeps {
  return {
    connectionId: "conn-1",
    listFiles: vi.fn(async () => [
      { kind: "file" as const, label: "index.vue", detail: "a/index.vue", uri: "file:///ws/a/index.vue", revision: "rev-a" },
      { kind: "file" as const, label: "index.vue", detail: "b/index.vue", uri: "file:///ws/b/index.vue", revision: "rev-b" },
    ]),
    activeSelection: () => null,
    listObjects: vi.fn(async () => [
      { kind: "table" as const, label: "users", detail: "conn-1 · public.users", connectionId: "conn-1", schema: "public", name: "users", revision: "sig-users" },
      { kind: "table" as const, label: "users", detail: "conn-2 · public.users", connectionId: "conn-2", schema: "public", name: "users", revision: "sig-users-2" },
    ]),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

// ---- #4 identity: duplicate labels, distinct ids/details -------------------

describe("buildContextRefs — identity (task case 4)", () => {
  it("gives duplicate filenames distinct ids and disambiguated tokens", () => {
    const refs = buildContextRefs([
      candidate(),
      candidate({ detail: "b/index.vue", source: { type: "uri", uri: "file:///ws/b/index.vue" }, revision: "rev-b" }),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.id).not.toBe(refs[1]!.id);
    expect(refs[0]!.displayToken).toBe("@a/index.vue");
    expect(refs[1]!.displayToken).toBe("@b/index.vue");
  });

  it("keeps a unique file token short (@index.vue)", () => {
    const [ref] = buildContextRefs([candidate()]);
    expect(ref!.displayToken).toBe("@index.vue");
  });

  it("renders a selection token as @selection(path:start–end) with an en dash", () => {
    const [ref] = buildContextRefs([
      candidate({
        kind: "selection",
        label: "index.vue",
        detail: "a/index.vue",
        lineRange: { start: 22, end: 48 },
      }),
    ]);
    expect(ref!.displayToken).toBe("@selection(index.vue:22–48)");
    expect(ref!.id).toBe("selection:file:///ws/a/index.vue:22-48");
  });

  it("disambiguates duplicate DB objects by connection.schema", () => {
    const refs = buildContextRefs([
      candidate({
        kind: "table",
        label: "users",
        detail: "conn-1 · public.users",
        source: { type: "object", connectionId: "conn-1", schema: "public", name: "users", objectKind: "table" },
      }),
      candidate({
        kind: "table",
        label: "users",
        detail: "conn-2 · public.users",
        source: { type: "object", connectionId: "conn-2", schema: "public", name: "users", objectKind: "table" },
      }),
    ]);
    expect(refs[0]!.displayToken).toBe("@conn-1.public.users");
    expect(refs[1]!.displayToken).toBe("@conn-2.public.users");
    expect(contextRefId({
      kind: "table",
      label: "users",
      detail: "",
      source: { type: "object", connectionId: "conn-1", schema: "public", name: "users", objectKind: "table" },
    })).toBe("table:conn-1.public.users");
  });

  it("collapses two candidates with an identical identity+range into one ref", () => {
    const refs = buildContextRefs([candidate(), candidate()]);
    expect(refs).toHaveLength(1);
  });

  it("carries no content field — identity and snapshot only", () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })], { now: () => FIXED_NOW });
    expect(ref!.snapshot).toEqual({ revision: "rev-a", capturedAt: FIXED_NOW });
    const keys = Object.keys(ref!);
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("base64");
    expect(keys).not.toContain("rows");
    expect(keys).not.toContain("text");
  });
});

// ---- #2 race: stale request/revision/generation ----------------------------

describe("isContextSearchResponseCurrent — race rejection (task case 2)", () => {
  const open = { requestId: "r2", draftRevision: 5, generation: 3 };

  it("accepts only the exact request+revision+generation triple", () => {
    expect(isContextSearchResponseCurrent(open, { ...open })).toBe(true);
  });

  it("rejects a stale requestId, revision or generation", () => {
    expect(isContextSearchResponseCurrent(open, { ...open, requestId: "r1" })).toBe(false);
    expect(isContextSearchResponseCurrent(open, { ...open, draftRevision: 4 })).toBe(false);
    expect(isContextSearchResponseCurrent(open, { ...open, generation: 2 })).toBe(false);
  });

  it("rejects everything once the popover is closed (Escape bumped generation)", () => {
    expect(isContextSearchResponseCurrent(null, { ...open })).toBe(false);
  });
});

// ---- #8 regression: search is model-free -----------------------------------

describe("searchContext — model-free structured search", () => {
  it("echoes the request correlation triple verbatim", async () => {
    const result = await searchContext(deps(), {
      requestId: "req-1",
      draftRevision: 7,
      query: "",
      kindFilter: "all",
    });
    expect(result.requestId).toBe("req-1");
    expect(result.draftRevision).toBe(7);
    expect(result.query).toBe("");
  });

  it("groups files and database objects on an empty query, selection first", async () => {
    const result = await searchContext(
      deps({
        activeSelection: () => ({
          label: "composer.ts",
          detail: "webview/aiChat/composer.ts",
          uri: "file:///ws/webview/aiChat/composer.ts",
          lineRange: { start: 10, end: 20 },
          revision: "sel-1",
        }),
      }),
      { requestId: "r", draftRevision: 0, query: "", kindFilter: "all" },
    );
    const kinds = result.items.map((i) => i.kind);
    expect(kinds[0]).toBe("selection");
    expect(kinds).toContain("file");
    expect(kinds).toContain("table");
  });

  it("filters by kind scope", async () => {
    const filesOnly = await searchContext(deps(), {
      requestId: "r",
      draftRevision: 0,
      query: "",
      kindFilter: "file",
    });
    expect(filesOnly.items.every((i) => i.kind === "file")).toBe(true);

    const dbOnly = await searchContext(deps(), {
      requestId: "r",
      draftRevision: 0,
      query: "",
      kindFilter: "database",
    });
    expect(dbOnly.items.every((i) => i.kind === "table")).toBe(true);
  });

  it("filters by query case-insensitively", async () => {
    const result = await searchContext(deps(), {
      requestId: "r",
      draftRevision: 0,
      query: "USERS",
      kindFilter: "database",
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.label).toBe("users");
  });

  it("degrades a failing source to empty instead of throwing", async () => {
    const result = await searchContext(
      deps({
        listFiles: async () => {
          throw new Error("workspace denied");
        },
      }),
      { requestId: "r", draftRevision: 0, query: "", kindFilter: "all" },
    );
    expect(result.items.every((i) => i.kind !== "file")).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("does not consult an AI engine (no engine surface is injected at all)", async () => {
    const sink = vi.fn();
    const result = await searchContext(deps({ listObjects: sink }), {
      requestId: "r",
      draftRevision: 0,
      query: "",
      kindFilter: "all",
    });
    expect(result.items.length).toBeGreaterThan(0);
    // Only the injected data sources were read; nothing else was called.
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

// ---- #6 resolution: changed/missing/forbidden ------------------------------

describe("resolveContextRef — status resolution (task case 6)", () => {
  it("ready when the live fingerprint matches the snapshot", async () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })]);
    const result = await resolveContextRef(probe(), ref!);
    expect(result.status).toBe("ready");
  });

  it("changed when the live fingerprint moved", async () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })]);
    const result = await resolveContextRef(probe({ fileRevision: async () => "rev-b" }), ref!);
    expect(result.status).toBe("changed");
    expect(result.snapshot.revision).toBe("rev-b");
  });

  it("missing when the source is gone; never throws on a probe error", async () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })]);
    expect((await resolveContextRef(probe({ fileRevision: async () => null }), ref!)).status).toBe("missing");
    const throwing = probe({
      fileRevision: async () => {
        throw new Error("EACCES");
      },
    });
    expect((await resolveContextRef(throwing, ref!)).status).toBe("missing");
  });

  it("forbidden when policy denies the ref class, without probing", async () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })]);
    const fileRevision = vi.fn(async () => "rev-a");
    const result = await resolveContextRef(probe({ isPermitted: () => false, fileRevision }), ref!);
    expect(result.status).toBe("forbidden");
    expect(fileRevision).not.toHaveBeenCalled();
  });

  it("resolves a list in input order", async () => {
    const refs = buildContextRefs([
      candidate(),
      candidate({ kind: "table", label: "users", detail: "public.users", source: { type: "object", connectionId: "conn-1", schema: "public", name: "users", objectKind: "table" }, revision: "sig-1" }),
    ]);
    const results = await resolveContextRefs(probe(), refs);
    expect(results.map((r) => r.refId)).toEqual(refs.map((r) => r.id));
  });
});

// ---- #6 structured turn context --------------------------------------------

describe("buildTurnContext — send blocked until explicit choice (task case 6)", () => {
  it("carries every ref id + snapshot separately from the visible text", async () => {
    const refs = buildContextRefs([candidate({ revision: "rev-a" })]);
    const resolutions = await resolveContextRefs(probe(), refs);
    const turn = buildTurnContext(refs, resolutions);
    expect(turn.entries).toHaveLength(1);
    expect(turn.entries[0]).toMatchObject({
      refId: refs[0]!.id,
      displayToken: "@index.vue",
      snapshotRevision: "rev-a",
      status: "ready",
    });
    expect(turn.blocked).toHaveLength(0);
  });

  it("blocks the send when any ref is changed/missing/forbidden", async () => {
    const refs = buildContextRefs([
      candidate({ revision: "rev-a" }),
      candidate({ detail: "b/index.vue", source: { type: "uri", uri: "file:///ws/b/index.vue" }, revision: "rev-b" }),
    ]);
    const turn = buildTurnContext(refs, [
      { refId: refs[0]!.id, status: "changed", snapshot: { revision: "rev-a2", capturedAt: FIXED_NOW }, label: "", detail: "", displayToken: "" },
      { refId: refs[1]!.id, status: "missing", snapshot: { revision: "rev-b", capturedAt: FIXED_NOW }, label: "", detail: "", displayToken: "" },
    ]);
    expect(turn.blocked.map((b) => b.status).sort()).toEqual(["changed", "missing"]);
    // Nothing is dropped: both refs still appear in `entries`.
    expect(turn.entries).toHaveLength(2);
  });
});

// ---- #4 removal affects one id only ---------------------------------------

describe("removeContextRef — duplicate labels remove one id (task case 4)", () => {
  it("removes only the named id and leaves a same-labelled sibling", () => {
    const refs = buildContextRefs([
      candidate(),
      candidate({ detail: "b/index.vue", source: { type: "uri", uri: "file:///ws/b/index.vue" }, revision: "rev-b" }),
    ]);
    const next = removeContextRef(refs, refs[0]!.id);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe(refs[1]!.id);
    expect(next[0]!.label).toBe("index.vue");
  });

  it("returns the same array when the id is unknown", () => {
    const refs = buildContextRefs([candidate()]);
    expect(removeContextRef(refs, "nope")).toBe(refs);
  });
});

// ---- #6 resolution choices -------------------------------------------------

describe("contextResolutionChoices / applyResolutionChoice (task case 6)", () => {
  it("offers keep only when policy permits a stale snapshot", () => {
    expect(contextResolutionChoices("changed", { allowKeepSnapshot: true })).toEqual([
      "refresh",
      "keep",
      "remove",
    ]);
    expect(contextResolutionChoices("changed", { allowKeepSnapshot: false })).toEqual([
      "refresh",
      "remove",
    ]);
  });

  it("offers remove or send-without (never keep) for missing/forbidden", () => {
    for (const status of ["missing", "forbidden"] as const) {
      expect(contextResolutionChoices(status, { allowKeepSnapshot: true })).toEqual([
        "remove",
        "send_without",
      ]);
    }
    expect(contextResolutionChoices("ready", { allowKeepSnapshot: true })).toEqual([]);
  });

  it("applies refresh/keep/remove to one ref only", () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })]);
    const refreshed = { refId: ref!.id, status: "ready" as const, snapshot: { revision: "rev-b", capturedAt: FIXED_NOW }, label: "", detail: "", displayToken: "" };
    expect(applyResolutionChoice(ref!, "remove", refreshed)).toBeNull();
    expect(applyResolutionChoice(ref!, "send_without", refreshed)).toBeNull();
    expect(applyResolutionChoice(ref!, "keep", refreshed)!.status).toBe("ready");
    const refreshedRef = applyResolutionChoice(ref!, "refresh", refreshed)!;
    expect(refreshedRef.snapshot.revision).toBe("rev-b");
    expect(refreshedRef.id).toBe(ref!.id);
  });
});

// ---- #7 security: metadata-only preview ------------------------------------

describe("previewContextRef — safe, metadata-only (task case 7)", () => {
  it("previews a file with its path, not its content", () => {
    const [ref] = buildContextRefs([candidate({ revision: "rev-a" })]);
    const preview = previewContextRef(ref!)!;
    expect(preview.metadataOnly).toBe(true);
    expect(preview.lines.join("\n")).toContain("a/index.vue");
    expect(preview.lines.join("\n")).not.toContain("function");
  });

  it("never returns file text even when the label is hostile markup", () => {
    const [ref] = buildContextRefs([
      candidate({ label: "<img src=x onerror=alert(1)>", detail: "<script>alert(1)</script>" }),
    ]);
    const preview = previewContextRef(ref!)!;
    // The hostile string stays inert DATA in the model — nothing is parsed.
    expect(preview.title).toBe("<img src=x onerror=alert(1)>");
    expect(preview.metadataOnly).toBe(true);
  });

  it("states that DB mentions expose schema metadata only", () => {
    const [ref] = buildContextRefs([
      candidate({
        kind: "table",
        label: "users",
        detail: "conn-1 · public.users",
        source: { type: "object", connectionId: "conn-1", schema: "public", name: "users", objectKind: "table" },
      }),
    ]);
    const preview = previewContextRef(ref!)!;
    expect(preview.lines.join("\n")).toContain("Schema metadata only");
    expect(preview.lines.join("\n")).toContain("conn-1");
  });

  it("returns null when the ref has no preview capability", () => {
    const [ref] = buildContextRefs([candidate({ status: "missing" })]);
    expect(ref!.preview.supported).toBe(false);
    expect(previewContextRef(ref!)).toBeNull();
  });
});

// ---- display token unit ----------------------------------------------------

describe("contextDisplayToken", () => {
  it("builds object tokens from schema.name", () => {
    expect(
      contextDisplayToken({
        kind: "view",
        label: "v",
        detail: "conn-1 · public.v",
        source: { type: "object", connectionId: "conn-1", schema: "public", name: "v", objectKind: "view" },
      }),
    ).toBe("@public.v");
  });
});

// ---- type-level guard ------------------------------------------------------

describe("ContextRef shape", () => {
  it("exposes exactly the required identity fields", () => {
    const [ref] = buildContextRefs([candidate()]);
    const typed: ContextRef = ref!;
    expect(typeof typed.id).toBe("string");
    expect(["file", "selection", "table", "view", "routine", "schema"]).toContain(typed.kind);
    expect(["ready", "changed", "missing", "forbidden"]).toContain(typed.status);
    expect(typed.source.type).toBe("uri");
  });
});
