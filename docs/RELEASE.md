# Release contract

Build Week releases are immutable source tags paired with one Linux AMD64 container digest and a public GitHub release. The GitHub release notes are the canonical record of the tag, source commit, image digest, and provenance.

## Published-image quick start

Replace `<digest>` with the full `sha256:...` value in the GitHub release notes:

```bash
git clone --branch v0.1.0-build-week --depth 1 https://github.com/otcan/orkestr-lite.git
cd orkestr-lite
ORKESTR_IMAGE="ghcr.io/otcan/orkestr-lite@<digest>" docker compose pull orkestr
ORKESTR_IMAGE="ghcr.io/otcan/orkestr-lite@<digest>" docker compose up -d --no-build
docker compose logs orkestr
```

Open <http://localhost:3000> and use the generated first-boot password shown once in the local logs. Supplying a 12–512 character `ORKESTR_ADMIN_PASSWORD` is also supported.

The tag and digest must come from the same GitHub release. The package must be public before giving this path to judges; verify the pull in a signed-out environment without a Docker registry login.

## Source-build fallback

At the same frozen tag:

```bash
docker compose up --build
```

The source-build path is useful for inspection, but the published digest is the judge path that avoids rebuilding the project from scratch.

## Release automation

Pushing a `v*` tag runs the release workflow, which:

1. builds the tagged source for Linux AMD64;
2. publishes version and commit tags to GitHub Container Registry;
3. records the immutable image digest;
4. creates a GitHub artifact attestation;
5. runs the full container smoke test against that exact published digest; and
6. creates a GitHub release containing the tag, source commit, and digest.

The workflow uses commit-pinned actions and grants only the permissions required to publish the package, attestation, and release.

## Freeze and amendment rules

- Never move or recreate a published competition tag.
- Never replace the digest recorded for a tag.
- Any runtime change requires a new version tag, image digest, smoke run, and release record.
- A documentation-only change after freeze must say that it is not part of the tagged build and must not silently change judge commands or claimed evidence.
- Keep the source tag, image, public release, repository, and provenance available through the judging period.
- Re-run the anonymous pull, browser login, seeded workspace, restart, and persistence checks before submission.
