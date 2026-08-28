// tests/consolePanelWebview.test.ts
//
// TASK-AF-004 — Console v2 webview bundle tests (jsdom). Covers the
// webview half of the new wire surface:
//
//   #4  runSelection sends the selection text verbatim
//   #10 Format round-trip: webview `format` → host replies via postMessage →
//        buffer replaced
//   #11 Format on empty buffer is a no-op (no error, buffer untouched)
//   #12 regression: existing single-tab surface (runConsole/saveConsoleAsSql
//        + tab bar + history dropdown) still wires through the bundle
//
// Loads dist/consolePanel.js into jsdom (built via `npm run compile`), stubs
// acquireVsCodeApi, dispatches incoming host messages, then exercises the
// toolbar / tab bar / history list.
//
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // No AG Grid in this bundle, but jsdom in vitest still asks for these
  // occasionally; stub once for symmetry with the results-bundle tests.
  const g = globalThis as unknown as {
    ResizeObserver?: typeof ResizeObserver;
    matchMedia?: (q: string) => MediaQueryList;
  };
  if (typeof g.ResizeObserver === "undefined") {
    class StubResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  }
  if (typeof g.matchMedia === "undefined") {
    g.matchMedia = (q: string) =>
      ({
        matches: false,
        media: q,
        onchange: null,
        addListener(): void {},
        removeListener(): void {},
        addEventListener(): void {},
        removeEventListener(): void {},
        dispatchEvent(): boolean {
          return false;
        },
      }) as unknown as MediaQueryList;
  }
});

const distPath = resolve(process.cwd(), "dist", "consolePanel.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

function loadBundle(): {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
} {
  if (!bundleSrc) {
    throw new Error(
      "dist/consolePanel.js missing — run `npm run compile` before this test",
    );
  }

  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-console"></div>';
  const root = document.getElementById("vsdb-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api = {
    postMessage: (msg: unknown) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (
    globalThis as unknown as { acquireVsCodeApi: () => typeof api }
  ).acquireVsCodeApi = () => api;

  (0, eval)(bundleSrc);

  return { received, root };
}

function dispatchHost(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function seedStateMessage(): Record<string, unknown> {
  // Two tabs, each with a different buffer so test #10/#12 can prove the
  // bundle switches the active editor on a `switchTab` host event.
  return {
    type: "state",
    tabs: [
      { id: "tab-A", name: "alpha", active: true, buffer: "SELECT 1;" },
      { id: "tab-B", name: "beta", active: false, buffer: "SELECT 2;" },
    ],
    history: [],
  };
}

describeIfBundle(
  "webview/consolePanelMain.ts bundle (TASK-AF-004 console v2)",
  () => {
    // #4 — runSelection sends exactly the selection text.
    itIfBundle(
      "4. runSelection posts { type: 'runSelection', text } with the editor selection verbatim",
      async () => {
        const { received } = loadBundle();
        dispatchHost(seedStateMessage());
        await flush();

        const editor = document.getElementById(
          "consoleSqlEditor",
        ) as HTMLTextAreaElement | null;
        expect(editor).toBeTruthy();
        editor!.value = "SELECT alpha FROM t WHERE id = 1;";
        editor!.setSelectionRange(7, 25); // "alpha FROM t WHERE"
        editor!.dispatchEvent(new Event("input", { bubbles: true }));
        editor!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await flush();

        const selMsgs = received.filter((m) => m.type === "runSelection");
        expect(selMsgs.length).toBe(1);
        expect(selMsgs[0].text).toBe("alpha FROM t WHERE");
      },
    );

    // #10 — Format round-trip: webview sends `format` → host replies with
    // a `state` carrying the formatted buffer → active buffer is replaced.
    itIfBundle(
      "10. format round-trip: webview `format` message → host reply → buffer replaced",
      async () => {
        const { received } = loadBundle();
        dispatchHost(seedStateMessage());
        await flush();

        const fmtBtn = document.getElementById(
          "consoleFormatBtn",
        ) as HTMLButtonElement | null;
        expect(fmtBtn).toBeTruthy();
        fmtBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();

        const fmtMsgs = received.filter((m) => m.type === "format");
        expect(fmtMsgs.length).toBe(1);

        // Host replies with a state carrying the formatted buffer.
        dispatchHost({
          type: "state",
          tabs: [
            {
              id: "tab-A",
              name: "alpha",
              active: true,
              buffer: "SELECT\n  formatted;\n",
            },
            { id: "tab-B", name: "beta", active: false, buffer: "SELECT 2;" },
          ],
          history: [],
        });
        await flush();

        const editor = document.getElementById(
          "consoleSqlEditor",
        ) as HTMLTextAreaElement | null;
        expect(editor!.value).toBe("SELECT\n  formatted;\n");
      },
    );

    // #11 — Format on empty buffer is a no-op.
    itIfBundle(
      "11. format on empty buffer: no outgoing format message, no error surfaced",
      async () => {
        const { received } = loadBundle();
        dispatchHost({
          type: "state",
          tabs: [
            { id: "tab-A", name: "alpha", active: true, buffer: "" },
            { id: "tab-B", name: "beta", active: false, buffer: "" },
          ],
          history: [],
        });
        await flush();

        const fmtBtn = document.getElementById(
          "consoleFormatBtn",
        ) as HTMLButtonElement | null;
        expect(fmtBtn).toBeTruthy();
        fmtBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();

        const fmtMsgs = received.filter((m) => m.type === "format");
        expect(fmtMsgs.length).toBe(0);

        const editor = document.getElementById(
          "consoleSqlEditor",
        ) as HTMLTextAreaElement | null;
        expect(editor!.value).toBe("");
      },
    );

    // #12 — regression: existing single-tab surface + new tab bar still wires.
    itIfBundle(
      "12. regression: existing runConsole/saveConsoleAsSql still post; tab bar renders with the active class on the active tab",
      async () => {
        const { received } = loadBundle();
        dispatchHost(seedStateMessage());
        await flush();

        // Tab bar shows one node per tab.
        const tabNodes = document.querySelectorAll(".vsdb-console-tab");
        expect(tabNodes.length).toBe(2);
        const activeTab = document.querySelector(
          ".vsdb-console-tab.vsdb-console-tab-active",
        );
        expect(activeTab).toBeTruthy();
        expect(activeTab!.textContent).toContain("alpha");

        // runConsole still routes through the toolbar button.
        const editor = document.getElementById(
          "consoleSqlEditor",
        ) as HTMLTextAreaElement | null;
        editor!.value = "SELECT 99;";
        editor!.dispatchEvent(new Event("input", { bubbles: true }));
        const runBtn = document.getElementById(
          "consoleRunBtn",
        ) as HTMLButtonElement | null;
        expect(runBtn).toBeTruthy();
        runBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
        const runMsgs = received.filter((m) => m.type === "runConsole");
        expect(runMsgs.length).toBe(1);
        expect(runMsgs[0].sql).toBe("SELECT 99;");

        // saveConsoleAsSql still routes through the save button.
        const saveBtn = document.getElementById(
          "consoleSaveBtn",
        ) as HTMLButtonElement | null;
        saveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
        const saveMsgs = received.filter(
          (m) => m.type === "saveConsoleAsSql",
        );
        expect(saveMsgs.length).toBe(1);
        expect(saveMsgs[0].sql).toBe("SELECT 99;");

        // Clicking a non-active tab fires a switchTab message carrying that id.
        const tabB = Array.from(tabNodes).find(
          (n) => n.textContent && n.textContent.includes("beta"),
        );
        expect(tabB).toBeTruthy();
        tabB!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
        const switchMsgs = received.filter((m) => m.type === "switchTab");
        expect(switchMsgs.length).toBe(1);
        expect(switchMsgs[0].tabId).toBe("tab-B");
      },
    );
  },
);
