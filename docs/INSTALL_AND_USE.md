# Install & Use

Rules:
- Do not run `docker compose` directly.
- Do not run `npm run dev`.
- Use project scripts for setup/start/stop/build.

## One-Command Setup

```bash
git clone https://github.com/SarveshPatkr/claw-browser.git
cd claw-browser

# Generate credentials
echo "API_KEY=$(openssl rand -hex 32)" >> .env
echo "VNC_PASSWORD=$(openssl rand -base64 16)" >> .env

./scripts/start.sh
```

## Optional: Global Commands

```bash
sudo ./scripts/install-global-commands.sh

# Then use:
browser-start   # Start browser
browser-stop    # Stop browser
browser-info    # Show connection info
```

## Connect Client

1. Run `./scripts/start.sh`
2. Open `http://localhost:3000` (or the printed host/IP URL)
3. Go to Settings → paste connection line
4. Enter API Key in Settings

Fallback:
- Open `client/dist/index.html` directly if needed.

## Client Server Controls

```bash
./scripts/serve-client.sh --status
./scripts/serve-client.sh --stop
./scripts/serve-client.sh --ensure --daemon --port 3000 --bind 0.0.0.0
```

## CLI Commands

```bash
browser-cmd ls                    # List tabs
browser-cmd nw <url>              # New tab
browser-cmd st --tab <ID>         # Get page state
browser-cmd st --agent --tab <ID> # Compact JSON
browser-cmd clk 1 --tab <ID>      # Click element
browser-cmd in 0 "text" --tab <ID> # Type in input
browser-cmd scr --stdout --tab<ID> # Screenshot
```

## Health Checks

```bash
curl http://localhost:18080/health        # API
curl http://localhost:19222/json/version  # CDP
```

## Stop

```bash
./scripts/stop.sh
```
