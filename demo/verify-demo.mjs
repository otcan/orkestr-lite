import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

const workspace = resolve(
  process.argv[2] ?? process.env.ORKESTR_DEMO_WORKSPACE ?? "",
);
assert.ok(
  process.argv[2] || process.env.ORKESTR_DEMO_WORKSPACE,
  "ORKESTR_DEMO_WORKSPACE is required and must be a host path",
);
assert.notEqual(workspace, "/workspace", "Use the bind-mounted host path");
const markdownPath = join(workspace, "reports/agent-runtime-landscape.md");
const htmlPath = join(workspace, "reports/agent-runtime-landscape.html");
const evidencePath = join(workspace, ".orkestr/demo-evidence-v0.2.json");
const [markdown, html, evidenceText] = await Promise.all([
  readFile(markdownPath, "utf8"),
  readFile(htmlPath, "utf8"),
  readFile(evidencePath, "utf8"),
]);
const evidence = JSON.parse(evidenceText);
assert.match(
  evidence.sourceSha || "",
  /^[a-f0-9]{40}$/,
  "Demo evidence has no full source SHA",
);
if (process.env.ORKESTR_VERIFY_ALLOW_RUNTIME_DESCENDANT !== "1") {
  const expectedSourceSha =
    process.env.ORKESTR_SOURCE_SHA ??
    (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
  assert.equal(
    evidence.sourceSha,
    expectedSourceSha,
    `Demo evidence is stale: expected ${expectedSourceSha}, found ${evidence.sourceSha}`,
  );
}
const sources = [
  "https://docs.openhands.dev/openhands/usage/architecture/runtime",
  "https://www.openinterpreter.com/docs/terminal/getting-started",
  "https://goose-docs.ai/docs/getting-started/installation/",
];
for (const source of sources) {
  assert.ok(markdown.includes(source), `Markdown is missing ${source}`);
  assert.ok(html.includes(source), `HTML is missing ${source}`);
}
assert.match(markdown, /not documented in the reviewed sources/i);
assert.match(html, /<html[\s>]/i);
for (const turn of [
  evidence.research,
  evidence.whatsapp,
  evidence.schedule?.turn,
]) {
  assert.match(turn?.requestedModel || "", /^gpt-5\.6(?:$|[-.])/i);
  assert.match(turn?.effectiveModel || "", /^gpt-5\.6(?:$|[-.])/i);
}
assert.equal(evidence.whatsapp?.outputAttachment, "agent-runtime-landscape.md");
assert.equal(evidence.whatsapp?.delivery?.status, "acknowledged");
assert.match(evidence.whatsapp?.delivery?.outboxId || "", /^[a-f0-9-]{36}$/i);
assert.equal(evidence.schedule?.name, "Weekly agent runtime watch");
assert.ok(evidence.schedule?.turn?.completedAt, "Scheduled turn is incomplete");
process.stdout.write(
  `${JSON.stringify({ verified: true, workspace, evidence }, null, 2)}\n`,
);
