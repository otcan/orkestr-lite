import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "./client.js";

test("initializes and drives the stable app-server lifecycle over JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-codex-client-"));
  const fakeServer = join(directory, "fake-app-server.mjs");
  await writeFile(
    fakeServer,
    `
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
        if (message.method === "account/read") send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
        if (message.method === "model/list") send({ id: message.id, result: { data: [{ id: "gpt-5.6", model: "gpt-5.6", displayName: "GPT-5.6", hidden: false, isDefault: true }] } });
        if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_test", model: message.params.model } } });
        if (message.method === "turn/start") {
          send({ id: message.id, result: { turn: { id: "turn_test", status: "inProgress", items: [] } } });
          send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn_test", status: "inProgress" } } });
        }
      });
    `,
    { mode: 0o700 },
  );

  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fakeServer],
    cwd: directory,
    codexHome: directory,
    requestTimeoutMs: 2_000,
  });
  const notifications: string[] = [];
  client.on("notification", (notification) =>
    notifications.push(notification.method),
  );

  try {
    await client.start();
    assert.equal(client.isRunning, true);
    assert.deepEqual(await client.accountRead(), {
      account: null,
      requiresOpenaiAuth: true,
    });
    assert.equal((await client.listModels())[0]?.model, "gpt-5.6");
    const thread = await client.startThread({
      cwd: directory,
      model: "gpt-5.6",
    });
    assert.equal(thread.thread.id, "thr_test");
    const turn = await client.startTurn({
      threadId: thread.thread.id,
      prompt: "Run the tests",
      cwd: directory,
      model: "gpt-5.6",
    });
    assert.equal(turn.turn.id, "turn_test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(notifications, ["turn/started"]);
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
