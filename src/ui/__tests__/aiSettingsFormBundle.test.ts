// src/ui/__tests__/aiSettingsFormBundle.test.ts
// TASK-004 — jsdom bundle test for webview/aiSettingsFormMain.ts.
//
// Loads dist/aiSettingsForm.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches an init
// message and asserts: all settings fields render, live validation disables
// OK on bad baseUrl, valid save submits a `{type:"save", settings, apiKey}`
// message, Escape → cancel.
//
// IMPORTANT: This test MUST run after `npm run compile` so that
// dist/aiSettingsForm.js exists — see TASK-004 §Verification Commands. If
// missing, the test is skipped with an explanatory message.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs (AG Grid bundle compatibility if loaded as side effect)
type ResizeObserverLike = {
  observe(): void;
  unobserve(): void;
  disconnect(): void;
};
type MediaQueryListLike = {
  matches: boolean;
  media: string;
  onchange: null;
  addListener(): void;
  removeListener(): void;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
};

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: new () => ResizeObserverLike;
    matchMedia?: (q: string) => MediaQueryListLike;
  };
  if (typeof g.ResizeObserver === "undefined") {
    class StubResizeObserver implements ResizeObserverLike {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as new () => ResizeObserverLike;
  }
  if (typeof g.matchMedia === "undefined") {
    const factory = (query: string): MediaQueryListLike => ({
      matches: false,
      media: query,
      onchange: null,
      addListener(): void {},
      removeListener(): void {},
      addEventListener(): void {},
      removeEventListener(): void {},
      dispatchEvent(): boolean {
        return false;
      },
    });
    g.matchMedia = factory;
  }
});

// ---- bundle loading --------------------------------------------------------

const distPath = resolve(process.cwd(), "dist", "aiSettingsForm.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface BundleHandle {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/aiSettingsForm.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-form-body"></div>';
  const root = document.getElementById("UnicDB-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrc);
  return { received, root };
}

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function inputEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function selectEl(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function fillValid(): void {
  inputEl("baseUrl").value = "https://api.openai.com/v1";
  selectEl("method").value = "chat/completions";
  inputEl("timeoutMs").value = "60000";
  inputEl("maxSteps").value = "12";
  inputEl("modelWork").value = "gpt-4o-mini";
  inputEl("modelSmart").value = "gpt-4o";
  inputEl("apiKey").value = "sk-9";
  for (const id of [
    "baseUrl",
    "method",
    "timeoutMs",
    "maxSteps",
    "modelWork",
    "modelSmart",
    "apiKey",
  ]) {
    inputEl(id).dispatchEvent(new Event("input", { bubbles: true }));
    inputEl(id).dispatchEvent(new Event("change", { bubbles: true }));
  }
}

describeIfBundle("webview/aiSettingsFormMain.ts bundle (TASK-004)", () => {
  itIfBundle("#9 init → all fields present + live validation", () => {
    const { received } = loadBundle();
    // bundle posts ready; host answers with init.
    expect(received.some((m) => m.type === "ready")).toBe(true);
    dispatch({
      type: "init",
      settings: {
        baseUrl: "",
        method: "chat/completions",
        timeoutMs: 60000,
        maxSteps: 12,
        models: {
          work: { modelId: "", vision: true },
          smart: { modelId: "", vision: false },
        },
      },
      hasApiKey: false,
    });
    const root = document.getElementById("UnicDB-root") as HTMLDivElement;
    // All required fields rendered.
    for (const id of [
      "baseUrl",
      "method",
      "timeoutMs",
      "maxSteps",
      "modelWork",
      "modelSmart",
      "visionWork",
      "visionSmart",
      "apiKey",
      "testBtn",
      "saveBtn",
      "cancelBtn",
    ]) {
      expect(root.querySelector(`#${id}`)).not.toBeNull();
    }
    // Type garbage into baseUrl → OK disabled + error visible.
    inputEl("baseUrl").value = "not-a-url";
    inputEl("baseUrl").dispatchEvent(new Event("input", { bubbles: true }));
    inputEl("baseUrl").dispatchEvent(new Event("change", { bubbles: true }));
    expect(btn("saveBtn").disabled).toBe(true);
    const errors = root.querySelector("#errors") as HTMLElement;
    expect(errors.textContent ?? "").toMatch(/Base URL/);
    // Fix baseUrl + fill rest → OK enabled.
    fillValid();
    expect(btn("saveBtn").disabled).toBe(false);
  });

  itIfBundle("#10 valid fields → OK posts {type:\"save\", settings, apiKey}", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      settings: {
        baseUrl: "",
        method: "chat/completions",
        timeoutMs: 60000,
        maxSteps: 12,
        models: {
          work: { modelId: "", vision: true },
          smart: { modelId: "", vision: false },
        },
      },
      hasApiKey: false,
    });
    fillValid();
    btn("saveBtn").click();
    const saveMsgs = received.filter((m) => m.type === "save");
    expect(saveMsgs.length).toBe(1);
    const msg = saveMsgs[0] as {
      settings: Record<string, unknown>;
      apiKey: string;
    };
    expect(msg.settings.baseUrl).toBe("https://api.openai.com/v1");
    expect(msg.settings.method).toBe("chat/completions");
    expect(msg.settings.timeoutMs).toBe(60000);
    expect(msg.settings.maxSteps).toBe(12);
    const models = msg.settings.models as Record<
      string,
      { modelId: string; vision: boolean }
    >;
    expect(models.work.modelId).toBe("gpt-4o-mini");
    expect(models.smart.modelId).toBe("gpt-4o");
    expect(msg.apiKey).toBe("sk-9");
  });

  itIfBundle("#11 Escape → cancel posted", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      settings: {
        baseUrl: "",
        method: "chat/completions",
        timeoutMs: 60000,
        maxSteps: 12,
        models: {
          work: { modelId: "", vision: true },
          smart: { modelId: "", vision: false },
        },
      },
      hasApiKey: false,
    });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(received.some((m) => m.type === "cancel")).toBe(true);
  });

  itIfBundle("#11b Test button → {type:\"test\", settings, apiKey}", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      settings: {
        baseUrl: "",
        method: "chat/completions",
        timeoutMs: 60000,
        maxSteps: 12,
        models: {
          work: { modelId: "", vision: true },
          smart: { modelId: "", vision: false },
        },
      },
      hasApiKey: false,
    });
    fillValid();
    btn("testBtn").click();
    const testMsgs = received.filter((m) => m.type === "test");
    expect(testMsgs.length).toBe(1);
    const msg = testMsgs[0] as { apiKey: string };
    expect(msg.apiKey).toBe("sk-9");
  });

  itIfBundle(
    "#12 B13: host posts saveResult{ok:false} → status shows the save error, distinct from testResult",
    () => {
      loadBundle();
      dispatch({
        type: "init",
        settings: {
          baseUrl: "",
          method: "chat/completions",
          timeoutMs: 60000,
          maxSteps: 12,
          models: {
            work: { modelId: "", vision: true },
            smart: { modelId: "", vision: false },
          },
        },
        hasApiKey: false,
      });
      dispatch({ type: "saveResult", ok: false, error: "disk full" });
      const status = document.getElementById("status") as HTMLElement;
      expect(status.textContent).toBe("disk full");
      expect(status.className).toContain("err");
    },
  );
});

// ============================================================================
// TASK-GC-006 — global Engine dropdown (bug fix) + Lite model section.
//
// Round-1 review fix: every NEW describe below starts with a HARD precondition
// that fails (not skips) when the bundle is missing. The old describes
// (TASK-004) still skip when missing, which is intentional — the legacy
// harness was written before the dist-missing policy was tightened.
// ============================================================================

describe("webview/aiSettingsFormMain.ts bundle — TASK-GC-006 (engine + lite)", () => {
  // Hard precondition: bundle must exist. If `npm run compile` was skipped
  // we want a FAIL with a clear message, not a silent SKIP that masks a
  // stale dist (this is exactly the round-1 review regression).
  const gc006BundlePath = resolve(process.cwd(), "dist", "aiSettingsForm.js");
  expect(
    existsSync(gc006BundlePath),
    "aiSettingsForm.js must be built before this test runs — run: npm run compile",
  ).toBe(true);

  const baseSettings = {
    baseUrl: "https://api.openai.com/v1",
    method: "chat/completions" as const,
    timeoutMs: 60000,
    maxSteps: 12,
    models: {
      work: { modelId: "gpt-4o-mini", vision: true },
      smart: { modelId: "gpt-4o", vision: false },
      autocomplete: { modelId: "", vision: false },
      lite: { modelId: "", vision: false, engine: "omp" as const },
    },
    engine: "builtin" as const,
  };

  it("#1 Engine select renders from init", () => {
    loadBundle();
    dispatch({
      type: "init",
      settings: { ...baseSettings, engine: "builtin" },
      hasApiKey: false,
    });
    expect(selectEl("engine").value).toBe("builtin");
    dispatch({
      type: "init",
      settings: { ...baseSettings, engine: "omp" },
      hasApiKey: false,
    });
    expect(selectEl("engine").value).toBe("omp");
  });

  it("#2 save posts engine + lite", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      settings: {
        ...baseSettings,
        engine: "omp",
        models: {
          ...baseSettings.models,
          lite: { modelId: "x", vision: false, engine: "omp" },
        },
      },
      hasApiKey: false,
    });
    fillValid();
    btn("saveBtn").click();
    const saveMsgs = received.filter((m) => m.type === "save");
    expect(saveMsgs.length).toBe(1);
    const payload = saveMsgs[0] as { settings: Record<string, unknown> };
    expect(payload.settings.engine).toBe("omp");
    const models = payload.settings.models as Record<
      string,
      { modelId: string; vision: boolean; engine?: string }
    >;
    expect(models.lite).toEqual({ modelId: "x", vision: false, engine: "omp" });
  });

  it("#3 regression: engine round-trip makes save host-valid", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      settings: baseSettings,
      hasApiKey: false,
    });
    fillValid();
    btn("saveBtn").click();
    const saveMsgs = received.filter((m) => m.type === "save");
    expect(saveMsgs.length).toBe(1);
    const payload = saveMsgs[0] as { settings: Record<string, unknown> };
    // Pre-GC code: payload.settings.engine was undefined → host validator
    // rejected with "Engine must be builtin or omp". This test fails on
    // pre-GC code and passes after the global Engine dropdown is wired.
    expect(payload.settings.engine).toBeDefined();
    expect(payload.settings.engine).toBe("builtin");
  });

  it("#4 empty Lite modelId passes gate", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      settings: {
        ...baseSettings,
        models: {
          ...baseSettings.models,
          lite: { modelId: "", vision: false, engine: "omp" },
        },
      },
      hasApiKey: false,
    });
    fillValid();
    // OK must remain enabled — empty lite = feature disabled (autocomplete precedent).
    expect(btn("saveBtn").disabled).toBe(false);
    btn("saveBtn").click();
    const saveMsgs = received.filter((m) => m.type === "save");
    expect(saveMsgs.length).toBe(1);
    const payload = saveMsgs[0] as {
      settings: { models: { lite: { modelId: string } } };
    };
    expect(payload.settings.models.lite.modelId).toBe("");
  });

  it("#5 lite engine select defaults omp with legacy init (no models.lite)", () => {
    loadBundle();
    // Legacy 3-role init fixture: no `models.lite`.
    const legacySettings = {
      baseUrl: "https://api.openai.com/v1",
      method: "chat/completions" as const,
      timeoutMs: 60000,
      maxSteps: 12,
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
      },
      engine: "builtin" as const,
    };
    dispatch({
      type: "init",
      settings: legacySettings as unknown as typeof baseSettings,
      hasApiKey: false,
    });
    // Defaults for the new fields.
    expect(selectEl("engineLite").value).toBe("omp");
    expect(inputEl("modelLite").value).toBe("");
    // Gate should still pass with the lite empty + default engine.
    fillValid();
    expect(btn("saveBtn").disabled).toBe(false);
  });

  it("#6 invalid engine blocks OK with 'Engine must be builtin or omp' error", () => {
    loadBundle();
    dispatch({
      type: "init",
      settings: baseSettings,
      hasApiKey: false,
    });
    fillValid();
    // Remove all options so the select has no legal value (value becomes "").
    const engineSelect = selectEl("engine");
    while (engineSelect.options.length > 0) {
      engineSelect.remove(0);
    }
    engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(btn("saveBtn").disabled).toBe(true);
    const errors = document.getElementById("errors") as HTMLElement;
    expect(errors.textContent ?? "").toMatch(/Engine must be builtin or omp/);
  });
});