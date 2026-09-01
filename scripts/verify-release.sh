#!/bin/sh
# scripts/verify-release.sh — release confidence runner (POSIX).
#
# Stages (in fixed order): npm-test → typecheck → compile.
# Prints "PASS <stage>" after each successful stage; on the first non-zero
# exit, prints "FAIL <stage>" then "FAIL verify:release" and propagates
# the failing exit code unchanged. No `set -e` so the FAIL line can print
# before the script exits.
#
# Exit codes:
#   0   — all stages passed
#   N>0 — the first stage that failed (propagated verbatim)
#
# Usage:
#   bash scripts/verify-release.sh
#   # or, on POSIX:
#   ./scripts/verify-release.sh

set -u

stage() {
  label=$1
  shift
  printf '%s\n' "==== stage: $label ===="
  if "$@"; then
    printf 'PASS %s\n' "$label"
  else
    rc=$?
    printf 'FAIL %s\n' "$label"
    printf 'FAIL verify:release\n'
    exit "$rc"
  fi
}

stage npm-test npm test
stage typecheck npm run typecheck
stage compile npm run compile

printf 'OK verify:release\n'