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

cd "$PROJECT_DIR"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

CONTAINER_NAME="${CONTAINER_NAME:-browser-tool}"
AUTO_STOP_CLIENT_SERVER="${AUTO_STOP_CLIENT_SERVER:-1}"
CLIENT_PORT="${CLIENT_PORT:-3000}"
CLIENT_BIND_ADDRESS="${CLIENT_BIND_ADDRESS:-0.0.0.0}"

if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
  echo "Stopped Claw Browser ($CONTAINER_NAME)"
else
  echo "No running/stopped container named $CONTAINER_NAME"
fi

if [[ "$AUTO_STOP_CLIENT_SERVER" == "1" ]]; then
  "$PROJECT_DIR/scripts/serve-client.sh" \
    --stop \
    --port "$CLIENT_PORT" \
    --bind "$CLIENT_BIND_ADDRESS" || true
fi
