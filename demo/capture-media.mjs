import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { chromium } from "playwright";
import { mediaBinaries, run } from "./media-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const baseUrl = process.env.ORKESTR_LIVE_URL ?? "http://127.0.0.1:3001";
const password = process.env.ORKESTR_LIVE_PASSWORD;
const workspaceValue = process.env.ORKESTR_DEMO_WORKSPACE;
const phoneCaptureValue = process.env.ORKESTR_WHATSAPP_CAPTURE;
assert.ok(password, "ORKESTR_LIVE_PASSWORD is required");
assert.ok(workspaceValue, "ORKESTR_DEMO_WORKSPACE is required");
assert.ok(
  isAbsolute(workspaceValue),
  "ORKESTR_DEMO_WORKSPACE must be absolute",
);
assert.ok(phoneCaptureValue, "ORKESTR_WHATSAPP_CAPTURE is required");

const workspace = resolve(workspaceValue);
const phoneCapture = resolve(phoneCaptureValue);
const outputDirectory = resolve(
  process.env.ORKESTR_SUBMISSION_MEDIA_DIR ??
    join(root, "assets/submission/v0.2"),
);
await Promise.all([
  access(join(workspace, ".orkestr/demo-evidence-v0.2.json")),
  access(join(workspace, "reports/agent-runtime-landscape.md")),
  access(join(workspace, "reports/agent-runtime-landscape.html")),
  access(phoneCapture),
  mkdir(outputDirectory, { recursive: true }),
]);

await sanitizeWhatsAppCapture(
  phoneCapture,
  join(outputDirectory, "whatsapp.png"),
);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const page = await context.newPage();
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const login = page.getByLabel("Administrator password");
  if (await login.isVisible().catch(() => false)) {
    await login.fill(password);
    await page.getByRole("button", { name: "Open workstation" }).click();
  }

  await capture(page, "/setup", "setup.png", async () => {
    await page
      .getByRole("heading", { name: "Connect your workstation" })
      .waitFor();
    await redactVisibleIdentity(page);
  });

  await capture(page, "/chat", "chat.png", async () => {
    await page.getByRole("heading", { name: "Codex" }).waitFor();
    const activity = page.getByText("Activity log", { exact: true }).last();
    if (await activity.isVisible().catch(() => false)) await activity.click();
  });

  await capture(page, "/desk", "desk-report.png", async () => {
    await page
      .getByText(/Live Desk|Connecting to Desk/i)
      .first()
      .waitFor();
    await page.waitForTimeout(8_000);
  });

  await capture(page, "/files", "files.png", async () => {
    await page
      .getByRole("heading", { name: "Workstation filesystem" })
      .waitFor();
    await openDirectory(page, "workspace");
    await openDirectory(page, "reports");
    await page
      .getByRole("button", { name: /agent-runtime-landscape\.md/ })
      .click();
    await page.waitForTimeout(500);
  });

  await capture(page, "/timers", "timers.png", async () => {
    await page.getByRole("heading", { name: "Scheduled messages" }).waitFor();
    await page
      .getByText("Weekly agent runtime watch", { exact: true })
      .waitFor();
  });

  await capture(page, "/chat", "report-complete.png", async () => {
    await page.getByRole("heading", { name: "Codex" }).waitFor();
    await page
      .getByText(/agent-runtime-landscape/i)
      .last()
      .scrollIntoViewIfNeeded();
  });
} finally {
  await browser.close();
}

process.stdout.write(
  `${JSON.stringify({ captured: true, outputDirectory }, null, 2)}\n`,
);

async function capture(page, path, filename, ready) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  await ready();
  await page.screenshot({
    path: join(outputDirectory, filename),
    fullPage: false,
    animations: "disabled",
  });
}

async function openDirectory(page, name) {
  const button = page.locator("button.file-entry", { hasText: name }).first();
  await button.waitFor();
  await button.click();
}

async function redactVisibleIdentity(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".whatsapp-qr,.device-code").forEach((node) => {
      node.replaceChildren(
        "Sensitive setup detail hidden for submission capture",
      );
    });
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      node.textContent = node.textContent
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "authenticated account")
        .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, "linked account")
        .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/g, "hidden code");
    }
  });
}

async function sanitizeWhatsAppCapture(input, output) {
  const crop = process.env.ORKESTR_WHATSAPP_CROP?.trim();
  const redactions = process.env.ORKESTR_WHATSAPP_REDACTIONS?.trim();
  const ownerApproved = process.env.ORKESTR_WHATSAPP_CAPTURE_SANITIZED === "1";
  assert.ok(
    crop || redactions || ownerApproved,
    "Set a crop/redaction or explicitly mark the private input sanitized",
  );
  const filters = [];
  if (crop) {
    assert.match(crop, /^\d+:\d+:\d+:\d+$/, "Invalid crop w:h:x:y");
    filters.push(`crop=${crop}`);
  }
  if (redactions) {
    for (const rectangle of redactions.split(",")) {
      assert.match(rectangle, /^\d+:\d+:\d+:\d+$/, "Invalid redaction x:y:w:h");
      const [x, y, w, h] = rectangle.split(":");
      filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill`);
    }
  }
  const { ffmpeg } = await mediaBinaries();
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input];
  if (filters.length) args.push("-vf", filters.join(","));
  args.push("-frames:v", "1", output);
  await run(ffmpeg, args);
}
