# Orkestr Lite judge and demo runbook

This is the canonical walkthrough for the OpenAI Build Week submission. It is designed for a public video under three minutes and for a judge running the repository on Linux AMD64.

## Success criteria

The walkthrough must make these points visible and audible:

1. Orkestr Lite is a browser-first developer tool for persistent Codex missions.
2. Codex app-server is running inside one unprivileged container.
3. The authenticated challenge account exposes an eligible GPT-5.6 model.
4. A real mission changes the mounted workspace and records live activity, the effective model, a diff, and a final response.
5. The repaired demo tests pass after the mission.

Do not substitute the deterministic fake-Codex test fixture for the live acceptance mission. The fixture is automated regression evidence only.

## Off-camera preflight

Use a disposable checkout and workspace. Do not record passwords, device codes, API keys, account email addresses, Codex home contents, or container logs containing credentials.

```bash
git status --short
git rev-parse HEAD
npm ci
npx playwright install chromium
npm run check:release
npm run test:docker
docker compose config --quiet
```

Record the release-candidate SHA after every command passes. Confirm that the checkout has no uncommitted changes.

Start the release without putting the administrator password in shell history:

```bash
read -rsp "Orkestr administrator password: " ORKESTR_ADMIN_PASSWORD
export ORKESTR_ADMIN_PASSWORD
docker compose up --build -d
```

Open <http://localhost:3000>, sign in, and authenticate Codex before recording. Confirm Setup reports both **Codex connected** and **First mission ready**, with the selected model in the GPT-5.6 family.

Reset only the disposable seeded demo workspace before each take:

```bash
docker compose exec orkestr git -C /workspace restore --source=HEAD --staged --worktree .
docker compose exec orkestr git -C /workspace clean -fd
docker compose exec orkestr node --test /workspace/test/clamp.test.js
```

The pre-mission test command must show exactly one bounded failure. The `clean -fd` command deletes untracked files in `/workspace`; never run it against a real project.

## Mission prompt

Paste this exact bounded prompt:

> Find the failing test in this workspace, implement the smallest correct fix, run the tests, and explain the change. Do not modify dependencies or files unrelated to the failure.

Do not approve any request outside the disposable workspace. If an unexpected approval appears, decline it and restart the take after investigating.

## Public video timeline

Target 2:40–2:50 so the uploaded video remains safely below the three-minute limit.

| Time      | Screen           | Narration cue                                                                                                                                                                                      |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | Mission list     | “Orkestr Lite turns Codex into a persistent browser-operated coding workstation: one active mission, a durable queue, live activity, and explicit approvals.”                                      |
| 0:20–0:45 | Setup            | Point out the single-container runtime, mounted workspace, Codex authentication, and verified GPT-5.6 selection. Explicitly say that GPT-5.6 performs the coding mission through Codex app-server. |
| 0:45–1:05 | New mission      | Paste the bounded prompt and create the mission. Show that the requested model is GPT-5.6.                                                                                                         |
| 1:05–1:55 | Mission detail   | Follow the thread/turn start, plan, commands, and workspace diff. Explain that events and recovery metadata are persisted in SQLite and uncertain work is not silently replayed.                   |
| 1:55–2:25 | Completed result | Show completed status, effective model, final response, and the reversed clamp-bound fix.                                                                                                          |
| 2:25–2:40 | Test command     | Run `docker compose exec orkestr node --test /workspace/test/clamp.test.js` and show all three tests passing.                                                                                      |
| 2:40–2:50 | Closing frame    | “Codex built and runs this workflow; GPT-5.6 is the verified model executing the mission. The public repository contains the license, setup, tests, and release evidence.”                         |

Keep narration continuous. Do not wait silently for a live mission; cut dead time while preserving the chronological flow and make any edit visually obvious.

## Judge path

1. Clone the release commit on Linux AMD64 with Docker Engine and Compose v2.
2. Run `docker compose up --build`.
3. Read the generated first-boot administrator password from local logs, or set a 12+ character `ORKESTR_ADMIN_PASSWORD` before startup.
4. Open <http://localhost:3000> and sign in.
5. Authenticate Codex, then confirm GPT-5.6 readiness in Setup.
6. Create the bounded mission above and follow its persisted activity through completion.
7. Inspect the result with `docker compose exec orkestr git -C /workspace diff`.
8. Run `docker compose exec orkestr node --test /workspace/test/clamp.test.js` and confirm all three tests pass.

The default port is loopback-only. A hosted judge instance must use authenticated HTTPS and `ORKESTR_COOKIE_SECURE=true` as described in [SECURITY.md](SECURITY.md).

## Evidence to capture

Keep these non-secret artifacts together for the submission:

- release commit SHA and final published image digest;
- mission URL/ID and timestamp;
- requested and effective GPT-5.6 model identifiers;
- changed file and passing three-test output;
- screenshot of completed mission activity and final response;
- primary implementation thread `/feedback` session ID;
- public YouTube URL and duration;
- signed-out repository and video link checks;
- Devpost confirmation ID and submission timestamp.

## Recovery rules

- If setup is not ready, stop recording and fix authentication/model availability off camera.
- If the mission fails, preserve its event history for diagnosis; do not present a fixture run as live evidence.
- If the workspace is already fixed, use the disposable reset commands above and verify the single expected failure before retrying.
- If the effective model is not in the GPT-5.6 family, do not use the take.
- If any credential or personal account detail appears, discard the recording rather than trying to blur only one frame.

## Final submission check

- [ ] Video is public on YouTube, has audible English narration, and is under three minutes.
- [ ] Video explicitly explains how Codex and GPT-5.6 are used.
- [ ] Repository is public and the submitted SHA contains the Apache-2.0 license, README, security guidance, sample workspace, and passing checks.
- [ ] Developer Tools category and English project description are selected.
- [x] `/feedback` session ID and live GPT-5.6 mission evidence are recorded.
- [ ] Release SHA and published image digest are frozen and match the submitted repository.
- [ ] Repository, video, and judge path work in a signed-out browser/session.
- [ ] Entry is submitted before July 21, 2026 at 17:00 PT.
- [ ] Confirmation ID/timestamp are saved and the project remains available through judging.

Official requirements and dates are linked from [HACKATHON.md](HACKATHON.md). If an organizer update conflicts with this runbook, the official rules control.
