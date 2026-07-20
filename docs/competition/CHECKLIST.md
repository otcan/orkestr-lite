# v0.2 Build Week release checklist

Do not create or push `v0.2.0-build-week` until every release item below is
complete. `v0.1.0-build-week` is immutable and must not be moved.

## Product gate

- [ ] Format, build, typecheck, unit, integration, browser, audit, and Compose
      configuration checks pass from a clean checkout.
- [ ] Existing v5 database migrates losslessly; schedule/WhatsApp edge tests pass.
- [ ] Control and Desk source images start together on Linux AMD64.
- [ ] Setup, `/chat`, Desk, Terminal, Files, Timers, and Settings work after a restart.
- [ ] Port 3000 is loopback-only; Desk agent/VNC/app-server have no published ports.
- [ ] Session/CSRF and one-use VNC tickets reject unauthenticated access.
- [ ] Whole-container Files cannot send paths outside workspace/attachment roots.
- [ ] WhatsApp QR refresh, account identity, five-second batch, media, outbox retry,
      and exact self-chat controls work; non-self chats remain read-only.
- [ ] Interval/cron previews, timezone/DST, five-minute floor, overlap skip,
      downtime miss, and Run-now 409 behavior are verified.

## Live GPT-5.6 demo

- [ ] Disposable sentinel created and `npm run demo:reset` succeeds safely.
- [ ] Exact primary prompt uses the three official sources.
- [ ] Real GPT-5.6 requested/effective identifiers recorded.
- [ ] Markdown and HTML reports exist, are cited, and HTML is open in Desk.
- [ ] Exact WhatsApp follow-up completes and returns the updated Markdown file.
- [ ] “Weekly agent runtime watch” Run now completes in the same conversation.
- [ ] `npm run demo:verify` passes without editing evidence by hand.
- [ ] Visible jump cuts disclose latency; no fixture/fake execution is presented.

## Media and documentation

- [ ] README, architecture, security, release, submission, provenance, runbook,
      and `JUDGE_GUIDE.md` match the actual two-container product.
- [ ] No visible Missions/Threads product terminology or webhook/hosted/public-API claim.
- [ ] Setup, chat, Desk, Files, timers, WhatsApp, and completed-report captures are
      authentic and sanitized under `assets/submission/v0.2/`.
- [ ] Hero montage contains only those captures.
- [ ] Public English demo video has audio, remains under the competition limit,
      and distinguishes Codex capabilities from Orkestr’s operational layer.

## Immutable publication

- [ ] Packages report version `0.2.0`.
- [ ] Clean signed-out pulls succeed for both proposed tags.
- [ ] Paired published-digest smoke verifies health, tools, private networking,
      VNC authentication, restart, and persistent workspace/browser/database state.
- [ ] Both artifact attestations are available.
- [ ] GitHub release records source SHA, control digest, Desk digest, checksums,
      limitations, and judge command.
- [ ] Source tag/release/images remain public and `v0.1.0-build-week` is unchanged.
- [ ] Final clean pull, setup, demo, restart, and cleanup pass from a signed-out
      Docker environment.
- [ ] Submission confirmation ID/time and final public video URL are archived.
