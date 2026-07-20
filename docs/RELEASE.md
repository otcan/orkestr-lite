# Release contract

`v0.2.0-build-week` is an immutable source tag paired with two Linux AMD64
container digests: control and Desk. One GitHub release records the source SHA,
both digests, their checksums/attestations, limitations, and judge commands.
The earlier `v0.1.0-build-week` tag, image, and release remain unchanged.

## Published pair

```bash
git clone --branch v0.2.0-build-week --depth 1 https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
docker compose --profile desk pull
docker compose --profile desk up -d --no-build
docker compose ps
```

The documented tags are:

- `ghcr.io/otcan/orkestr-lite:v0.2.0-build-week`
- `ghcr.io/otcan/orkestr-lite:v0.2.0-build-week-desk`

For maximum immutability, replace both tags with the full `@sha256:…` values
from the same GitHub release. Verify anonymous pulls from a Docker configuration
with no registry credentials before handing the build to judges.

## Source-build fallback

```bash
docker compose --profile desk up --build -d
```

The build path is for inspection. Published digests are the judge path.

## Automation

A pushed `v*` tag runs `.github/workflows/release.yml`, which:

1. checks out the frozen source and installs with Node 22.23.1;
2. builds the Dockerfile `final` and `desk-runtime` targets for Linux AMD64;
3. publishes the exact version tags plus source-SHA tags;
4. creates a separate artifact attestation for each digest;
5. starts those two published digests together;
6. verifies control/Desk health, unprivileged users, installed tools, private
   Desk ports, authenticated VNC proxying, restart behavior, and persistent
   workspace/browser/database state; and
7. creates one GitHub release with both digests, source SHA, checksum file,
   limitations, and the Compose judge command.

Actions are commit-pinned and permissions are limited to contents, packages,
OIDC, and attestations required by the release job.

## Freeze rules

- Never move, recreate, or overwrite a published Build Week tag.
- Never replace either digest associated with a release.
- Runtime changes require a new semantic version, paired image build, paired
  smoke test, attestations, and release record.
- Documentation after freeze must not silently alter judge commands or claimed
  evidence for the frozen source.
- Keep source, both images, release notes, attestations, and checksum artifact
  available throughout judging.

Before tagging, run the full release gate, one live GPT-5.6 research acceptance,
`npm run demo:verify`, final clean pulls, setup, demo, restart, and cleanup from a
signed-out Docker environment. Do not create the tag until every item passes.

The tag also waits for the owner-controlled gate: confirmed Devpost
registration/eligibility, approved sanitized captures, approved narrated video,
and a working public video URL. Validate those confirmations with
`npm run submission:verify -- --owner-gate`.

After publication and final submission, use `npm run submission:record` to
create the non-secret JSON record described in
`docs/competition/RELEASE_EVIDENCE.md`, then run
`npm run submission:verify -- --published`. A source-independent workflow
failure may be retried. A source correction requires a new immutable patch
version; never move the v0.2 tag.
