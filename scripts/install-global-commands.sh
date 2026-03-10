#!/usr/bin/env bash
set -euo pipefail

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  while [[ -h "$source" ]]; do
    local dir
    dir="$(cd -P -- "$(dirname -- "$source")" && pwd)"
    source="$(readlink -- "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done
  cd -P -- "$(dirname -- "$source")" && pwd
}

SCRIPT_DIR="$(resolve_script_dir)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${1:-/usr/local/bin}"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Target directory does not exist: $TARGET_DIR" >&2
  exit 1
fi

if [[ ! -w "$TARGET_DIR" ]]; then
  echo "No write permission to $TARGET_DIR. Run with sudo." >&2
  exit 1
fi

ln -sf "$PROJECT_DIR/scripts/browser-cmd.sh" "$TARGET_DIR/browser-cmd"
ln -sf "$PROJECT_DIR/scripts/start.sh" "$TARGET_DIR/browser-start"
ln -sf "$PROJECT_DIR/scripts/stop.sh" "$TARGET_DIR/browser-stop"
ln -sf "$PROJECT_DIR/scripts/open-url.sh" "$TARGET_DIR/browser-open-url"
ln -sf "$PROJECT_DIR/scripts/serve-client.sh" "$TARGET_DIR/browser-serve"
ln -sf "$PROJECT_DIR/scripts/browser-info.sh" "$TARGET_DIR/browser-info"

echo ""
echo "Installing Node dependencies..."
cd "$PROJECT_DIR"
chmod -R 755 node_modules 2>/dev/null || true

install_npm() {
  if command -v npm >/dev/null 2>&1; then
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
    return 0
  fi
  if [[ -n "${SUDO_USER:-}" ]] && sudo -u "$SUDO_USER" command -v npm >/dev/null 2>&1; then
    sudo -u "$SUDO_USER" env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
    return 0
  fi
  if [[ -d node_modules ]] && [[ -f node_modules/.package-lock.json || -f package-lock.json ]]; then
    echo "Node modules already installed, skipping"
    return 0
  fi
  echo "Warning: npm not found, skipping Node dependencies"
  return 0
}

install_npm

install_client_deps() {
  if [ ! -d "$PROJECT_DIR/client" ]; then
    echo "Client directory not found, skipping..."
    return 0
  fi
  
  echo ""
  echo "Installing client dependencies..."
  cd "$PROJECT_DIR/client"
  
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
    return 0
  fi
  
  if command -v npm >/dev/null 2>&1; then
    npm install
    return 0
  fi
  
  echo "Warning: pnpm/npm not found, skipping client dependencies"
  return 0
}

install_client_deps
echo ""
echo "Installed commands:"
echo "  browser-cmd"
echo "  browser-start"
echo "  browser-stop"
echo "  browser-open-url"
echo "  browser-serve"
echo "  browser-info"

echo ""
echo "✅ Setup complete!"
