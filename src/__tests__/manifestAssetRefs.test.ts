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
    // v1.53.30: viewsContainers icons switched to PNG (defensive against
    // VS Code's activity-bar icon masker silently refusing to render some
    // SVGs). This guard now loops ONLY over any SVGs still contributed —
    // it no longer asserts at least one SVG exists, since the defensive
    // posture is PNG-only. If a future cycle reintroduces an SVG icon, the
    // width/height checks below still apply.
    const pkg = readJson<Manifest>("package.json");
    const refs = collectMediaIconRefs(pkg).filter((r) => r.endsWith(".svg"));
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

  // v1.53.30 defensive guards — switched viewsContainers icons to PNG because
  // VS Code's activity-bar icon masker silently refused to render the SVG for
  // some installed users (icon missing from Workbench visibility menu even
  // after Reload / Disable+Re-enable / full uninstall+reinstall). These two
  // tests pin the PNG-only fallback so a future cycle cannot silently
  // re-introduce a non-PNG icon asset.
  it("every manifest icon path uses a vscode-supported image format (.png or .svg)", () => {
    const pkg = readJson<Manifest>("package.json");
    const refs: string[] = [];
    if (pkg.icon) refs.push(pkg.icon);
    refs.push(...collectMediaIconRefs(pkg));
    expect(refs.length, "manifest must declare at least one icon").toBeGreaterThan(0);
    for (const rel of refs) {
      expect(
        /\.(png|svg)$/i.test(rel),
        `${rel} must end with .png or .svg — VS Code icon loaders reject other formats`,
      ).toBe(true);
    }
  });

  it("every contributed PNG asset has the PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)", () => {
    const pkg = readJson<Manifest>("package.json");
    const refs = collectMediaIconRefs(pkg).filter((r) => r.toLowerCase().endsWith(".png"));
    // This guard assumes the defensive PNG-fallback posture; it will fail if
    // someone reintroduces a broken .png path or a non-PNG file renamed to .png.
    expect(refs.length, "no PNG icons contributed — guard pinned to PNG fallback").toBeGreaterThan(0);
    for (const rel of refs) {
      const buf = fs.readFileSync(path.join(repoRoot, rel));
      expect(
        buf.length >= 8 &&
          buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
          buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
        `${rel} is not a valid PNG (magic bytes 89 50 4E 47 0D 0A 1A 0A mismatch)`,
      ).toBe(true);
    }
  });

  it("every contributed PNG asset uses color type 6 (RGBA true-color), not palette/indexed", () => {
    // v1.53.32 defensive guard — VS Code's activity-bar icon masker
    // silently refuses to render palette/indexed PNGs (color_type=3) for
    // some users, leaving the activity-bar container slot empty even when
    // the manifest is valid. Indexed PNGs only render reliably on the
    // Extensions panel + extension detail page (the surfaces that showed
    // the icon correctly throughout 1.53.29–1.53.31). True-color RGBA
    // (color_type=6) is the universal format.
    const pkg = readJson<Manifest>("package.json");
    const refs = collectMediaIconRefs(pkg).filter((r) => r.toLowerCase().endsWith(".png"));
    expect(refs.length, "no PNG icons contributed").toBeGreaterThan(0);
    for (const rel of refs) {
      const buf = fs.readFileSync(path.join(repoRoot, rel));
      // PNG signature (8) + IHDR length (4) + 'IHDR' (4) + 13 bytes data.
      // IHDR data layout: width(4) height(4) bit_depth(1) color_type(1) compression(1) filter(1) interlace(1).
      // color_type sits at offset 25 (sig=8 + len=4 + type=4 + width=4 + height=4 + bit_depth=1).
      expect(buf.length, `${rel}: PNG too short to contain IHDR`).toBeGreaterThanOrEqual(8 + 4 + 4 + 13);
      const colorType = buf[25];
      expect(
        colorType === 6,
        `${rel}: PNG color_type=${colorType} (must be 6=RGBA true-color). ` +
          `Indexed/palette PNGs (color_type=3) render on Extensions panel but ` +
          `VS Code activity-bar icon masker silently drops them.`,
      ).toBe(true);
    }
  });
});
