#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_WIDTH="${SCREEN_WIDTH:-1920}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-1080}"
SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
BROWSER_START_URL="${BROWSER_START_URL:-about:blank}"
CHROMIUM_NO_SANDBOX="${CHROMIUM_NO_SANDBOX:-1}"
CHROMIUM_FLAGS="${CHROMIUM_FLAGS:-}"
CHROMIUM_PROFILE_DIR="${CHROMIUM_PROFILE_DIR:-/home/browser/.config/chromium}"
TAB_TO_WINDOW="${TAB_TO_WINDOW:-1}"
CHROMIUM_APP_MODE="${CHROMIUM_APP_MODE:-1}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
API_KEY="${API_KEY:-}"

export DISPLAY=":${DISPLAY_NUM}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-${UID}}"
export GTK_THEME="${GTK_THEME:-Adwaita}"
export XCURSOR_THEME="${XCURSOR_THEME:-Adwaita}"
export XCURSOR_SIZE="${XCURSOR_SIZE:-24}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p /tmp/.X11-unix || true
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" || true

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac +extension RANDR &
pids+=("$!")

for _ in $(seq 1 40); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  if [[ -n "${DBUS_SESSION_BUS_PID:-}" ]]; then
    pids+=("$DBUS_SESSION_BUS_PID")
  fi
fi

openbox-session >/tmp/openbox.log 2>&1 &
pids+=("$!")

API_PORT="${API_PORT:-8080}"

# Set up VNC password if provided
if [[ -n "$VNC_PASSWORD" ]]; then
  echo "$VNC_PASSWORD" | x11vnc -storepasswd - /tmp/vnc.passwd 2>/dev/null
  x11vnc_passwd_arg="-passwdfile /tmp/vnc.passwd"
else
  x11vnc_passwd_arg="-nopw"
fi

x11vnc \
  -display "$DISPLAY" \
  -forever \
  -shared \
  -rfbport 5900 \
  $x11vnc_passwd_arg \
  -xkb \
  -noxdamage \
  -nowf \
  -noscr \
  -cursor arrow >/tmp/x11vnc.log 2>&1 &
pids+=("$!")

# Wait for x11vnc to start
sleep 2

# Run novnc_proxy for WebSocket proxy (no web files, just proxy)
/usr/share/novnc/utils/novnc_proxy --web /usr/share/novnc --listen 6080 --vnc localhost:5900 >/tmp/novnc.log 2>&1 &
pids+=("$!")

CONTAINER_IP="$(hostname -i | awk '{print $1}')"
if [[ -n "$CONTAINER_IP" ]]; then
  socat TCP4-LISTEN:9222,bind="$CONTAINER_IP",fork,reuseaddr TCP4:127.0.0.1:9222 >/tmp/cdp-socat.log 2>&1 &
  pids+=("$!")
fi

/usr/local/bin/workspace-manager.py >/tmp/workspace-manager.log 2>&1 &
pids+=("$!")

start_browser() {
  rm -f \
    "${CHROMIUM_PROFILE_DIR}/SingletonLock" \
    "${CHROMIUM_PROFILE_DIR}/SingletonSocket" \
    "${CHROMIUM_PROFILE_DIR}/SingletonCookie" || true

  chromium_args=(
    --disable-dev-shm-usage
    --disable-gpu
    --ozone-platform=x11
    --no-first-run
    --no-default-browser-check
    --no-pings
    --media-router=0
    --password-store=basic
    --enable-features=OverlayScrollbar
    --enable-smooth-scrolling
    --force-color-profile=srgb
    --remote-debugging-address=0.0.0.0
    --remote-debugging-port=9222
    --remote-allow-origins=*
    --user-data-dir="${CHROMIUM_PROFILE_DIR}"
    --start-maximized
    --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}"
    --window-position=0,0
    --force-app-mode
    --noerrdialogs
    --disable-features=ProfileErrorBrowserTest
  )

  if [[ "$CHROMIUM_APP_MODE" == "1" ]]; then
    chromium_args+=("--app=${BROWSER_START_URL}")
  else
    chromium_args+=("${BROWSER_START_URL}")
  fi

  if [[ "$TAB_TO_WINDOW" == "1" ]]; then
    chromium_args+=(
      --disable-extensions-except=/home/browser/extensions/tab-to-window
      --load-extension=/home/browser/extensions/tab-to-window
    )
  fi

  if [[ "$CHROMIUM_NO_SANDBOX" == "1" ]]; then
    chromium_args+=(--no-sandbox)
  fi

  if [[ -n "$CHROMIUM_FLAGS" ]]; then
    extra_chromium_args=($CHROMIUM_FLAGS)
    chromium_args+=("${extra_chromium_args[@]}")
  fi

  chromium \
    "${chromium_args[@]}" >>/tmp/chromium.log 2>&1
}

(
  while true; do
    if ! start_browser; then
      echo "Chromium exited with error; restarting in 2s..." >>/tmp/chromium.log
    else
      echo "Chromium exited; restarting in 2s..." >>/tmp/chromium.log
    fi
    sleep 2
  done
) &
browser_loop_pid="$!"
pids+=("$browser_loop_pid")

echo "Virtual desktop started on DISPLAY=${DISPLAY}"
echo "Ports: VNC=6080, CDP=9222, API=${API_PORT}"
echo "Client: open host file client/dist/index.html (build with ./scripts/build-client.sh)"

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "Process ${pid} died; shutting down" >&2
      exit 1
    fi
  done
  sleep 2
done
