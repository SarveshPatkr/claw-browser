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

cd "$PROJECT_DIR/client"

echo "Building React client..."
if [[ ! -d node_modules ]] || [[ -z "$(ls -A node_modules 2>/dev/null)" ]]; then
  echo "Installing client dependencies..."
  if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile
  elif [[ -f package-lock.json ]] && command -v npm >/dev/null 2>&1; then
    npm ci
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm install
  elif command -v npm >/dev/null 2>&1; then
    npm install
  else
    echo "Error: pnpm or npm is required to install/build the client" >&2
    exit 1
  fi
fi

if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
  pnpm run build
elif command -v npm >/dev/null 2>&1; then
  npm run build
elif command -v pnpm >/dev/null 2>&1; then
  pnpm run build
else
  echo "Error: pnpm or npm is required to build the client" >&2
  exit 1
fi

echo ""
echo "✅ React client built successfully!"
echo ""
echo "The built files are in: $PROJECT_DIR/client/dist"
echo ""
echo "Single-page client:"
echo "  $PROJECT_DIR/client/dist/index.html"
echo ""
echo "Open index.html directly in your browser (file://...)"
echo "or run ./scripts/serve-client.sh to serve it over HTTP."
