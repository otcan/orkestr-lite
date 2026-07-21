import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const baseUrl = process.env.ORKESTR_LIVE_URL ?? "http://127.0.0.1:3001";
const password = process.env.ORKESTR_LIVE_PASSWORD;
const workspace = resolve(process.env.ORKESTR_DEMO_WORKSPACE ?? "");
let demoWorkspaceValidated = false;
let sourceSha = process.env.ORKESTR_SOURCE_SHA ?? null;
process.on("uncaughtExceptionMonitor", (error) => {
  if (!demoWorkspaceValidated) return;
  try {
    writeFileSync(
      join(workspace, ".orkestr/demo-failure-v0.2.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          failedAt: new Date().toISOString(),
          baseUrl,
          sourceSha,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch {}
});
const whatsappTimeoutMinutes = Math.max(
  1,
  Number(process.env.ORKESTR_DEMO_WHATSAPP_TIMEOUT_MINUTES) || 20,
);

if (!password) throw new Error("ORKESTR_LIVE_PASSWORD is required");
if (!process.env.ORKESTR_DEMO_WORKSPACE) {
  throw new Error("ORKESTR_DEMO_WORKSPACE is required");
}
assert.ok(isAbsolute(process.env.ORKESTR_DEMO_WORKSPACE));
assert.notEqual(workspace, "/workspace", "Use the bind-mounted host path");
assert.equal(
  (await readFile(join(workspace, ".orkestr-demo-disposable"), "utf8")).trim(),
  "orkestr-lite-demo-v0.2",
  "Disposable demo sentinel is missing or invalid",
);
demoWorkspaceValidated = true;
const execFileAsync = promisify(execFile);
sourceSha ??= (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!loginResponse.ok) {
  throw new Error(
    `Login failed (${loginResponse.status}): ${await loginResponse.text()}`,
  );
}
const cookie = loginResponse.headers.getSetCookie()[0]?.split(";", 1)[0];
assert.ok(cookie, "Login did not set a session cookie");
const login = await loginResponse.json();
assert.equal(typeof login.csrfToken, "string");

const setup = await waitForSetup();
assert.equal(setup.codex.authenticated, true);
assert.match(setup.codex.selectedModel, /^gpt-5\.6(?:$|[-.])/i);
emit("setup.ready", {
  selectedModel: setup.codex.selectedModel,
  cliVersion: setup.codex.cliVersion,
  whatsappReady: setup.whatsapp?.ready ?? false,
});

const research = await request("/api/turns", {
  method: "POST",
  csrfToken: login.csrfToken,
  body: {
    source: "demo",
    content: researchPrompt(),
    clientMessageId: `v0.2-research-${Date.now()}`,
  },
});
emit("research.queued", {
  turnId: research.id,
  controlCode: research.controlCode,
});
const completedResearch = await waitForTurn(research.id, 45 * 60_000);
assertGpt56(completedResearch);

const markdownPath = join(workspace, "reports/agent-runtime-landscape.md");
const htmlPath = join(workspace, "reports/agent-runtime-landscape.html");
emit("research.completed", {
  turnId: completedResearch.id,
  effectiveModel: completedResearch.effectiveModel,
  markdownPath,
  htmlPath,
});

process.stdout.write(
  "\nWhatsApp step (authentic linked-device self-chat)\n" +
    "Send this exact message now:\n\n" +
    `${whatsappFollowup()}\n\n` +
    `Waiting up to ${whatsappTimeoutMinutes} minutes for the completed WhatsApp turn…\n`,
);
const whatsappTurn = await waitForWhatsAppFollowup(
  Date.parse(research.createdAt),
  whatsappTimeoutMinutes * 60_000,
);
assertGpt56(whatsappTurn);
assert.ok(
  whatsappTurn.attachments.some(
    (attachment) =>
      attachment.direction === "outbound" &&
      attachment.name === "agent-runtime-landscape.md",
  ),
  "WhatsApp follow-up did not return the updated Markdown report",
);
emit("whatsapp.completed", {
  turnId: whatsappTurn.id,
  controlCode: whatsappTurn.controlCode,
  outputAttachment: "agent-runtime-landscape.md",
});

const now = new Date();
const timer = await request("/api/timers", {
  method: "POST",
  csrfToken: login.csrfToken,
  body: {
    name: "Weekly agent runtime watch",
    prompt:
      "Review the three official runtime documentation sources in /workspace/reports/agent-runtime-landscape.md for material changes. Update both report files with citations and a dated change note. If nothing material changed, record that explicitly.",
    kind: "weekly",
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    weekday: now.getDay(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    enabled: true,
  },
});
const ranTimer = await request(`/api/timers/${timer.id}/run`, {
  method: "POST",
  csrfToken: login.csrfToken,
});
assert.ok(ranTimer.lastTurnId, "Run now did not create a scheduled turn");
const scheduledTurn = await waitForTurn(ranTimer.lastTurnId, 30 * 60_000);
assertGpt56(scheduledTurn);
emit("schedule.completed", {
  timerId: timer.id,
  turnId: scheduledTurn.id,
});

await mkdir(join(workspace, ".orkestr"), { recursive: true });
const evidence = {
  schemaVersion: 1,
  completedAt: new Date().toISOString(),
  sourceSha,
  primaryPrompt: researchPrompt(),
  research: evidenceTurn(completedResearch),
  whatsapp: {
    ...evidenceTurn(whatsappTurn),
    outputAttachment: "agent-runtime-landscape.md",
  },
  schedule: {
    id: timer.id,
    name: timer.name,
    turn: evidenceTurn(scheduledTurn),
  },
  reports: { markdownPath, htmlPath },
};
await writeFile(
  join(workspace, ".orkestr/demo-evidence-v0.2.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 },
);
emit("demo.passed", evidence);

async function waitForSetup() {
  let latest;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const [setup, whatsapp] = await Promise.all([
      request("/api/setup/status"),
      request("/api/setup/whatsapp/status"),
    ]);
    latest = { ...setup, whatsapp };
    if (latest.ready && whatsapp.ready) return latest;
    await delay(1_000);
  }
  throw new Error(
    `Orkestr did not become ready: ${JSON.stringify({ codex: latest?.codex, whatsapp: latest?.whatsapp })}`,
  );
}

async function waitForTurn(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let priorStatus;
  while (Date.now() < deadline) {
    const turn = await request(`/api/turns/${id}`);
    if (turn.status !== priorStatus) {
      emit("turn.status", { turnId: id, status: turn.status });
      priorStatus = turn.status;
    }
    if (turn.status === "completed") return turn;
    if (["failed", "interrupted", "cancelled"].includes(turn.status)) {
      throw new Error(
        `${id} ended ${turn.status}: ${turn.error || "no detail"}`,
      );
    }
    await delay(2_000);
  }
  throw new Error(`Turn ${id} timed out`);
}

async function waitForWhatsAppFollowup(after, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await request("/api/turns?limit=100");
    const match = page.data.find(
      (turn) =>
        turn.source === "whatsapp" &&
        Date.parse(turn.createdAt) >= after &&
        /solo-operator recommendation/i.test(turn.prompt),
    );
    if (match) return waitForTurn(match.id, Math.max(1, deadline - Date.now()));
    await delay(2_000);
  }
  throw new Error("Timed out waiting for the WhatsApp demo follow-up");
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
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  assert.ok(response.ok, `${response.status}: ${text}`);
  return result;
}

function researchPrompt() {
  return `Create a sourced research report comparing these three agent runtimes using only their official documentation as primary sources:
- OpenHands runtime: https://docs.openhands.dev/openhands/usage/architecture/runtime
- Open Interpreter terminal getting started: https://www.openinterpreter.com/docs/terminal/getting-started
- goose installation: https://goose-docs.ai/docs/getting-started/installation/

Compare deployment model, runtime boundary, persistence, GUI/computer access, supervision, and operational inputs. Be precise: write “not documented in the reviewed sources” when the reviewed pages do not establish a capability; do not equate that with “unsupported.” Include inline Markdown links near every material claim, a concise comparison table, limitations, and a dated source-review note.

Save the cited Markdown report at /workspace/reports/agent-runtime-landscape.md and a readable self-contained HTML version beside it at /workspace/reports/agent-runtime-landscape.html. Open the HTML file in the visible Desk browser with xdg-open after writing both files. Do not fabricate execution, citations, or product capabilities.`;
}

function whatsappFollowup() {
  return "Update the agent runtime landscape report with a sourced solo-operator recommendation. Preserve the distinction between not documented in the reviewed sources and unsupported. Return the updated /workspace/reports/agent-runtime-landscape.md file to this WhatsApp chat.";
}

function assertGpt56(turn) {
  assert.equal(turn.status, "completed");
  assert.match(turn.requestedModel || "", /^gpt-5\.6(?:$|[-.])/i);
  assert.match(turn.effectiveModel || "", /^gpt-5\.6(?:$|[-.])/i);
}

function evidenceTurn(turn) {
  return {
    id: turn.id,
    source: turn.source,
    requestedModel: turn.requestedModel,
    effectiveModel: turn.effectiveModel,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
  };
}

function emit(event, detail) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
