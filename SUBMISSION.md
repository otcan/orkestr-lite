# Orkestr Lite submission copy

This is the copy-ready English narrative for the OpenAI Build Week Devpost entry. Replace every `OWNER INPUT` marker during the release freeze; do not submit the markers themselves.

## Project name

Orkestr Lite

## Tagline

Run persistent Codex coding missions from your browser.

## Category

Developer Tools

## Short description

Orkestr Lite turns Codex into a durable, browser-operated coding workstation. Create bounded missions, follow structured activity and approvals live, recover explicitly after interruption, and keep an auditable history in one hardened container.

## Inspiration

Codex is excellent at doing real engineering work, but a useful coding mission is more than a single prompt. It has setup state, a model choice, commands, approvals, progress, workspace changes, interruptions, and a result that should still be understandable after the terminal closes.

Orkestr Lite asks a focused question: what is the smallest complete operating layer that makes a Codex mission persistent and observable without hiding Codex behind a generic chat interface?

## What it does

Orkestr Lite is a single-user Codex workstation that runs locally in one container and is operated from a browser. The user signs in, authenticates Codex, verifies that an eligible GPT-5.6 model is available, and creates a bounded coding mission against a mounted workspace.

From there, Orkestr Lite:

- serializes missions so only one can mutate the workspace at a time;
- starts Codex app-server threads and turns with workspace-write isolation and explicit approvals;
- streams plans, commands, approval requests, progress, and the final response into a mission-centered UI;
- records the requested and effective model identifiers, mission state, and structured event history in SQLite;
- supports cancellation, interruption, and deliberate inspect-then-continue recovery instead of silently replaying uncertain work; and
- preserves both application data and the coding workspace across container restarts.

The repository includes a seeded judge workspace with one bounded failing test. In the demo, GPT-5.6 finds the reversed clamp bounds, applies the smallest fix, runs the tests, and explains the change while the browser shows the full mission lifecycle.

## How we built it

The product is a modular TypeScript monolith:

- Angular 22 provides the responsive mission list, setup, mission creation, live activity, approval, interruption, and result views.
- NestJS owns authentication, the mission controller, server-sent events, recovery policy, and the Codex process boundary.
- A typed JSONL client talks to the pinned Codex CLI app-server over standard input/output.
- SQLite in WAL mode stores missions, events, model provenance, session generation, and recovery metadata.
- Docker packages the complete runtime, Codex CLI, sample workspace, and web application for Linux AMD64.

The runtime is intentionally narrow: one user, one container, one workspace, and one active mission. It runs as an unprivileged user with all Linux capabilities dropped, `no-new-privileges` enabled, a loopback-only default port, private data modes, strict browser security headers, CSRF protection, rate-limited authentication, and server-side session revocation.

The release gate builds the production application, type-checks all workspaces, runs unit and integration/security suites, drives the complete product loop in real Chromium, audits production and development dependencies, and verifies the isolated container's health, authentication, restart behavior, persistence, user, capabilities, and filesystem modes.

## How Codex and GPT-5.6 were used

Codex was the primary implementation environment for Orkestr Lite. It accelerated the empty-repository build into a working vertical slice: repository structure, app-server protocol client, persistent mission state machine, Angular experience, security boundaries, deterministic fixture, real-browser acceptance, Docker release gate, and judge documentation. The dated commit history and primary `/feedback` session identify that work.

The entrant kept the core product decisions explicit: a modular monolith instead of microservices, backend ownership of app-server as the trust boundary, one active mission to avoid competing workspace mutations, a mission-first interface instead of generic chat, and inspect-before-continue recovery for uncertain interrupted work.

GPT-5.6 is also a functional part of the product. After Codex authentication, Orkestr Lite queries app-server's model list, selects an available model in the GPT-5.6 family, and sends that model with the persistent thread and turn. Each mission records both requested and effective model identifiers, including reroutes. The public demo shows a live authenticated GPT-5.6 mission modifying and testing the workspace; the protocol-faithful fake model is used only for deterministic automated regression tests and is not presented as live evidence.

## Challenges

The hardest part was preserving useful state without pretending interrupted agent work is automatically safe to replay. A process can stop after changing a file or launching a command but before the application records the final event. Orkestr Lite therefore marks in-flight work as interrupted on restart, preserves the Codex thread and event history, and makes recovery an explicit inspect-then-continue operation.

The app-server protocol is evolving, so the Codex CLI version is pinned and exercised through a typed boundary plus a protocol-faithful test double. The real acceptance gate still uses Chromium and the compiled application so a passing API fixture cannot mask a broken browser experience.

Packaging also exposed practical failures that unit tests did not: an unwritable bind-mounted workspace, duplicate init processes, missing environment forwarding, and browser behavior under a strict content security policy. Clean-clone and isolated-container tests turned those discoveries into repeatable release checks.

## Accomplishments

- A complete browser-to-Codex mission loop built from an empty Lite repository during the submission period.
- Durable queued, running, approval, completed, failed, cancelled, and interrupted mission states with replayable event history.
- Explicit model provenance and an acceptance path that distinguishes live GPT-5.6 evidence from fixtures.
- A one-command local runtime with persistent sample workspace and application data.
- A real Chromium test of login, setup readiness, mission creation, live activity, workspace change, completion, result, and logout.
- A hardened unprivileged container and automated security-boundary coverage.
- Clear provenance, limitations, judge steps, a sub-three-minute demo script, and Apache-2.0 licensing in the public repository.

## What we learned

Agent infrastructure benefits from treating work as an operational mission rather than a sequence of chat messages. The durable objects are intent, thread, turn, approvals, progress events, workspace effects, model provenance, and recovery state.

We also learned that recovery semantics and packaging are product features. A clear statement that work is uncertain is safer than an attractive but incorrect automatic retry, and a small tool is only useful to judges or developers if its clean-start path is continuously tested.

Finally, observability does not have to mean exposing private reasoning. Structured lifecycle events, commands, approvals, status, diffs, and final responses provide a useful audit trail while intentionally excluding reasoning deltas.

## What's next

The next milestones are workspace inspection, a browser terminal, persistent timers, optional WhatsApp self-chat routing, stronger multi-workspace isolation, and release channels beyond Linux AMD64. The Lite constraint remains valuable: each capability should strengthen the persistent mission loop rather than turn the product into a general-purpose chat client.

## Built with

Codex CLI and app-server, GPT-5.6, TypeScript, Node.js 22, NestJS, Angular 22, SQLite, Playwright, Docker, and GitHub Actions.

## Links and submission fields

- Repository: <https://github.com/otcan/orkestr-lite>
- License: Apache-2.0
- Supported platform: Linux AMD64 with Docker Engine and Docker Compose v2
- Public YouTube demo: `OWNER INPUT: public URL and verified duration under 3:00`
- Primary `/feedback` Codex Session ID: `OWNER INPUT: session ID`
- Live GPT-5.6 evidence: `OWNER INPUT: mission ID, timestamp, requested model, and effective model`
- Release commit: `OWNER INPUT: frozen release SHA`
- Published image: `OWNER INPUT: immutable GHCR digest`

## Judge instructions

Clone the frozen release commit, then run:

```bash
docker compose up --build
```

Open <http://localhost:3000>, read the generated administrator password from the local container logs, authenticate Codex, and confirm GPT-5.6 readiness. The seeded workspace and exact bounded mission are documented in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md). Inspect the result with:

```bash
docker compose exec orkestr git -C /workspace diff
docker compose exec orkestr node --test /workspace/test/clamp.test.js
```

For the final submission, replace the build command above with the immutable published-image command if the release candidate provides one. Keep the source-build path as a fallback.

## Final editor notes

- Keep the project name, category, model evidence, video, repository SHA, and image digest consistent across Devpost, YouTube, and the repository.
- Preserve the explicit distinction between the live GPT-5.6 demo and the deterministic fixture.
- Do not claim a hosted demo, additional platform, or future feature unless it is working and documented before submission.
- Confirm all links in a signed-out browser and remove every `OWNER INPUT` marker before submitting.
