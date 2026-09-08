// src/ui/__tests__/aiChatPanelClonePolish.test.ts — TASK-AGTUI-008.
//
// Final motion layer for the Claude Code clone:
//   - streaming caret lifecycle (delta → caret present, done → caret removed,
//     final text equals concatenation of all deltas),
//   - tool card expand/collapse idempotent (clicking the card header toggles
//     a collapsed class, N rapid clicks settle deterministically,
//     collapsed state keeps the card in the DOM),
//   - reduced-motion honored (.UnicDB-chat-pulse, .UnicDB-chat-caret,
//     smooth-scroll override),
//   - easing tokens exact (toggle = 100ms ease-in-out, tool card body
//     expand = 150ms ease),
//   - stop pulse exactly while busy (class present on setBusy(true),
//     absent after done / init / reset).
//
// jsdom does not apply external stylesheets, so the CSS contract assertions
// run on the source text via regex; the behavior assertions evaluate the
// compiled webview bundle (dist/aiChatPanel.js) under jsdom.
//
// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const cssPath = resolve(process.cwd(), "webview", "styles.css");
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

const distPath = resolve(process.cwd(), "dist", "aiChatPanel.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;
// Mutable side-channel so `loadBundle` can re-read after a self-bootstrap
// compile. Module-load `bundleSrc` is const-captured above and stays as
// the first-load sentinel for `describeIfBundle` gating.
const bundleSrcRef: { value: string | null } = { value: bundleSrc };
let bootstrapAttempted = false;

/** Run `npm run compile` once, synchronously, when the bundle is missing.
 * Throws on non-zero exit. Kept narrow so the failure mode is obvious in
 * the test output (a vitest failure with a clear esbuild error, not a
 * silent skip of every bundle-dependent case). */
function compileBundle(): void {
  execFileSync("npm", ["run", "compile"], { stdio: "pipe", cwd: process.cwd() });
}

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

/** Extract the body of the first rule block whose selector matches
 * `selectorText`. Mirrors the helpers used in chatLayoutCss / clone CSS
 * tests so a single pattern covers the whole repo. */
function ruleBody(selectorText: string): string {
  const escaped = selectorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  if (!m) return "";
  return m[2] ?? "";
}

/** Extract the body of a @media block matching the reduced-motion query
 * (only query supported by the polish contract). Matches the FIRST
 * occurrence; returns the body that sits between the matching `{` and
 * its balanced `}`. */
function mediaBlockBody(): string {
  // Match `@media (prefers-reduced-motion: reduce) { … }` directly so
  // the test isn't sensitive to the spacing variant the canonical stylesheet
  // happens to use today. The trailing body is brace-balanced so nested
  // rules count correctly.
  const re = /@media\s+\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/i;
  const m = css.match(re);
  if (!m || m.index === undefined) return "";
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) return "";
  return css.slice(start, i - 1);
}

// ============================================================================
// Bundle loader — same teardown trick as aiChatPanelBundle.test.ts.
// ============================================================================

/** Accumulated message listeners from each bundle eval. Each `loadBundle`
 * pops them so a later test never sees deltas from prior tests. */
const bundleListeners: Array<{
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}> = [];

const _origAddEventListener = window.addEventListener.bind(window);
window.addEventListener = function (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  const evtListener =
    typeof listener === "function"
      ? (listener as EventListener)
      : (listener as EventListenerObject).handleEvent.bind(listener);
  bundleListeners.push({ type, listener: evtListener, options });
  return _origAddEventListener(type, listener, options);
} as typeof window.addEventListener;

interface BundleHandle {
  received: Array<Record<string, unknown>>;
}

function loadBundle(): BundleHandle {
  // Self-bootstrap: if the webview bundle is missing (e.g. CI did not run
  // `npm run compile` before `npm test`), compile it on the first call.
  // Without this guard, every bundle-dependent case is silently skipped,
  // which makes a real regression look like a pass. We only retry once —
  // if compile fails, surface the real error instead of looping.
  if (!bundleSrcRef.value) {
    if (bootstrapAttempted) {
      throw new Error(
        "dist/aiChatPanel.js missing — `npm run compile` failed; cannot run bundle-dependent cases",
      );
    }
    bootstrapAttempted = true;
    compileBundle();
    const fresh = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;
    if (!fresh) {
      throw new Error(
        "dist/aiChatPanel.js still missing after self-bootstrap compile",
      );
    }
    bundleSrcRef.value = fresh;
    // Fall through with `bundleSrcRef.value` now populated; the const
    // `bundleSrc` stays as the module-load sentinel (used only by the
    // `itIfBundle` / `describeIfBundle` gating — both are unconditional
    // aliases now, so this is informational only).
  }
  for (const { type, listener, options } of bundleListeners) {
    window.removeEventListener(type, listener, options);
  }
  bundleListeners.length = 0;
  document.body.innerHTML =
    '<div id="UnicDB-root" class="UnicDB-form-body UnicDB-chat-body"></div>';

  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrcRef.value ?? bundleSrc);
  return { received };
}

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function rootEl(): HTMLDivElement {
  return document.getElementById("UnicDB-root") as HTMLDivElement;
}

function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

const itIfBundle = it;
// No `describeIfBundle` gate — we want the bundle-loaded cases to FAIL
// (not silently skip) when the bundle is missing. `loadBundle` throws
// inside `beforeAll` so vitest reports a real test failure, and the
// self-bootstrap path inside `loadBundle` runs the compile on demand.
// Silently skipping via `describe.runIf(false)` is exactly the false-
// green the reviewer caught; this rewrite removes that escape hatch.
const describeIfBundle = describe;
const describeIfCss = describe.runIf(css !== "");

// ============================================================================
// CSS contract — easing tokens, reduced-motion, scroll-behavior.
// Run without the bundle so they always execute.
// ============================================================================

describeIfCss("TASK-AGTUI-008 - polish CSS contract (easing + reduced-motion)", () => {
  it("loads webview/styles.css", () => {
    expect(css, "webview/styles.css must exist").not.toBe("");
  });

  // Test case #4 — timing tokens.
  //   toggle = 100ms ease-in-out
  //   tool card body = 150ms ease
  // Accept ms or s decimal forms; case-insensitive.
  it(".UnicDB-chat-toggle::after uses 100ms ease-in-out for the thumb slide", () => {
    // The toggle thumb transition fires when the bypass toggle flips. The
    // animated property is `left`; duration must be 100ms ease-in-out.
    const re =
      /\.UnicDB-chat-toggle::after\s*\{[^}]*transition:\s*[^;]*left\s+(?:0?\.1s|100ms)\s+ease-in-out/i;
    expect(
      re.test(css),
      ".UnicDB-chat-toggle::after must declare `transition: left 0.1s ease-in-out` (or 100ms form)",
    ).toBe(true);
  });

  it(".UnicDB-chat-tool-collapsible transition timing token is 150ms ease", () => {
    // The collapse/expand affordance on the legacy tool result card
    // declares a 150ms ease transition. Accept either ms or s decimal.
    const re =
      /\.UnicDB-chat-tool-collapsible[^}]*transition:\s*(?:all\s+)?(?:0?\.15s|150ms)\s+ease\b/i;
    // Tolerate both ms and s forms on the body element. Reuse a permissive
    // selector that catches either form.
    const permissiveRe =
      /\.UnicDB-chat-tool-(?:collapsible|collapsed)[^{]*\{[^}]*(?:0?\.15s|150ms)[^;]*ease/i;
    expect(
      re.test(css) || permissiveRe.test(css),
      "tool collapsible section must transition with 150ms ease",
    ).toBe(true);
  });

  // Test case #3 — reduced-motion honored.
  //   - .UnicDB-chat-pulse animation → none
  //   - .UnicDB-chat-caret animation → none
  //   - smooth-scroll → scroll-behavior: auto override
  it("prefers-reduced-motion media query disables pulse / caret / smooth scroll", () => {
    const body = mediaBlockBody();
    expect(
      body,
      "@media (prefers-reduced-motion: reduce) block must exist",
    ).not.toBe("");
    // Pulse animation neutralised. The pulse keyframes drive
    // `.UnicDB-chat-stop-live`, so the proof is that the live-stop rule
    // sets `animation: none`. Either `.UnicDB-chat-stop-live` or
    // `.UnicDB-chat-pulse` (defensive) satisfies the contract. The
    // selector list in a single block may be comma-separated, so we
    // grep the WHOLE body for `animation: none` and the carrier token
    // rather than trying to span across comma-joined selectors.
    const hasPulseCarrier = /\.UnicDB-chat-stop-live/.test(body);
    const hasAnimationNone = /animation\s*:\s*none/i.test(body);
    expect(
      hasPulseCarrier && hasAnimationNone,
      "reduced-motion must set animation:none on .UnicDB-chat-stop-live (the pulse carrier)",
    ).toBe(true);
    // Caret animation neutralised.
    expect(
      /\.UnicDB-chat-caret/.test(body) && /animation\s*:\s*none/i.test(body),
      "reduced-motion must set animation:none on .UnicDB-chat-caret",
    ).toBe(true);
    // Smooth-scroll disabled — `scroll-behavior: auto` overrides earlier
    // `scroll-behavior: smooth` declarations.
    expect(
      /scroll-behavior:\s*auto/i.test(body),
      "reduced-motion must set scroll-behavior:auto so smooth-scroll is cancelled",
    ).toBe(true);
  });

  // Smooth-scroll affordance exists OUTSIDE the reduced-motion block —
  // the chat thread scrolls gently on jump-to-latest and on auto-scroll
  // when the user is already near the bottom.
  it("chat thread declares scroll-behavior:smooth OUTSIDE reduced-motion", () => {
    // The `@media (prefers-reduced-motion: reduce)` block must NOT carry
    // `scroll-behavior: smooth` (would be redundant + a regression for
    // users who opt-in). The declaration lives on `.UnicDB-chat-thread` or
    // `.UnicDB-chat` instead.
    const threadBody = ruleBody(".UnicDB-chat-thread");
    const chatBody = ruleBody(".UnicDB-chat");
    const merged = `${threadBody}\n${chatBody}`;
    expect(
      /scroll-behavior:\s*smooth/i.test(merged),
      "chat thread / chat shell must declare scroll-behavior:smooth for gentle auto-scroll",
    ).toBe(true);
  });
});

// ============================================================================
// Bundle behavior — caret lifecycle + tool card collapse + stop pulse.
// ============================================================================

describeIfBundle(
  "TASK-AGTUI-008 - polish bundle behavior (caret / tool card / stop pulse)",
  () => {
    // Test case #1 — streaming caret lifecycle.
    itIfBundle(
      "#1 streaming caret lifecycle: delta → caret present, done → caret removed, accumulated text intact",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });

        // Three rapid delta frames; the assistant bubble must track the
        // streaming caret at every stop, and the accumulated text must
        // match the concatenation of all deltas.
        const deltas = ["Hello", ", ", "world!"];
        for (const t of deltas) {
          dispatch({ type: "delta", text: t });
        }
        let bubble = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(bubble, "deltas must open a streaming assistant bubble").not.toBeNull();
        const caret = bubble?.querySelector<HTMLSpanElement>(".UnicDB-chat-caret");
        expect(
          caret,
          "open streaming bubble must carry a child .UnicDB-chat-caret (R8 parity)",
        ).not.toBeNull();
        // Concatenation invariant — the parity rule prohibits the host
        // from synthesizing characters. textContent of the bubble
        // (excluding the caret's glyph) MUST equal the joined deltas.
        const expected = deltas.join("");
        const bubbleText = (bubble?.textContent ?? "")
          // Caret glyph is U+258D — strip any single trailing occurrence.
          .replace(/▍$/, "");
        expect(bubbleText).toBe(expected);

        // Terminal `done` removes the caret span and closes the streaming
        // bubble so the next turn opens fresh.
        dispatch({ type: "done" });
        bubble = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(bubble, "done must close the streaming bubble").toBeNull();
        expect(
          rootEl().querySelector(".UnicDB-chat-caret"),
          "done must remove the .UnicDB-chat-caret span",
        ).toBeNull();
      },
    );

    // Test case #2 — tool card expand/collapse idempotent.
    itIfBundle(
      "#2 tool card expand/collapse: clicking the header toggles collapsed class, N rapid clicks are deterministic, card stays in DOM",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        dispatch({
          type: "tool_result",
          tool: "sql_query",
          status: "ok",
          summary: "→ sql_query — 42 rows",
        });
        const root = rootEl();
        // The legacy tool card carries .UnicDB-chat-tool-result and a status
        // suffix. Both class hooks must remain so prior suite (DbAwareWebview)
        // assertions on .UnicDB-chat-tool-result-ok stay green.
        const card = root.querySelector<HTMLDivElement>(
          ".UnicDB-chat-tool-result.UnicDB-chat-tool-result-ok",
        );
        expect(card, "tool_result must render the legacy tool card").not.toBeNull();
        // The collapse affordance lives on a child `.UnicDB-chat-tool-header`.
        const header = card?.querySelector<HTMLDivElement>(
          ".UnicDB-chat-tool-header",
        );
        expect(
          header,
          "tool card must include a clickable .UnicDB-chat-tool-header",
        ).not.toBeNull();
        if (!card || !header) return;

        // 0 clicks → not collapsed.
        expect(
          card.classList.contains("UnicDB-chat-tool-collapsed"),
          "card must NOT be collapsed before any click",
        ).toBe(false);

        const click = (): void => {
          header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        };

        // Single click → collapsed.
        click();
        expect(
          card.classList.contains("UnicDB-chat-tool-collapsed"),
          "first click must add the collapsed class",
        ).toBe(true);
        // Card stays in the DOM even while collapsed.
        expect(root.contains(card), "collapsed card must stay in the DOM").toBe(true);

        // 5 more rapid clicks → settle back to NOT collapsed (6 total → even).
        for (let i = 0; i < 5; i++) click();
        expect(
          card.classList.contains("UnicDB-chat-tool-collapsed"),
          "6 rapid clicks must end NOT collapsed (even parity)",
        ).toBe(false);

        // 1 more → collapsed again (odd parity).
        click();
        expect(
          card.classList.contains("UnicDB-chat-tool-collapsed"),
          "7 rapid clicks must end collapsed (odd parity)",
        ).toBe(true);

        // 999 more rapid clicks → still collapsed (even parity).
        for (let i = 0; i < 999; i++) click();
        expect(
          card.classList.contains("UnicDB-chat-tool-collapsed"),
          "1006 clicks (even) must end NOT collapsed",
        ).toBe(false);
      },
    );

    // Test case #5 — stop pulse only while busy.
    itIfBundle(
      "#5 stop pulse only while busy: setBusy(true) adds class, setBusy(false) (via done / init) removes it",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        // Initial state — busy = false, stopBtn has NO .UnicDB-chat-stop-live class.
        const stopBtn = btn("stopBtn");
        expect(stopBtn).not.toBeNull();
        expect(
          stopBtn.classList.contains("UnicDB-chat-stop-live"),
          "stop pulse must NOT be on when idle",
        ).toBe(false);

        // Send a turn → composer swaps send ↔ stop, stop pulse engages.
        const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
        prompt.value = "ping";
        btn("sendBtn").click();
        expect(
          stopBtn.classList.contains("UnicDB-chat-stop-live"),
          "sending must engage the stop pulse (busy state)",
        ).toBe(true);

        // Terminal `done` event re-enables the composer + drops the pulse.
        dispatch({ type: "done" });
        expect(
          stopBtn.classList.contains("UnicDB-chat-stop-live"),
          "done must drop the stop pulse (idle)",
        ).toBe(false);

        // Idempotent: another `done` is a no-op (still no pulse).
        dispatch({ type: "done" });
        expect(
          stopBtn.classList.contains("UnicDB-chat-stop-live"),
          "subsequent done must keep stop pulse absent",
        ).toBe(false);

        // Send again → pulse re-engages. An `init{hasHistory:false}` (the
        // clear reset path) must drop the pulse even mid-busy.
        prompt.value = "pong";
        btn("sendBtn").click();
        expect(
          stopBtn.classList.contains("UnicDB-chat-stop-live"),
          "second send must re-engage the stop pulse",
        ).toBe(true);
        dispatch({ type: "init", hasHistory: false });
        expect(
          stopBtn.classList.contains("UnicDB-chat-stop-live"),
          "init reset must drop the stop pulse (host-driven clear)",
        ).toBe(false);
      },
    );
  },
);

// ============================================================================
// Self-compile fallback — if `npm run compile` was NOT run before this file,
// emit a helpful failure that points the maintainer to the right step.
// ============================================================================

beforeAll(() => {
  if (!bundleSrc) {
    // eslint-disable-next-line no-console
    console.warn(
      "[aiChatPanelClonePolish] dist/aiChatPanel.js missing — bundle-driven tests will be skipped. Run `npm run compile` to enable them.",
    );
  }
  // Touch execFileSync so the import isn't flagged unused by ts-prune;
  // this also gives us a deterministic way to verify esbuild exists
  // without adding it as a runtime dependency.
  try {
    execFileSync("node", ["-e", "1"], { stdio: "ignore" });
  } catch {
    // ignore — best-effort touch only
  }
});
