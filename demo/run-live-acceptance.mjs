import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.ORKESTR_LIVE_URL ?? "http://127.0.0.1:3000";
const password = process.env.ORKESTR_LIVE_PASSWORD;
const workspace = process.env.ORKESTR_LIVE_WORKSPACE;

if (!password) throw new Error("ORKESTR_LIVE_PASSWORD is required");
if (!workspace) throw new Error("ORKESTR_LIVE_WORKSPACE is required");

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
if (loginResponse.status !== 200) {
  throw new Error(
    `Login failed (${loginResponse.status}): ${await loginResponse.text()}`,
  );
}
const cookie = loginResponse.headers.getSetCookie()[0]?.split(";", 1)[0];
assert.ok(cookie, "Login response did not set a session cookie");
const login = await loginResponse.json();
assert.equal(typeof login.csrfToken, "string");

const setup = await waitForSetup();
process.stdout.write(
  `${JSON.stringify(
    {
      event: "setup.ready",
      process: setup.codex.process,
      cliVersion: setup.codex.cliVersion,
      expectedVersion: setup.codex.expectedVersion,
      authenticated: setup.codex.authenticated,
      authMode: setup.codex.authMode,
      requestedModel: setup.codex.requestedModel,
      selectedModel: setup.codex.selectedModel,
      modelReady: setup.codex.modelReady,
      availableModelCount: setup.codex.models.length,
    },
    null,
    2,
  )}\n`,
);
assert.equal(setup.codex.authenticated, true);
assert.equal(setup.codex.modelReady, true);
assert.match(setup.codex.selectedModel, /^gpt-5\.6(?:$|[-.])/i);

const created = await request("/api/missions", {
  method: "POST",
  csrfToken: login.csrfToken,
  body: {
    source: "demo",
    title: "Build Week live GPT-5.6 acceptance",
    prompt:
      "Work only in this disposable demo workspace. Find the failing test, identify the cause, implement the smallest correct fix, run the tests, and explain the change. Do not access the network or anything outside this workspace.",
  },
});
process.stdout.write(
  `${JSON.stringify({ event: "mission.created", id: created.id })}\n`,
);

let mission;
let priorStatus;
for (let attempt = 0; attempt < 600; attempt += 1) {
  mission = await request(`/api/missions/${created.id}`);
  if (mission.status !== priorStatus) {
    process.stdout.write(
      `${JSON.stringify({ event: "mission.status", status: mission.status })}\n`,
    );
    priorStatus = mission.status;
  }
  if (
    ["completed", "failed", "interrupted", "cancelled"].includes(mission.status)
  ) {
    break;
  }
  if (mission.status === "awaiting_approval") {
    throw new Error(
      `Mission ${mission.id} is awaiting manual approval; inspect it in Orkestr Lite`,
    );
  }
  await delay(2_000);
}

assert.ok(mission, "Mission did not start");
assert.equal(mission.status, "completed", mission.error ?? "Mission timed out");
assert.match(mission.requestedModel, /^gpt-5\.6(?:$|[-.])/i);
assert.match(mission.effectiveModel, /^gpt-5\.6(?:$|[-.])/i);

const resolvedWorkspace = resolve(workspace);
const changedSource = await readFile(
  join(resolvedWorkspace, "src/clamp.js"),
  "utf8",
);
assert.match(changedSource, /Math\.max\(minimum/);

const testEnvironment = { ...process.env };
delete testEnvironment.NODE_TEST_CONTEXT;
const testResult = await execFileAsync(
  process.execPath,
  ["--test", "test/clamp.test.js"],
  { cwd: resolvedWorkspace, env: testEnvironment },
);
assert.match(testResult.stdout, /pass 3/);

process.stdout.write(
  `${JSON.stringify(
    {
      event: "acceptance.passed",
      missionId: mission.id,
      codexThreadId: mission.codexThreadId,
      codexTurnId: mission.codexTurnId,
      requestedModel: mission.requestedModel,
      effectiveModel: mission.effectiveModel,
      startedAt: mission.startedAt,
      finishedAt: mission.finishedAt,
      changedFile: "src/clamp.js",
      independentTest: testResult.stdout.trim().split("\n").slice(-6),
      finalResponse: mission.finalResponse,
    },
    null,
    2,
  )}\n`,
);

async function waitForSetup() {
  let latest;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    latest = await request("/api/setup/status");
    if (latest.firstMissionReady) return latest;
    await delay(1_000);
  }
  throw new Error(
    `Orkestr Lite did not become mission-ready: ${JSON.stringify({
      process: latest?.codex?.process,
      authenticated: latest?.codex?.authenticated,
      modelReady: latest?.codex?.modelReady,
      processError: latest?.codex?.processError,
    })}`,
  );
}

async function request(path, options = {}) {
  const headers = { cookie };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.csrfToken) headers["x-orkestr-csrf"] = options.csrfToken;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
