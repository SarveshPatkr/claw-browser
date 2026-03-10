#!/usr/bin/env bash
set -euo pipefail

curl -fsS http://127.0.0.1:9222/json/version >/dev/null
pgrep -x Xvfb >/dev/null
pgrep -x x11vnc >/dev/null
pgrep -f novnc_proxy >/dev/null
