#!/usr/bin/env python3
import sys
sys.stderr = open('/tmp/wm-stderr.log', 'w')

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path


import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

print("workspace-manager starting...", flush=True)

DISPLAY = os.environ.get("DISPLAY", ":99")
API_PORT = int(os.environ.get("API_PORT", "8080"))
API_KEY = os.environ.get("API_KEY", "")
PREVIEW_DIR = Path("/usr/share/novnc/tabs")
STATE_PATH = PREVIEW_DIR / "state.json"

ENV = dict(os.environ)
ENV["DISPLAY"] = DISPLAY

print(f"API_PORT = {API_PORT}", flush=True)
if API_KEY:
    print("API auth: enabled", flush=True)
else:
    print("API auth: disabled (API_KEY not set)", flush=True)

# Keep track of last capture time for each window id
last_capture_time = {}
_capture_lock = threading.Lock()
# Track in-flight capture threads so we don't double-capture
_capturing = set()
_capturing_lock = threading.Lock()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle requests in separate threads"""
    daemon_threads = True

class FocusHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    
    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}", flush=True)
    
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _check_api_key(self):
        if not API_KEY:
            return True
        auth_header = self.headers.get("Authorization", "")
        expected = f"Bearer {API_KEY}"
        return auth_header == expected

    def _send_response(self, status, content=b"", content_type="text/plain"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self._cors()
        self.end_headers()
        if content:
            self.wfile.write(content)
        self.wfile.flush()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        print(f"GET {self.path}", flush=True)
        
        parsed = urlparse(self.path)
        if not self._check_api_key():
            self._send_response(401, b"Unauthorized", "text/plain")
            return

        if parsed.path == "/health":
            payload = {
                "status": "ok",
                "apiPort": API_PORT,
                "endpoints": ["/health", "/tabs/state.json", "/focus", "/close", "/auth/check"]
            }
            self._send_response(200, json.dumps(payload).encode("utf-8"), "application/json")
            return

        if parsed.path == "/auth/check":
            self._send_response(200, b"OK")
            return
            
        if parsed.path == "/focus":
            qs = parse_qs(parsed.query)
            wid = qs.get("id", [""])[0]
            if wid:
                subprocess.Popen(["wmctrl", "-i", "-a", wid], env=ENV)
            self._send_response(200, b"OK")
            return
             
        if parsed.path == "/close":
            qs = parse_qs(parsed.query)
            wid = qs.get("id", [""])[0]
            if wid:
                subprocess.Popen(["wmctrl", "-i", "-c", wid], env=ENV)
            self._send_response(200, b"OK")
            return
        
        if parsed.path == "/tabs/state.json":
            try:
                with open(STATE_PATH, 'rb') as f:
                    content = f.read()
                self._send_response(200, content, "application/json")
            except Exception as e:
                print(f"Error reading state: {e}", flush=True)
                self._send_response(404, b"Not Found")
            return
        
        self._send_response(404, b"Not Found")

def run_focus_server():
    print("Creating server...", flush=True)
    server = ThreadedHTTPServer(("0.0.0.0", API_PORT), FocusHandler)
    print(f"Server listening on port {API_PORT}", flush=True)
    server.serve_forever()

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, env=ENV)


def quiet(cmd):
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV)


def parse_windows():
    result = run(["wmctrl", "-lpGx"])
    if result.returncode != 0:
        return []

    windows = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 8)
        if len(parts) < 9:
            continue

        wid = parts[0]
        wm_class = parts[7].lower()
        if "chromium" not in wm_class:
            continue

        title = parts[8].strip()
        windows.append({"id": wid, "title": title})

    return windows


def active_window_id():
    result = run(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    if result.returncode != 0:
        return ""
    token = result.stdout.strip().split()[-1].lower()
    if not token.startswith("0x"):
        return ""
    return "0x" + token[2:].upper().rjust(8, "0")


def write_placeholder(index):
    out = PREVIEW_DIR / f"tab{index}.jpg"
    quiet(
        [
            "convert",
            "-size",
            "360x210",
            "gradient:#0f172a-#1e293b",
            str(out),
        ]
    )


def capture_preview(window_id, index):
    """Capture a window screenshot and save as JPEG. Runs in a background thread."""
    out = PREVIEW_DIR / f"tab{index}.jpg"

    # Use xwd because it's significantly faster than import
    xwd_proc = subprocess.Popen(["xwd", "-id", window_id, "-silent"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV)
    convert_proc = subprocess.Popen([
        "convert",
        "xwd:-",
        "-resize", "360x210^",
        "-gravity", "center",
        "-extent", "360x210",
        "-strip",
        "-quality", "75",
        str(out)
    ], stdin=xwd_proc.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV)
    
    xwd_proc.stdout.close()
    convert_proc.communicate()

    if convert_proc.returncode != 0:
        raw = PREVIEW_DIR / f".tab{index}.raw.png"
        # Fallback to import if xwd fails
        first = run(["import", "-window", window_id, str(raw)])
        if first.returncode != 0:
            write_placeholder(index)
        else:
            second = run(
                [
                    "convert",
                    str(raw),
                    "-resize", "360x210^",
                    "-gravity", "center",
                    "-extent", "360x210",
                    "-strip",
                    "-quality", "75",
                    str(out),
                ]
            )
            quiet(["rm", "-f", str(raw)])

            if second.returncode != 0:
                write_placeholder(index)

    with _capture_lock:
        last_capture_time[window_id] = time.time()
    with _capturing_lock:
        _capturing.discard(window_id)


def fetch_cdp_targets():
    try:
        req = urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=1)
        return json.loads(req.read().decode("utf-8"))
    except:
        return []

def cdp_ws_to_path(ws_url):
    if not ws_url:
        return ""
    try:
        parsed = urlparse(ws_url)
        if parsed.path:
            suffix = parsed.path
            if parsed.query:
                suffix += f"?{parsed.query}"
            return suffix
    except:
        pass
    if ws_url.startswith("/"):
        return ws_url
    return f"/{ws_url.lstrip('/')}"

def fetch_browser_ws():
    try:
        req = urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)
        data = json.loads(req.read().decode("utf-8"))
        ws = data.get("webSocketDebuggerUrl", "")
        return cdp_ws_to_path(ws)
    except:
        return ""

def write_state(windows, active_hex):
    payload = {"tabs": []}
    
    cdp_targets = fetch_cdp_targets()
    browser_ws = fetch_browser_ws()
    payload["browserWsUrl"] = browser_ws

    # Track matched targets so we don't map same target to multiple windows if titles match
    matched_ids = set()

    for idx, window in enumerate(windows, start=1):
        window_hex = "0x" + window["id"][2:].upper().rjust(8, "0")
        
        # Match CDP target
        matched_target = None
        clean_title = window["title"].replace(" - Chromium", "").strip()
        
        # Exact match first
        for target in cdp_targets:
            if target.get("type") == "page" and target.get("id") not in matched_ids:
                if clean_title == target.get("title", ""):
                    matched_target = target
                    break
                    
        # Partial match
        if not matched_target:
            for target in cdp_targets:
                if target.get("type") == "page" and target.get("id") not in matched_ids:
                    t_title = target.get("title", "")
                    if clean_title in t_title or t_title in clean_title:
                        matched_target = target
                        break
        
        # Fallbacks for new blank tabs
        if not matched_target and clean_title in ("New Tab", "about:blank"):
            for target in cdp_targets:
                if target.get("type") == "page" and target.get("id") not in matched_ids:
                    if target.get("url") in ("chrome://newtab/", "about:blank"):
                        matched_target = target
                        break
                        
        if matched_target:
            matched_ids.add(matched_target["id"])
            ws_url = matched_target.get("webSocketDebuggerUrl")
            ws_url = cdp_ws_to_path(ws_url)

        out_path = PREVIEW_DIR / f"tab{idx}.jpg"
        ts = int(os.path.getmtime(out_path) * 1000) if out_path.exists() else int(time.time() * 1000)

        import re
        clean_fallback_title = re.sub(r'^\(/home/browser/[^)]+\)\.?\s*', '', window["title"])
        
        tab_data = {
            "index": idx,
            "id": window["id"],
            "title": matched_target["title"] if matched_target else clean_fallback_title,
            "active": window_hex == active_hex,
            "preview": f"/tabs/tab{idx}.jpg?t={ts}",
            "cdpId": matched_target["id"] if matched_target else None,
            "url": matched_target["url"] if matched_target else "",
            "wsUrl": ws_url if matched_target else None
        }
        
        payload["tabs"].append(tab_data)

    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(STATE_PATH)


# Capture interval: capture a fresh preview every 4 seconds per window
CAPTURE_INTERVAL = 4.0

def main():
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    
    threading.Thread(target=run_focus_server, daemon=True).start()

    while True:
        windows = parse_windows()
        active_hex = active_window_id()

        if not windows:
            write_placeholder(1)
            write_state([], "")
            time.sleep(1.0)
            continue

        # Write state FIRST so the frontend always has fresh metadata
        write_state(windows, active_hex)

        # Kick off captures in background threads — never block the state loop
        now = time.time()
        for idx, window in enumerate(windows, start=1):
            wid = window["id"]

            with _capture_lock:
                last_cap = last_capture_time.get(wid, 0)

            with _capturing_lock:
                already_capturing = wid in _capturing

            if already_capturing:
                continue  # Previous capture still running, skip

            if (now - last_cap) >= CAPTURE_INTERVAL:
                with _capturing_lock:
                    _capturing.add(wid)
                t = threading.Thread(
                    target=capture_preview,
                    args=(wid, idx),
                    daemon=True
                )
                t.start()

        time.sleep(1.0)


if __name__ == "__main__":
    main()
