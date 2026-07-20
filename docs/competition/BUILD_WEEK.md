# OpenAI Build Week provenance

## Project

- Submission: Orkestr Lite
- Repository: `otcan/orkestr-lite`
- Track: Developer Tools
- Submission period: July 13, 2026 at 09:00 PT through July 21, 2026 at 17:00 PT
- Extraction baseline: this repository was empty when Lite implementation began on July 18, 2026
- Official challenge page: <https://openai.devpost.com/>
- Official rules: <https://openai.devpost.com/rules>

## Orkestr OSS background

Orkestr Lite is a deliberately smaller, single-user Codex workstation derived from product decisions and experience in the broader Orkestr project. It is not presented as a new version of every pre-existing Orkestr capability.

No upstream source was copied into the initial Lite baseline. If upstream code is introduced later, its repository, baseline commit, component inventory, and license must be recorded before it is copied.

## New Lite work

The following is being built during the submission period:

- single-container runtime contract
- Codex app-server client over stdio
- device-code and API-key setup UX
- persistent SQLite mission controller and event history
- serialized mission queue, approvals, interruption, and recovery
- mission-centered Angular browser interface
- deterministic judge demo workspace

Later milestones may add workspace inspection, a PTY terminal, WhatsApp self-chat routing, and persistent timers.

## Codex and GPT-5.6 evidence

- Primary implementation thread `/feedback` ID: `019f745b-ee85-7533-b151-e25c7baff729`
- Codex CLI protocol baseline: `0.144.5`
- Model selection: discovered at runtime with `model/list`; every mission records requested and effective model identifiers
- Required model family: GPT-5.6; the authenticated acceptance run selected the exact account identifier `gpt-5.6-sol`

## Product decisions made by the entrant

- modular monolith rather than microservices
- one user, one container, one mounted workspace, one active mission
- backend-owned app-server process as the security boundary
- persistent, operational missions rather than a chat-first interface
- explicit recovery after interruption; uncertain work is never silently replayed
- browser mission loop is the first release gate

## Test evidence

Automated browser-mission acceptance is in place. It starts the compiled NestJS
application against a protocol-faithful app-server fixture, authenticates through
the browser API, discovers the exact fixture model identifier `gpt-5.6`, creates a
mission, waits for completion, verifies the persisted final response, checks the
workspace diff, and runs the repaired demo tests in a separate process.

- `npm run format:check` — passed
- `npm run build` — passed; Angular production bundle is 291.72 kB raw
- `npm test` — passed; SQLite WAL/replay and app-server JSONL lifecycle covered
- `npm run test:integration` — passed; browser mission fixes the bounded demo bug, all 3 demo tests pass, and HTTP/session/private-data security boundaries are exercised
- `npm run test:browser` — passed; Chromium covers login, setup readiness, mission creation, live activity, completion, and logout
- `npm audit` and `npm audit --omit=dev` — 0 vulnerabilities
- `docker build --tag orkestr-lite:smoke .` — passed
- clean local image — built successfully; the frozen published release digest is recorded below
- clean anonymous volumes — readiness passed before and after restart, image health is `healthy`, runtime user is `orkestr`, effective capabilities are zero, `no-new-privileges` is active, private data modes are enforced, authentication remains functional, and the seeded Git workspace persists with the expected failing test
- clean-clone Compose quick start — passed with loopback-only port publishing, forwarded administrator-password override, persistent data/workspace volumes, healthy restart, and no duplicate init process

The fixture is deterministic test infrastructure, not evidence of a live GPT-5.6
challenge-account run.

## Live authenticated GPT-5.6 acceptance

The live acceptance ran on July 18, 2026 against the ChatGPT-authenticated Codex
account already present on the competition host. The service and browser were
bound to loopback, the mission used a disposable copy of the bounded demo
workspace, and no account email, token, device code, or credential was captured.

- Mission ID: `8f23b759-7741-4c19-a1c8-b7936de567e3`
- Codex thread ID: `019f7542-f253-7f21-8116-c170da8e6f7e`
- Codex turn ID: `019f7542-f75a-7a12-b735-3cf15bf4a9cd`
- Started: `2026-07-18T12:45:49.398Z`
- Finished: `2026-07-18T12:46:30.456Z`
- Codex CLI: `0.144.5`
- Authentication mode: `chatgpt`
- Requested model: `gpt-5.6-sol`
- Effective model: `gpt-5.6-sol`
- Changed file: `src/clamp.js`
- Independent verification: `node --test test/clamp.test.js` reported 3 passed, 0 failed
- Sanitized browser evidence:
  `assets/submission/archive/v0.1/live-mission-complete.png`

The mission corrected the reversed minimum and maximum arguments in the clamp
expression, ran the workspace tests itself, and completed without a model
reroute. A separate process then reran the tests and confirmed the three passing
cases. The reusable `npm run acceptance:live` runner validates readiness,
requested/effective GPT-5.6 provenance, the bounded file change, and the
independent test result without printing private account fields.

Codex accepted the feedback upload with logs included and returned primary
implementation session ID `019f745b-ee85-7533-b151-e25c7baff729`.

## Frozen Build Week release

- Tag: `v0.1.0-build-week`
- Source commit: `06f736f569f12a67164a43613f81e740eb36d2cc`
- GitHub release: <https://github.com/otcan/orkestr-lite/releases/tag/v0.1.0-build-week>
- Linux AMD64 image: `ghcr.io/otcan/orkestr-lite@sha256:026beb20c20f92b226424ffa32316b7a9b0fe2fb26461aae0d95df3960657e9b`
- Release workflow: <https://github.com/otcan/orkestr-lite/actions/runs/29642982912>
- Provenance: GitHub artifact attestation generated and pushed with the image
- Published-digest smoke: passed health, unprivileged runtime, zero capabilities, `no-new-privileges`, authentication, private data modes, seeded workspace, restart, and persistence checks
- Anonymous access: the exact digest pulled successfully with a fresh Docker configuration containing no registry credentials
- Clean-clone judge path: the public tag and digest started with `--no-build`, became healthy, authenticated, preserved the seeded workspace across restart, and were removed cleanly after verification

The tag and container are the immutable competition build. This post-freeze documentation records their evidence only and does not alter the tagged source or image.

## v0.2 operational expansion

The v0.1 artifact above remains frozen. Work after that release expanded the
same Lite repository into the current two-container local workstation:

- a single visible `/chat` conversation rather than mission/thread navigation;
- the private Ubuntu Desk with XFCE, Chromium, VNC, tmux, and persistent browser
  state;
- an explicitly administrative single-user workstation path with Byobu and
  passwordless `sudo` inside the isolated containers;
- whole-container Files plus upload/download/explicit WhatsApp delivery and a
  real PTY terminal;
- durable five-second WhatsApp batching, media, outbox acknowledgements, inbox
  snapshot, reconnect state, and exact self-chat supervision commands;
- interval/hourly/daily/weekly/cron schedules with previews, DST-aware timezone
  evaluation, overlap skipping, missed-run advancement, and Run-now conflicts;
- Codex context telemetry/compaction and exact event attribution; and
- the live official-source agent-runtime research story documented in
  `docs/DEMO.md`.

The broader Orkestr project supplied product experience and previously explored
ideas such as WhatsApp self-chat and workstation operations. The v0.2 code,
migrations, UI integration, two-image release automation, reliability tests,
demo scripts, and documentation were implemented and committed in this Lite
repository during the event. The historical deterministic clamp workspace is
retained only as regression infrastructure.

The next immutable target is `v0.2.0-build-week`, with separate control and Desk
digests. Its final source SHA, live GPT-5.6 evidence identifiers, screenshots,
workflow run, and digests must be recorded only after the release gate passes;
no placeholder is presented as completed evidence.

## Required competition artifacts

- working project built with Codex and GPT-5.6
- Developer Tools category selection
- English project description
- public YouTube demo shorter than three minutes, with audio explaining both Codex and GPT-5.6 usage
- public repository with relevant licensing, setup instructions, and sample data
- primary Codex implementation thread `/feedback` session ID
- runnable judge path that does not require rebuilding from scratch

See [CHECKLIST.md](CHECKLIST.md) for the release and submission checklist.

The immutable tag, image, provenance, smoke test, and amendment process are defined in [the release contract](../RELEASE.md). The GitHub release notes record the final source commit and image digest.

## Known limitations

- The initial implementation targets Linux AMD64.
- App-server is an evolving Codex interface, so the CLI version is pinned and compatibility is checked.
- The immutable v0.1 artifact does not include the later WhatsApp, Desk, Files,
  terminal, context, and schedule expansion; those belong to v0.2.
- Live GPT-5.6 acceptance passed with the host's authenticated challenge account; final submission ownership and public-video inputs remain pending.
