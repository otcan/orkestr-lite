import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { WorkspaceService } from "./workspace.service.js";

test("box files browse and preview beyond the mounted workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "orkestr-box-files-"));
  const workspace = join(root, "workspace");
  const app = join(root, "app");
  await mkdir(workspace);
  await mkdir(app);
  await writeFile(join(app, "outside.txt"), "whole box\n");
  const config = {
    filesRoot: root,
    workspace,
  } as RuntimeConfig;
  const service = new WorkspaceService(config);

  try {
    const top = await service.boxDirectory(root);
    assert.deepEqual(
      top.data.map((entry) => entry.name),
      ["app", "workspace"],
    );
    const appDirectory = await service.boxDirectory(app);
    assert.equal(
      appDirectory.data[0]?.path,
      join(await realpath(app), "outside.txt"),
    );
    const preview = await service.boxPreview(join(app, "outside.txt"));
    assert.equal(preview.content, "whole box\n");
    await assert.rejects(() => service.boxPreview("/etc/passwd"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("box uploads are contained, collision-safe, and size-limited", async () => {
  const root = await mkdtemp(join(tmpdir(), "orkestr-box-upload-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const service = new WorkspaceService({
    filesRoot: root,
    workspace,
  } as RuntimeConfig);

  try {
    const first = await service.boxUpload(workspace, [
      {
        originalname: "../notes.txt",
        mimetype: "text/plain",
        size: 5,
        buffer: Buffer.from("hello"),
      },
    ]);
    const second = await service.boxUpload(workspace, [
      {
        originalname: "notes.txt",
        mimetype: "text/plain",
        size: 5,
        buffer: Buffer.from("again"),
      },
    ]);
    assert.equal(first[0]?.name, "notes.txt");
    assert.equal(second[0]?.name, "notes (1).txt");
    assert.equal((await service.boxPreview(first[0]!.path)).content, "hello");
    await assert.rejects(() =>
      service.boxUpload("/etc", [
        {
          originalname: "blocked.txt",
          mimetype: "text/plain",
          size: 1,
          buffer: Buffer.from("x"),
        },
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
