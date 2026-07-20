# Orkestr Lite v0.2 — judge guide

Orkestr Lite is a local operational runtime around Codex. It pairs a browser
control plane with a private Ubuntu Desk; it is not a hosted service and does
not expose a webhook or public automation API.

## Start the immutable pair

```bash
git clone --branch v0.2.0-build-week --depth 1 https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
docker compose --profile desk up -d
docker compose logs orkestr
```

Open <http://localhost:3000>, use the generated local administrator password,
complete Workstation setup, and authenticate Codex. The only published port is
loopback port 3000; Desk/VNC/app-server stay private.

## Five-minute product tour

1. `/chat`: one conversation, GPT-5.6 model/effort, YOLO state, durable queue,
   activity, context usage, attachments, and WhatsApp control codes.
2. `/desk`: interactive Ubuntu 24.04 XFCE/Chromium workstation.
3. `/terminal`: real xterm PTY; try `tmux -V`, `codex --version`, and `rg --version`.
4. `/files`: browse the whole container; upload/download and explicitly send an
   allowed file to the linked self-chat.
5. `/timers`: preview interval or five-field cron schedules; Run now enters the
   same conversation and overlapping work returns 409/skips occurrences.
6. `/settings`: Linked Device QR, account name/number, outbox recovery,
   WhatsApp command reference, Desk health, and context compaction.

## Verify the real research demo

Follow [docs/DEMO.md](docs/DEMO.md). The live workflow creates:

```text
/workspace/reports/agent-runtime-landscape.md
/workspace/reports/agent-runtime-landscape.html
/workspace/.orkestr/demo-evidence-v0.2.json
```

Then run `npm run demo:verify`. It checks official source links, both artifacts,
GPT-5.6 requested/effective provenance, the WhatsApp output attachment, and the
completed scheduled turn.

## Inspect the release

```bash
docker compose ps
docker compose exec orkestr id
docker compose exec orkestr-desk id
docker compose exec orkestr sh -lc 'tmux -V; codex --version; chromium --version'
npm run test:docker:pair
```

Published images:

- `ghcr.io/otcan/orkestr-lite:v0.2.0-build-week`
- `ghcr.io/otcan/orkestr-lite:v0.2.0-build-week-desk`

The GitHub release records both immutable digests, their attestations, source
SHA, checksums, limitations, and the exact Compose command. The prior
`v0.1.0-build-week` release is preserved unchanged.
