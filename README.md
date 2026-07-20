# Orkestr Lite

> **An always-on Codex workstation you can reach from the browser or WhatsApp.**

[![CI](https://github.com/otcan/orkestr-lite/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/otcan/orkestr-lite/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/otcan/orkestr-lite)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Linux%20AMD64-8ef0b5)
[![OpenAI Build Week](https://img.shields.io/badge/OpenAI-Build%20Week-111827)](https://openai.devpost.com/)

Codex can do serious agentic work. The unreliable part is everything around it: keeping a machine available, running work on a schedule, preserving browser state, connecting messaging, recovering after disconnects, and bringing the human back when judgment is needed.

**Orkestr Lite packages that operational layer into one self-hosted Docker application.**

Send work manually, from your own WhatsApp chat, or on a timer. Codex handles it inside a persistent Ubuntu workstation. Watch the desktop live, take control when needed, and come back to the same conversation, browser, files, terminal, and results.

**Codex does the work. Orkestr keeps the workstation running.**

## One workstation, one continuous thread

Orkestr Lite deliberately avoids project hierarchies and orchestration graphs. It gives one user one continuous Codex conversation attached to one persistent workspace.

```mermaid
flowchart LR
    Web["Browser"] --> Orkestr["Orkestr Lite"]
    WhatsApp["WhatsApp self-chat"] --> Orkestr
    Schedule["Once, hourly, daily, weekly"] --> Orkestr

    Orkestr --> Codex["One Codex conversation"]
    Codex --> Desk["Persistent Ubuntu workstation"]

    Desk --> Browser["Chromium"]
    Desk --> Terminal["Terminal"]
    Desk --> Files["Files"]

    Codex --> Results["History and results"]
    Results --> Web
    Results --> WhatsApp
```

Every input enters the same sequential queue and reaches the same context. Work started from WhatsApp is visible in the browser. Scheduled work joins the conversation instead of disappearing into a separate automation log. Closing the browser does not close the workstation.

## What you can do

### Start work from the web or WhatsApp

Use the web chat, or link WhatsApp as a companion device by scanning a QR code. Messages sent to your own WhatsApp chat enter Orkestr, and results return to that chat. No second phone number or group is required.

### Run work now or later

Create one-time, hourly, daily, or weekly timers. Scheduled messages use the same queue as manual requests and can be paused, edited, run immediately, or deleted.

### Give Codex a real workstation

The optional **Live Desk** includes Ubuntu, XFCE, Chromium, a terminal, and a file manager. Browser data persists between runs. Watch Codex use the environment, open the desk full-screen, or explicitly take control of the keyboard and mouse.

### Work with the same files and terminal

The browser interface exposes a real PTY terminal and the persistent workspace. Browse, upload, download, attach, and share files without moving work into a second tool.

### Recover honestly

Conversation history, queued work, schedules, files, Codex state, and browser data live in Docker volumes. If execution is interrupted, Orkestr preserves the evidence and avoids silently replaying uncertain work.

## What is it useful for?

Orkestr Lite is an operational layer, not a workflow-specific bot. For example:

- **Outreach:** research contacts, prepare follow-ups, and bring drafts back for review.
- **Job search:** review opportunities, prepare application material, and revisit the pipeline on a schedule.
- **Messaging:** inspect unresolved conversations, prepare replies, and ask for a decision when needed.
- **Recurring checks:** inspect a site, repository, queue, or report hourly, daily, or weekly and explain what changed.
- **Browser work:** keep an authenticated browser profile available when an API is not enough.

These are examples, not built-in LinkedIn or job-board integrations. External services remain subject to their own authentication, policies, and approval requirements.

## Product surface

| Surface | What it does |
| --- | --- |
| **Chat** | Send instructions and follow one continuous Codex conversation. |
| **Desk** | Watch the Ubuntu desktop, use Chromium, or take control. |
| **Files** | Inspect, upload, download, attach, and share workspace files. |
| **Terminal** | Work directly inside the same environment through a real PTY. |
| **Timers** | Schedule one-time, hourly, daily, or weekly messages. |
| **Settings** | Connect Codex and WhatsApp and manage the workstation. |

Diagnostics and raw Codex events remain available when needed, but they are not the product experience.

## Quickstart

### Requirements

- Linux AMD64, or Docker Desktop with Linux containers
- Docker Engine with Docker Compose v2
- an OpenAI account with Codex access
- 4 GB RAM for headless operation
- 8 GB RAM recommended for Live Desk

### Start the complete workstation

```bash
git clone https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
docker compose --profile desk up --build
```

Open <http://localhost:3000>.

On first boot, Orkestr generates an administrator password and prints it once in the local container logs:

```bash
docker compose logs orkestr
```

Then:

1. Sign in to Orkestr.
2. Connect Codex with ChatGPT device authentication or an API key.
3. Optionally link WhatsApp by scanning the QR code.
4. Open **Chat** and send the first request.
5. Open **Desk** to watch the workstation or take control.

### Headless mode

If you do not need the graphical desktop:

```bash
docker compose up --build
```

Chat, WhatsApp, timers, files, terminal, persistence, and the Codex workspace remain available.

## Try one complete loop

Start manually in Chat:

> Inspect the workspace, explain its current state, and tell me what needs attention first.

Then create a timer:

> Every Monday at 09:00, review the workspace and summarize anything that requires action.

Or send this to your own linked WhatsApp chat:

> Review the open work and send me the three most important next actions.

All three inputs enter the same conversation. Open **Desk** while Codex is working to see the environment it is using, then inspect the resulting files and terminal output directly.

## How it works

Orkestr Lite is a modular monolith with an optional desktop runtime:

```mermaid
flowchart TB
    Inputs["Web, WhatsApp, timers"] --> API["Authenticated control plane"]
    API --> Store[("SQLite WAL")]
    API --> Codex["Codex app-server"]
    Codex --> Workspace["Persistent workspace"]
    API --> PTY["PTY terminal"]
    API --> Desk["XFCE, Chromium, noVNC"]
```

NestJS owns authentication, queueing, schedules, persistence, recovery, and the Codex process boundary. Angular provides the browser experience. Codex app-server runs the conversation and streams structured activity. SQLite stores operational state without an external database, and `whatsapp-web.js` provides the linked-device self-chat bridge.

Only port `3000` is published. Codex app-server, the Desk agent, and VNC are not exposed directly.

## Built for OpenAI Build Week

Orkestr Lite was built with Codex as the primary implementation environment and is submitted to the **Work & Productivity** track.

Codex accelerated the app-server integration, persistent conversation controller, WhatsApp router, scheduler, terminal, file handling, Live Desk, Docker packaging, security boundaries, and automated verification. The product itself runs through Codex app-server, discovers the models available to the authenticated account, and records both the requested and effective model.

The product decisions remained human-owned: one user, one conversation, serialized execution, explicit recovery, an optional graphical desk, and WhatsApp self-chat instead of a second phone number.

<details>
<summary><strong>Verification commands</strong></summary>

```bash
npm ci
npx playwright install chromium
npm run check:release
npm run test:docker
```

The automated suite covers the product walkthrough, Codex protocol lifecycle, persistence and recovery, timers, WhatsApp routing, workspace boundaries, authentication, production builds, and clean Docker restart.

</details>

## Security and current scope

Orkestr Lite is a powerful local application. Access to it is equivalent to shell access to its workspace.

- Port `3000` binds to loopback by default.
- The application runs unprivileged with Linux capabilities dropped and `no-new-privileges` enabled.
- Codex credentials and WhatsApp session state stay in private persistent volumes.
- The Docker socket is never mounted.
- The source build is single-user and intended for private, self-hosted deployment.
- Live Desk is an isolated desktop container, not a virtual machine or hard multi-tenant boundary.

Do not expose Orkestr directly to the public internet. Read [Security](SECURITY.md) before changing the deployment boundary.

Current limits are intentional: one user, one active Codex conversation, and one workspace per installation; Linux AMD64 is the verified target; timers support once, hourly, daily, and weekly schedules; and WhatsApp uses the user's linked-device session and self-chat. Orkestr does not bypass CAPTCHAs, service policies, or authentication requirements.

## License

[Apache-2.0](LICENSE)
