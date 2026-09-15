// webview/aiChat/icons.ts — TASK-CHATV2-005
//
// Local, closed-set SVG icon factory for the V2 chat shell. Every glyph is
// inlined geometry built with `createElementNS`; there is NO icon font, NO
// remote asset, NO CSS framework and NO `innerHTML` anywhere in this module.
//
// SECURITY / CAPABILITY CONTRACT
// - `createChatIcon(name, size)` accepts only the closed `CHAT_ICON_NAMES`
//   allowlist. An unknown name is never interpolated into markup, a text
//   node, or an attribute: it resolves to a neutral, inert placeholder with
//   `data-icon="unknown"`. Callers who need to branch can use
//   `isChatIconName(name)` first.
// - The `name` argument is used ONLY as a lookup key. It is never written to
//   the DOM, so a hostile string such as `<img onerror=...>` cannot become an
//   element, an attribute value, or visible text.
// - Every returned <svg> carries `viewBox="0 0 24 24"`, `currentColor`
//   painting, `aria-hidden="true"` and `focusable="false"` by construction.
//
// This module is pure DOM TypeScript: no `vscode`, no node builtins.

/** SVG namespace used for every created element. */
const SVG_NS = "http://www.w3.org/2000/svg";

/** Default glyph box in CSS pixels when the caller omits a size. */
const DEFAULT_SIZE = 16;

/** Stroke width on the 24-unit viewBox (matches PLAN §3 icon weight). */
const STROKE_WIDTH = "2";

/** One icon definition: the geometry is a list of `<path d="…">` strings.
 * When `filled` is true the paths paint with `fill: currentColor` and no
 * stroke (used by solid glyphs such as stop-square); otherwise they render as
 * stroked outlines. */
interface ChatIconDefinition {
  readonly paths: readonly string[];
  readonly filled?: boolean;
}

/** Closed allowlist — the ONLY names `createChatIcon` will render. */
const CHAT_ICON_DEFINITIONS: Record<string, ChatIconDefinition> = {
  database: {
    paths: [
      "M12 3C7.03 3 3 4.34 3 6s4.03 3 9 3 9-1.34 9-3-4.03-3-9-3Z",
      "M3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6",
      "M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6",
    ],
  },
  plug: {
    paths: ["M9 2v6", "M15 2v6", "M6 8h12v3a6 6 0 0 1-12 0Z", "M12 17v5"],
  },
  ellipsis: {
    paths: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  },
  plus: {
    paths: ["M12 5v14", "M5 12h14"],
  },
  slash: {
    paths: ["M16 4 8 20"],
  },
  "chevron-down": {
    paths: ["M6 9l6 6 6-6"],
  },
  "chevron-right": {
    paths: ["M9 6l6 6-6 6"],
  },
  file: {
    paths: [
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z",
      "M14 2v6h6",
    ],
  },
  selection: {
    paths: [
      "M3 8V5a2 2 0 0 1 2-2h3",
      "M16 3h3a2 2 0 0 1 2 2v3",
      "M21 16v3a2 2 0 0 1-2 2h-3",
      "M8 21H5a2 2 0 0 1-2-2v-3",
    ],
  },
  table: {
    paths: ["M3 5h18v14H3Z", "M3 10h18", "M9 10v9"],
  },
  view: {
    paths: [
      "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z",
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    ],
  },
  routine: {
    paths: ["M21 12a9 9 0 1 1-3-6.7", "M21 3v6h-6"],
  },
  schema: {
    paths: [
      "M10 2h4v4h-4Z",
      "M3 18h4v4H3Z",
      "M17 18h4v4h-4Z",
      "M12 6v6",
      "M12 12H5v6",
      "M12 12h7v6",
    ],
  },
  "shield-check": {
    paths: [
      "M12 3 5 6v5c0 4.4 3 7.7 7 8.8 4-1.1 7-4.4 7-8.8V6Z",
      "M9 12l2 2 4-4",
    ],
  },
  "shield-alert": {
    paths: ["M12 3 5 6v5c0 4.4 3 7.7 7 8.8 4-1.1 7-4.4 7-8.8V6Z", "M12 8v4", "M12 15h.01"],
  },
  "arrow-up": {
    paths: ["M12 19V5", "M5 12l7-7 7 7"],
  },
  "stop-square": {
    filled: true,
    paths: ["M6 6h12v12H6Z"],
  },
  copy: {
    paths: [
      "M9 9h11v11H9Z",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    ],
  },
  edit: {
    paths: ["M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16Z", "M13.5 6.5l4 4"],
  },
  retry: {
    paths: ["M3 12a9 9 0 1 0 3-6.7", "M3 3v6h6"],
  },
  check: {
    paths: ["M20 6 9 17l-5-5"],
  },
  x: {
    paths: ["M18 6 6 18", "M6 6l12 12"],
  },
  warning: {
    paths: ["M12 3 2 20h20Z", "M12 9v5", "M12 17h.01"],
  },
  spinner: {
    paths: ["M12 3a9 9 0 1 0 9 9"],
  },
};

/** Neutral placeholder geometry for an unrecognised name. Deliberately inert:
 * a plain centered ring that cannot be mistaken for a real action glyph. */
const UNKNOWN_ICON: ChatIconDefinition = {
  paths: ["M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z"],
};

/** The closed set of renderable icon names, in declaration order. */
export const CHAT_ICON_NAMES: readonly string[] = Object.freeze(
  Object.keys(CHAT_ICON_DEFINITIONS),
);

/** Narrowing type for the allowlist. */
export type ChatIconName = keyof typeof CHAT_ICON_DEFINITIONS & string;

/** True when `name` is a member of the closed allowlist. */
export function isChatIconName(name: unknown): name is ChatIconName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(CHAT_ICON_DEFINITIONS, name);
}

/** Normalise the requested size to a finite positive number of pixels. */
function normaliseSize(size: unknown): number {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return DEFAULT_SIZE;
  }
  return size;
}

/**
 * Create one decorative inline SVG icon.
 *
 * @param name Allowlisted icon name; anything else resolves to a neutral,
 *   inert placeholder (`data-icon="unknown"`). The raw value is never written
 *   to the DOM.
 * @param size Optional square edge in CSS pixels (defaults to 16).
 * @returns A fresh `SVGSVGElement` — never a string, never parsed markup.
 */
export function createChatIcon(name: string, size?: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const known = isChatIconName(name);
  const def = known ? CHAT_ICON_DEFINITIONS[name] : UNKNOWN_ICON;
  const edge = `${normaliseSize(size)}`;

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", edge);
  svg.setAttribute("height", edge);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  // The ONLY attribute derived from the caller input, and only after the
  // value has been collapsed to one of two compile-time constants.
  svg.setAttribute("data-icon", known ? name : "unknown");

  if (def.filled) {
    svg.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", STROKE_WIDTH);
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }

  for (const d of def.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    if (def.filled) {
      path.setAttribute("fill", "currentColor");
    }
    svg.appendChild(path);
  }

  return svg;
}
