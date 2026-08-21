#!/usr/bin/env bash
# scripts/build.sh — Maintainer build pipeline for VSDB.
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
VSIX_PATH="$(npx @vscode/vsce package --no-dependencies -o dist/ 2>&1 | tee /tmp/vsce-out.log | grep -E '^.*\.vsix$' | tail -n1 || true)"

# Fallback: if vsce printed "Created .../foo.vsix", parse that.
if [[ -z "${VSIX_PATH}" ]]; then
  VSIX_PATH="$(grep -oE "Successfully packaged: [^ ]+\.vsix" /tmp/vsce-out.log | sed 's/Successfully packaged: //' | tail -n1 || true)"
fi
if [[ -z "${VSIX_PATH}" || ! -f "${VSIX_PATH}" ]]; then
  echo "ERROR: vsce did not produce a .vsix file" >&2
  echo "--- vsce output ---" >&2
  cat /tmp/vsce-out.log >&2 || true
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
echo "  bash scripts/install-vsdb.sh --local ${VSIX_ABS}"
