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

BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
RAW_VNC_HOST_PORT="${RAW_VNC_HOST_PORT:-15900}"
VNC_WS_HOST_PORT="${VNC_WS_HOST_PORT:-16080}"
CDP_HOST_PORT="${CDP_HOST_PORT:-19222}"
API_HOST_PORT="${API_HOST_PORT:-18080}"

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

PRIMARY_HOST="localhost"
if [[ "$BIND_ADDRESS" != "127.0.0.1" ]]; then
  PRIMARY_HOST="$(get_primary_ip)"
fi

API_KEY_VALUE="${API_KEY:-}"
if [[ -n "$API_KEY_VALUE" ]]; then
  CONNECT_LINE="bt://${PRIMARY_HOST}?api=${API_HOST_PORT}&vnc=${VNC_WS_HOST_PORT}&cdp=${CDP_HOST_PORT}&path=websockify&key=${API_KEY_VALUE}"
else
  CONNECT_LINE="bt://${PRIMARY_HOST}?api=${API_HOST_PORT}&vnc=${VNC_WS_HOST_PORT}&cdp=${CDP_HOST_PORT}&path=websockify"
fi

echo "Engine ports"
echo "  API:      http://${PRIMARY_HOST}:${API_HOST_PORT}"
echo "  VNC WS:   ws://${PRIMARY_HOST}:${VNC_WS_HOST_PORT}/websockify"
echo "  CDP:      http://${PRIMARY_HOST}:${CDP_HOST_PORT}"
echo "  Raw VNC:  ${PRIMARY_HOST}:${RAW_VNC_HOST_PORT}"
echo ""
echo "Connection line"
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
