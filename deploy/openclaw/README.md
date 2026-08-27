# OpenClaw hosting

This reference gateway pins OpenClaw `2026.7.1-2` and Node `24.15.0`. Its typed `brain_*` tools call the shared core; it has no second wiki or knowledge database. The gateway exposes only the second-brain plugin plus OpenClaw's `web_search` and `web_fetch` tools. The plugin blocks both native web tools until the owner has approved web research for the active question.

## Start one brain

```bash
cp .env.example .env
openssl rand -hex 32
# Put the result in OPENCLAW_GATEWAY_TOKEN and add provider credentials.
docker compose -f deploy/openclaw/compose.yaml up --build -d
docker compose -f deploy/openclaw/compose.yaml ps
```

Open `http://127.0.0.1:18789`. The host port is loopback-only, while the gateway binds `lan` inside its isolated Docker network so the published port works. The health check uses `/readyz`.

## Multiple independent brains

Run the compose file from each clone with a unique project and host port:

```bash
OPENCLAW_GATEWAY_PORT=18790 docker compose \
  -p astronomy-brain \
  -f deploy/openclaw/compose.yaml up --build -d
```

The compose project name gives every brain a separate `openclaw-runtime` volume. Each repository bind mount remains its only canonical knowledge store.

## Remote access

Keep the published socket on loopback. Tunnel it over SSH:

```bash
ssh -L 18789:127.0.0.1:18789 user@brain-host
```

For Tailscale, use Tailscale SSH and the same local forward. This avoids exposing the gateway directly on a public or tailnet interface while retaining token authentication.

## Persistence and restart

`docker compose restart` preserves both the repository and the named runtime volume. Removing the runtime volume discards only OpenClaw operational state; `sources/`, `wiki/`, and tracked `.brain` data live in the repository mount. Stop active operations cleanly before deleting any runtime volume.

Secrets enter through environment variables and are not written to the repository. Do not commit `.env`.

## Web research approval

For each question, the agent must first request web research approval after exhausting the wiki and local sources. OpenClaw then presents one owner approval control covering that question's web research. Only after approval can the active session call `web_search` or `web_fetch`; captured evidence is still written through the shared immutable-source workflow.
