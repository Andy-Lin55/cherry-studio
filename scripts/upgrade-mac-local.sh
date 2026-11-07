#!/usr/bin/env bash
# Cherry Studio — Safe MacBook Local Upgrade Script (Antigravity ACP Fork)
#
# Upgrades /Applications/Cherry Studio.app in-place while backing up and preserving
# ~/Library/Application Support/CherryStudio (SQLite DB, chats, providers, MCPs).
#
# Usage:
#   # Mode 1 (Default): Download latest prebuilt macOS .dmg from GitHub Release
#   curl -fsSL https://raw.githubusercontent.com/Andy-Lin55/cherry-studio/feat/antigravity-acp-windows/scripts/upgrade-mac-local.sh | bash
#
#   # Mode 2: Build locally from git checkout on MacBook and upgrade /Applications
#   ./scripts/upgrade-mac-local.sh --from-source

set -euo pipefail

REPO="${CHERRY_FORK_REPO:-Andy-Lin55/cherry-studio}"
RELEASE_TAG="${CHERRY_RELEASE_TAG:-mac-acp-latest}"
APP_DEST="${CHERRY_APP_DEST:-/Applications/Cherry Studio.app}"
USER_DATA_DIR="${HOME}/Library/Application Support/CherryStudio"
DB_FILE="${USER_DATA_DIR}/Data/cherrystudio.sqlite"
MODE="release"

for arg in "$@"; do
  case "$arg" in
    --from-source)
      MODE="source"
      ;;
    --help|-h)
      echo "Usage: $0 [--from-source]"
      echo "  (default)      Download prebuilt macOS .dmg from ${REPO} (${RELEASE_TAG}) and upgrade ${APP_DEST}"
      echo "  --from-source  Build Cherry Studio.app locally from this git checkout and upgrade ${APP_DEST}"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help)" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: This upgrade script is for macOS (Darwin) only." >&2
  exit 1
fi

MACHINE_ARCH="$(uname -m)"
case "$MACHINE_ARCH" in
  arm64|aarch64)
    ARCH="arm64"
    ;;
  x86_64)
    ARCH="x64"
    ;;
  *)
    echo "Error: Unsupported macOS architecture: ${MACHINE_ARCH}" >&2
    exit 1
    ;;
esac

echo "==> Detected MacBook architecture: ${ARCH}"

# 1. Gracefully quit running Cherry Studio so SQLite WAL flushes cleanly
if pgrep -x "Cherry Studio" >/dev/null 2>&1; then
  echo "==> Closing running Cherry Studio..."
  osascript -e 'tell application "Cherry Studio" to quit' >/dev/null 2>&1 || true
  for _ in {1..15}; do
    if ! pgrep -x "Cherry Studio" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if pgrep -x "Cherry Studio" >/dev/null 2>&1; then
    echo "Error: Cherry Studio is still running. Please quit Cherry Studio (Cmd+Q) and re-run." >&2
    exit 1
  fi
fi

# 2. Back up existing SQLite database before upgrading
if [[ -f "$DB_FILE" ]]; then
  TIMESTAMP="$(date +'%Y%m%d-%H%M%S')"
  BACKUP_DIR="${USER_DATA_DIR}/Data/backups/pre-acp-${TIMESTAMP}"
  mkdir -p "$BACKUP_DIR"
  echo "==> Backing up SQLite database to: ${BACKUP_DIR}"
  cp -p "${DB_FILE}"* "$BACKUP_DIR/" 2>/dev/null || true
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_FILE" ".backup '${BACKUP_DIR}/cherrystudio.online-backup.sqlite'"
  fi
  echo "==> Database backup verified."
else
  echo "==> No existing SQLite database at ${DB_FILE} (clean profile or custom data directory)."
fi

install_app_bundle() {
  local src_app="$1"
  if [[ ! -d "$src_app" ]]; then
    echo "Error: Source app bundle not found: ${src_app}" >&2
    exit 1
  fi

  echo "==> Installing upgraded Cherry Studio.app to ${APP_DEST}..."
  if [[ -w "$(dirname "$APP_DEST")" ]] && { [[ ! -e "$APP_DEST" ]] || [[ -w "$APP_DEST" ]]; }; then
    rm -rf "$APP_DEST"
    ditto "$src_app" "$APP_DEST"
    xattr -cr "$APP_DEST" || true
  else
    echo "==> Administrator permission required to update ${APP_DEST}:"
    sudo rm -rf "$APP_DEST"
    sudo ditto "$src_app" "$APP_DEST"
    sudo xattr -cr "$APP_DEST" || true
  fi
}

# 3. Acquire upgraded Cherry Studio.app (either from GitHub Release or local source build)
if [[ "$MODE" == "source" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
  echo "==> Building Cherry Studio (${ARCH}) from source at ${REPO_ROOT}..."
  cd "$REPO_ROOT"
  pnpm install --frozen-lockfile
  CHERRY_EDITION=global SENTRY_SOURCE_MAP_UPLOAD=false pnpm exec electron-vite build
  pnpm run build:utility-process
  CSC_FOR_PULL_REQUEST=true pnpm exec electron-builder --mac "--${ARCH}" --dir "--config.mac.identity=-" --publish never

  BUILT_APP="${REPO_ROOT}/dist/mac-${ARCH}/Cherry Studio.app"
  if [[ ! -d "$BUILT_APP" ]]; then
    BUILT_APP="${REPO_ROOT}/dist/mac/Cherry Studio.app"
  fi
  install_app_bundle "$BUILT_APP"
else
  TMP_DIR="$(mktemp -d)"
  MOUNT_DIR=""
  cleanup() {
    if [[ -n "$MOUNT_DIR" ]] && [[ -d "$MOUNT_DIR" ]]; then
      hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
    fi
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT

  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}"
  echo "==> Querying GitHub release ${REPO}@${RELEASE_TAG} for macOS (${ARCH})..."

  DMG_URL="$(
    curl -fsSL "$API_URL" | python3 -c '
import json, sys
arch = sys.argv[1]
data = json.load(sys.stdin)
for asset in data.get("assets", []):
    name = asset.get("name", "")
    if name.endswith(f"-mac-{arch}.dmg"):
        print(asset["browser_download_url"])
        sys.exit(0)
sys.exit(1)
' "$ARCH"
  )" || {
    echo "Error: Could not find a '*-mac-${ARCH}.dmg' asset in https://github.com/${REPO}/releases/tag/${RELEASE_TAG}." >&2
    echo "Check that the 'MacBook Build & Local Upgrade Release' GitHub Action has finished running." >&2
    exit 1
  }

  DMG_PATH="${TMP_DIR}/Cherry-Studio-mac-${ARCH}.dmg"
  echo "==> Downloading ${DMG_URL}..."
  curl -fL --progress-bar "$DMG_URL" -o "$DMG_PATH"

  echo "==> Mounting disk image..."
  MOUNT_OUTPUT="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly)"
  MOUNT_DIR="$(echo "$MOUNT_OUTPUT" | awk -F'\t' '/\/Volumes\// {print $NF; exit}')"
  if [[ -z "$MOUNT_DIR" ]] || [[ ! -d "${MOUNT_DIR}/Cherry Studio.app" ]]; then
    echo "Error: Failed to locate 'Cherry Studio.app' inside mounted DMG (${MOUNT_DIR})." >&2
    exit 1
  fi

  install_app_bundle "${MOUNT_DIR}/Cherry Studio.app"
fi

# 4. Ensure official Google Antigravity CLI (agy) is installed for ACP sessions
if command -v agy >/dev/null 2>&1 || [[ -x "${HOME}/.local/bin/agy" ]]; then
  AGY_BIN="$(command -v agy || echo "${HOME}/.local/bin/agy")"
  echo "==> Detected Antigravity CLI: ${AGY_BIN}"
else
  echo "==> Installing official Google Antigravity CLI (agy)..."
  curl -fsSL https://antigravity.google/cli/install.sh | bash
fi

echo ""
echo "✅ Upgrade complete: ${APP_DEST}"
echo "   1. Open Cherry Studio from Applications or Spotlight."
echo "   2. Go to Code / Agent Services -> Google Antigravity."
echo "   3. Click Sign in -> Google (oauth-personal) to access Claude & Gemini models."
