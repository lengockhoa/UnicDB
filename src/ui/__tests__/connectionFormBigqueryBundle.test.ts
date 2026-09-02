// src/ui/__tests__/connectionFormBigqueryBundle.test.ts
// TASK-BQ01-004 — jsdom bundle test for webview/connectionFormMain.ts: the
// BigQuery field group, SQL-only field hiding, submit gating, and verbatim
// ADC remediation rendering in the REAL compiled bundle (dist/connectionForm.js).
//
// Covers the task's Test Cases at the webview layer:
//   - #1 happy/render: driver="bigquery" renders billingProject / bqLocation /
//       bqMaxBytesBilled inputs and HIDES host/port/password/SSL block.
//   - #2 edge/gate: billingProject empty Save posts NO {type:"submit"} and
//       status element carries an inline error naming the billing project;
//       same for bqMaxBytesBilled:"0".
//   - #3 edge/copy-safe: testResult.message with the verbatim ADC remediation
//       copy renders exactly into the status node — no concatenation with
//       user input.
//   - #4 regression: driver="postgres" keeps host/port/user/password/SSL
//       rendered and BQ group absent.
//   - #5 wire symmetry: Test from a filled BQ form posts
//       {type:"test", billingProject:"proj-billing", bqLocation:"EU",
//        bqMaxBytesBilled:"1000000", ...}; empty fields post "" (never
//        omitted/undefined).
//
// IMPORTANT: run `npm run compile` BEFORE this test — it evaluates
// dist/connectionForm.js. If missing, the suite is skipped with an
// explanatory message.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface VsdbApi {
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
    '<div id="vsdb-root" class="vsdb-form-body"><div class="vsdb-form-loading">Loading…</div></div>';
  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
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
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}
function statusEl(): HTMLElement {
  return document.getElementById("status") as HTMLElement;
}
function lastOf(
  received: Array<Record<string, unknown>>,
  type: string,
): Record<string, unknown> | undefined {
  const hits = received.filter((m) => m.type === type);
  return hits[hits.length - 1];
}
function has(received: Array<Record<string, unknown>>, type: string): boolean {
  return received.some((m) => m.type === type);
}

/** Fixed remediation copy (BQ-00 REMEDIATION.missing_adc) — verbatim, never interpolated. */
const FIXED_ADC_REMEDIATION =
  "Application Default Credentials not found. Run: gcloud auth application-default login";

describeIfBundle("webview/connectionFormMain.ts bundle — BigQuery field group + submit gate (TASK-BQ01-004)", () => {
  // -----------------------------------------------------------------------
  // #1 — Render: driver=bigquery shows BQ group, hides SQL-only fields.
  // -----------------------------------------------------------------------
  it("#1 bigquery driver renders BQ group, hides host/port/password/SSL", () => {
    loadBundle();
    const root = document.getElementById("vsdb-root") as HTMLElement;

    // Switch driver to bigquery.
    const driver = document.getElementById("driver") as HTMLSelectElement;
    expect(driver).not.toBeNull();
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));

    // BQ group inputs render and the BQ container is visible.
    expect(root.querySelector("#billingProject")).not.toBeNull();
    expect(root.querySelector("#bqLocation")).not.toBeNull();
    expect(root.querySelector("#bqMaxBytesBilled")).not.toBeNull();
    const bqContainer = document.getElementById("bqFields") as HTMLElement;
    expect(bqContainer).not.toBeNull();

    // SQL-only fields' CONTAINER is REMOVED from DOM for bigquery (the
    // structural "render ONLY" guarantee). Host/port/user/password/SSL
    // inputs are nested under that container so they're gone too.
    expect(document.getElementById("sqlFields")).toBeNull();
    expect(document.getElementById("host")).toBeNull();
    expect(document.getElementById("port")).toBeNull();
    expect(document.getElementById("password")).toBeNull();
    expect(document.getElementById("useSsl")).toBeNull();
    expect(document.getElementById("sslPanel")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // #2a — Submit gate: empty billingProject blocks Save with inline status.
  // -----------------------------------------------------------------------
  it("#2a empty billingProject blocks Save (no submit posted) with inline error", () => {
    const { received } = loadBundle();
    const driver = document.getElementById("driver") as HTMLSelectElement;
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));

    // Fill BQ form EXCEPT billingProject.
    inputEl("name").value = "BQ Dev";
    inputEl("bqLocation").value = "EU";
    inputEl("bqMaxBytesBilled").value = "1000000";
    // billingProject left blank.

    btn("saveBtn").click();

    // No submit message posted.
    expect(has(received, "submit")).toBe(false);
    // Status element carries an inline error naming the billing project.
    const status = statusEl();
    expect(status.className).toContain("err");
    expect(status.textContent).toMatch(/billing\s*project/i);
    expect(status.textContent).not.toContain("undefined");
  });

  // -----------------------------------------------------------------------
  // #2b — Submit gate: invalid maxBytesBilled blocks Save.
  // -----------------------------------------------------------------------
  it("#2b invalid bqMaxBytesBilled blocks Save with inline error", () => {
    const { received } = loadBundle();
    const driver = document.getElementById("driver") as HTMLSelectElement;
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));

    inputEl("name").value = "BQ Dev";
    inputEl("billingProject").value = "proj-billing";
    inputEl("bqLocation").value = "EU";
    inputEl("bqMaxBytesBilled").value = "0";

    btn("saveBtn").click();

    expect(has(received, "submit")).toBe(false);
    const status = statusEl();
    expect(status.className).toContain("err");
    expect(status.textContent).toMatch(/max\s*bytes\s*billed/i);
  });

  // -----------------------------------------------------------------------
  // #3 — Copy-safe: ADC remediation renders verbatim, never concatenated.
  // -----------------------------------------------------------------------
  it("#3 ADC remediation renders verbatim into status, never concatenated", () => {
    const { received } = loadBundle();
    // User types into BQ fields that share names with the remediation copy
    // substrings — verifies no concatenation by reading the status textContent
    // and asserting exact equality with the fixed remediation string.
    const driver = document.getElementById("driver") as HTMLSelectElement;
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));
    inputEl("name").value = "gcloud auth application-default login"; // hostile string
    inputEl("billingProject").value = "proj-evil";
    inputEl("bqLocation").value = "EU";
    inputEl("bqMaxBytesBilled").value = "1000000";

    // Host posts testResult with the BQ-00 fixed remediation copy verbatim.
    dispatch({
      type: "testResult",
      ok: false,
      message: FIXED_ADC_REMEDIATION,
    });

    const status = statusEl();
    expect(status.className).toContain("err");
    // Verbatim: status.textContent equals the fixed remediation EXACTLY
    // (no user input concatenated). The hostile "gcloud auth..." string
    // typed into name MUST NOT appear inside the status text.
    expect(status.textContent).toBe(FIXED_ADC_REMEDIATION);
    expect(status.textContent).not.toContain("proj-evil");
    expect(status.textContent).not.toContain("undefined");
  });

  // -----------------------------------------------------------------------
  // #4 — Regression: postgres keeps host/port/user/password/SSL and NO BQ
  //      group.
  // -----------------------------------------------------------------------
  it("#4 postgres driver keeps SQL fields rendered and BQ group hidden", () => {
    loadBundle();
    const root = document.getElementById("vsdb-root") as HTMLElement;
    // Default driver is postgres on first render.
    const driver = document.getElementById("driver") as HTMLSelectElement;
    expect(driver.value).toBe("postgres");

    // SQL fields rendered.
    expect(root.querySelector("#host")).not.toBeNull();
    expect(root.querySelector("#port")).not.toBeNull();
    expect(root.querySelector("#user")).not.toBeNull();
    expect(root.querySelector("#password")).not.toBeNull();
    expect(root.querySelector("#useSsl")).not.toBeNull();
    // BQ group hidden / not rendered for postgres.
    expect(root.querySelector("#billingProject")).toBeNull();
    expect(root.querySelector("#bqLocation")).toBeNull();
    expect(root.querySelector("#bqMaxBytesBilled")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // #5 — Wire symmetry: Test from a filled BQ form posts the three new
  //      fields with "" when empty (never omitted/undefined).
  // -----------------------------------------------------------------------
  it("#5a Test from filled BQ form posts billingProject/bqLocation/bqMaxBytesBilled", () => {
    const { received } = loadBundle();
    const driver = document.getElementById("driver") as HTMLSelectElement;
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));

    inputEl("name").value = "BQ Dev";
    inputEl("billingProject").value = "proj-billing";
    inputEl("bqLocation").value = "EU";
    inputEl("bqMaxBytesBilled").value = "1000000";

    btn("testBtn").click();
    const test = lastOf(received, "test");
    expect(test).toBeDefined();
    expect(test!.billingProject).toBe("proj-billing");
    expect(test!.bqLocation).toBe("EU");
    expect(test!.bqMaxBytesBilled).toBe("1000000");
  });

  it("#5b Test from partial BQ form posts empty strings (never omitted/undefined)", () => {
    const { received } = loadBundle();
    const driver = document.getElementById("driver") as HTMLSelectElement;
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));

    inputEl("name").value = "BQ Dev";
    inputEl("billingProject").value = "proj-billing";
    // bqLocation + bqMaxBytesBilled left blank intentionally.

    btn("testBtn").click();
    const test = lastOf(received, "test");
    expect(test).toBeDefined();
    expect("billingProject" in test!).toBe(true);
    expect("bqLocation" in test!).toBe(true);
    expect("bqMaxBytesBilled" in test!).toBe(true);
    expect(test!.billingProject).toBe("proj-billing");
    expect(test!.bqLocation).toBe("");
    expect(test!.bqMaxBytesBilled).toBe("");
    // Type check: never undefined.
    expect(typeof test!.bqLocation).toBe("string");
    expect(typeof test!.bqMaxBytesBilled).toBe("string");
  });

  it("#5c Submit from a valid bigquery form posts the three new fields", () => {
    const { received } = loadBundle();
    const driver = document.getElementById("driver") as HTMLSelectElement;
    driver.value = "bigquery";
    driver.dispatchEvent(new Event("change"));

    inputEl("name").value = "BQ Dev";
    inputEl("billingProject").value = "proj-billing";
    inputEl("bqLocation").value = "US";
    inputEl("bqMaxBytesBilled").value = "2000000";

    btn("saveBtn").click();
    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect(submit!.billingProject).toBe("proj-billing");
    expect(submit!.bqLocation).toBe("US");
    expect(submit!.bqMaxBytesBilled).toBe("2000000");
    // host/port still ride the wire (TASK-001 symmetric protocol).
    // For bigquery the inputs are absent → empty string values.
    expect(submit!.driver).toBe("bigquery");
  });

  // -----------------------------------------------------------------------
  // #6 — Edit-open regression: opening an existing SQL connection with a
  //      custom port must NOT clobber the stored port with the driver
  //      default. Previously updateDriverVisibility() unconditionally set
  //      port = DRIVER_PORTS[driver] on every call (including the one
  //      triggered by applyInit), which silently overwrote mysql:6544 etc.
  // -----------------------------------------------------------------------
  it("#6 edit-open with custom SQL port preserves the stored port (no clobber)", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      existing: {
        id: "mysql-1",
        name: "Prod MySQL",
        driver: "mysql",
        host: "db.example.com",
        port: 6544,
        user: "app",
        database: "appdb",
        sslMode: "disable",
      },
    });
    // Port input must still carry the stored custom value, not the mysql
    // driver default (3306) that updateDriverVisibility() would clobber.
    expect(inputEl("port").value).toBe("6544");
    // Submit posts the preserved port.
    btn("saveBtn").click();
    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect(submit!.port).toBe(6544);
    expect(submit!.driver).toBe("mysql");
    expect(submit!.host).toBe("db.example.com");
  });

  // -----------------------------------------------------------------------
  // #6b — Edit-open regression for mssql custom port (1434, instance
  //      endpoint — also commonly customized). Same gate must hold.
  // -----------------------------------------------------------------------
  it("#6b edit-open with custom mssql port preserves the stored port", () => {
    const { received } = loadBundle();
    dispatch({
      type: "init",
      existing: {
        id: "mssql-1",
        name: "Prod MSSQL",
        driver: "mssql",
        host: "sql.example.com",
        port: 1434,
        user: "sa",
        database: "master",
        sslMode: "disable",
      },
    });
    expect(inputEl("port").value).toBe("1434");
    btn("saveBtn").click();
    const submit = lastOf(received, "submit");
    expect(submit).toBeDefined();
    expect(submit!.port).toBe(1434);
    expect(submit!.driver).toBe("mssql");
  });
});