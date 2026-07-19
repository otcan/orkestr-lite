import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";

const host = process.env.ORKESTR_DESK_HOST ?? "0.0.0.0";
const port = Number(process.env.ORKESTR_DESK_PORT ?? "3100");
const tokenFile =
  process.env.ORKESTR_DESK_TOKEN_FILE ?? "/run/orkestr-desk-auth/token";
const workspace = process.env.ORKESTR_WORKSPACE ?? "/workspace";
const codexHome = process.env.CODEX_HOME ?? "/codex";
const deskHome = process.env.HOME ?? "/home/orkestr";
const display = process.env.DISPLAY ?? ":1";
const expectedCodexVersion = process.env.ORKESTR_CODEX_VERSION ?? "0.144.5";
const browserCommand = process.env.ORKESTR_DESK_BROWSER ?? "chromium";

let secret = "";
let desktopProcesses: ChildProcess[] = [];
let codexProcess: ChildProcess | null = null;
let codexSocket: WebSocket | null = null;
let desktopStartedAt: string | null = null;
let restartCount = 0;
let desktopGeneration = 0;
let desktopStartTimer: NodeJS.Timeout | null = null;

const ubuntuVersion = osRelease();
const chromeVersion = commandVersion(browserCommand, ["--version"]);
const codexVersion =
  commandVersion("codex", ["--version"]).replace(/^codex-cli\s+/, "") ||
  expectedCodexVersion;

const websocketServer = new WebSocketServer({ noServer: true });
const server = createServer(
  (request, response) => void handleHttp(request, response),
);

async function main(): Promise<void> {
  secret = (await readFile(tokenFile, "utf8")).trim();
  if (!secret) throw new Error("Desk authentication token is empty");
  startDesktop();
  websocketServer.on("connection", (socket) => connectCodex(socket));
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (
      url.pathname !== "/codex" ||
      !sameSecret(url.searchParams.get("token") || "")
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (codexSocket || codexProcess) {
      socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) =>
      websocketServer.emit("connection", client, request),
    );
  });
  server.listen(port, host);
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") {
    const ready = desktopReady();
    json(response, ready ? 200 : 503, {
      status: ready ? "ready" : "starting",
      ubuntuVersion,
      chromeVersion,
      codexVersion,
      desktopStartedAt,
      restartCount,
    });
    return;
  }
  if (!sameSecret(bearerToken(request))) {
    json(response, 401, { message: "Unauthorized" });
    return;
  }
  if (request.method !== "POST") {
    json(response, 404, { message: "Not found" });
    return;
  }
  if (url.pathname === "/actions/open-browser") {
    openBrowser();
    json(response, 202, { accepted: true });
    return;
  }
  if (url.pathname === "/actions/restart") {
    await restartDesktop(false);
    json(response, 200, { restarted: true });
    return;
  }
  if (url.pathname === "/actions/reset") {
    await restartDesktop(true);
    json(response, 200, { reset: true });
    return;
  }
  json(response, 404, { message: "Not found" });
}

function startDesktop(): void {
  const generation = ++desktopGeneration;
  const environment = { ...process.env, DISPLAY: display, HOME: deskHome };
  desktopProcesses = [
    managed(
      "Xtigervnc",
      [
        display,
        "-geometry",
        process.env.ORKESTR_DESK_GEOMETRY ?? "1600x900",
        "-depth",
        "24",
        "-SecurityTypes",
        "None",
        "-localhost",
        "no",
        "-AlwaysShared",
      ],
      environment,
    ),
  ];
  desktopStartTimer = setTimeout(() => {
    desktopStartTimer = null;
    if (generation !== desktopGeneration) return;
    desktopProcesses.push(
      managed("dbus-run-session", ["--", "startxfce4"], environment),
      managed("websockify", ["6080", "127.0.0.1:5901"], environment),
    );
  }, 750);
  desktopStartedAt = new Date().toISOString();
}

function desktopReady(): boolean {
  return ["Xtigervnc", "dbus-run-session", "websockify"].every((command) =>
    desktopProcesses.some(
      (child) =>
        (child.spawnfile === command ||
          child.spawnfile.endsWith(`/${command}`)) &&
        child.exitCode === null &&
        child.signalCode === null,
    ),
  );
}

function managed(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) =>
    process.stdout.write(`[${command}] ${chunk}`),
  );
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(`[${command}] ${chunk}`),
  );
  child.on("error", (error) =>
    process.stderr.write(`[${command}] ${error.message}\n`),
  );
  return child;
}

function openBrowser(): void {
  const profile = `${deskHome}/.config/google-chrome`;
  const existing = desktopProcesses.find(
    (process) =>
      process.spawnargs[0]?.includes(browserCommand) &&
      process.exitCode === null,
  );
  const profileProcess = spawnSync("pgrep", [
    "-f",
    `chromium.*--user-data-dir=${profile}`,
  ]);
  if (existing || profileProcess.status === 0) return;
  for (const singleton of [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
  ])
    rmSync(`${profile}/${singleton}`, { force: true });
  desktopProcesses.push(
    managed(
      browserCommand,
      [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "about:blank",
      ],
      { ...process.env, DISPLAY: display, HOME: deskHome },
    ),
  );
}

async function restartDesktop(reset: boolean): Promise<void> {
  stopCodex();
  desktopGeneration += 1;
  if (desktopStartTimer) clearTimeout(desktopStartTimer);
  desktopStartTimer = null;
  for (const child of desktopProcesses) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of desktopProcesses) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  desktopProcesses = [];
  if (reset) {
    await Promise.all([
      rm(`${deskHome}/.config/google-chrome`, { recursive: true, force: true }),
      rm(`${deskHome}/.cache`, { recursive: true, force: true }),
      rm(`${deskHome}/.config/xfce4`, { recursive: true, force: true }),
    ]);
  }
  restartCount += 1;
  startDesktop();
}

function connectCodex(socket: WebSocket): void {
  codexSocket = socket;
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: deskHome,
      DISPLAY: display,
      BROWSER: browserCommand,
      XDG_CURRENT_DESKTOP: "XFCE",
      DESKTOP_SESSION: "xfce",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  codexProcess = child;
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
  stdout.on("line", (line) => send(socket, { type: "stdout", line }));
  stderr.on("line", (line) => send(socket, { type: "stderr", line }));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        line?: string;
      };
      if (message.type === "stdin" && typeof message.line === "string") {
        child.stdin.write(`${message.line}\n`);
      } else if (message.type === "stop") {
        child.kill("SIGTERM");
      }
    } catch {
      send(socket, { type: "stderr", line: "Invalid control transport frame" });
    }
  });
  const close = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (socket.readyState === WebSocket.OPEN) socket.close();
    if (codexSocket === socket) codexSocket = null;
    if (codexProcess === child) codexProcess = null;
  };
  socket.once("close", close);
  socket.once("error", close);
  child.once("exit", close);
  child.once("error", (error) => {
    send(socket, { type: "stderr", line: error.message });
    close();
  });
}

function stopCodex(): void {
  codexProcess?.kill("SIGTERM");
  codexSocket?.close(1012, "Desk restarting");
  codexProcess = null;
  codexSocket = null;
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function sameSecret(candidate: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(secret);
  return (
    left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right)
  );
}

function bearerToken(request: IncomingMessage): string {
  const header = String(request.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function commandVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

function osRelease(): string {
  const result = spawnSync(
    "sh",
    ["-c", ". /etc/os-release && printf '%s' \"$PRETTY_NAME\""],
    {
      encoding: "utf8",
      timeout: 1_000,
    },
  );
  return result.stdout.trim();
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function shutdown(): Promise<void> {
  stopCodex();
  desktopGeneration += 1;
  if (desktopStartTimer) clearTimeout(desktopStartTimer);
  desktopStartTimer = null;
  for (const child of desktopProcesses) child.kill("SIGTERM");
  websocketServer.close();
  server.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
