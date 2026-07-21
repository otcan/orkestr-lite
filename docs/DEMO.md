# v0.2 research demo runbook

This is the canonical Build Week walkthrough. Every response, source visit,
file, screenshot, and WhatsApp delivery must come from the real local product
using an authenticated GPT-5.6 model. The deterministic coding fixture is a
regression test, not the public story.

## Preflight

Use the dedicated Compose project and a host bind that exists only for this
acceptance run. The preparation command refuses broad or non-demo paths and
creates the reset sentinel itself:

```bash
npm ci
npm run check:release
npm run test:docker
export ORKESTR_DEMO_WORKSPACE="$PWD/.demo/workspace"
export ORKESTR_LIVE_URL=http://127.0.0.1:3001
read -rsp 'Disposable Orkestr password: ' ORKESTR_LIVE_PASSWORD
export ORKESTR_LIVE_PASSWORD
npm run demo:prepare
npm run demo:up
```

`compose.demo.yaml` fixes the project name to `orkestr-v02-demo`, binds only
loopback port 3001, creates project-scoped data/auth/Desk volumes, and mounts
that absolute host directory at `/workspace` in both containers. Host-side
scripts always use `ORKESTR_DEMO_WORKSPACE`; Codex always sees `/workspace`.

Open <http://localhost:3001>, complete Workstation setup, verify GPT-5.6 in the
chat toolbar, link WhatsApp, and confirm Desk/Files/Terminal. Do not capture a
password, device code, account email, WhatsApp QR, phone number, personal inbox,
or Codex credential.

Then run the live workflow:

```bash
npm run demo:reset
npm run demo
```

The runner queues the primary research, waits for a real WhatsApp follow-up,
creates “Weekly agent runtime watch,” invokes Run now, and records sanitized
provenance in `/workspace/.orkestr/demo-evidence-v0.2.json`. Finish with:

```bash
npm run demo:verify
```

On failure, keep the terminal output and application activity. Do not edit the
evidence JSON. Diagnose the failure, run `demo:reset` only against the sentinel
workspace, and rerun the complete research/WhatsApp/timer sequence affected by
the failure.

## Exact primary prompt

> Create a sourced research report comparing these three agent runtimes using only their official documentation as primary sources:
>
> - OpenHands runtime: https://docs.openhands.dev/openhands/usage/architecture/runtime
> - Open Interpreter terminal getting started: https://www.openinterpreter.com/docs/terminal/getting-started
> - goose installation: https://goose-docs.ai/docs/getting-started/installation/
>
> Compare deployment model, runtime boundary, persistence, GUI/computer access, supervision, and operational inputs. Be precise: write “not documented in the reviewed sources” when the reviewed pages do not establish a capability; do not equate that with “unsupported.” Include inline Markdown links near every material claim, a concise comparison table, limitations, and a dated source-review note.
>
> Save the cited Markdown report at /workspace/reports/agent-runtime-landscape.md and a readable self-contained HTML version beside it at /workspace/reports/agent-runtime-landscape.html. Open the HTML file in the visible Desk browser with xdg-open after writing both files. Do not fabricate execution, citations, or product capabilities.

## Exact WhatsApp follow-up

Send this to the linked account’s self-chat while `npm run demo` waits:

> Update the agent runtime landscape report with a sourced solo-operator recommendation. Preserve the distinction between not documented in the reviewed sources and unsupported. Return the updated /workspace/reports/agent-runtime-landscape.md file to this WhatsApp chat.

Show the control code in chat activity, the Working reply in WhatsApp, the
completed sourced recommendation, and the returned Markdown document.

## Recording sequence

1. Setup: local-only two-container workstation and authenticated GPT-5.6.
2. Chat: exact prompt, model/effort/YOLO toolbar, live activity and context.
3. Desk: authentic Chromium source research, then the generated HTML report.
4. Files: whole-box navigation and both report artifacts.
5. WhatsApp: linked account label (sanitize number), exact follow-up, control
   code, and returned Markdown file.
6. Timers: “Weekly agent runtime watch,” next-three preview, and Run now.
7. Chat: the scheduled result in the same visible conversation.
8. Terminal: `npm run demo:verify` passing.

Use honest cuts for research latency. Never imply that a cut was uninterrupted
real time and never substitute fake Codex output.

## Submission assets

Place the private phone source under `demo/private/` or another ignored path.
It must contain only the demo self-chat. Supply either a crop, black redaction
rectangles, or an already-sanitized owner approval:

```bash
export ORKESTR_WHATSAPP_CAPTURE="$PWD/demo/private/whatsapp-source.png"
export ORKESTR_WHATSAPP_CROP='1170:1800:120:80'       # w:h:x:y, example only
export ORKESTR_WHATSAPP_REDACTIONS='0:0:1170:160'     # x:y:w:h, comma-separated
npm run demo:capture
```

Visually inspect all seven screenshots. Never use the crop example without
checking the actual phone capture. The public screenshot walkthrough is
[hosted on GitHub Pages](https://otcan.github.io/orkestr-lite/) from the single
static [`demo.html`](../demo.html) file. It uses those captures directly and has
no generated montage or video.

Record the public video manually in Loom against the real product. Follow the
[Loom script](competition/NARRATION.md), keep the finished video below three
minutes, and review it signed out before submitting its public URL.

Stop the disposable stack with `npm run demo:down`. Do not remove its volumes or
private inputs until all evidence has been reviewed and backed up.

## Acceptance criteria

- Markdown and HTML files exist and contain all three official URLs.
- Claims distinguish absent documentation from unsupported capabilities.
- Requested and effective models for research, WhatsApp, and scheduled turns
  are GPT-5.6-family identifiers.
- The WhatsApp-originated turn returned `agent-runtime-landscape.md`.
- The timer’s Run-now turn completed in the same conversation.
- HTML is visibly open in Desk.
- Captures reveal no secrets or personal messages.

If any live step fails, preserve its activity/evidence, diagnose it, reset only
the disposable artifacts, and take a new run. Never edit evidence JSON by hand.
