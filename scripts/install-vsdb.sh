#!/usr/bin/env bash
# scripts/install-vsdb.sh — VSDB extension installer.
# TASK-008: curl | bash friendly, idempotent.
#
# Usage:
#   bash scripts/install-vsdb.sh                          # install latest from GitHub releases
#   bash scripts/install-vsdb.sh --local dist/vsdb.vsix   # install from a local .vsix
#   bash scripts/install-vsdb.sh --dry-run                # resolve CLI, print path, exit 0
#   bash scripts/install-vsdb.sh --help                   # usage
#
# Environment overrides (for testing):
#   VSDB_CODE_PATH   — explicit path to `code` CLI (skips PATH + macOS fallback search)
#   VSDB_DRY_RUN=1   — same as --dry-run
#   VSDB_RELEASES_URL — override GitHub releases API URL
#   VSDB_PLATFORM    — fake uname -s value (for tests)
#
# Exit codes:
#   0 — success
#   1 — usage / config error
#   2 — network / download failure
#   3 — code CLI invocation failed

set -euo pipefail

REPO_OWNER="lengockhoa"
REPO_NAME="VSDB"
DEFAULT_RELEASES_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"

MACOS_CODE_PATH="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
WIN_GITBASH_CODE_PATH="$HOME/AppData/Local/Programs/Microsoft VS Code/bin/code"
LINUX_CODE_PATH="/usr/share/code"

usage() {
  cat <<EOF
Usage: install-vsdb.sh [options]

Options:
  --local <file.vsix>   Install a local .vsix file (skip GitHub release lookup).
  --dry-run             Resolve CLI, print path, exit 0 without installing.
  --help                Show this help and exit.

Environment overrides:
  VSDB_CODE_PATH      Explicit path to 'code' CLI (skips PATH + fallback search).
  VSDB_DRY_RUN=1      Same as --dry-run.
  VSDB_RELEASES_URL   Override GitHub releases API URL.

Examples:
  curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/scripts/install-vsdb.sh | bash
  bash scripts/install-vsdb.sh --local dist/vsdb-0.1.0.vsix
EOF
}

# ----------------------------------------------------------------------------
# detect_code_cli — resolve absolute path to the 'code' binary.
# Priority: VSDB_CODE_PATH env > command -v code > platform fallback.
# Echoes path on stdout; returns 0 if found, 1 if not.
# ----------------------------------------------------------------------------
detect_code_cli() {
  if [[ -n "${VSDB_CODE_PATH:-}" && -x "${VSDB_CODE_PATH}" ]]; then
    printf '%s\n' "${VSDB_CODE_PATH}"
    return 0
  fi
  local found=""
  found="$(command -v code 2>/dev/null || true)"
  if [[ -n "${found}" && -x "${found}" ]]; then
    printf '%s\n' "${found}"
    return 0
  fi
  # Platform fallbacks (best-effort).
  local platform="${VSDB_PLATFORM:-$(uname -s 2>/dev/null || echo unknown)}"
  case "${platform}" in
    Darwin)
      if [[ -x "${MACOS_CODE_PATH}" ]]; then
        printf '%s\n' "${MACOS_CODE_PATH}"
        return 0
      fi
      ;;
    Linux)
      if [[ -x "${LINUX_CODE_PATH}" ]]; then
        printf '%s\n' "${LINUX_CODE_PATH}"
        return 0
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -x "${WIN_GITBASH_CODE_PATH}" ]]; then
        printf '%s\n' "${WIN_GITBASH_CODE_PATH}"
        return 0
      fi
      ;;
  esac
  return 1
}

# ----------------------------------------------------------------------------
# parse_json_field — extract a string field from JSON without jq.
# Uses python3 if available; else grep/sed fallback (best-effort).
# ----------------------------------------------------------------------------
parse_json_field() {
  local json="$1" field="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; d=json.loads(sys.stdin.read()); v=d.get('${field}',''); print(v)" <<<"${json}" 2>/dev/null || true
    return 0
  fi
  # Fallback: grep the field; tolerate spaces.
  printf '%s' "${json}" | grep -oE "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n1 | sed -E "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/"
}

# ----------------------------------------------------------------------------
# find_vsix_asset_url — given release JSON, return browser_download_url of the
# first .vsix asset. Echoes URL on stdout; returns 1 if not found.
# ----------------------------------------------------------------------------
find_vsix_asset_url() {
  local json="$1"
  if command -v python3 >/dev/null 2>&1; then
    # Pipe JSON via stdin; keep script inline with -c (no heredoc/<<<'s STDIN clash).
    python3 -c '
import json, sys
data = json.load(sys.stdin)
for a in data.get("assets", []):
    if a.get("name", "").endswith(".vsix"):
        print(a.get("browser_download_url", ""))
        break
' <<<"${json}" 2>/dev/null || true
    return 0
  fi
  # Fallback: split into "browser_download_url" entries then pick the .vsix one.
  printf '%s' "${json}" | tr ',' '\n' | grep -E '"browser_download_url"' | grep -E '\.vsix' | head -n1 | sed -E 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# ----------------------------------------------------------------------------
# get_installed_version — query code --list-extensions for our extension.
# Echoes version (or empty string).
# ----------------------------------------------------------------------------
get_installed_version() {
  local code_cli="$1" pubname="$2"
  "${code_cli}" --list-extensions --show-versions 2>/dev/null \
    | awk -v p="${pubname}@" 'index($0, p) == 1 { sub(p, ""); print; exit }'
}

# ----------------------------------------------------------------------------
# parse_release_tag — strip leading 'v' (v0.1.0 -> 0.1.0).
# ----------------------------------------------------------------------------
parse_release_tag() {
  printf '%s' "$1" | sed -E 's/^v//'
}

# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
main() {
  local local_file=""
  local dry_run=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local)
        [[ $# -ge 2 ]] || { echo "ERROR: --local requires a file path" >&2; exit 1; }
        local_file="$2"
        shift 2
        ;;
      --dry-run)
        dry_run="1"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        echo "ERROR: unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  [[ -n "${VSDB_DRY_RUN:-}" ]] && dry_run="1"

  # Resolve code CLI.
  local code_cli
  if ! code_cli="$(detect_code_cli)"; then
    cat >&2 <<EOF
ERROR: Cannot find 'code' (VS Code CLI).

Tried in order:
  1. \$VSDB_CODE_PATH (override)
  2. 'code' on PATH
  3. Platform fallback paths (macOS app, Linux /usr/share/code, Windows git-bash)

Fix: open VS Code → Cmd+Shift+P (macOS) or Ctrl+Shift+P → "Shell Command: Install 'code' command in PATH", then re-run this script.
EOF
    exit 1
  fi

  echo "Using code CLI: ${code_cli}"

  if [[ -n "${dry_run}" ]]; then
    echo "Dry run: resolved code CLI at ${code_cli}"
    exit 0
  fi

  local vsix_path=""
  local release_json=""
  local release_tag=""
  local asset_url=""

  if [[ -n "${local_file}" ]]; then
    if [[ ! -f "${local_file}" ]]; then
      echo "ERROR: --local file not found: ${local_file}" >&2
      exit 1
    fi
    vsix_path="$(cd "$(dirname "${local_file}")" && pwd)/$(basename "${local_file}")"
  else
    local releases_url="${VSDB_RELEASES_URL:-${DEFAULT_RELEASES_URL}}"
    echo "Fetching latest release from ${releases_url}"
    if ! release_json="$(curl -fsSL "${releases_url}" 2>/dev/null)"; then
      echo "ERROR: failed to fetch release info from ${releases_url}" >&2
      echo "       (no network? rate-limited? repo private?)" >&2
      exit 2
    fi
    release_tag="$(parse_json_field "${release_json}" "tag_name")"
    asset_url="$(find_vsix_asset_url "${release_json}")"
    if [[ -z "${asset_url}" ]]; then
      echo "ERROR: no .vsix asset found in latest release (tag=${release_tag})" >&2
      exit 2
    fi
    echo "Latest release: ${release_tag}"
    echo "Asset URL: ${asset_url}"
    # Thư mục mktemp + tên file đơn giản: VS Code CLI lowercase toàn bộ path
    # và fail với template chữ hoa (vsdb-XXXXXX.vsix) trên macOS (/var symlink).
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    vsix_path="${tmp_dir}/vsdb.vsix"
    echo "Downloading to ${vsix_path}"
    if ! curl -fsSL -o "${vsix_path}" "${asset_url}"; then
      echo "ERROR: failed to download ${asset_url}" >&2
      rm -f "${vsix_path}"; rmdir "${tmp_dir}" 2>/dev/null
      exit 2
    fi
  fi

  # Detect installed version (publisher is "lengockhoa", name "vsdb").
  local pubname="lengockhoa.vsdb"
  local prev_ver
  prev_ver="$(get_installed_version "${code_cli}" "${pubname}" || true)"

  echo "Installing ${vsix_path} ..."
  if ! "${code_cli}" --install-extension "${vsix_path}" --force >/dev/null 2>&1; then
    echo "ERROR: code --install-extension failed" >&2
    exit 3
  fi

  local new_ver
  new_ver="$(get_installed_version "${code_cli}" "${pubname}" || true)"
  if [[ -n "${prev_ver}" ]]; then
    echo "Updated ${pubname}: ${prev_ver} → ${new_ver}"
  else
    echo "Installed ${pubname} ${new_ver:-version unknown}"
  fi

  # Extension updates only load in VS Code after a window reload/restart.
  # Prevents the "installed but icon missing" confusion.
  cat <<'EOF'
NOTE: If VSDB does not show in the Activity Bar, reload the window:
      Cmd+Shift+P (or Ctrl+Shift+P) -> "Developer: Reload Window"
EOF

  # Cleanup tmp vsix (only if we downloaded it).
  if [[ -z "${local_file}" && -n "${vsix_path}" ]]; then
    rm -f "${vsix_path}" || true
  fi
}

main "$@"
