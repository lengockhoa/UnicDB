// src/__tests__/manifestAssetRefs.test.ts
// Manifest asset-reference guard.
//
// Defends against the "extension icon silently missing from the activity bar"
// regression: every `media/*` path that package.json declares (top-level
// `icon`, every `viewsContainers.activitybar[].icon`, every
// `viewsContainers.panel[].icon`) must resolve on disk, and any SVG asset
// under `media/` that participates in the activity bar / panel needs explicit
// intrinsic `width` and `height` on the root <svg> so icon-theme maskers in
// newer VS Code versions do not collapse the rendered glyph to 0x0.
//
// Reads manifests and asset files dynamically — bumping the manifest or
// swapping an SVG never requires editing this test.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

function readJson<T>(relPath: string): T {
  const raw = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
  return JSON.parse(raw) as T;
}

interface ViewsContainer {
  id?: string;
  title?: string;
  icon?: string;
}

interface Manifest {
  icon?: string;
  contributes?: {
    viewsContainers?: {
      activitybar?: ViewsContainer[];
      panel?: ViewsContainer[];
    };
  };
}

function collectMediaIconRefs(pkg: Manifest): string[] {
  const out: string[] = [];
  if (pkg.icon && pkg.icon.startsWith("media/")) out.push(pkg.icon);
  for (const vc of pkg.contributes?.viewsContainers?.activitybar ?? []) {
    if (vc.icon && vc.icon.startsWith("media/")) out.push(vc.icon);
  }
  for (const vc of pkg.contributes?.viewsContainers?.panel ?? []) {
    if (vc.icon && vc.icon.startsWith("media/")) out.push(vc.icon);
  }
  return Array.from(new Set(out)).sort();
}

describe("manifest asset references", () => {
  it("every viewsContainer.activitybar[].icon path resolves on disk", () => {
    const pkg = readJson<Manifest>("package.json");
    const refs = collectMediaIconRefs(pkg);
    expect(
      refs.length,
      "package.json must contribute at least one media/* icon (activity bar)",
    ).toBeGreaterThan(0);
    for (const rel of refs) {
      expect(
        fs.existsSync(path.join(repoRoot, rel)),
        `manifest icon path '${rel}' (declared in package.json) does not resolve on disk — ` +
          `either the file was moved/deleted or the manifest must be updated`,
      ).toBe(true);
    }
  });

  it("every contributed media/*.svg asset has explicit width and height on the root <svg>", () => {
    const pkg = readJson<Manifest>("package.json");
    const refs = collectMediaIconRefs(pkg).filter((r) => r.endsWith(".svg"));
    expect(refs.length, "no media/*.svg contributed via viewsContainers").toBeGreaterThan(0);
    for (const rel of refs) {
      const svg = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      // Only assert the FIRST <svg ...> open tag — the root element. Inner
      // <svg> elements (rare in icon assets) would scale this guard
      // unnecessarily; the activity-bar mask applies at the root.
      const rootOpenMatch = svg.match(/<svg\b[^>]*>/i);
      expect(
        rootOpenMatch,
        `${rel}: could not find a root <svg> open tag`,
      ).not.toBeNull();
      const rootOpen = rootOpenMatch![0];
      expect(
        /\bwidth\s*=\s*["']\d/.test(rootOpen),
        `${rel}: root <svg> must have an explicit width attribute (e.g. width="24") so ` +
          `VS Code icon-theme maskers do not collapse the rendered glyph to 0x0`,
      ).toBe(true);
      expect(
        /\bheight\s*=\s*["']\d/.test(rootOpen),
        `${rel}: root <svg> must have an explicit height attribute (e.g. height="24") so ` +
          `VS Code icon-theme maskers do not collapse the rendered glyph to 0x0`,
      ).toBe(true);
    }
  });

  it("extension top-level `icon` (Marketplace + Extensions panel) resolves on disk", () => {
    const pkg = readJson<Manifest>("package.json");
    expect(pkg.icon, "package.json must declare a top-level `icon`").toBeTruthy();
    expect(
      fs.existsSync(path.join(repoRoot, pkg.icon!)),
      `top-level package.json 'icon' path '${pkg.icon}' does not resolve on disk`,
    ).toBe(true);
  });
});
