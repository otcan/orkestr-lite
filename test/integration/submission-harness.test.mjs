import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test("prepares and resets only a sentinel-protected host demo workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orkestr-demo-harness-"));
  const workspace = join(parent, "orkestr-demo-workspace");
  try {
    const environment = { ...process.env, ORKESTR_DEMO_WORKSPACE: workspace };
    await execFileAsync(process.execPath, ["demo/prepare-workspace.mjs"], {
      cwd: root,
      env: environment,
    });
    assert.equal(
      (
        await readFile(join(workspace, ".orkestr-demo-disposable"), "utf8")
      ).trim(),
      "orkestr-lite-demo-v0.2",
    );

    await mkdir(join(workspace, "reports"), { recursive: true });
    await writeFile(
      join(workspace, "reports/agent-runtime-landscape.md"),
      "remove",
    );
    await writeFile(join(workspace, "keep.txt"), "keep");
    await execFileAsync(process.execPath, ["demo/reset-demo.mjs"], {
      cwd: root,
      env: environment,
    });

    await assert.rejects(
      access(join(workspace, "reports/agent-runtime-landscape.md")),
    );
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("refuses ambiguous container and filesystem-root reset targets", async () => {
  for (const workspace of ["/", "/workspace"]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["demo/reset-demo.mjs", workspace], {
        cwd: root,
      }),
      /Refusing to reset unsafe workspace/,
    );
  }
});

test("live acceptance waits for current Codex and WhatsApp readiness", async () => {
  const runner = await readFile(
    resolve(root, "demo/run-live-acceptance.mjs"),
    "utf8",
  );

  assert.match(runner, /request\("\/api\/setup\/status"\)/);
  assert.match(runner, /request\("\/api\/setup\/whatsapp\/status"\)/);
  assert.match(runner, /latest\.ready && whatsapp\.ready/);
  assert.match(runner, /waitForWhatsAppAttachmentAcknowledgement/);
  assert.match(runner, /includeAcknowledged=true/);
  assert.doesNotMatch(runner, /firstMissionReady/);
});

test("control and Desk share only the attachment data subtree", async () => {
  const compose = await readFile(resolve(root, "compose.yaml"), "utf8");

  assert.equal(
    (compose.match(/orkestr-attachments:\/data\/attachments/g) || []).length,
    2,
  );
  assert.match(compose, /^  orkestr-attachments:$/m);

  const desk = compose.split(/^  orkestr-desk:$/m)[1] ?? "";
  assert.doesNotMatch(desk, /^\s+- orkestr-data:\/data$/m);
});
