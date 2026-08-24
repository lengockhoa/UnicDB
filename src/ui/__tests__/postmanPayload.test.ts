// src/ui/__tests__/postmanPayload.test.ts
// TASK-008 — Pure builder tests for the Postman Payload JS object literal.
// Covers cases #1 (table payload), #4 (0 columns), #5 (malformed identifiers),
// #8 (jsKey helper).
import { describe, it, expect } from "vitest";
import { buildPostmanPayload, jsKey } from "../postmanPayload";

describe("postmanPayload — buildPostmanPayload", () => {
  it("case #1: table payload — exact literal with 2-space indent and trailing comma", () => {
    const out = buildPostmanPayload("public", "users", ["id", "name"]);
    expect(out).toBe(
      '{\n' +
      '  schema: "public",\n' +
      '  table: "users",\n' +
      '  id: this.workingObj.id,\n' +
      '  name: this.workingObj.name,\n' +
      '}',
    );
  });

  it("case #4: 0 columns → only schema + table, no field rows, still valid", () => {
    const out = buildPostmanPayload("public", "empty", []);
    expect(out).toBe(
      '{\n' +
      '  schema: "public",\n' +
      '  table: "empty",\n' +
      '}',
    );
    // Empty payload is structurally an object literal — Object.keys enumerates
    // its own keys without touching the missing column references.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const parsed = new Function(`return (${out});`)();
    expect(Object.keys(parsed).sort()).toEqual(["schema", "table"]);
  });

  it("case #5: malformed identifiers (weird-col, 1abc, default) — double-quoted keys + bracket access", () => {
    const out = buildPostmanPayload("public", "t", [
      "weird-col",
      "1abc",
      "default",
    ]);
    expect(out).toContain('"weird-col": this.workingObj["weird-col"],');
    expect(out).toContain('"1abc": this.workingObj["1abc"],');
    expect(out).toContain('"default": this.workingObj["default"],');
    // Emitted JS parses without error and exposes the expected own keys.
    // The JS literal references `this.workingObj.<col>`; we evaluate it via
    // `.call(self)` where `self = { workingObj: proxy }`. The proxy returns a
    // sentinel for any property access.
    const captured: Record<string, true> = {};
    const workingObj = new Proxy(
      {},
      {
        get: (_t, prop: string | symbol) => {
          captured[String(prop)] = true;
          return "sentinel";
        },
      },
    );
    const self = { workingObj };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const parsed = new Function(`return (${out});`).call(self);
    expect(parsed.schema).toBe("public");
    expect(parsed.table).toBe("t");
    expect(parsed["weird-col"]).toBe("sentinel");
    expect(captured["default"]).toBe(true);
  });

  it("happy: payload parses and column keys resolve to this.workingObj.<col>", () => {
    const out = buildPostmanPayload("public", "users", ["id", "name"]);
    const captured: Record<string, true> = {};
    const workingObj = new Proxy(
      {},
      {
        get: (_t, prop: string | symbol) => {
          captured[String(prop)] = true;
          return `v(${String(prop)})`;
        },
      },
    );
    const self = { workingObj };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const parsed = new Function(`return (${out});`).call(self);
    expect(parsed.schema).toBe("public");
    expect(parsed.table).toBe("users");
    expect(parsed.id).toBe("v(id)");
    expect(parsed.name).toBe("v(name)");
    expect(captured.id).toBe(true);
    expect(captured.name).toBe(true);
  });
});

describe("postmanPayload — jsKey", () => {
  it("case #8: plain identifier → bare", () => {
    expect(jsKey("id")).toBe("id");
    expect(jsKey("name")).toBe("name");
    expect(jsKey("user_id")).toBe("user_id");
  });

  it("case #8: non-identifier (hyphen, leading digit, reserved) → double-quoted", () => {
    expect(jsKey("weird-col")).toBe('"weird-col"');
    expect(jsKey("1abc")).toBe('"1abc"');
    expect(jsKey("default")).toBe('"default"');
    expect(jsKey("class")).toBe('"class"');
  });
});
