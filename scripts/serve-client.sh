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
CLIENT_DIR="$PROJECT_DIR/client"
DIST_DIR="$CLIENT_DIR/dist"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/client-server.pid"
LOG_FILE="$RUNTIME_DIR/client-server.log"

MODE="foreground"
CLIENT_PORT="${CLIENT_PORT:-3000}"
CLIENT_BIND_ADDRESS="${CLIENT_BIND_ADDRESS:-127.0.0.1}"

print_help() {
  cat <<USAGE
Usage: ./scripts/serve-client.sh [options]

Options:
  --daemon          Start in background and exit
  --ensure          Ensure background server is running (start if needed)
  --stop            Stop background server
  --status          Show background server status
  --port <port>     HTTP port (default: CLIENT_PORT or 3000)
  --bind <address>  Bind address (default: CLIENT_BIND_ADDRESS or 127.0.0.1)
  -h, --help        Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --daemon)
      MODE="daemon"
      ;;
    --ensure)
      MODE="ensure"
      ;;
    --stop)
      MODE="stop"
      ;;
    --status)
      MODE="status"
      ;;
    --port)
      [[ $# -lt 2 ]] && { echo "Missing value for --port" >&2; exit 1; }
      CLIENT_PORT="$2"
      shift
      ;;
    --bind)
      [[ $# -lt 2 ]] && { echo "Missing value for --bind" >&2; exit 1; }
      CLIENT_BIND_ADDRESS="$2"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
  shift
done

require_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is required to serve static files" >&2
    exit 1
  fi
}

ensure_dist() {
  if [[ ! -f "$DIST_DIR/index.html" ]]; then
    echo "Building React client..."
    "$PROJECT_DIR/scripts/build-client.sh"
  fi
}

server_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' < "$PID_FILE"
  fi
}

is_running() {
  local pid
  pid="$(server_pid || true)"
  if [[ -z "${pid:-}" ]]; then
    return 1
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    if [[ -r "/proc/$pid/cmdline" ]]; then
      local cmdline
      cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" || true)"
      if [[ "$cmdline" == *"http.server"* ]]; then
        return 0
      fi
      rm -f "$PID_FILE"
      return 1
    fi
    return 0
  fi
  rm -f "$PID_FILE"
  return 1
}

status_server() {
  local host_for_display
  if [[ "$CLIENT_BIND_ADDRESS" == "0.0.0.0" || "$CLIENT_BIND_ADDRESS" == "::" ]]; then
    host_for_display="localhost"
  else
    host_for_display="$CLIENT_BIND_ADDRESS"
  fi

  if is_running; then
    local pid
    pid="$(server_pid)"
    echo "Client server is running"
    echo "  PID: $pid"
    echo "  URL: http://${host_for_display}:${CLIENT_PORT}"
    echo "  Log: $LOG_FILE"
    return 0
  fi

  echo "Client server is not running"
  echo "  Expected URL: http://${host_for_display}:${CLIENT_PORT}"
  return 1
}

start_background() {
  require_python
  ensure_dist

  mkdir -p "$RUNTIME_DIR"

  if is_running; then
    local pid
    pid="$(server_pid)"
    echo "Client server already running (pid=$pid)"
    return 0
  fi

  cd "$DIST_DIR"
  nohup python3 -m http.server "$CLIENT_PORT" --bind "$CLIENT_BIND_ADDRESS" >>"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Give the process a brief stabilization window. Some environments fail right
  # after spawn (e.g., socket bind denied), so a single immediate check is too optimistic.
  local stable=1
  for _ in $(seq 1 50); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      stable=0
      break
    fi
    sleep 0.1
  done

  if [[ "$stable" != "1" ]]; then
    rm -f "$PID_FILE"
    echo "Failed to start client server on ${CLIENT_BIND_ADDRESS}:${CLIENT_PORT}" >&2
    echo "Check log: $LOG_FILE" >&2
    tail -n 30 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi

  echo "Client server started"
  echo "  PID: $pid"
  echo "  URL: http://${CLIENT_BIND_ADDRESS}:${CLIENT_PORT}"
  echo "  Log: $LOG_FILE"
}

stop_background() {
  if ! is_running; then
    echo "Client server is not running"
    return 0
  fi

  local pid
  pid="$(server_pid)"

  kill "$pid" >/dev/null 2>&1 || true

  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$PID_FILE"
      echo "Client server stopped"
      return 0
    fi
    sleep 0.1
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  echo "Client server force-stopped"
}

run_foreground() {
  require_python
  ensure_dist

  if is_running; then
    local pid
    pid="$(server_pid)"
    echo "Client server is already running in background (pid=$pid)."
    echo "Use ./scripts/serve-client.sh --stop to stop it first." >&2
    exit 1
  fi

  local host_for_display
  if [[ "$CLIENT_BIND_ADDRESS" == "0.0.0.0" || "$CLIENT_BIND_ADDRESS" == "::" ]]; then
    host_for_display="localhost"
  else
    host_for_display="$CLIENT_BIND_ADDRESS"
  fi

  echo "Starting static web server on ${CLIENT_BIND_ADDRESS}:${CLIENT_PORT}"
  echo "URL: http://${host_for_display}:${CLIENT_PORT}"
  echo "Press Ctrl+C to stop..."

  cd "$DIST_DIR"
  python3 -m http.server "$CLIENT_PORT" --bind "$CLIENT_BIND_ADDRESS"
}

case "$MODE" in
  daemon)
    start_background
    ;;
  ensure)
    if is_running; then
      pid="$(server_pid)"
      echo "Client server already running (pid=$pid)"
      exit 0
    fi
    start_background
    ;;
  stop)
    stop_background
    ;;
  status)
    status_server
    ;;
  foreground)
    run_foreground
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
