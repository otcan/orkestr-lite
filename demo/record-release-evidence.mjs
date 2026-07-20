import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const workspace = resolve(process.env.ORKESTR_DEMO_WORKSPACE ?? "");
assert.ok(
  process.env.ORKESTR_DEMO_WORKSPACE,
  "ORKESTR_DEMO_WORKSPACE is required",
);
const demoEvidence = JSON.parse(
  await readFile(join(workspace, ".orkestr/demo-evidence-v0.2.json"), "utf8"),
);
const sourceSha = (
  await execFileAsync("git", ["rev-list", "-n", "1", "v0.2.0-build-week"], {
    cwd: root,
  })
).stdout.trim();

const required = {
  controlDigest: process.env.ORKESTR_CONTROL_DIGEST,
  deskDigest: process.env.ORKESTR_DESK_DIGEST,
  workflowUrl: process.env.ORKESTR_RELEASE_WORKFLOW_URL,
  releaseUrl: process.env.ORKESTR_RELEASE_URL,
  videoUrl: process.env.ORKESTR_PUBLIC_VIDEO_URL,
  submissionId: process.env.ORKESTR_SUBMISSION_ID,
  submissionAt: process.env.ORKESTR_SUBMISSION_AT,
};
for (const [name, value] of Object.entries(required)) {
  assert.ok(value, `${name} is required`);
}
assert.match(required.controlDigest, /^sha256:[a-f0-9]{64}$/);
assert.match(required.deskDigest, /^sha256:[a-f0-9]{64}$/);
for (const url of [
  required.workflowUrl,
  required.releaseUrl,
  required.videoUrl,
]) {
  assert.match(url, /^https:\/\//);
}
assert.ok(Date.parse(required.submissionAt));

const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  releaseTag: "v0.2.0-build-week",
  sourceSha,
  demoSourceSha: demoEvidence.sourceSha,
  controlDigest: required.controlDigest,
  deskDigest: required.deskDigest,
  workflowUrl: required.workflowUrl,
  releaseUrl: required.releaseUrl,
  videoUrl: required.videoUrl,
  submissionConfirmation: {
    id: required.submissionId,
    at: new Date(required.submissionAt).toISOString(),
  },
};
const output = join(root, "docs/competition/release-evidence-v0.2.json");
await mkdir(join(root, "docs/competition"), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o644,
  flag: "wx",
});
process.stdout.write(`Recorded immutable publication evidence in ${output}\n`);
