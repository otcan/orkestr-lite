# OpenAI Build Week provenance

## Submission

- **Project:** Orkestr Lite
- **Repository:** `otcan/orkestr-lite`
- **Category:** Work & Productivity
- **Build period:** July 18 to July 21, 2026
- **Primary Codex implementation session:**
  `019f745b-ee85-7533-b151-e25c7baff729`
- **Runtime model used in the public demo:** `gpt-5.6-sol`

## What Orkestr Lite is

Orkestr Lite is a self-hosted operating layer around Codex. It gives one user
one continuous Codex conversation attached to a persistent workspace and an
optional Ubuntu Desk. Work can enter manually from the browser, from the user's
own WhatsApp self-chat, or from a one-time or recurring schedule.

The product is intentionally small:

- one user;
- one Codex conversation;
- one serialized work queue;
- one persistent workspace;
- one optional graphical Desk; and
- browser, WhatsApp, and scheduled inputs.

## What existed before Build Week

The broader Orkestr project had already explored persistent agent sessions,
remote supervision, WhatsApp routing, timers, and managed desktops. That work
provided product experience and the reason to build Lite.

The `orkestr-lite` repository itself was empty when implementation began. No
source from the larger Orkestr repository was copied into the initial Lite
baseline.

## What was built during Build Week

- Codex app-server integration with runtime model discovery;
- one persistent conversation with ordered browser, WhatsApp, and timer input;
- SQLite-backed history, queueing, recovery, and context telemetry;
- Codex device authentication and API-key setup;
- WhatsApp linked-device self-chat routing, attachments, and durable delivery;
- once, interval, hourly, daily, weekly, and cron schedules with previews;
- a real PTY terminal and persistent Files interface;
- an optional Ubuntu 24.04 Desk with XFCE, Chromium, VNC, and browser state;
- Docker packaging with private Desk and app-server networking;
- a real GPT-5.6 research demonstration and automated verification; and
- unit, integration, browser, security-boundary, and Docker smoke tests.

## How Codex was used

Codex was the primary implementation environment. It helped implement and test
the app-server client, persistence model, conversation controller, WhatsApp
bridge, scheduler, terminal, file handling, Desk integration, Docker setup, and
release automation.

The submitted product also uses Codex at runtime. Orkestr launches Codex
app-server inside the workstation, discovers the models available to the
authenticated account, and records the requested and effective model for each
turn. The public research run used `gpt-5.6-sol`.

## Decisions made by the entrant

The entrant made the product and trust-boundary decisions, including:

- building a single-user workstation instead of a multi-agent dashboard;
- keeping every input in one visible conversation and one FIFO queue;
- using the user's own WhatsApp self-chat instead of a second phone number;
- keeping the service local and publishing only loopback port 3000;
- running the Desk, VNC, and app-server only on the private Compose network;
- preserving uncertain interrupted work instead of silently replaying it; and
- keeping external service automation subject to user authentication, policy,
  and human control.

## Evidence

The public demonstration uses a real GPT-5.6 run. Codex reviews official source
pages, writes cited Markdown and HTML reports, opens the HTML report in the
visible Desk, accepts a follow-up from WhatsApp, returns the updated Markdown
file, and runs a weekly review through the same conversation.

The screenshots in `assets/submission/v0.2/` are sanitized captures from that
run. [`demo.html`](../../demo.html) presents them as the public walkthrough.
[`docs/DEMO.md`](../DEMO.md) contains the reproducible prompt and verification
path. The owner-recorded video follows
[`NARRATION.md`](NARRATION.md).

The immutable `v0.1.0-build-week` release remains available as historical
evidence. The expanded v0.2 source and paired control and Desk images must be
tagged only after the final clean release gate passes.

## Current limits

- one local operator, one conversation, and one workspace per installation;
- Linux AMD64 is the verified release target;
- Live Desk is a containerized desktop, not a virtual machine or multi-tenant
  security boundary;
- WhatsApp uses the user's linked-device session and self-chat;
- external websites keep their own authentication, CAPTCHA, and usage rules;
  and
- the user supplies the Codex account and optional WhatsApp authentication.
