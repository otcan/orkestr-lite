# Orkestr Lite judge guide

Orkestr Lite is a self-hosted operating layer around Codex. It gives one Codex
conversation a persistent workspace, an optional Ubuntu Desk, WhatsApp access,
and flexible schedules.

Start with the [screenshot walkthrough](demo.html). It shows the complete real
GPT-5.6 demonstration without requiring setup.

## Run the product

Requirements: Docker with Compose, 8 GB RAM for the Desk, and an OpenAI account
with Codex access.

```bash
git clone --depth 1 https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
docker compose --profile desk up --build -d
docker compose logs orkestr
```

Open <http://localhost:3000> and use the generated local administrator password
from the logs. Complete Workstation setup and authenticate Codex. WhatsApp is
optional.

Only loopback port 3000 is published. The Desk, VNC, and Codex app-server remain
on the private Compose network.

## Five-minute product tour

1. Open **Chat** and send a request. This is one continuous Codex conversation.
2. Open **Desk** to inspect the Ubuntu workstation and Chromium, or take control.
3. Open **Files** to inspect, upload, download, or attach workspace artifacts.
4. Open **Terminal** to use the real PTY in the same environment.
5. Open **Timers** and preview a once, interval, daily, weekly, or cron schedule.
6. Optionally link WhatsApp in **Settings** and send work from your self-chat.

Browser, WhatsApp, and timer inputs enter the same serialized queue and return
to the same visible history.

## Reproduce the public demo

Follow [docs/DEMO.md](docs/DEMO.md). The live workflow asks GPT-5.6 to research
three official sources, creates cited Markdown and HTML reports, opens the HTML
inside Desk, accepts a WhatsApp follow-up, returns the updated file, and runs a
weekly review through the same conversation.

```bash
npm run demo:verify
```

The verifier checks the source links, both report artifacts, requested and
effective GPT-5.6 model provenance, the WhatsApp output attachment, and the
completed scheduled turn.

## Inspect the boundary

```bash
docker compose ps
docker compose exec orkestr id
docker compose exec orkestr-desk id
docker compose exec orkestr-desk sh -lc 'tmux -V; codex --version; chromium --version'
npm run test:docker:pair
```

Read [SECURITY.md](SECURITY.md) before changing the local-only deployment
boundary.
