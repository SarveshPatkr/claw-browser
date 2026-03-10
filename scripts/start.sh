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

mkdir -p downloads
chmod 777 downloads 2>/dev/null || true

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
}

BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
RAW_VNC_HOST_PORT="${RAW_VNC_HOST_PORT:-15900}"
VNC_WS_HOST_PORT="${VNC_WS_HOST_PORT:-16080}"
CDP_HOST_PORT="${CDP_HOST_PORT:-19222}"
API_HOST_PORT="${API_HOST_PORT:-18080}"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_WIDTH="${SCREEN_WIDTH:-1920}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-1080}"
SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
BROWSER_START_URL="${BROWSER_START_URL:-https://www.google.com}"
CHROMIUM_NO_SANDBOX="${CHROMIUM_NO_SANDBOX:-1}"
CHROMIUM_FLAGS="${CHROMIUM_FLAGS:-}"
TAB_TO_WINDOW="${TAB_TO_WINDOW:-1}"
CHROMIUM_APP_MODE="${CHROMIUM_APP_MODE:-1}"
TZ="${TZ:-UTC}"
API_PORT="${API_PORT:-8080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
API_KEY="${API_KEY:-}"
CLIENT_PORT="${CLIENT_PORT:-3000}"
CLIENT_BIND_ADDRESS="${CLIENT_BIND_ADDRESS:-0.0.0.0}"
AUTO_START_CLIENT_SERVER="${AUTO_START_CLIENT_SERVER:-1}"

SHM_SIZE="${SHM_SIZE:-4gb}"
IMAGE_NAME="${IMAGE_NAME:-browser-tool:local}"
CONTAINER_NAME="${CONTAINER_NAME:-browser-tool}"
DATA_VOLUME_NAME="${DATA_VOLUME_NAME:-browser-data}"

build_client_if_needed() {
  if [[ "${SKIP_CLIENT_BUILD:-0}" == "1" ]]; then
    return 0
  fi

  if [[ -f "$PROJECT_DIR/client/dist/index.html" ]]; then
    return 0
  fi

  echo "Building React client (client/dist missing)..."
  "$PROJECT_DIR/scripts/build-client.sh"
}

collect_ipv4_addresses() {
  if command -v ip >/dev/null 2>&1; then
    local detected
    detected="$(ip -o -4 addr show scope global | awk '!($2 ~ /^(docker|br-|veth|lo)/) {split($4,a,"/"); print a[1]}' | sort -u)"
    if [[ -n "$detected" ]]; then
      echo "$detected"
      return
    fi
  fi

  local ips
  ips="$(hostname -I 2>/dev/null || true)"
  if [[ -z "$ips" ]]; then
    echo "localhost"
    return
  fi
  echo "$ips" | tr ' ' '\n' | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/' | sort -u
}

get_primary_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')"
    if [[ -z "$ip" ]]; then
      local iface
      iface="$(ip route | awk '/default/ {print $5; exit}')"
      if [[ -n "$iface" ]]; then
        ip="$(ip -4 addr show "$iface" 2>/dev/null | awk '/inet / {print $2}' | cut -d'/' -f1 | head -n 1)"
      fi
    fi
  fi
  if [[ -z "$ip" ]]; then
    ip="$(collect_ipv4_addresses | head -n 1)"
  fi
  echo "${ip:-localhost}"
}

wait_for_health() {
  local attempts=90
  for _ in $(seq 1 "$attempts"); do
    local state
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    if [[ "$state" == "healthy" || "$state" == "running" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Warning: container did not report healthy yet." >&2
}

start_container() {
  echo "Building engine image: $IMAGE_NAME"
  docker build -t "$IMAGE_NAME" "$PROJECT_DIR"

  docker volume inspect "$DATA_VOLUME_NAME" >/dev/null 2>&1 || docker volume create "$DATA_VOLUME_NAME" >/dev/null

  if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi

  echo "Starting engine container: $CONTAINER_NAME"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --shm-size "$SHM_SIZE" \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --log-driver json-file \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    -e DISPLAY_NUM="$DISPLAY_NUM" \
    -e SCREEN_WIDTH="$SCREEN_WIDTH" \
    -e SCREEN_HEIGHT="$SCREEN_HEIGHT" \
    -e SCREEN_DEPTH="$SCREEN_DEPTH" \
    -e BROWSER_START_URL="$BROWSER_START_URL" \
    -e CHROMIUM_NO_SANDBOX="$CHROMIUM_NO_SANDBOX" \
    -e CHROMIUM_FLAGS="$CHROMIUM_FLAGS" \
    -e TAB_TO_WINDOW="$TAB_TO_WINDOW" \
    -e CHROMIUM_APP_MODE="$CHROMIUM_APP_MODE" \
    -e TZ="$TZ" \
    -e API_PORT="$API_PORT" \
    -e VNC_PASSWORD="$VNC_PASSWORD" \
    -e API_KEY="$API_KEY" \
    -p "${BIND_ADDRESS}:${RAW_VNC_HOST_PORT}:5900" \
    -p "${BIND_ADDRESS}:${VNC_WS_HOST_PORT}:6080" \
    -p "${BIND_ADDRESS}:${CDP_HOST_PORT}:9222" \
    -p "${BIND_ADDRESS}:${API_HOST_PORT}:8080" \
    -v "${DATA_VOLUME_NAME}:/home/browser/.config/chromium" \
    -v "$PROJECT_DIR/downloads:/home/browser/Downloads" \
    "$IMAGE_NAME" >/dev/null
}

start_client_server() {
  if [[ "$AUTO_START_CLIENT_SERVER" != "1" ]]; then
    return 0
  fi

  "$PROJECT_DIR/scripts/serve-client.sh" \
    --ensure \
    --daemon \
    --port "$CLIENT_PORT" \
    --bind "$CLIENT_BIND_ADDRESS"
}

require_cmd docker
build_client_if_needed
start_container
wait_for_health
start_client_server

PRIMARY_HOST="localhost"
if [[ "$BIND_ADDRESS" != "127.0.0.1" ]]; then
  PRIMARY_HOST="$(get_primary_ip)"
fi

CLIENT_HOST="localhost"
if [[ "$CLIENT_BIND_ADDRESS" == "0.0.0.0" || "$CLIENT_BIND_ADDRESS" == "::" ]]; then
  CLIENT_HOST="$PRIMARY_HOST"
elif [[ "$CLIENT_BIND_ADDRESS" == "127.0.0.1" || "$CLIENT_BIND_ADDRESS" == "localhost" ]]; then
  CLIENT_HOST="localhost"
else
  CLIENT_HOST="$CLIENT_BIND_ADDRESS"
fi

if [[ -n "$API_KEY" ]]; then
  CONNECT_LINE="bt://${PRIMARY_HOST}?api=${API_HOST_PORT}&vnc=${VNC_WS_HOST_PORT}&cdp=${CDP_HOST_PORT}&path=websockify&key=${API_KEY}"
else
  CONNECT_LINE="bt://${PRIMARY_HOST}?api=${API_HOST_PORT}&vnc=${VNC_WS_HOST_PORT}&cdp=${CDP_HOST_PORT}&path=websockify"
fi

echo ""
if [[ "$BIND_ADDRESS" == "127.0.0.1" ]]; then
  echo "Note: BIND_ADDRESS=127.0.0.1 (local-only mode)."
  echo ""
fi

echo ""
echo "Started Claw Browser engine"
echo ""
echo "Engine ports (host machine)"
echo "  API:      http://${PRIMARY_HOST}:${API_HOST_PORT}"
echo "  VNC WS:   ws://${PRIMARY_HOST}:${VNC_WS_HOST_PORT}/websockify"
echo "  CDP:      http://${PRIMARY_HOST}:${CDP_HOST_PORT}"
echo "  Raw VNC:  ${PRIMARY_HOST}:${RAW_VNC_HOST_PORT}"
echo ""
echo "Client UI"
if [[ "$AUTO_START_CLIENT_SERVER" == "1" ]]; then
  echo "  URL:      http://${CLIENT_HOST}:${CLIENT_PORT}"
else
  echo "  Auto server disabled (AUTO_START_CLIENT_SERVER=0)"
fi
echo "  File:     ${PROJECT_DIR}/client/dist/index.html"
echo ""
echo "Connection line for React client"
echo "  ${CONNECT_LINE}"
echo ""
echo "Reachable host/IP options"
if [[ "$BIND_ADDRESS" == "127.0.0.1" ]]; then
  echo "  localhost (loopback only)"
else
  collect_ipv4_addresses | while read -r ip; do
    [[ -z "$ip" ]] && continue
    echo "  ${ip}"
  done
fi
echo ""
echo "Paste the connection line in client Settings > Engine URL."
