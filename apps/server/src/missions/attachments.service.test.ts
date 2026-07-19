import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { AttachmentsService } from "./attachments.service.js";

test("browser attachments are stored, claimed, returned, and downloaded safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-attachments-"));
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port: 3000,
    home: directory,
    codexHome: join(directory, "codex"),
    workspace: join(directory, "workspace"),
    filesRoot: directory,
    databasePath: join(directory, "orkestr.sqlite"),
    requestedModel: "gpt-5.6",
    cookieSecure: false,
    allowedOrigins: [],
    codexCommand: "codex",
    codexVersion: "0.144.5",
    publicDir: join(directory, "public"),
  };
  const database = new DatabaseService(config);
  database.onModuleInit();
  try {
    const service = new AttachmentsService(database, config);
    const uploaded = await service.saveBrowserUploads([
      {
        buffer: Buffer.from("input data\n"),
        mimetype: "text/plain",
        originalname: "../../input.txt",
        size: 11,
      },
    ]);
    assert.equal(uploaded[0]?.name, "input.txt");

    const turnId = "11111111-1111-4111-8111-111111111111";
    database.db
      .prepare(
        `INSERT INTO missions(
          id, title, prompt, source, workspace, status, created_at,
          requested_model, enqueue_sequence
        ) VALUES (?, 'Attachment test', 'Inspect it', 'web', ?, 'queued', ?, 'gpt-5.6', 1)`,
      )
      .run(turnId, config.workspace, new Date().toISOString());

    service.assertClaimableBrowserUploads([uploaded[0]!.id], null);
    service.claimBrowserUploads(turnId, [uploaded[0]!.id]);
    assert.match(service.promptForTurn(turnId), /input\.txt/);
    assert.equal(service.listForTurn(turnId)[0]?.direction, "inbound");

    const incomingDownload = await service.download(uploaded[0]!.id);
    assert.equal(
      await readFile(incomingDownload.absolute, "utf8"),
      "input data\n",
    );

    const outputDirectory = await service.prepareBrowserOutputDirectory(turnId);
    const outputPath = join(outputDirectory, "answer.txt");
    await writeFile(outputPath, "answer\n");
    const returned = await service.registerBrowserOutputs(turnId, [outputPath]);
    assert.equal(returned[0]?.name, "answer.txt");
    assert.equal(returned[0]?.direction, "outbound");
    assert.equal(service.listForTurn(turnId).length, 2);

    const outside = join(directory, "outside.txt");
    await writeFile(outside, "nope\n");
    await assert.rejects(() =>
      service.registerBrowserOutputs(turnId, [outside]),
    );
  } finally {
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  }
});
