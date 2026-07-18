import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = resolve(import.meta.dirname, "../..");
const fakeCodex = join(root, "test/fixtures/fake-codex.mjs");

test("replays mission event histories beyond the repository batch size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-event-replay-"));
  const workspace = join(directory, "workspace");
  const databasePath = join(directory, "data/orkestr.sqlite");
  await cp(join(root, "demo/workspace"), workspace, { recursive: true });
  await chmod(fakeCodex, 0o755);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, "dist/server/main.js")], {
    cwd: root,
    env: {
      ...process.env,
      ORKESTR_HOME: join(directory, "data"),
      CODEX_HOME: join(directory, "data/codex"),
      ORKESTR_DATABASE: databasePath,
      ORKESTR_WORKSPACE: workspace,
      ORKESTR_PORT: String(port),
      ORKESTR_ADMIN_PASSWORD: "event-replay-password",
      ORKESTR_CODEX_COMMAND: fakeCodex,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  try {
    await waitForHealth(origin, child, () => logs);
    const session = await login(origin, "event-replay-password");
    const missionId = seedLongApprovalHistory(databasePath, workspace);
    const events = await readEvents(origin, session.cookie, missionId, 2_002);

    assert.equal(events.length, 2_002);
    assert.equal(events.at(-1)?.kind, "approval.required");
    assert.equal(events.at(-1)?.payload.requestId, "approval_after_2000");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3_000).then(() => child.kill("SIGKILL")),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

function seedLongApprovalHistory(databasePath, workspace) {
  const database = new Database(databasePath);
  const missionId = randomUUID();
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `INSERT INTO missions(
          id, title, prompt, source, workspace, codex_thread_id, codex_turn_id,
          status, created_at, started_at, requested_model, effective_model
        ) VALUES (?, ?, ?, 'demo', ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?)`,
      )
      .run(
        missionId,
        "Long approval history",
        "Exercise event replay",
        workspace,
        "thr_long_history",
        "turn_long_history",
        now,
        now,
        "gpt-5.6",
        "gpt-5.6",
      );
    const insert = database.prepare(
      "INSERT INTO mission_events(mission_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
    );
    database.transaction(() => {
      for (let index = 0; index < 2_001; index += 1) {
        insert.run(
          missionId,
          "item/started",
          JSON.stringify({
            item: { type: "commandExecution", id: `noise_${index}` },
          }),
          now,
        );
      }
      insert.run(
        missionId,
        "approval.required",
        JSON.stringify({
          requestId: "approval_after_2000",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thr_long_history",
            reason: "Required after a long history",
          },
        }),
        now,
      );
    })();
  } finally {
    database.close();
  }
  return missionId;
}

async function readEvents(origin, cookie, missionId, expectedCount) {
  const response = await fetch(`${origin}/api/missions/${missionId}/events`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  try {
    while (events.length < expectedCount) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const records = buffer.split("\n\n");
      buffer = records.pop() ?? "";
      for (const record of records) {
        const data = record
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) events.push(JSON.parse(data));
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0]?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie };
}

async function waitForHealth(origin, child, getLogs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Server exited early:\n${getLogs()}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(25);
  }
  throw new Error(`Server did not become healthy:\n${getLogs()}`);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
