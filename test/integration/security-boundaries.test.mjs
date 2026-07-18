import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const fakeCodex = join(root, "test/fixtures/fake-codex.mjs");

test("rejects an explicitly weak administrator password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-weak-password-"));
  const child = spawn(process.execPath, [join(root, "dist/server/main.js")], {
    cwd: root,
    env: {
      ...process.env,
      ORKESTR_HOME: join(directory, "data"),
      ORKESTR_WORKSPACE: join(directory, "workspace"),
      ORKESTR_ADMIN_PASSWORD: "too-short",
      ORKESTR_CODEX_COMMAND: fakeCodex,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  try {
    const [code] = await Promise.race([
      once(child, "exit"),
      delay(3_000).then(() => {
        throw new Error("Server accepted an explicitly weak password");
      }),
    ]);
    assert.notEqual(code, 0);
    assert.match(logs, /between 12 and 512 characters/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces the HTTP, session, and private-data security boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-security-"));
  const home = join(directory, "data");
  const codexHome = join(home, "codex");
  const database = join(home, "orkestr.sqlite");
  const workspace = join(directory, "workspace");
  await cp(join(root, "demo/workspace"), workspace, { recursive: true });
  await chmod(fakeCodex, 0o755);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, "dist/server/main.js")], {
    cwd: root,
    env: {
      ...process.env,
      ORKESTR_HOME: home,
      CODEX_HOME: codexHome,
      ORKESTR_DATABASE: database,
      ORKESTR_WORKSPACE: workspace,
      ORKESTR_PORT: String(port),
      ORKESTR_ADMIN_PASSWORD: "security-test-password",
      ORKESTR_CODEX_COMMAND: fakeCodex,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  try {
    await waitForHealth(origin, child, () => logs);

    assert.equal(await permissions(home), 0o700);
    assert.equal(await permissions(codexHome), 0o700);
    assert.equal(await permissions(database), 0o600);

    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
    assert.ok(page.headers.get("x-frame-options"));

    const anonymousSession = await fetch(`${origin}/api/auth/session`);
    assert.equal(anonymousSession.status, 200);
    assert.equal(anonymousSession.headers.get("cache-control"), "no-store");
    assert.deepEqual(await anonymousSession.json(), {
      authenticated: false,
      csrfToken: null,
    });

    const anonymousMissions = await fetch(`${origin}/api/missions`);
    assert.equal(anonymousMissions.status, 401);

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "security-test-password" }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("cache-control"), "no-store");
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    const cookie = setCookie.split(";", 1)[0];
    assert.ok(cookie.startsWith("orkestr_session="));
    const loginBody = await login.json();
    assert.equal(loginBody.authenticated, true);
    assert.equal(typeof loginBody.csrfToken, "string");
    const csrfToken = loginBody.csrfToken;

    const authenticatedSession = await fetch(`${origin}/api/auth/session`, {
      headers: { cookie },
    });
    assert.equal(authenticatedSession.status, 200);
    assert.equal((await authenticatedSession.json()).authenticated, true);

    const missingCsrf = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(missingCsrf.status, 403);

    const crossOrigin = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://attacker.invalid",
        "x-orkestr-csrf": csrfToken,
      },
    });
    assert.equal(crossOrigin.status, 403);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "x-orkestr-csrf": csrfToken,
      },
    });
    assert.equal(logout.status, 204);

    const replayedSession = await fetch(`${origin}/api/auth/session`, {
      headers: { cookie },
    });
    assert.deepEqual(await replayedSession.json(), {
      authenticated: false,
      csrfToken: null,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalidLogin = await fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "incorrect-password" }),
      });
      assert.equal(invalidLogin.status, 401);
    }
    const rateLimited = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "incorrect-password" }),
    });
    assert.equal(rateLimited.status, 429);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3_000).then(() => child.kill("SIGKILL")),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function permissions(path) {
  return (await stat(path)).mode & 0o777;
}

async function waitForHealth(origin, child, getLogs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early:\n${getLogs()}`);
    }
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
  if (!address || typeof address !== "object") {
    throw new Error("Could not allocate a security test port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
