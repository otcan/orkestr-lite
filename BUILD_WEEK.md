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

- Primary implementation thread: current Codex thread; `/feedback` ID must be added before submission
- Codex CLI protocol baseline: `0.144.5`
- Model selection: discovered at runtime with `model/list`; every mission records requested and effective model identifiers
- Required model family: GPT-5.6; the exact challenge-account identifier must be captured from a live authenticated run

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
- `npm run test:integration` — passed; browser mission fixes the bounded demo bug and all 3 tests pass
- `npm run test:browser` — passed; Chromium covers login, setup readiness, mission creation, live activity, completion, and logout
- `npm audit` and `npm audit --omit=dev` — 0 vulnerabilities
- `docker build --tag orkestr-lite:smoke .` — passed
- clean image digest — `sha256:c0934631b5abc66079d9226007a714d685d5325b2c6fef4890ff3551a587f573`
- clean anonymous volumes — readiness passed before and after restart, image health is `healthy`, runtime user is `orkestr`, authentication remains functional, and the seeded Git workspace persists with the expected failing test
- clean-clone Compose quick start — passed with loopback-only port publishing, forwarded administrator-password override, persistent data/workspace volumes, healthy restart, and no duplicate init process

The fixture is deterministic test infrastructure, not evidence of a live GPT-5.6
challenge-account run. Before submission, add the real authenticated mission ID,
effective model identifier returned by app-server, changed files, passing output,
and the primary Codex thread's `/feedback` ID here.

## Required competition artifacts

- working project built with Codex and GPT-5.6
- Developer Tools category selection
- English project description
- public YouTube demo shorter than three minutes, with audio explaining both Codex and GPT-5.6 usage
- public repository with relevant licensing, setup instructions, and sample data
- primary Codex implementation thread `/feedback` session ID
- runnable judge path that does not require rebuilding from scratch

See [HACKATHON.md](HACKATHON.md) for the release and submission checklist.

## Known limitations

- The initial implementation targets Linux AMD64.
- App-server is an evolving Codex interface, so the CLI version is pinned and compatibility is checked.
- WhatsApp and timers are not part of the first browser-mission milestone.
- Live GPT-5.6 acceptance still requires authentication with the challenge account.
