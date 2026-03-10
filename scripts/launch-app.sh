#!/usr/bin/env bash
chromium --app=about:blank \
  --start-maximized \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --remote-allow-origins=* \
  --force-app-mode \
  --disable-extensions-except=/home/browser/extensions/tab-to-window \
  --load-extension=/home/browser/extensions/tab-to-window \
  --user-data-dir=/home/browser/.config/chromium
