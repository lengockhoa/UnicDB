// src/ui/__tests__/connectionFormManualCommitBundle.test.ts
// TASK-001 — jsdom bundle test for webview/connectionFormMain.ts: the
// manual-commit checkbox in the REAL compiled bundle (dist/connectionForm.js).
//
// Covers the task's Test Cases at the webview layer:
//   - #1 happy: checked add-form Save posts {type:"submit", manualCommit:true}.
//   - #2 edge/default: untouched form posts exactly manualCommit:false (never
//     omitted/undefined) so the persisted config is always explicit.
//   - #3 regression: init(existing.manualCommit===true) prechecks the box and
//     Save retains true; a legacy config omitting the optional field stays
//     unchecked, remains editable, and saves explicit false.
//   - #4 protocol symmetry: Test from a checked form posts
//     {type:"test", manualCommit:true}.
//
// IMPORTANT: run `npm run compile` BEFORE this test — it evaluates
// dist/connectionForm.js (see TASK-001 §Verification Commands). If missing,
// the suite is skipped with an explanatory message.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

const distPath = resolve(process.cwd(), "dist", "connectionForm.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface BundleHandle {
  received: Array<Record<string, unknown>>;
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/connectionForm.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML =
    '<div id="UnicDB-root" class="UnicDB-form-body"><div class="UnicDB-form-loading">Loading…</div></div>';
  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;
  (0, eval)(bundleSrc);
  return { received };
}

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function inputEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function checkbox(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}
/** Fill only the required (*) fields — port/host defaults come from markup. */
function fillRequired(): void {
  inputEl("name").value = "Local Dev";
  inputEl("user").value = "app";
  inputEl("database").value = "appdb";
}
function lastOf(
  received: Array<Record<string, unknown>>,
  type: string,
): Record<string, unknown> | undefined {
  const hits = received.filter((m) => m.type === type);
  return hits[hits.length - 1];
}

function baseExisting(manualCommit?: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    id: "pg-1",
    name: "Prod PG",
    driver: "postgres",
    host: "db.example.com",
    port: 5432,
    user: "app",
    database: "appdb",
    sslMode: "disable",
  };
  if (manualCommit !== undefined) cfg.manualCommit = manualCommit;
  return cfg;
}

describeIfBundle("webview/connectionFormMain.ts bundle — manualCommit (TASK-001)", () => {
  it("#1 checked add-form Save posts {type:'submit', manualCommit:true}", () => {
    const { received } = loadBundle();
    const root = document.getElementById("UnicDB-root") as HTMLElement;
    // The form visibly renders the checkbox control.
    const box = root.querySelector<HTMLInputElement>("#manualCommit");
    expect(box).not.toBeNull();
    expect(box!.type).toBe("checkbox");

    fillRequired();
    checkbox("manualCommit").checked = true;
    btn("saveBtn").click();

    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect(submit!.type).toBe("submit");
    expect(submit!.manualCommit).toBe(true);
    expect(typeof submit!.manualCommit).toBe("boolean");
    // Required fields travel alongside (form integrity while we're here).
    expect(submit!.name).toBe("Local Dev");
    expect(submit!.database).toBe("appdb");
  });

  it("#2 untouched add-form Save posts exactly manualCommit:false (boolean, never omitted)", () => {
    const { received } = loadBundle();
    fillRequired();
    // Checkbox is left alone (unchecked default).
    expect(checkbox("manualCommit").checked).toBe(false);
    btn("saveBtn").click();

    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect("manualCommit" in submit!).toBe(true);
    expect(submit!.manualCommit).toBe(false);
  });

  it("#3a edit init with existing.manualCommit=true prechecks and Save retains true", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", existing: baseExisting(true) });
    expect(document.getElementById("formTitle")!.textContent).toContain("Prod PG");
    expect(checkbox("manualCommit").checked).toBe(true);
    btn("saveBtn").click();
    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect(submit!.manualCommit).toBe(true);
  });

  it("#3b legacy config without manualCommit initializes unchecked, editable, saves false", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", existing: baseExisting() });
    expect(checkbox("manualCommit").checked).toBe(false);
    // Legacy record stays editable — prefilled fields survive intact.
    expect(inputEl("name").value).toBe("Prod PG");
    expect(inputEl("host").value).toBe("db.example.com");
    expect(inputEl("port").value).toBe("5432");
    btn("saveBtn").click();
    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect("manualCommit" in submit!).toBe(true);
    expect(submit!.manualCommit).toBe(false);
  });

  it("#4 Test from a checked form posts {type:'test', manualCommit:true}", () => {
    const { received } = loadBundle();
    fillRequired();
    checkbox("manualCommit").checked = true;
    btn("testBtn").click();
    const test = lastOf(received, "test");
    expect(test).toBeDefined();
    expect(test!.type).toBe("test");
    expect(test!.manualCommit).toBe(true);
  });
});
