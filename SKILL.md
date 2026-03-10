# Claw Browser skill

AI agent browser automation. State-first workflow.

## Setup

```bash
# Install CLI (optional - also works without)
sudo ./scripts/install-global-commands.sh

# Start
./scripts/start.sh
```

Optional `.env` overrides:

```bash
echo "API_KEY=$(openssl rand -hex 32)" >> .env
echo "VNC_PASSWORD=$(openssl rand -base64 16)" >> .env
```

Rules:
- Never use `docker compose` directly; use scripts only.
- Never use `npm run dev`; use `./scripts/build-client.sh`.
- `./scripts/start.sh` auto-starts the client server on `http://localhost:3000`.

## Credentials

- `API_KEY` in `.env` (optional) - enables API auth
- Configure in client Settings

## Commands

```bash
browser-cmd ls                          # List tabs
browser-cmd nw [url]                    # New tab
browser-cmd st --tab <ID>               # Page state
browser-cmd st --agent --tab <ID>       # Compact JSON
browser-cmd clk <target> --tab <ID>     # Click
browser-cmd in <target> <text> --tab <ID> # Input
browser-cmd scr --stdout --tab <ID>    # Screenshot
```

## Workflow

1. `browser-cmd ls` → get tab ID
2. `browser-cmd st --tab <ID>` → see page
3. `browser-cmd clk <n> --tab <ID>` → interact
4. Re-run `st` to see results

## Tips

- Use `--limit 20` to reduce output
- Use `--agent` flag for compact JSON
- Use `--id` or `--selector` for precise clicks
