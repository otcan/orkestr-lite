# OpenAI Build Week submission checklist

Orkestr Lite targets the **Developer Tools** category in the OpenAI Build Week Challenge.

## Authoritative timeline

- Registration: July 9, 2026 at 10:00 PT through July 21, 2026 at 17:00 PT
- Submission: July 13, 2026 at 09:00 PT through July 21, 2026 at 17:00 PT
- Judging: July 22, 2026 at 10:00 PT through August 5, 2026 at 17:00 PT
- Winners announced: on or around August 12, 2026 at 14:00 PT

Sources:

- <https://openai.com/build-week/>
- <https://openai.devpost.com/>
- <https://openai.devpost.com/rules>

The Devpost rules and organizer updates are authoritative if any summary in this repository becomes stale.

## Required submission package

- [x] Working browser-first developer tool
- [x] Developer Tools category selected in project planning
- [x] Public repository created
- [x] Apache-2.0 license included
- [x] README with setup, supported platform, sample workspace, and testing instructions
- [x] Judge and sub-three-minute demo runbook prepared in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)
- [x] Copy-ready English submission narrative prepared in [SUBMISSION.md](SUBMISSION.md)
- [x] Devpost thumbnail and authentic fixture screenshots prepared in [MEDIA.md](MEDIA.md)
- [ ] Devpost registration confirmed
- [ ] Entrant eligibility and representative confirmed
- [x] Live authenticated GPT-5.6 acceptance mission recorded
- [x] Primary Codex implementation thread `/feedback` session ID recorded
- [ ] English project description finalized
- [ ] Public YouTube demo shorter than three minutes, with audio explaining Codex and GPT-5.6 usage
- [x] Release candidate tag, commit SHA, and image digest recorded
- [ ] Anonymous judge path verified through the end of judging
- [ ] Submission confirmation ID and timestamp recorded

## Judge path

The intended judge path is:

1. Clone the `v0.1.0-build-week` tag on Linux AMD64.
2. Pull and start the immutable image digest from the GitHub release by following [RELEASE.md](RELEASE.md), without rebuilding.
3. Read the generated administrator password from the logs and open <http://localhost:3000>.
4. Authenticate Codex, confirm GPT-5.6 readiness, and create a mission.
5. Observe persisted live activity and the final response in the browser.
6. Inspect the resulting workspace change and run the demo tests.

Use [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) for the exact prompt, commands, narration timeline, evidence capture, and recovery rules.

Use [SUBMISSION.md](SUBMISSION.md) for the copy-ready Devpost narrative and the release-only fields that remain to be filled.

Use the source-build command `docker compose up --build` only as a fallback; the published-image path is the verified judge path.

The automated fixture covers the same backend mission lifecycle deterministically. It does not replace the required live GPT-5.6 evidence.

## Owner confirmation needed

Record these details outside public source if they contain personal information, and copy only the minimum non-sensitive confirmation here:

- entry type: individual, team, or organization
- eligible country or territory confirmed
- Devpost registration complete
- authorized team or organization representative, if applicable
- YouTube publishing access available
- judge credentials or sandbox plan, if the final test path is private

## Submission freeze

Before submitting:

1. Run `npm run check:release`.
2. Run `npm run test:docker` from the release commit.
3. Record the commit SHA and Docker image digest.
4. Test every repository, video, and demo link in a signed-out browser.
5. Submit before July 21, 2026 at 17:00 PT.
6. Preserve the submitted project through the judging period.
