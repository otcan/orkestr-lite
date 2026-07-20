# Orkestr Lite v0.2 submission copy

## Tagline

An operational runtime for Codex.

## Short description

Orkestr Lite turns Codex into one persistent local workstation spanning browser
chat, Ubuntu Desk, files, terminal, schedules, and a linked WhatsApp self-chat.

## Product description

Codex is already excellent at agentic work. The missing layer is operational:
where the work runs, how it survives a restart, how inputs remain ordered, how
files move in and out, how a solo operator supervises it away from the browser,
and how one long conversation stays understandable.

Orkestr Lite is self-hosted infrastructure around Codex, not a replacement for
native Codex capabilities. A local Angular/NestJS control container persists the
conversation, events, schedules, WhatsApp state, attachments, and context
telemetry. A private Ubuntu 24.04 Desk container runs Codex app-server, XFCE,
Chromium, VNC, and developer tools against the same workspace. Only
`127.0.0.1:3000` is published.

One visible `/chat` surface accepts browser, WhatsApp, and scheduled input. A
durable FIFO serializes work; Codex reconnects without discarding queued input;
context compaction remains native but becomes observable; and an interrupted
turn receives one inspect-before-continuing recovery attempt. Model and effective
GPT-5.6 provenance remain visible.

WhatsApp is a built-in linked-device interface. Self-chat messages batch for
five seconds, media moves in both directions, and a durable at-least-once outbox
survives disconnects. Exact `status`, `stop`, `approve`, `decline`, and `help`
commands use audited eight-character turn codes. Other direct chats are a
read-only local inbox snapshot; groups are ignored.

Schedules support once, interval, hourly, daily, weekly, and standard five-field
cron with timezone-aware three-run previews. A five-minute floor is enforced at
save and execution. Overlaps are recorded as skipped, stale downtime occurrences
as one missed run, and Run now refuses to duplicate pending work.

The live demo asks GPT-5.6 to compare official OpenHands, Open Interpreter, and
goose runtime documentation. It writes cited Markdown and HTML reports, opens
the report in Desk, accepts a sourced solo-operator follow-up through WhatsApp
and returns the updated Markdown file, then runs a weekly watch through the same
conversation. Visible jump cuts disclose research latency; no fake execution is
presented as live evidence.

## Built with Codex

Codex was the primary implementation environment for the Lite repository. It
helped build the app-server client, durable control plane, recovery semantics,
WhatsApp bridge, schedule evaluator, two-container Desk, Angular experience,
tests, and release package. Product/trust-boundary decisions remained explicit:
single user, loopback only, one shared conversation/workspace, one active Codex
turn, YOLO inside the isolated workstation, and no public webhook/API surface.

The larger Orkestr project contributed experience and previously explored
ideas; Build Week provenance distinguishes those reused ideas from code written
in this Lite repository. The original deterministic coding fixture remains only
as regression infrastructure.

## Judge path

```bash
git clone --branch v0.2.0-build-week --depth 1 https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
docker compose --profile desk up -d
```

Open <http://localhost:3000>, complete Workstation setup, and use the one-page
`JUDGE_GUIDE.md`. The release publishes and attests paired Linux AMD64 control
and Desk images. It is local-only and requires the judge’s eligible Codex
authentication; WhatsApp linking is optional outside the complete demo.

## Limitations

- one local operator, shared workspace/conversation, and active Codex turn;
- Linux AMD64 release images;
- user-supplied Codex and optional WhatsApp authentication;
- at-least-once WhatsApp delivery can rarely duplicate a message;
- no hosted instance, webhook ingress, bearer-token automation, public API,
  multi-user tenancy, or intentionally exposed Desk/VNC/app-server service.

## Links

- Repository: <https://github.com/otcan/orkestr-lite>
- v0.2 release: <https://github.com/otcan/orkestr-lite/releases/tag/v0.2.0-build-week>
- Judge guide: `JUDGE_GUIDE.md`
- Demo runbook: `docs/DEMO.md`
- Provenance: `docs/competition/BUILD_WEEK.md`
