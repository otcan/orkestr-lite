import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = resolve(import.meta.dirname, "../..");
const fakeCodex = join(root, "test/fixtures/fake-codex.mjs");

test(
  "interrupts the active mission and resumes the queue after app-server exits",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orkestr-codex-recovery-"));
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "data/orkestr.sqlite");
    const crashMarker = join(directory, "codex-crashed-once");
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
        ORKESTR_ADMIN_PASSWORD: "recovery-test-password",
        ORKESTR_CODEX_COMMAND: fakeCodex,
        ORKESTR_FAKE_CODEX_CRASH_ONCE_MARKER: crashMarker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (chunk) => (logs += chunk.toString()));
    child.stderr.on("data", (chunk) => (logs += chunk.toString()));

    try {
      await waitForHealth(origin, child, () => logs);
      const session = await login(origin, "recovery-test-password");
      const first = await createMission(origin, session, "Crashing mission");
      const second = await createMission(origin, session, "Queued mission");

      const result = await waitFor(async () => {
        const firstState = await getMission(origin, session.cookie, first.id);
        const secondState = await getMission(origin, session.cookie, second.id);
        if (
          firstState.status === "interrupted" &&
          secondState.status === "completed"
        ) {
          return { firstState, secondState };
        }
        return null;
      });

      assert.equal(
        result.firstState.interruptionMetadata.reason,
        "codex_app_server_exit",
      );
      assert.equal(
        result.firstState.interruptionMetadata.previousStatus,
        "running",
      );
      assert.ok(result.firstState.codexThreadId);
      assert.equal(result.secondState.error, null);

      const database = new Database(databasePath, { readonly: true });
      try {
        const interruptionCount = database
          .prepare(
            "SELECT count(*) AS count FROM mission_events WHERE mission_id = ? AND kind = 'mission.interrupted'",
          )
          .get(first.id).count;
        assert.equal(interruptionCount, 1);
      } finally {
        database.close();
      }
      assert.ok(
        (logs.match(/Codex app-server 0\.144\.5 ready/g) ?? []).length >= 2,
      );
    } finally {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        delay(3_000).then(() => child.kill("SIGKILL")),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0]?.split(";", 1)[0];
  assert.ok(cookie);
  const body = await response.json();
  return { cookie, csrfToken: body.csrfToken };
}

async function createMission(origin, session, title) {
  const response = await fetch(`${origin}/api/missions`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      "x-orkestr-csrf": session.csrfToken,
    },
    body: JSON.stringify({
      source: "demo",
      title,
      prompt: "Run the bounded demo fix.",
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function getMission(origin, cookie, id) {
  const response = await fetch(`${origin}/api/missions/${id}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(probe) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = await probe();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out waiting for app-server recovery");
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
