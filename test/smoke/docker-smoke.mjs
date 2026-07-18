import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const suffix = `${process.pid}-${Date.now()}`;
const suppliedImage = process.env.ORKESTR_SMOKE_IMAGE?.trim();
const image = suppliedImage || `orkestr-lite:smoke-${suffix}`;
const container = `orkestr-lite-smoke-${suffix}`;
const dataVolume = `orkestr-lite-smoke-data-${suffix}`;
const workspaceVolume = `orkestr-lite-smoke-workspace-${suffix}`;
const password = `smoke-${suffix}`;

try {
  if (suppliedImage) {
    console.log(`Testing published image ${image}`);
    await run("docker", ["pull", image]);
  } else {
    console.log(`Building ${image}`);
    await run("docker", ["build", "--tag", image, "."]);
  }
  await run("docker", ["volume", "create", dataVolume]);
  await run("docker", ["volume", "create", workspaceVolume]);

  await run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--publish",
    "127.0.0.1::3000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--env",
    `ORKESTR_ADMIN_PASSWORD=${password}`,
    "--mount",
    `type=volume,source=${dataVolume},target=/data`,
    "--mount",
    `type=volume,source=${workspaceVolume},target=/workspace`,
    image,
  ]);

  let port = await publishedPort();
  await waitForHealthy();
  assert.equal(
    (await run("docker", ["exec", container, "id", "-un"])).stdout.trim(),
    "orkestr",
  );
  const processSecurity = (
    await run("docker", [
      "exec",
      container,
      "sh",
      "-c",
      "grep -E '^(CapEff|NoNewPrivs):' /proc/1/status",
    ])
  ).stdout;
  assert.match(processSecurity, /CapEff:\s+0{16}/);
  assert.match(processSecurity, /NoNewPrivs:\s+1/);
  await assertLogin(port);

  const firstCommit = (
    await run("docker", [
      "exec",
      container,
      "git",
      "-C",
      "/workspace",
      "rev-parse",
      "HEAD",
    ])
  ).stdout.trim();
  assert.match(firstCommit, /^[0-9a-f]{40}$/);
  await run("docker", [
    "exec",
    container,
    "test",
    "-s",
    "/data/orkestr.sqlite",
  ]);
  const privateModes = (
    await run("docker", [
      "exec",
      container,
      "stat",
      "-c",
      "%a",
      "/data",
      "/data/codex",
      "/data/orkestr.sqlite",
    ])
  ).stdout.trim();
  assert.equal(privateModes, "700\n700\n600");

  const demoTest = await run(
    "docker",
    ["exec", container, "node", "--test", "/workspace/test/clamp.test.js"],
    { allowFailure: true },
  );
  assert.notEqual(
    demoTest.exitCode,
    0,
    "the seeded demo should begin with one bounded failure",
  );

  console.log("Restarting the container to verify persistent state");
  await run("docker", ["restart", container]);
  await waitForHealthy();
  port = await publishedPort();
  await assertLogin(port);

  const secondCommit = (
    await run("docker", [
      "exec",
      container,
      "git",
      "-C",
      "/workspace",
      "rev-parse",
      "HEAD",
    ])
  ).stdout.trim();
  assert.equal(
    secondCommit,
    firstCommit,
    "workspace state must survive restart",
  );
  await run("docker", [
    "exec",
    container,
    "test",
    "-s",
    "/data/orkestr.sqlite",
  ]);

  console.log("Docker smoke test passed");
} finally {
  await cleanup();
}

async function assertLogin(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
      assert.ok(
        response.headers.getSetCookie()[0],
        "login must issue a session cookie",
      );
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Login endpoint did not become ready: ${lastError}`);
}

async function publishedPort() {
  const result = await run("docker", ["port", container, "3000/tcp"]);
  const match = result.stdout.trim().match(/:(\d+)$/);
  assert.ok(match, `Could not parse published port from: ${result.stdout}`);
  return Number(match[1]);
}

async function waitForHealthy() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await run(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", container],
      { allowFailure: true },
    );
    if (result.stdout.trim() === "healthy") return;
    if (result.stdout.trim() === "unhealthy") {
      const logs = await run("docker", ["logs", container], {
        allowFailure: true,
      });
      throw new Error(
        `Container became unhealthy:\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    await delay(250);
  }
  const logs = await run("docker", ["logs", container], { allowFailure: true });
  throw new Error(
    `Container did not become healthy:\n${logs.stdout}\n${logs.stderr}`,
  );
}

async function cleanup() {
  await run("docker", ["rm", "--force", container], { allowFailure: true });
  await run("docker", ["volume", "rm", dataVolume, workspaceVolume], {
    allowFailure: true,
  });
  if (!suppliedImage) {
    await run("docker", ["image", "rm", image], { allowFailure: true });
  }
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (!options.allowFailure) throw error;
    return {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
      exitCode: Number(error.code ?? 1),
    };
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
