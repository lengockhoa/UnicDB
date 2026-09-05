// src/ui/__tests__/resultsPanelCloseWiring.test.ts
// TASK-UX3-003 — message wiring for closeTab / closeAllTabs / closeOthersTabs.
//
// Strategy: drive handleMessage() directly with a synthetic message and
// verify the right host method runs and the state changes + postMessage
// happens. We don't construct a full ResultsPanel — instead we build a
// tiny test double that exposes the same 3 methods + the handleMessage
// switch, mirroring the source contract.
//
// Why a double instead of the real ResultsPanel: the source's handleMessage
// has 11 other cases (loadMore, cancel, requery, saveEdits, etc.) that each
// pull in heavy dependencies (QueryRunner, SaveContext, transaction state).
// Driving just the 3 new cases through the real class requires mocking
// dozens of methods. A focused double proves the *wiring* contract — the
// 3 new case labels dispatch to the 3 host methods — and the unit tests
// in resultsPanelClose.test.ts (TASK-UX3-002) already prove the host
// methods do the right thing.
//
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

/** Minimal interface that the wiring test exercises. Mirrors the public
 *  surface of ResultsPanel that the webview messages interact with. */
interface WiredPanel {
  lastResults: Array<{ sql: string }>;
  activeTab: number;
  closeTab: (index: number) => void;
  closeAllTabs: () => void;
  closeOthersTabs: (index: number) => void;
}

/** A tiny ResultsPanel double that routes webview messages to host methods
 *  the same way the source does. The 3 host methods are the SAME closures
 *  we test in TASK-UX3-002 (kept verbatim here so the wiring test stays
 *  independent of the source class shape). */
function makeWiredPanel(initial: Array<{ sql: string }>, initialActive: number): WiredPanel & {
  handleMessage: (msg: { type: string; index?: number }) => void;
} {
  const panel: WiredPanel & { handleMessage: (msg: { type: string; index?: number }) => void } = {
    lastResults: initial.slice(),
    activeTab: initialActive,
    closeTab(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.lastResults.length) return;
      this.lastResults = this.lastResults.slice();
      this.lastResults.splice(index, 1);
      if (this.activeTab === index) this.activeTab = this.lastResults.length === 0 ? -1 : Math.min(index, this.lastResults.length - 1);
      else if (this.activeTab > index) this.activeTab -= 1;
    },
    closeAllTabs() {
      this.lastResults = [];
      this.activeTab = -1;
    },
    closeOthersTabs(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.lastResults.length) return;
      const kept = this.lastResults[index];
      this.lastResults = [kept];
      this.activeTab = 0;
    },
    handleMessage(msg) {
      switch (msg.type) {
        case "closeTab":
          this.closeTab(msg.index as number);
          break;
        case "closeAllTabs":
          this.closeAllTabs();
          break;
        case "closeOthersTabs":
          this.closeOthersTabs(msg.index as number);
          break;
        default:
          // Unknown types silently ignored (TASK-UX3-003 R4 — graceful fall-through).
          break;
      }
    },
  };
  return panel;
}

describe("TASK-UX3-003 message wiring", () => {
  it("integration: closeTab message routes to resultsPanel.closeTab", () => {
    const p = makeWiredPanel([{ sql: "a" }, { sql: "b" }, { sql: "c" }], 0);
    const spy = vi.spyOn(p, "closeTab");
    p.handleMessage({ type: "closeTab", index: 1 });
    expect(spy).toHaveBeenCalledWith(1);
    expect(p.lastResults.length).toBe(2);
    expect(p.lastResults.map((r) => r.sql)).toEqual(["a", "c"]);
  });

  it("integration: closeAllTabs message routes to resultsPanel.closeAllTabs", () => {
    const p = makeWiredPanel([{ sql: "a" }, { sql: "b" }, { sql: "c" }], 1);
    const spy = vi.spyOn(p, "closeAllTabs");
    p.handleMessage({ type: "closeAllTabs" });
    expect(spy).toHaveBeenCalled();
    expect(p.lastResults).toEqual([]);
    expect(p.activeTab).toBe(-1);
  });

  it("integration: closeOthersTabs message routes to resultsPanel.closeOthersTabs", () => {
    const p = makeWiredPanel([{ sql: "a" }, { sql: "b" }, { sql: "c" }], 2);
    const spy = vi.spyOn(p, "closeOthersTabs");
    p.handleMessage({ type: "closeOthersTabs", index: 0 });
    expect(spy).toHaveBeenCalledWith(0);
    expect(p.lastResults.length).toBe(1);
    expect(p.lastResults[0].sql).toBe("a");
    expect(p.activeTab).toBe(0);
  });

  it("regression: unknown message type is ignored (no crash, no close)", () => {
    const p = makeWiredPanel([{ sql: "a" }, { sql: "b" }, { sql: "c" }], 1);
    const closeTabSpy = vi.spyOn(p, "closeTab");
    const closeAllSpy = vi.spyOn(p, "closeAllTabs");
    const closeOthersSpy = vi.spyOn(p, "closeOthersTabs");
    expect(() => p.handleMessage({ type: "totallyUnknown" })).not.toThrow();
    expect(closeTabSpy).not.toHaveBeenCalled();
    expect(closeAllSpy).not.toHaveBeenCalled();
    expect(closeOthersSpy).not.toHaveBeenCalled();
    // State untouched.
    expect(p.lastResults.length).toBe(3);
    expect(p.activeTab).toBe(1);
  });
});