import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const fakeCodex = join(root, "test/fixtures/fake-codex.mjs");
const mediaDirectory = process.env.ORKESTR_CAPTURE_MEDIA_DIR?.trim();

test("runs one persistent conversation from the browser", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-browser-e2e-"));
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
        ORKESTR_ADMIN_PASSWORD: "browser-e2e-password",
        ORKESTR_CODEX_COMMAND: fakeCodex,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));

  try {
    await waitForHealth(port, child, () => logs);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}`);

    await page
      .getByLabel("Administrator password")
      .fill("browser-e2e-password");
    await page.getByRole("button", { name: "Open workstation" }).click();
    await expect(page.getByText("Workstation setup")).toBeVisible();

    await expect(page.getByText("System ready")).toHaveCount(0);
    await expect(page.getByText("Workspace mounted")).toHaveCount(0);
    const codexConnection = page.locator(".setup-connection").first();
    await expect(
      page.getByRole("heading", { name: "Codex connected" }),
    ).toBeVisible();
    await expect(codexConnection).toContainText("Connected");
    await expect(codexConnection).toContainText("gpt-5.6");
    const whatsappConnection = page
      .locator(".setup-connection")
      .filter({ hasText: "WhatsApp linked device" });
    await expect(whatsappConnection).toContainText("Link WhatsApp");
    await expect(
      whatsappConnection.getByRole("button", { name: "Link WhatsApp" }),
    ).toBeVisible();
    await captureMedia(page, "setup-ready.png");

    await page.getByRole("button", { name: "Open Orkestr" }).click();
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/chat`);
    await expect(
      page.getByRole("heading", { name: "What should Codex do?" }),
    ).toBeVisible();
    await expect(page.getByText("Mission", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Thread", { exact: true })).toHaveCount(0);
    await page
      .getByPlaceholder("Message Codex…")
      .fill(
        "Find the failing test, implement the smallest correct fix, run the tests, and explain the change.",
      );
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page).toHaveURL(
      new RegExp(`http://127\\.0\\.0\\.1:${port}/chat/[0-9a-f-]+`),
    );
    await expect(page.getByText("Thread", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Completed in \d+ seconds/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("3 tests passed")).toBeVisible();
    await expect(page.locator(".codex-message")).toContainText(
      "Corrected the reversed clamp bounds",
    );
    await expect(page.locator(".activity-timeline")).toContainText(
      "Response completed",
    );
    await page.reload();
    await expect(page.locator(".codex-message")).toContainText(
      "Corrected the reversed clamp bounds",
    );
    await captureMedia(page, "conversation-complete.png");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Administrator password")).toBeVisible();

    assertFixtureChanged(
      await readFile(join(workspace, "src/clamp.js"), "utf8"),
    );
    const testEnvironment = { ...process.env };
    delete testEnvironment.NODE_TEST_CONTEXT;
    const testResult = await execFileAsync(
      process.execPath,
      ["--test", "test/clamp.test.js"],
      { cwd: workspace, env: testEnvironment },
    );
    expect(testResult.stdout).toContain("pass 3");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3_000).then(() => child.kill("SIGKILL")),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function captureMedia(page, filename) {
  if (!mediaDirectory) return;
  const outputDirectory = resolve(root, mediaDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await page.screenshot({
    path: join(outputDirectory, filename),
    fullPage: true,
  });
}

function assertFixtureChanged(source) {
  expect(source).toContain("Math.max(minimum, Math.min(maximum, value))");
}

async function waitForHealth(port, child, getLogs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early:\n${getLogs()}`);
    }
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
  if (!address || typeof address !== "object") {
    throw new Error("Could not allocate a browser test port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
