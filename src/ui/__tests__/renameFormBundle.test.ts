// src/ui/__tests__/renameFormBundle.test.ts — TASK-DBX06-003
// jsdom bundle test for webview/renameFormMain.ts (same harness as
// newTableFormBundle.test.ts). Requires `npm run compile` first.
// DBX06-006 — render trigger/index rows, typed step labels, and confirm
// dependency labels stay as text (no HTML sinks).
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: new () => unknown;
    matchMedia?: (q: string) => unknown;
  };
  if (typeof g.ResizeObserver === "undefined") {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as new () => unknown;
  }
  if (typeof g.matchMedia === "undefined") {
    g.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener(): void {},
      removeListener(): void {},
      addEventListener(): void {},
      removeEventListener(): void {},
      dispatchEvent(): boolean {
        return false;
      },
    }) as unknown;
  }
});

const distPath = resolve(process.cwd(), "dist", "renameForm.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface BundleHandle {
  received: Array<Record<string, unknown>>;
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error("dist/renameForm.js missing — run `npm run compile`");
  }
  document.body.innerHTML = '<div id="vsdb-root"></div>';
  const received: Array<Record<string, unknown>> = [];
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi =
    () => ({ postMessage: (m: unknown) => received.push(m as Record<string, unknown>) });
  (0, eval)(bundleSrc);
  return { received };
}

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

const itIf = it.runIf(bundleSrc !== null);
const describeIf = describe.runIf(bundleSrc !== null);

describeIf("webview/renameFormMain.ts bundle (DBX-06)", () => {
  it("ready → init renders input + buttons (textContent only)", () => {
    const { received } = loadBundle();
    expect(received[0]).toEqual({ type: "ready" });
    dispatch({
      type: "init",
      mode: "table",
      schema: "public",
      table: "users",
      oldName: "users",
    });
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    expect(root.querySelector("#vsdb-rename-input")).not.toBeNull();
    expect(root.querySelector("#vsdb-rename-analyze")).not.toBeNull();
    expect(root.querySelector("#vsdb-rename-approve")).not.toBeNull();
    expect(root.querySelector("#vsdb-rename-cancel")).not.toBeNull();
    const approve = root.querySelector(
      "#vsdb-rename-approve",
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(true); // disabled until a clean analysis
    // textContent-only invariant: no innerHTML writes in the bundle source.
    expect(bundleSrc).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML/);
  });

  it("analysis with errors shows them and keeps approve disabled", () => {
    loadBundle();
    dispatch({ type: "init", mode: "table", schema: "public", table: "users", oldName: "users" });
    dispatch({
      type: "analysis",
      report: { views: [], fks: [], routines: [], triggers: [], indexes: [], collisions: [] },
      statements: [],
      steps: [],
      errors: ["Name collision — target already exists: customers (table)."],
    });
    const box = document.getElementById(
      "vsdb-rename-analysis",
    ) as HTMLDivElement;
    expect(box.textContent).toContain("Name collision");
    const approve = document.getElementById(
      "vsdb-rename-approve",
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });

  it("clean analysis renders trigger/index rows, typed step labels, and enables approve", () => {
    loadBundle();
    dispatch({ type: "init", mode: "table", schema: "public", table: "users", oldName: "users" });
    dispatch({
      type: "analysis",
      report: {
        views: [{ name: "v_users", kind: "view" }],
        fks: [{ constraint: "fk1", fromTable: "orders" }],
        routines: [],
        triggers: [{ name: "trg_audit", event: "INSERT", timing: "AFTER" }],
        indexes: [
          { name: "users_email_idx", isPrimary: false, isUnique: true, columns: ["email"] },
        ],
        collisions: [],
      },
      statements: ['ALTER TABLE "public"."users" RENAME TO "customers";'],
      steps: [
        {
          kind: "rename",
          executable: true,
          statement: 'ALTER TABLE "public"."users" RENAME TO "customers";',
        },
        { kind: "triggers", executable: false, statement: "" },
        { kind: "indexes", executable: false, statement: "" },
      ],
      errors: [],
    });
    const box = document.getElementById(
      "vsdb-rename-analysis",
    ) as HTMLDivElement;
    expect(box.textContent).toContain("v_users");
    expect(box.textContent).toContain("Trigger: trg_audit");
    expect(box.textContent).toContain("Index: users_email_idx");
    expect(box.textContent).toContain("Rename table");
    expect(box.textContent).toContain(
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    );
    const approve = document.getElementById(
      "vsdb-rename-approve",
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });

  it("hostile trigger/index label stays as text — no img element", () => {
    loadBundle();
    dispatch({ type: "init", mode: "table", schema: "public", table: "users", oldName: "users" });
    dispatch({
      type: "analysis",
      report: {
        views: [],
        fks: [],
        routines: [],
        triggers: [
          { name: '<img src=x onerror=1>', event: "INSERT", timing: "AFTER" },
        ],
        indexes: [],
        collisions: [],
      },
      statements: ['ALTER TABLE "public"."users" RENAME TO "customers";'],
      steps: [
        {
          kind: "rename",
          executable: true,
          statement: 'ALTER TABLE "public"."users" RENAME TO "customers";',
        },
        { kind: "triggers", executable: false, statement: "" },
      ],
      errors: [],
    });
    const box = document.getElementById(
      "vsdb-rename-analysis",
    ) as HTMLDivElement;
    expect(box.textContent).toContain('<img src=x onerror=1>');
    expect(box.querySelectorAll("img").length).toBe(0);
    // No HTML sinks anywhere in the compiled bundle.
    expect(bundleSrc).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML/);
  });

  it("done failure reports applied + failed step label + error", () => {
    loadBundle();
    dispatch({ type: "init", mode: "table", schema: "public", table: "users", oldName: "users" });
    dispatch({
      type: "done",
      applied: [
        {
          index: 0,
          label: "rename",
          sql: 'ALTER TABLE "public"."users" RENAME TO "customers";',
        },
      ],
      failed: {
        index: 1,
        label: "rename",
        sql: 'ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";',
        error: "relation locked",
      },
    });
    const box = document.getElementById(
      "vsdb-rename-progress",
    ) as HTMLDivElement;
    expect(box.textContent).toContain("FAILED");
    expect(box.textContent).toContain("rename");
    expect(box.textContent).toContain("relation locked");
  });

  it("done cancel reports applied + remaining", () => {
    loadBundle();
    dispatch({ type: "init", mode: "table", schema: "public", table: "users", oldName: "users" });
    dispatch({
      type: "done",
      applied: [{ index: 0, label: "rename", sql: "A;" }],
      cancelledAfter: 1,
      remaining: 2,
    });
    const box = document.getElementById(
      "vsdb-rename-progress",
    ) as HTMLDivElement;
    expect(box.textContent).toContain("Cancelled");
    expect(box.textContent).toContain("2 remaining");
  });
});
