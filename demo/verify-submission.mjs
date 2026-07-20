import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mediaBinaries } from "./media-utils.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const workspaceValue = process.env.ORKESTR_DEMO_WORKSPACE;
assert.ok(workspaceValue, "ORKESTR_DEMO_WORKSPACE is required");
const workspace = resolve(workspaceValue);

// The evidence verifier is intentionally the same code used by `demo:verify`.
await import("./verify-demo.mjs");

const mediaDirectory = join(root, "assets/submission/v0.2");
const requiredPngs = [
  "setup.png",
  "chat.png",
  "desk-report.png",
  "files.png",
  "timers.png",
  "whatsapp.png",
  "report-complete.png",
  "hero-montage.png",
];
for (const name of requiredPngs) {
  const path = join(mediaDirectory, name);
  const file = await readFile(path);
  assert.ok(file.length > 20_000, `${name} is implausibly small`);
  assert.equal(
    file.subarray(1, 4).toString("ascii"),
    "PNG",
    `${name} is not PNG`,
  );
}

const { ffprobe } = await mediaBinaries();
const video = join(mediaDirectory, "demo.mp4");
const probe = await execFileAsync(
  ffprobe,
  [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    video,
  ],
  { maxBuffer: 1_000_000 },
);
const media = JSON.parse(probe.stdout);
const duration = Number(media.format?.duration);
assert.ok(duration > 5 && duration < 180, `Video duration is ${duration}s`);
assert.ok(
  media.streams?.some((stream) => stream.codec_type === "audio"),
  "Video has no audio stream",
);
assert.ok(
  media.streams?.some((stream) => stream.codec_type === "video"),
  "Video has no video stream",
);

const packageFiles = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/codex-client/package.json",
  "packages/shared/package.json",
];
for (const packageFile of packageFiles) {
  const manifest = JSON.parse(await readFile(join(root, packageFile), "utf8"));
  assert.equal(
    manifest.version,
    "0.2.0",
    `${packageFile} is not version 0.2.0`,
  );
}

const competitionFiles = await readdir(join(root, "docs/competition"));
assert.equal(
  competitionFiles.filter((name) => / 2\.md$/i.test(name)).length,
  0,
  "Accidental '* 2.md' documents remain",
);
const publicDocuments = [
  "README.md",
  "JUDGE_GUIDE.md",
  "docs/DEMO.md",
  "docs/RELEASE.md",
  "docs/competition/CHECKLIST.md",
  "docs/competition/MEDIA.md",
  "docs/competition/SUBMISSION.md",
];
const docs = await Promise.all(
  publicDocuments.map(async (name) => [
    name,
    await readFile(join(root, name), "utf8"),
  ]),
);
for (const [name, text] of docs) {
  assert.doesNotMatch(
    text,
    /OWNER INPUT|\bTODO\b|\bTBD\b/i,
    `${name} has a placeholder`,
  );
  assert.doesNotMatch(
    text,
    /ORKESTR_LIVE_WORKSPACE/,
    `${name} uses the ambiguous old workspace variable`,
  );
}
const combinedDocs = docs.map(([, text]) => text).join("\n");
assert.match(combinedDocs, /v0\.2\.0-build-week/);
assert.match(combinedDocs, /v0\.2\.0-build-week-desk/);
assert.match(combinedDocs, /127\.0\.0\.1/);
assert.match(combinedDocs, /visible jump cuts/i);

const workflow = await readFile(
  join(root, ".github/workflows/release.yml"),
  "utf8",
);
assert.match(workflow, /target: final/);
assert.match(workflow, /target: desk-runtime/);
assert.match(workflow, /platforms: linux\/amd64/g);
assert.match(workflow, /steps\.control-push\.outputs\.digest/);
assert.match(workflow, /steps\.desk-push\.outputs\.digest/);

const evidence = JSON.parse(
  await readFile(join(workspace, ".orkestr/demo-evidence-v0.2.json"), "utf8"),
);
const currentSha = (
  await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
).stdout.trim();
await execFileAsync(
  "git",
  ["merge-base", "--is-ancestor", evidence.sourceSha, currentSha],
  { cwd: root },
).catch(() => {
  throw new Error("Demo source SHA is not an ancestor of the current freeze");
});
const runtimeDiff = (
  await execFileAsync(
    "git",
    [
      "diff",
      "--name-only",
      evidence.sourceSha,
      currentSha,
      "--",
      "Dockerfile",
      "compose.yaml",
      "compose.demo.yaml",
      "package.json",
      "package-lock.json",
      "apps",
      "packages",
      "demo",
      "docker",
      "scripts",
      "test",
    ],
    { cwd: root },
  )
).stdout.trim();
assert.equal(
  runtimeDiff,
  "",
  `Runtime changed after the authentic demo:\n${runtimeDiff}`,
);

if (process.argv.includes("--owner-gate")) {
  assert.match(
    process.env.ORKESTR_PUBLIC_VIDEO_URL ?? "",
    /^https:\/\//,
    "ORKESTR_PUBLIC_VIDEO_URL must be the approved public video",
  );
  assert.equal(
    process.env.ORKESTR_DEVPOST_CONFIRMED,
    "1",
    "Set ORKESTR_DEVPOST_CONFIRMED=1 only after registration and eligibility are confirmed",
  );
  assert.equal(
    process.env.ORKESTR_CAPTURES_APPROVED,
    "1",
    "Set ORKESTR_CAPTURES_APPROVED=1 only after the owner reviews every capture",
  );
}

if (process.argv.includes("--published")) {
  const releaseEvidence = JSON.parse(
    await readFile(
      join(root, "docs/competition/release-evidence-v0.2.json"),
      "utf8",
    ),
  );
  const taggedSha = (
    await execFileAsync("git", ["rev-list", "-n", "1", "v0.2.0-build-week"], {
      cwd: root,
    })
  ).stdout.trim();
  assert.equal(releaseEvidence.sourceSha, taggedSha);
  assert.equal(releaseEvidence.demoSourceSha, evidence.sourceSha);
  assert.match(releaseEvidence.controlDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(releaseEvidence.deskDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(releaseEvidence.videoUrl, /^https:\/\//);
  assert.match(releaseEvidence.releaseUrl, /^https:\/\//);
  assert.ok(releaseEvidence.submissionConfirmation?.id);
  assert.ok(Date.parse(releaseEvidence.submissionConfirmation?.at));
}

process.stdout.write(
  `${JSON.stringify({ verified: true, sourceSha: currentSha, duration, mediaDirectory }, null, 2)}\n`,
);
