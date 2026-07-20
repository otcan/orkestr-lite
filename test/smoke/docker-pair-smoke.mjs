import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const suffix = `${process.pid}-${Date.now()}`;
const project = `orkestr-pair-${suffix}`;
const password = `pair-smoke-${suffix}`;
const controlImage =
  process.env.ORKESTR_SMOKE_IMAGE?.trim() ||
  "ghcr.io/otcan/orkestr-lite:v0.2.0-build-week";
const deskImage =
  process.env.ORKESTR_SMOKE_DESK_IMAGE?.trim() ||
  "ghcr.io/otcan/orkestr-lite:v0.2.0-build-week-desk";

const environment = {
  ...process.env,
  ORKESTR_IMAGE: controlImage,
  ORKESTR_DESK_IMAGE: deskImage,
  ORKESTR_ADMIN_PASSWORD: password,
  ORKESTR_HOST_PORT: process.env.ORKESTR_SMOKE_HOST_PORT?.trim() || "0",
};
let cleanupPromise;

installSignalCleanup("SIGINT", 130);
installSignalCleanup("SIGTERM", 143);

try {
  if (process.env.ORKESTR_SMOKE_SKIP_PULL !== "true") {
    await compose(["pull", "orkestr", "orkestr-desk"]);
  }
  await compose(["up", "--detach", "--no-build"]);
  const control = await containerId("orkestr");
  const desk = await containerId("orkestr-desk");
  await Promise.all([waitHealthy(control), waitHealthy(desk)]);
  const port = await publishedPort(control, "3000/tcp");

  assert.equal(
    (await docker(["exec", control, "id", "-un"])).stdout.trim(),
    "orkestr",
  );
  assert.equal(
    (await docker(["exec", desk, "id", "-un"])).stdout.trim(),
    "orkestr",
  );
  for (const tool of [
    "tmux",
    "byobu",
    "sudo",
    "git",
    "rg",
    "jq",
    "chromium",
    "codex",
  ]) {
    await docker(["exec", control, "sh", "-lc", `command -v ${tool}`]);
    await docker(["exec", desk, "sh", "-lc", `command -v ${tool}`]);
  }
  for (const container of [control, desk]) {
    assert.equal(
      (
        await docker(["exec", container, "sudo", "-n", "id", "-u"])
      ).stdout.trim(),
      "0",
    );
  }

  const deskPorts = JSON.parse(
    (
      await docker([
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        desk,
      ])
    ).stdout,
  );
  assert.equal(
    deskPorts["3100/tcp"],
    null,
    "Desk agent must not publish a host port",
  );
  assert.equal(deskPorts["6080/tcp"], null, "VNC must not publish a host port");

  const login = await loginAt(port);
  const deskStatus = await requestAt(port, "/api/desk/status", login);
  assert.equal(deskStatus.healthy, true);
  assert.match(deskStatus.ubuntuVersion || "", /Ubuntu 24\.04/i);
  const session = await requestAt(port, "/api/desk/session", login, "POST");
  await assertVncProxy(port, session.websocketPath, login.cookie);

  await docker([
    "exec",
    control,
    "sh",
    "-lc",
    "printf pair-smoke > /workspace/.pair-smoke",
  ]);
  await docker([
    "exec",
    desk,
    "sh",
    "-lc",
    "mkdir -p /home/orkestr/.config/chromium && printf browser-state > /home/orkestr/.config/chromium/pair-smoke && ln -sf stale-container-1989 /home/orkestr/.config/chromium/SingletonLock && ln -sf /tmp/missing-orkestr-smoke/SingletonSocket /home/orkestr/.config/chromium/SingletonSocket && ln -sf stale-cookie /home/orkestr/.config/chromium/SingletonCookie",
  ]);
  await compose(["restart", "orkestr", "orkestr-desk"]);
  await Promise.all([waitHealthy(control), waitHealthy(desk)]);
  const restartedPort = await publishedPort(control, "3000/tcp");
  await docker(["exec", control, "test", "-s", "/workspace/.pair-smoke"]);
  await docker([
    "exec",
    desk,
    "test",
    "-s",
    "/home/orkestr/.config/chromium/pair-smoke",
  ]);
  await docker([
    "exec",
    desk,
    "sh",
    "-lc",
    "test ! -L /home/orkestr/.config/chromium/SingletonLock && test ! -L /home/orkestr/.config/chromium/SingletonSocket && test ! -L /home/orkestr/.config/chromium/SingletonCookie",
  ]);
  await docker(["exec", control, "test", "-s", "/data/orkestr.sqlite"]);

  await requestAt(
    restartedPort,
    "/api/desk/actions/open-browser",
    login,
    "POST",
  );
  await waitForChromium(desk);
  await docker([
    "exec",
    desk,
    "sh",
    "-lc",
    "printf '<h1>pair smoke</h1>' > /workspace/.pair-smoke.html && xdg-open /workspace/.pair-smoke.html",
  ]);
  await waitForBrowserUrl(desk, "file:///workspace/.pair-smoke.html");
  console.log("Published control + Desk smoke test passed");
} finally {
  await cleanupOnce();
}

function cleanupOnce() {
  cleanupPromise ??= compose(["down", "--volumes", "--remove-orphans"], true);
  return cleanupPromise;
}

function installSignalCleanup(signal, exitCode) {
  process.once(signal, () => {
    console.error(
      `Received ${signal}; removing paired Docker smoke artifacts.`,
    );
    void cleanupOnce().finally(() => process.exit(exitCode));
  });
}

async function loginAt(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`login ${response.status}`);
      const cookie = response.headers.getSetCookie()[0]?.split(";", 1)[0];
      const body = await response.json();
      assert.ok(cookie);
      assert.ok(body.csrfToken);
      return { cookie, csrfToken: body.csrfToken };
    } catch {
      await delay(500);
    }
  }
  throw new Error("Control login did not become ready");
}

async function requestAt(port, path, auth, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      cookie: auth.cookie,
      ...(method === "POST" ? { "x-orkestr-csrf": auth.csrfToken } : {}),
    },
  });
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function assertVncProxy(port, path, cookie) {
  await new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    const timeout = setTimeout(
      () => rejectSocket(new Error("VNC proxy did not open")),
      10_000,
    );
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolveSocket();
    });
    socket.once("error", rejectSocket);
  });
}

async function containerId(service) {
  return (await compose(["ps", "--quiet", service])).stdout.trim();
}

async function publishedPort(container, port) {
  const value = (await docker(["port", container, port])).stdout.trim();
  const match = value.match(/:(\d+)$/);
  assert.ok(match, `Could not parse published port: ${value}`);
  return Number(match[1]);
}

async function waitHealthy(container) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const state = await docker(
      ["inspect", "--format", "{{.State.Health.Status}}", container],
      true,
    );
    if (state.stdout.trim() === "healthy") return;
    if (state.stdout.trim() === "unhealthy") {
      throw new Error((await docker(["logs", container], true)).stderr);
    }
    await delay(500);
  }
  throw new Error(`${container} did not become healthy`);
}

async function waitForChromium(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await docker(
      [
        "exec",
        container,
        "sh",
        "-lc",
        'pgrep -f \'chromium.*--user-data-dir=/home/orkestr/.config/chromium\' >/dev/null && curl --silent --fail http://127.0.0.1:9222/json/version >/dev/null && case "$(readlink /home/orkestr/.config/chromium/SingletonLock)" in "$(hostname)"-*) exit 0;; *) exit 1;; esac',
      ],
      true,
    );
    if (result.exitCode === 0) return;
    await delay(250);
  }
  throw new Error("Chromium did not acquire the current Desk profile");
}

async function waitForBrowserUrl(container, expectedUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await docker(
      [
        "exec",
        container,
        "sh",
        "-lc",
        "curl --silent --fail http://127.0.0.1:9222/json",
      ],
      true,
    );
    if (result.exitCode === 0 && result.stdout.includes(expectedUrl)) return;
    await delay(250);
  }
  throw new Error(`Chromium did not open ${expectedUrl}`);
}

function compose(args, allowFailure = false) {
  return run(
    "docker",
    ["compose", "--project-name", project, "--profile", "desk", ...args],
    allowFailure,
  );
}

function docker(args, allowFailure = false) {
  return run("docker", args, allowFailure);
}

async function run(command, args, allowFailure = false) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      env: environment,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (!allowFailure) throw error;
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
