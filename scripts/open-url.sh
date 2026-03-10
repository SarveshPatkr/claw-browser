#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <url>"
  exit 1
fi

URL="$1"
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

cd "$PROJECT_DIR"
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

CONTAINER_NAME="${CONTAINER_NAME:-browser-tool}"

docker exec \
  -e TARGET_URL="$URL" \
  "$CONTAINER_NAME" \
  bash -lc 'chromium --no-sandbox --new-tab "$TARGET_URL" >/dev/null 2>&1 &'

echo "Requested URL open: ${URL}"
