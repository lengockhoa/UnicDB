// webview/__tests__/aiSettingsFormMain.test.ts
// TASK-008 — four-engine dropdown and mirrored validation in the AI
// Settings webview (consumes `dist/aiSettingsForm.js`).
//
// Strategy: mirror src/ui/__tests__/aiSettingsFormBundle.test.ts. We can't
// import `webview/aiSettingsFormMain.ts` directly (it touches `document` and
// runs `render()` at module scope, which crashes in jsdom). Instead, load
// the compiled bundle via `eval` after stubbing `acquireVsCodeApi`,
// `ResizeObserver`, and `matchMedia`. If the bundle is missing the tests
// skip with an explanatory message, matching the bundle-test pattern.
//
// Tests 1–4 follow docs/AI_HANDOFF/tasks/TASK-008.md §Test Cases.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs (mirror aiSettingsFormBundle.test.ts) ---------------

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
    g.ResizeObserver =
      StubResizeObserver as unknown as new () => ResizeObserverLike;
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
  document.body.innerHTML =
    '<div id="UnicDB-root" class="UnicDB-form-body"></div>';
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

function inputEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function selectEl(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

// Fill all fields with values that pass the host validator so save posts
// cleanly when the engine is a legal value.
function fillRequired(): void {
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

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

// Order required by TASK-008 Acceptance Criteria: omp, claude-code, codex, builtin.
const EXPECTED_ENGINE_ORDER = ["omp", "claude-code", "codex", "builtin"];
const EXACT_ENGINE_ERROR =
  "Engine must be builtin, omp, claude-code, or codex";

describeIfBundle("TASK-008 four-engine webview", () => {
  itIfBundle(
    "#1 init renders global Claude Code setting + save posts engine:claude-code",
    () => {
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
            autocomplete: { modelId: "", vision: false },
            lite: { modelId: "", vision: false },
          },
          engine: "claude-code",
        },
        hasApiKey: false,
      });
      expect(selectEl("engine").value).toBe("claude-code");
      fillRequired();
      btn("saveBtn").click();
      const saveMsgs = received.filter((m) => m.type === "save");
      expect(saveMsgs.length).toBe(1);
      const payload = saveMsgs[0] as { settings: { engine: string } };
      expect(payload.settings.engine).toBe("claude-code");
    },
  );

  itIfBundle(
    "#3 unknown engine: blocks save + visible error is exact 4-engine string",
    () => {
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
            autocomplete: { modelId: "", vision: false },
            lite: { modelId: "", vision: false },
          },
          engine: "builtin",
        },
        hasApiKey: false,
      });
      fillRequired();
      const engineSelect = selectEl("engine");
      while (engineSelect.options.length > 0) {
        engineSelect.remove(0);
      }
      engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
      expect(btn("saveBtn").disabled).toBe(true);
      btn("saveBtn").click();
      btn("testBtn").click();
      expect(received.some((m) => m.type === "save")).toBe(false);
      expect(received.some((m) => m.type === "test")).toBe(false);
      const errors = document.getElementById("errors") as HTMLElement;
      expect(errors.textContent ?? "").toContain(EXACT_ENGINE_ERROR);
    },
  );

  itIfBundle(
    "#4 missing engine keeps 'omp' default (fresh-install behavior, legacy 2-role init)",
    () => {
      loadBundle();
      const legacySettings = {
        baseUrl: "https://api.openai.com/v1",
        method: "chat/completions" as const,
        timeoutMs: 60000,
        maxSteps: 12,
        models: {
          work: { modelId: "gpt-4o-mini", vision: true },
          smart: { modelId: "gpt-4o", vision: false },
        },
      };
      dispatch({
        type: "init",
        settings: legacySettings as unknown as Record<string, unknown>,
        hasApiKey: false,
      });
      // engineLite select was dropped in this cycle — must NOT exist.
      expect(document.getElementById("engineLite")).toBeNull();
      // Fresh-install global default is "omp" now.
      expect(selectEl("engine").value).toBe("omp");
    },
  );
});

// ---- shape contract: global select exposes the same 4 options in fixed order
describeIfBundle("TASK-008 select option shape", () => {
  itIfBundle("global select carries the four engines in the user-confirmed order", () => {
    loadBundle();
    dispatch({
      type: "init",
      settings: {
        baseUrl: "https://api.openai.com/v1",
        method: "chat/completions",
        timeoutMs: 60000,
        maxSteps: 12,
        models: {
          work: { modelId: "gpt-4o-mini", vision: true },
          smart: { modelId: "gpt-4o", vision: false },
        },
        engine: "builtin",
      },
      hasApiKey: false,
    });
    const globalValues = Array.from(selectEl("engine").options).map(
      (o) => o.value,
    );
    expect(globalValues).toEqual(EXPECTED_ENGINE_ORDER);
    expect(new Set(globalValues)).toEqual(new Set(EXPECTED_ENGINE_ORDER));
  });
});

