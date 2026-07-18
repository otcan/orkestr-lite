# Orkestr Lite

Run persistent Codex missions from your browser.

Orkestr Lite is a single-user, single-container Codex workstation. The first implementation milestone provides browser setup, a persistent mission queue, live Codex activity, approvals, interruption, recovery, and a deterministic demo workspace.

This Build Week release intentionally focuses on the complete browser mission loop. WhatsApp routing, timers, a PTY terminal, and broader multi-user Orkestr capabilities are future milestones.

## Quick start

Use the immutable published image from the current GitHub release to start without rebuilding:

```bash
docker compose pull
docker compose up -d --no-build
```

See [RELEASE.md](RELEASE.md) for the exact-digest command and release verification. To build the checked-out source instead, run:

```bash
docker compose up --build
```

Open <http://localhost:3000>. On first boot, read the generated administrator password from the container logs. For a deterministic local password, start with `ORKESTR_ADMIN_PASSWORD="choose-a-long-password" docker compose up --build`.

Application state and the seeded coding workspace persist in the `orkestr-data` and `orkestr-workspace` volumes. Inspect workspace changes with `docker compose exec orkestr git -C /workspace diff`. Mount only an intended disposable host workspace if you replace the default volume.

### Supported platform

The competition build targets Linux AMD64 with Docker Engine and Docker Compose v2. The image runs as the unprivileged `orkestr` user. Other platforms are not part of the first release gate.

### First mission

1. Sign in with the administrator password.
2. Authenticate Codex with device login or an API key.
3. Wait for setup to report that Codex and GPT-5.6 are ready.
4. Create a mission from the browser and follow its live activity.

The seeded demo workspace contains a bounded failing test for a deterministic judge walkthrough. Reset it with `node demo/reset-demo.mjs` when developing outside Docker.

## Development

Requirements: Node.js 22, npm 10, Git, and Codex CLI 0.144.5.

```bash
npm install
npx playwright install chromium
npm run build
npm test
```

Run the full local release gate:

```bash
npm run check:release
```

The release gate includes a real headless Chromium walkthrough of login, setup readiness, mission creation, live mission activity, completion, and logout.

Run the isolated Docker build, health, authentication, restart, and persistence smoke test:

```bash
npm run test:docker
```

Start the API and web development servers separately:

```bash
npm run dev:server
npm run dev:web
```

## Safety

Do not expose port 3000 directly to the public internet. See [SECURITY.md](SECURITY.md).

## How Codex was used

Codex was the primary implementation environment for this repository. Product decisions remained explicit: a modular monolith, one active mission, backend ownership of the Codex app-server process, persisted mission history, and deliberate recovery instead of silently replaying uncertain work. GPT-5.6 is selected through app-server model discovery, and each mission records the requested and effective model identifiers.

The deterministic fixture verifies the protocol and product loop; it is not presented as a live GPT-5.6 challenge-account run. Live acceptance evidence and the primary implementation thread `/feedback` ID must be recorded before submission.

## Build Week

Implementation provenance and GPT-5.6 evidence are recorded in [BUILD_WEEK.md](BUILD_WEEK.md).

The current competition checklist, official requirements, and owner-only submission inputs are tracked in [HACKATHON.md](HACKATHON.md).

The exact judge path, bounded live prompt, sub-three-minute narration timeline, evidence list, and recovery rules are in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).

The copy-ready Developer Tools submission narrative is in [SUBMISSION.md](SUBMISSION.md).
