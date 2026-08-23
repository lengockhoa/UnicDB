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

interface VsdbApi {
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
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-form-body"></div>';
  const root = document.getElementById("vsdb-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
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
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
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
});