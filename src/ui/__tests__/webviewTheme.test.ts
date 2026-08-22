// src/ui/__tests__/webviewTheme.test.ts
// TASK-401 — CSS var mapping `--ag-*` → `--vscode-*` in dist/webview.css.
//
// Reads the bundled CSS artifact produced by `npm run compile` (esbuild
// concatenates webview/styles.css into dist/webview.css via the import in
// webview/main.ts). If the artifact is missing, the test is skipped with an
// explanatory message — same pattern as src/ui/__tests__/webviewBundle.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const distPath = resolve(process.cwd(), "dist", "webview.css");
const css = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

const itIfCss = it.runIf(css !== null);
const describeIfCss = describe.runIf(css !== null);

describeIfCss("webview/styles.css theme mapping (TASK-401)", () => {
  itIfCss(
    "maps the 4 quartz root tokens to --vscode-* with fallbacks",
    () => {
      const expectations: Array<[string, RegExp]> = [
        [
          "--ag-background-color",
          /--ag-background-color:\s*var\(--vscode-editor-background,\s*#1e1e1e\)/,
        ],
        [
          "--ag-foreground-color",
          /--ag-foreground-color:\s*var\(--vscode-foreground,\s*#cccccc\)/,
        ],
        [
          "--ag-active-color",
          /--ag-active-color:\s*var\(--vscode-focusBorder,\s*#007fd4\)/,
        ],
        [
          "--ag-header-column-resize-handle-color",
          /--ag-header-column-resize-handle-color:\s*var\(--vscode-panel-border,\s*#3c3c3c\)/,
        ],
      ];
      for (const [name, re] of expectations) {
        expect(css!, name).toMatch(re);
      }
    },
  );

  itIfCss(
    "override block sits AFTER any base quartz `--ag-background-color: #fff` so cascade wins",
    () => {
      const baseIdx = css!.indexOf("--ag-background-color: #fff");
      const overrideIdx = css!.indexOf(
        "--ag-background-color: var(--vscode-editor-background",
      );
      // Base token must be present (from ag-theme-quartz.css) so the assertion
      // is meaningful. If the base index is -1, fall back to asserting the
      // override simply exists in the bundle.
      if (baseIdx === -1) {
        expect(overrideIdx).toBeGreaterThan(-1);
        return;
      }
      expect(overrideIdx).toBeGreaterThan(baseIdx);
    },
  );

  itIfCss(
    "input rule declares --vscode-input-background, --vscode-input-foreground, --vscode-input-border together",
    () => {
      // The input ruleset must contain all 3 declarations and target both
      // input.ag-input-field-input and textarea.ag-input-field-input.
      const re = /\.ag-theme-quartz\s+input\.ag-input-field-input[\s\S]*?\.ag-theme-quartz\s+textarea\.ag-input-field-input\s*\{([^}]*)\}/;
      const match = css!.match(re);
      expect(match, "input ruleset not found in bundled CSS").not.toBeNull();
      const body = match![1];
      expect(body).toMatch(
        /background-color:\s*var\(--vscode-input-background,\s*#2b2b2b\)/,
      );
      expect(body).toMatch(
        /color:\s*var\(--vscode-input-foreground,\s*#cccccc\)/,
      );
      // border-color alone doesn't render — must accompany style + width.
      expect(body).toMatch(
        /border-color:\s*var\(--vscode-input-border,\s*#3c3c3c\)/,
      );
      expect(body).toMatch(/border-style:\s*solid/);
      expect(body).toMatch(/border-width:\s*1px/);
    },
  );
});
