// src/ui/__tests__/webviewTheme.test.ts
// TASK-401 (fix round 2) — VS Code theme binding via the AG Grid JS Theming
// API. AG v36 paints the grid from `themeQuartz.withParams(...)` passed to
// `createGrid`; the generated stylesheet + element-level vars BEAT any CSS
// overrides on a `.ag-theme-quartz` class (which is the legacy system and
// conflicts with the API — AG error #106). So the assertions target:
//
//   1. dist/webview.js  — theme params bound to --vscode-* CSS variables.
//   2. dist/webview.css — no legacy quartz stylesheet bundled; input rules
//      (UA-stylesheet override for dark themes) on the neutral host class.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const jsPath = resolve(process.cwd(), "dist", "webview.js");
const cssPath = resolve(process.cwd(), "dist", "webview.css");
const js = existsSync(jsPath) ? readFileSync(jsPath, "utf8") : null;
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : null;

const itIfBuilt = it.runIf(js !== null && css !== null);
const describeIfBuilt = describe.runIf(js !== null && css !== null);

describeIfBuilt("VS Code theme via Theming API (TASK-401 fix round 2)", () => {
  itIfBuilt("theme params bind --vscode-* vars with dark-safe fallbacks", () => {
    expect(js!, "themeQuartz imported").toMatch(/themeQuartz/);
    expect(js!).toMatch(
      /backgroundColor:\s*"var\(--vscode-editor-background,\s*#1e1e1e\)"/,
    );
    expect(js!).toMatch(
      /foregroundColor:\s*"var\(--vscode-foreground,\s*#cccccc\)"/,
    );
    expect(js!).toMatch(
      /accentColor:\s*"var\(--vscode-focusBorder,\s*#007fd4\)"/,
    );
    expect(js!).toMatch(
      /borderColor:\s*"var\(--vscode-panel-border,\s*#3c3c3c\)"/,
    );
  });

  itIfBuilt("legacy ag-grid stylesheets NOT bundled (error #106 pair)", () => {
    // The legacy quartz stylesheet defines this var list — its presence means
    // someone re-added the stylesheet import alongside the theme API.
    expect(css!).not.toMatch(/--ag-checkbox-unchecked-color:\s*color-mix/);
    expect(js!).not.toMatch(/styles\/ag-grid\.css/);
    expect(js!).not.toMatch(/styles\/ag-theme-quartz\.css/);
  });

  itIfBuilt("input rules override UA white inputs on dark themes (host class)", () => {
    const re =
      /\.UnicDB-ag-host\s+input\.ag-input-field-input[\s\S]*?\.UnicDB-ag-host\s+textarea\.ag-input-field-input\s*\{([^}]*)\}/;
    const match = css!.match(re);
    expect(match, "input ruleset not found in bundled CSS").not.toBeNull();
    const body = match![1];
    expect(body).toMatch(
      /background-color:\s*var\(--vscode-input-background,\s*#2b2b2b\)/,
    );
    expect(body).toMatch(
      /color:\s*var\(--vscode-input-foreground,\s*#cccccc\)/,
    );
    expect(body).toMatch(
      /border-color:\s*var\(--vscode-input-border,\s*#3c3c3c\)/,
    );
    expect(body).toMatch(/border-style:\s*solid/);
    expect(body).toMatch(/border-width:\s*1px/);
  });
});
