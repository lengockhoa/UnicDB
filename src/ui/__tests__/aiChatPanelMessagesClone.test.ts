// src/ui/__tests__/aiChatPanelMessagesClone.test.ts — TASK-AGTUI-002.
//
// Pure type-shape and runtime-narrowing tests for the AGT-UI clone protocol
// additions to src/ui/aiChatPanelMessages.ts:
//
//   host → webview   { type: "models", active, roles[] }
//   webview → host   { type: "model_select", role }
//   webview → host   { type: "bypass_permissions", enabled }
//
// Pattern mirrors the existing aiChatPanelMessages.test.ts (assignability +
// exhaustive-union mirrors + no-secret assertions + wire-shape frozen).

import { describe, it, expect } from "vitest";
import type {
  AiChatPanelHostMessage,
  AiChatPanelWebviewMessage,
  AiChatPanelModels,
  AiChatPanelModelSelect,
  AiChatPanelBypassPermissions,
  AiChatPanelPermissionResponse,
} from "../aiChatPanelMessages";

// ---- Fixtures --------------------------------------------------------------

const modelsFixture: AiChatPanelModels = {
  type: "models",
  active: "work",
  roles: [
    { role: "work", modelId: "gpt-5", vision: true },
    { role: "smart", modelId: "claude-opus-4-7", vision: true },
    { role: "autocomplete", modelId: "", vision: false },
    { role: "lite", modelId: "", vision: false },
  ],
};

const modelSelectFixture: AiChatPanelModelSelect = {
  type: "model_select",
  role: "smart",
};

const bypassOnFixture: AiChatPanelBypassPermissions = {
  type: "bypass_permissions",
  enabled: true,
};

const bypassOffFixture: AiChatPanelBypassPermissions = {
  type: "bypass_permissions",
  enabled: false,
};

// ---- #1 — new frames are union members (happy) ----------------------------
describe("AiChatPanelMessages — AGT-UI clone wire protocol (TASK-AGTUI-002)", () => {
  it("#1a `models` is assignable to AiChatPanelHostMessage", () => {
    const arr: AiChatPanelHostMessage[] = [modelsFixture];
    const found = arr.find((m) => m.type === "models");
    expect(found).toBeDefined();
    expect(found).toEqual(modelsFixture);
    // The frame MUST NOT carry apiKey material — wire is shape-safe.
    const asJson = JSON.stringify(modelsFixture);
    expect(asJson).not.toMatch(/api_?key/i);
    expect(asJson).not.toMatch(/sk-[a-z0-9]/i);
    expect(asJson).not.toMatch(/secret/i);
  });

  it("#1b `model_select` is assignable to AiChatPanelWebviewMessage", () => {
    const arr: AiChatPanelWebviewMessage[] = [modelSelectFixture];
    const found = arr.find((m) => m.type === "model_select");
    expect(found).toBeDefined();
    expect(found).toEqual(modelSelectFixture);
    const asJson = JSON.stringify(modelSelectFixture);
    expect(asJson).not.toMatch(/api_?key|sk-[a-z0-9]|secret/i);
  });

  it("#1c `bypass_permissions` (true + false) is assignable to AiChatPanelWebviewMessage", () => {
    const arr: AiChatPanelWebviewMessage[] = [bypassOnFixture, bypassOffFixture];
    const on = arr.find(
      (m) => m.type === "bypass_permissions" && m.enabled === true,
    );
    const off = arr.find(
      (m) => m.type === "bypass_permissions" && m.enabled === false,
    );
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    expect(on).toEqual(bypassOnFixture);
    expect(off).toEqual(bypassOffFixture);
  });

  // ---- #2 — empty roles array is the "nothing configured" signal -----------
  it("#2 `models` with empty roles array still compiles + is a valid host frame", () => {
    const empty: AiChatPanelModels = {
      type: "models",
      active: "work",
      roles: [],
    };
    expect(empty.type).toBe("models");
    expect(empty.active).toBe("work");
    expect(empty.roles).toHaveLength(0);
    // Frozen wire shape: only type/active/roles — no extra payload.
    expect(Object.keys(empty).sort()).toEqual(["active", "roles", "type"]);
  });

  // ---- #3 — invalid role literal rejected (compile-time via @ts-expect-error)
  it("#3 invalid role literal is rejected by the type checker", () => {
    // The two @ts-expect-error directives below MUST suppress real TS errors
    // (the casts fail because "turbo" is not a literal AiModelRole). If the
    // protocol regresses to `role: string`, the cast stops failing AND the
    // @ts-expect-error itself fails (no error to suppress), tripping RED.
    const invalidModelSelect = {
      type: "model_select",
      role: "turbo",
    // @ts-expect-error role must be a literal AiModelRole, not arbitrary string
    } as AiChatPanelModelSelect;
    const invalidActive = {
      type: "models",
      // @ts-expect-error active must be a literal AiModelRole, not arbitrary string
      active: "turbo",
      roles: [],
    } as AiChatPanelModels;
    expect(typeof invalidModelSelect).toBe("object");
    expect(invalidActive.roles).toHaveLength(0);
  });

  // ---- #4 — optional-omitted regression: deny response still omits optionId
  it("#4 deny response still omits optionId (regression: existing protocol unchanged)", () => {
    const deny: AiChatPanelPermissionResponse = {
      type: "permission_response",
      requestId: "req-host-7c4f",
    };
    expect("optionId" in deny).toBe(false);
    // Existing kind is still part of the webview union.
    const arr: AiChatPanelWebviewMessage[] = [deny];
    expect(arr.some((m) => m.type === "permission_response")).toBe(true);
  });

  // ---- #5 — exhaustive union mirrors: every new kind lives in exactly one direction
  it("#5 exhaustive union mirrors: every new kind lives in exactly one direction", () => {
    const host: AiChatPanelHostMessage[] = [modelsFixture];
    const webview: AiChatPanelWebviewMessage[] = [
      modelSelectFixture,
      bypassOnFixture,
      bypassOffFixture,
    ];
    // models lives on the host direction only.
    expect(host.some((m) => m.type === "models")).toBe(true);
    // model_select lives on the webview direction only.
    expect(webview.some((m) => m.type === "model_select")).toBe(true);
    // bypass_permissions lives on the webview direction only.
    expect(webview.some((m) => m.type === "bypass_permissions")).toBe(true);
    // Combined types (Set) cover each new kind exactly once.
    const all = [...host, ...webview];
    const counts = new Map<string, number>();
    for (const m of all) {
      counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    }
    expect(counts.get("models")).toBe(1);
    expect(counts.get("model_select")).toBe(1);
    expect(counts.get("bypass_permissions")).toBe(2); // on + off
  });

  // ---- #6 — roles entry shape is frozen -----------------------------------
  it("#6 `roles[]` entries carry exactly role + modelId + vision (frozen shape)", () => {
    const keys = Object.keys(modelsFixture.roles[0] as object).sort();
    expect(keys).toEqual(["modelId", "role", "vision"]);
    // vision is a boolean (not a truthy string / truthy object).
    for (const r of modelsFixture.roles) {
      expect(typeof r.vision).toBe("boolean");
      expect(typeof r.modelId).toBe("string");
    }
  });
});
