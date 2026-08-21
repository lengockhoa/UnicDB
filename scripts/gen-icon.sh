#!/usr/bin/env bash
# scripts/gen-icon.sh — generate media/icon.png (128×128) from media/vsdb.svg.
# Prefers rsvg-convert; falls back to sips+qlmanage or a python3 generator.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/media/vsdb.svg"
PNG="$ROOT/media/icon.png"

fallback_python() {
  python3 - "$SVG" "$PNG" <<'PY'
import sys, struct, zlib, pathlib
svg_path, png_path = sys.argv[1], sys.argv[2]
# VSDB mandate: 128x128 icon regardless of SVG viewBox.
W = H = 128

def png_solid(w, h, rgb):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    raw = b""
    row = bytes(rgb) * w
    for _ in range(h):
        raw += b"\x00" + row
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

try:
    import cairo  # type: ignore
    surface = cairo.ImageSurface(cairo.FORMAT_RGB24, W, H)
    ctx = cairo.Context(surface)
    ctx.set_source_rgb(0.227, 0.639, 1.0)
    ctx.paint()
    ctx.set_source_rgb(1, 1, 1)
    ctx.select_font_face("Sans", cairo.FONT_SLANT_BOLD, cairo.FONT_WEIGHT_BOLD)
    ctx.set_font_size(W * 0.5)
    te = ctx.text_extents("DB")
    x_b, y_b, w_b, h_b = te.x_bearing, te.y_bearing, te.width, te.height
    ctx.move_to((W - w_b) / 2 - x_b, (H - h_b) / 2 - y_b)
    ctx.show_text("DB")
    surface.write_to_png(png_path)
except Exception:
    pathlib.Path(png_path).write_bytes(png_solid(W, H, (58, 163, 255)))
PY
}

if [[ ! -f "$SVG" ]]; then
  echo "missing $SVG" >&2
  exit 1
fi

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 128 -h 128 "$SVG" -o "$PNG"
elif command -v qlmanage >/dev/null 2>&1; then
  TMP="${TMPDIR:-/tmp}/vsdb-icon-$$.png"
  if qlmanage -t -s 128 -o "${TMPDIR:-/tmp}" "$SVG" >/dev/null 2>&1 && [[ -f "$TMP" ]]; then
    mv "$TMP" "$PNG"
  else
    fallback_python
  fi
else
  fallback_python
fi

if [[ -f "$PNG" ]]; then
  echo "wrote $PNG ($(stat -f%z "$PNG" 2>/dev/null || stat -c%s "$PNG") bytes)"
else
  echo "failed to generate $PNG" >&2
  exit 1
fi
