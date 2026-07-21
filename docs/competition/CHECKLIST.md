# v0.2 Build Week release checklist

Do not create or push `v0.2.0-build-week` until every **pre-tag** item below is
complete and backed by evidence. Publication checks happen only after that tag
exists. `v0.1.0-build-week` is immutable and must not be moved.

## Pre-tag: product gate

- [x] Format, build, typecheck, unit, integration, browser, audit, and Compose
      configuration checks pass from a clean checkout.
- [x] Existing v5 database migrates losslessly; schedule/WhatsApp edge tests pass.
- [x] Control and Desk source images start together on Linux AMD64.
- [ ] Setup, `/chat`, Desk, Terminal, Files, Timers, and Settings work after a restart.
- [x] Port 3000 is loopback-only; Desk agent/VNC/app-server have no published ports.
- [x] Session/CSRF and one-use VNC tickets reject unauthenticated access.
- [x] Whole-container Files cannot send paths outside workspace/attachment roots.
- [x] WhatsApp QR refresh, account identity, five-second batch, media, outbox retry,
      and exact self-chat controls work; non-self chats remain read-only.
- [x] Interval/cron previews, timezone/DST, five-minute floor, overlap skip,
      downtime miss, and Run-now 409 behavior are verified.
- [x] Every repository package reports version `0.2.0`.

## Pre-tag: live GPT-5.6 demo

- [x] Disposable sentinel created and `npm run demo:reset` succeeds safely.
- [x] Exact primary prompt uses the three official sources.
- [x] Real GPT-5.6 requested/effective identifiers recorded.
- [x] Markdown and HTML reports exist, are cited, and HTML is open in Desk.
- [x] Exact WhatsApp follow-up completes and returns the updated Markdown file.
- [x] “Weekly agent runtime watch” Run now completes in the same conversation.
- [x] `npm run demo:verify` passes without editing evidence by hand.
- [x] Visible jump cuts disclose latency; no fixture/fake execution is presented.

## Pre-tag: media and documentation

- [x] README, architecture, security, release, submission, provenance, runbook,
      and `JUDGE_GUIDE.md` match the actual two-container product.
- [x] No visible Missions/Threads product terminology or webhook/hosted/public-API claim.
- [x] Setup, chat, Desk, Files, timers, WhatsApp, and completed-report captures are
      authentic and sanitized under `assets/submission/v0.2/`.
- [x] Hero montage contains only those captures.
- [x] English demo video has audio, remains under the competition limit,
      and distinguishes Codex capabilities from Orkestr’s operational layer.
- [x] `npm run submission:verify` passes against the frozen source and demo workspace.

## Pre-tag: owner gate

- [ ] Devpost registration, eligibility, and representative authority confirmed.
- [x] The under-three-minute draft uses disclosed synthetic narration recorded in
      `demo-metadata.json`; it may be replaced with owner narration without changing
      the authentic captures.
- [ ] Owner approves every sanitized capture and the final video.
- [ ] Approved video is public and its signed-out URL works.
- [ ] `npm run submission:verify -- --owner-gate` passes with the public-video,
      Devpost, and capture-approval environment confirmations.

## Post-tag: immutable publication

- [ ] `v0.2.0-build-week` points at the exact frozen `main` SHA and is never moved.
- [ ] Clean signed-out pulls succeed for both published tags.
- [ ] Paired published-digest smoke verifies health, tools, private networking,
      VNC authentication, restart, and persistent workspace/browser/database state.
- [ ] Both artifact attestations are available.
- [ ] GitHub release records source SHA, control digest, Desk digest, checksums,
      limitations, and judge command.
- [ ] Source tag/release/images remain public and `v0.1.0-build-week` is unchanged.
- [ ] Final clean pull, setup, demo, restart, and cleanup pass from a signed-out
      Docker environment.
- [ ] Submission confirmation ID/time and final public video URL are archived.
- [ ] `npm run submission:verify -- --published` passes against the recorded
      source SHA, image digests, workflow/release URLs, video URL, and submission.
