// src/ui/__tests__/userGuideContent.test.ts
// TASK-UX1-004 (R2) — verify docs/UNICDB_USER_GUIDE.md exists and covers
// every shipped feature required by §Acceptance. Pure file-read test,
// no vscode mock.
//
// NOTE: filename case is significant — vsce's .vscodeignore glob is
// case-sensitive on Linux/Windows (the Marketplace CI runs on ubuntu-latest).
// Historical case `docs/UnicDB_USER_GUIDE.md` (mixed-case UnicDB prefix) was
// a typo that caused the file to silently drop from the .vsix while macOS
// dev (case-insensitive HFS+/APFS) masked it. Path strings here MUST match
// the on-disk entry exactly so the test catches future drift on Linux CI.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const guidePath = resolve(process.cwd(), "docs", "UNICDB_USER_GUIDE.md");
const exists = existsSync(guidePath);
const content = exists ? readFileSync(guidePath, "utf8") : "";

describe("TASK-UX1-004 (R2) — docs/UNICDB_USER_GUIDE.md", () => {
  it("#1 file exists at docs/UNICDB_USER_GUIDE.md", () => {
    expect(exists, "guide file must exist on disk").toBe(true);
  });

  it("#2 file is non-empty (> 200 chars)", () => {
    expect(content.length).toBeGreaterThan(200);
  });

  const requiredKeywords = [
    "Cài đặt",
    "Kết nối",
    "Schema Explorer",
    "SQL Console",
    "Results",
    "AI Chat",
    "Settings",
    "SQL Generator",
    "Sample Data",
    "Schema Refresh",
  ];
  for (const kw of requiredKeywords) {
    it(`#3 contains section keyword: ${kw}`, () => {
      expect(content.toLowerCase()).toContain(kw.toLowerCase());
    });
  }

  it("#4 does NOT mention the removed UnicDB.resultsPlacement setting", () => {
    expect(content).not.toContain("UnicDB.resultsPlacement");
  });

  it("#4b no stale placement option words remain in a settings context", () => {
    const lower = content.toLowerCase();
    expect(lower).not.toContain("resultsplacement");
    expect(content).not.toContain("beside");
    expect(content).not.toContain("moveEditorToBelowGroup");
  });

  it("#4c guide documents the fixed bottom-panel placement", () => {
    expect(/Results[\s\S]{0,400}?Terminal|Terminal[\s\S]{0,400}?Results/i.test(content)).toBe(true);
  });

  it("#5 explains how to open the guide (book icon)", () => {
    expect(content).toContain("book") || expect(content).toContain("📖");
  });
});
