# Orkestr Lite

## An operational runtime for Codex

Orkestr Lite is self-hosted infrastructure around Codex: one persistent Ubuntu
workstation, one visible conversation, and local controls for files, terminal,
Desk, schedules, and WhatsApp. It does not replace Codex or imitate its agentic
capabilities. Codex does the work; Orkestr keeps the workstation observable,
recoverable, and reachable from the browser or your linked self-chat.

[![CI](https://github.com/otcan/orkestr-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/otcan/orkestr-lite/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.2.0--build--week-7bd3ab)](https://github.com/otcan/orkestr-lite/releases/tag/v0.2.0-build-week)

## What the workstation includes

- one shared Codex conversation at `/chat`, fed by browser messages,
  WhatsApp self-chat, and schedules;
- an Ubuntu 24.04 Desk with Chromium, XFCE, tmux, Byobu, passwordless `sudo`,
  git, ripgrep, jq, and Codex;
- an interactive xterm terminal and a whole-container Files view with upload
  and download;
- durable FIFO work, browser idempotency, queue positions, cancellation, and
  recovery after process or container interruption;
- WhatsApp Linked Device QR, five-second message batching, files in both
  directions, a durable at-least-once outbox, and exact supervision commands;
- once, interval, hourly, daily, weekly, and five-field cron schedules with
  timezone-aware previews, a five-minute floor, overlap coalescing, and missed
  run accounting;
- visible Codex model/effort selection, GPT-5.6 provenance, context usage, and
  automatic/manual compaction.

The product is deliberately single-user and local. Port 3000 binds to loopback;
the Desk agent, VNC, and Codex app-server remain on the private Compose network.
There are no webhooks, public automation endpoints, hosted instances, or
public-API claims.

## Start v0.2

Requirements: Docker Engine with Compose v2 and an eligible Codex account.

```bash
git clone --branch v0.2.0-build-week --depth 1 https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
docker compose --profile desk up -d
docker compose logs orkestr
```

Open <http://localhost:3000>. On first boot the local logs print a generated
administrator password unless `ORKESTR_ADMIN_PASSWORD` was supplied. Complete
the Workstation setup, authenticate Codex through the official device flow,
and optionally scan the WhatsApp Linked Device QR.

To build the current checkout instead of pulling the immutable pair:

```bash
docker compose --profile desk up --build -d
```

Persistent volumes hold the control database, Codex login, workspace, Desk
home/browser state, and private Desk token. A normal restart does not discard
them.

## WhatsApp supervision

Only the linked account’s self-chat can submit work or control it. Other direct
chats are retained as a read-only local inbox snapshot for Codex; groups and
status broadcasts are ignored.

Commands must be the entire self-chat message:

```text
status
status CODE
stop CODE
approve CODE
decline CODE
help
```

Every actionable conversation turn gets an eight-character code. Commands are
deduplicated by WhatsApp message ID, audited on the turn, and answered through
the durable outbox. Normal prose, including sentences containing words such as
“status” or “stop,” continues to Codex.

## Research demo

The v0.2 public story is a real GPT-5.6 research workflow comparing the official
runtime documentation for
[OpenHands](https://docs.openhands.dev/openhands/usage/architecture/runtime),
[Open Interpreter](https://www.openinterpreter.com/docs/terminal/getting-started),
and [goose](https://goose-docs.ai/docs/getting-started/installation/). It writes
cited Markdown and HTML reports, opens the HTML in Desk, accepts a sourced
WhatsApp follow-up with the updated Markdown returned as a file, and runs a
weekly watch through the same conversation.

```bash
export ORKESTR_LIVE_PASSWORD='your local administrator password'
export ORKESTR_LIVE_WORKSPACE='/absolute/path/to/the-mounted-workspace'
npm run demo
npm run demo:verify
```

`demo:reset` removes only the three v0.2 demo artifacts and refuses to run
unless the target workspace contains `.orkestr-demo-disposable` with the exact
value `orkestr-lite-demo-v0.2`. See [JUDGE_GUIDE.md](JUDGE_GUIDE.md) and the
[demo runbook](docs/DEMO.md). The deterministic clamp fixture remains in
`demo/workspace` as regression infrastructure; it is not presented as the
product demo.

## Development and release gates

```bash
npm ci
npm run check
npm run test:docker
npm run check:release
```

The immutable release publishes a paired Linux AMD64 runtime:

- control: `ghcr.io/otcan/orkestr-lite:v0.2.0-build-week`
- Desk: `ghcr.io/otcan/orkestr-lite:v0.2.0-build-week-desk`

The tag workflow builds and attests both images, starts the published digests
together, verifies health/private networking/VNC authentication/tools/restarts/
persistence, and records both digests plus the source SHA in one release.
`v0.1.0-build-week` remains unchanged.

## Trust boundary and limitations

Orkestr grants Codex full access inside its isolated workstation by default.
That is convenient and intentionally powerful: keep untrusted secrets out of
prompts, review external side effects, and treat the persistent volumes as
sensitive. WhatsApp cannot bypass the linked self-chat boundary, browser APIs
remain session/CSRF protected, and no service is meant to be exposed online.

The `orkestr` process starts as UID 1000, but the single local operator can use
passwordless `sudo` in Terminal and Desk. System packages installed at runtime
survive an ordinary container restart but not an image upgrade or container
recreation; bake tools needed permanently into a custom image.

This release supports one operator, one shared workspace/conversation, and one
active Codex turn. WhatsApp delivery is at least once, so a rare duplicate is
preferred to a silent loss. Live research depends on current network access and
the user’s eligible Codex authentication. See [SECURITY.md](SECURITY.md),
[architecture](docs/ARCHITECTURE.md), and [release operations](docs/RELEASE.md).
