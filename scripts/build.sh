#!/usr/bin/env bash
# scripts/build.sh — Maintainer build pipeline for UnicDB.
# TASK-008: npm ci → compile → test → package vsix → print path.
# Idempotent: safe to re-run; cleans dist/ before package.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> 1/4 Install dependencies"
npm ci

echo "==> 2/4 Typecheck + tests"
npx tsc --noEmit
npm test

echo "==> 3/4 Compile (extension + webview)"
npm run compile

echo "==> 4/4 Package vsix"
# deps are bundled by esbuild → use --no-dependencies to skip registry metadata.
rm -rf dist/*.vsix
VSCE_LOG="$(mktemp -t vsce-out-XXXXXX.log)"
trap 'rm -f "${VSCE_LOG}"' EXIT

# Capture vsce output (stdout+stderr) to a temp file. Don't grep inline — vsce
# emits progress on stderr; the "Packaged: <path>" line appears on stdout.
npx @vscode/vsce package --no-dependencies -o dist/ >"${VSCE_LOG}" 2>&1 || {
  echo "ERROR: vsce package failed" >&2
  echo "--- vsce output ---" >&2
  cat "${VSCE_LOG}" >&2 || true
  exit 1
}

# vsce prints: " DONE  Packaged: dist/UnicDB-<version>.vsix (<n> files, <size>)"
# Parse "<path>" after the literal "Packaged: " prefix.
VSIX_PATH="$(grep -oE 'Packaged: [^ ]+\.vsix' "${VSCE_LOG}" | head -n1 | sed -E 's/^Packaged:[[:space:]]+//' || true)"

# Belt-and-braces fallback: construct expected path from package.json version.
if [[ -z "${VSIX_PATH}" || ! -f "${VSIX_PATH}" ]]; then
  PKG_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
  CANDIDATE="dist/UnicDB-${PKG_VERSION}.vsix"
  if [[ -f "${CANDIDATE}" ]]; then
    VSIX_PATH="${CANDIDATE}"
  fi
fi

if [[ -z "${VSIX_PATH}" || ! -f "${VSIX_PATH}" ]]; then
  echo "ERROR: vsce did not produce a .vsix file" >&2
  echo "--- vsce output ---" >&2
  cat "${VSCE_LOG}" >&2 || true
  exit 1
fi

VSIX_ABS="$(cd "$(dirname "${VSIX_PATH}")" && pwd)/$(basename "${VSIX_PATH}")"
VSIX_BYTES="$(wc -c < "${VSIX_ABS}" | tr -d ' ')"
echo
echo "Build complete:"
echo "  vsix: ${VSIX_ABS}"
echo "  size: ${VSIX_BYTES} bytes"
echo
echo "Install with:"
echo "  bash scripts/install-UnicDB.sh --local ${VSIX_ABS}"