import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const fakeCodex = join(root, "test/fixtures/fake-codex.mjs");

test("runs sequential turns through one persistent Codex conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-browser-mission-"));
  const workspace = join(directory, "workspace");
  await cp(join(root, "demo/workspace"), workspace, { recursive: true });
  await chmod(fakeCodex, 0o755);
  const port = await availablePort();
  const child = await import("node:child_process").then(({ spawn }) =>
    spawn(process.execPath, [join(root, "dist/server/main.js")], {
      cwd: root,
      env: {
        ...process.env,
        ORKESTR_HOME: join(directory, "data"),
        CODEX_HOME: join(directory, "data/codex"),
        ORKESTR_WORKSPACE: workspace,
        ORKESTR_PORT: String(port),
        ORKESTR_ADMIN_PASSWORD: "integration-test-password",
        ORKESTR_CODEX_COMMAND: fakeCodex,
        ORKESTR_FAKE_CODEX_THREAD_MODEL: "gpt-5.6-effective",
        ORKESTR_FAKE_CODEX_REROUTE_MODEL: "gpt-5.6-rerouted",
        ORKESTR_FAKE_CODEX_REROUTE_ON_TURN: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  try {
    await waitForHealth(port, child, () => logs);
    const loginResponse = await fetch(
      `http://127.0.0.1:${port}/api/auth/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "integration-test-password" }),
      },
    );
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.getSetCookie()[0]?.split(";", 1)[0];
    assert.ok(cookie);
    const login = await loginResponse.json();
    assert.equal(typeof login.csrfToken, "string");

    const setup = await jsonRequest(port, "/api/setup/status", cookie);
    assert.equal(setup.ready, true);
    assert.equal(setup.codex.selectedModel, "gpt-5.6");

    await jsonRequest(port, "/api/conversation/complete-setup", cookie, {
      method: "POST",
      csrfToken: login.csrfToken,
    });
    const created = await jsonRequest(port, "/api/turns", cookie, {
      method: "POST",
      csrfToken: login.csrfToken,
      body: {
        source: "demo",
        clientMessageId: "integration-browser-draft-1",
        content:
          "Find the failing test, identify the cause, implement the smallest correct fix, run the tests, and explain the change.",
      },
    });
    assert.equal(created.status, "queued");
    const duplicate = await jsonRequest(port, "/api/turns", cookie, {
      method: "POST",
      csrfToken: login.csrfToken,
      body: {
        source: "demo",
        clientMessageId: "integration-browser-draft-1",
        content:
          "Find the failing test, identify the cause, implement the smallest correct fix, run the tests, and explain the change.",
      },
    });
    assert.equal(duplicate.id, created.id);

    let mission;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const turns = await jsonRequest(port, "/api/turns", cookie);
      mission = turns.data.find((turn) => turn.id === created.id);
      if (["completed", "failed"].includes(mission.status)) break;
      await delay(25);
    }
    assert.equal(mission?.status, "completed", logs);
    assert.match(mission.finalResponse, /three tests pass/);
    assert.match(
      await readFile(join(workspace, "src/clamp.js"), "utf8"),
      /Math\.max\(minimum/,
    );
    const testEnvironment = { ...process.env };
    delete testEnvironment.NODE_TEST_CONTEXT;
    const testResult = await execFileAsync(
      process.execPath,
      ["--test", "test/clamp.test.js"],
      { cwd: workspace, env: testEnvironment },
    );
    assert.match(testResult.stdout, /pass 3/);

    const rerouted = await jsonRequest(port, "/api/turns", cookie, {
      method: "POST",
      csrfToken: login.csrfToken,
      body: {
        source: "demo",
        content:
          "Verify model reroute provenance without changing unrelated files.",
      },
    });
    let reroutedMission;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const turns = await jsonRequest(port, "/api/turns", cookie);
      reroutedMission = turns.data.find((turn) => turn.id === rerouted.id);
      if (["completed", "failed"].includes(reroutedMission.status)) break;
      await delay(25);
    }
    assert.equal(reroutedMission?.status, "completed", logs);
    const [firstInternal, secondInternal] = await Promise.all([
      jsonRequest(port, `/api/missions/${created.id}`, cookie),
      jsonRequest(port, `/api/missions/${rerouted.id}`, cookie),
    ]);
    assert.equal(firstInternal.codexThreadId, secondInternal.codexThreadId);
    assert.equal(firstInternal.requestedModel, "gpt-5.6");
    assert.equal(firstInternal.effectiveModel, "gpt-5.6-effective");
    assert.equal(secondInternal.effectiveModel, "gpt-5.6-rerouted");

    const newest = await jsonRequest(port, "/api/turns?limit=1", cookie);
    assert.deepEqual(
      newest.data.map((turn) => turn.id),
      [rerouted.id],
    );
    const older = await jsonRequest(
      port,
      `/api/turns?limit=1&before=${newest.nextCursor}`,
      cookie,
    );
    assert.deepEqual(
      older.data.map((turn) => turn.id),
      [created.id],
    );
    const permalink = await jsonRequest(
      port,
      `/api/turns/${created.id}`,
      cookie,
    );
    assert.equal(permalink.finalResponse, mission.finalResponse);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3_000).then(() => child.kill("SIGKILL")),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function jsonRequest(port, path, cookie, options = {}) {
  const headers = { cookie };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.csrfToken) headers["x-orkestr-csrf"] = options.csrfToken;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function waitForHealth(port, child, getLogs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Server exited early:\n${getLogs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
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
