import {
  Inject,
  Injectable,
  HttpException,
  HttpStatus,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { AuthService } from "../auth/auth.service.js";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

const MAX_SCROLLBACK = 1024 * 1024;
const TOKEN_LIFETIME_MS = 60_000;

interface ActiveTerminal {
  id: string;
  process: pty.IPty;
  clients: Set<WebSocket>;
  scrollback: string;
  status: "running" | "closed";
}

@Injectable()
export class TerminalService implements OnModuleInit, OnModuleDestroy {
  private active: ActiveTerminal | null = null;
  private readonly tokens = new Map<string, { sessionId: string; expiresAt: number }>();
  private readonly tokenRequests: number[] = [];
  private websocketServer: WebSocketServer | null = null;
  private upgradeListener: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private httpServer: Server | null = null;

  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  onModuleInit(): void {
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        "UPDATE terminal_sessions SET status = 'closed', closed_at = ?, last_active_at = ? WHERE status = 'running'",
      )
      .run(now, now);
  }

  onModuleDestroy(): void {
    if (this.active?.status === "running") this.active.process.kill();
    for (const client of this.active?.clients ?? []) client.close();
    this.websocketServer?.close();
    if (this.httpServer && this.upgradeListener) {
      this.httpServer.off("upgrade", this.upgradeListener);
    }
  }

  attach(server: Server, auth: AuthService): void {
    if (this.websocketServer) return;
    this.httpServer = server;
    this.websocketServer = new WebSocketServer({ noServer: true });
    this.websocketServer.on("connection", (socket, request) =>
      this.connect(socket, request),
    );
    this.upgradeListener = (request, socket, head) => {
      const url = new URL(request.url || "/", "http://localhost");
      const match = /^\/api\/terminal\/([0-9a-f-]+)$/.exec(url.pathname);
      if (!match) return;
      const sessionId = match[1] ?? "";
      const token = url.searchParams.get("token") ?? "";
      if (
        !this.validOrigin(request) ||
        !auth.verifySession(readCookieHeader(request.headers.cookie)) ||
        !this.consumeToken(token, sessionId) ||
        this.active?.id !== sessionId
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocketServer?.handleUpgrade(request, socket, head, (websocket) =>
        this.websocketServer?.emit("connection", websocket, request),
      );
    };
    server.on("upgrade", this.upgradeListener);
  }

  open(): { id: string; status: string; websocketToken: string } {
    this.rateLimitToken();
    if (!this.active || this.active.status === "closed") this.spawn();
    return this.issueConnection(this.active as ActiveTerminal);
  }

  restart(id: string): { id: string; status: string; websocketToken: string } {
    if (!this.active || this.active.id !== id) {
      throw new NotFoundException("Terminal session not found");
    }
    if (this.active.status === "running") {
      this.audit(id, "restart", {});
      this.active.process.kill();
      for (const client of this.active.clients) client.close();
      this.closeRecord(this.active, null);
      this.active = null;
    }
    if (!this.active || this.active.status === "closed") this.spawn();
    return this.issueConnection(this.active as ActiveTerminal);
  }

  private spawn(): void {
    const id = randomUUID();
    const shell = process.env.SHELL?.endsWith("bash") ? process.env.SHELL : "/bin/bash";
    const terminalProcess = pty.spawn(shell, ["--noprofile", "--norc"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: this.config.workspace,
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: this.config.workspace,
        LANG: process.env.LANG || "C.UTF-8",
        TERM: "xterm-256color",
      },
    });
    const session: ActiveTerminal = {
      id,
      process: terminalProcess,
      clients: new Set(),
      scrollback: "",
      status: "running",
    };
    this.active = session;
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        "INSERT INTO terminal_sessions(id, status, created_at, last_active_at) VALUES (?, 'running', ?, ?)",
      )
      .run(id, now, now);
    this.audit(id, "started", { cwd: this.config.workspace });
    terminalProcess.onData((data) => {
      if (this.active !== session) return;
      session.scrollback = `${session.scrollback}${data}`.slice(-MAX_SCROLLBACK);
      this.touch(id);
      this.broadcast(session, { type: "output", data });
    });
    terminalProcess.onExit(({ exitCode, signal }) => {
      if (this.active !== session) return;
      session.status = "closed";
      this.closeRecord(session, exitCode);
      this.audit(id, "exited", { exitCode, signal });
      this.broadcast(session, { type: "exit", exitCode, signal });
    });
  }

  private connect(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url || "/", "http://localhost");
    const id = /^\/api\/terminal\/([0-9a-f-]+)$/.exec(url.pathname)?.[1];
    const session = this.active;
    if (!id || !session || session.id !== id || session.status !== "running") {
      socket.close(1008, "Terminal session is unavailable");
      return;
    }
    session.clients.add(socket);
    this.audit(id, "connected", {});
    socket.send(
      JSON.stringify({
        type: "ready",
        sessionId: id,
        status: session.status,
        scrollback: session.scrollback,
      }),
    );
    socket.on("message", (raw, binary) => {
      const bytes = Array.isArray(raw)
        ? raw.reduce((total, part) => total + part.byteLength, 0)
        : raw.byteLength;
      if (binary || bytes > 16_384) return;
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "input" && typeof message.data === "string") {
          const data = message.data.slice(0, 8_192);
          session.process.write(data);
          this.audit(id, "input", { bytes: Buffer.byteLength(data) });
        } else if (message.type === "resize") {
          const cols = clamp(Number(message.cols), 20, 300);
          const rows = clamp(Number(message.rows), 5, 120);
          session.process.resize(cols, rows);
          this.audit(id, "resize", { cols, rows });
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid terminal frame" }));
      }
    });
    socket.on("close", () => {
      session.clients.delete(socket);
      this.audit(id, "disconnected", {});
    });
  }

  private issueConnection(session: ActiveTerminal) {
    const websocketToken = randomBytes(24).toString("base64url");
    this.tokens.set(websocketToken, {
      sessionId: session.id,
      expiresAt: Date.now() + TOKEN_LIFETIME_MS,
    });
    this.pruneTokens();
    return { id: session.id, status: session.status, websocketToken };
  }

  private consumeToken(token: string, sessionId: string): boolean {
    const record = this.tokens.get(token);
    this.tokens.delete(token);
    return Boolean(
      record && record.sessionId === sessionId && record.expiresAt > Date.now(),
    );
  }

  private rateLimitToken(): void {
    const cutoff = Date.now() - 60_000;
    while (this.tokenRequests[0] && this.tokenRequests[0] < cutoff) {
      this.tokenRequests.shift();
    }
    if (this.tokenRequests.length >= 30) {
      throw new HttpException(
        "Too many terminal connection attempts",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.tokenRequests.push(Date.now());
  }

  private validOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    const forwarded = String(request.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      ?.trim();
    const protocol = forwarded || (this.config.cookieSecure ? "https" : "http");
    const expected = `${protocol}://${request.headers.host}`;
    return origin === expected || this.config.allowedOrigins.includes(origin);
  }

  private broadcast(session: ActiveTerminal, message: unknown): void {
    const data = JSON.stringify(message);
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  private touch(id: string): void {
    this.database.db
      .prepare("UPDATE terminal_sessions SET last_active_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  private closeRecord(session: ActiveTerminal, exitCode: number | null): void {
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        "UPDATE terminal_sessions SET status = 'closed', closed_at = ?, last_active_at = ?, exit_code = ? WHERE id = ?",
      )
      .run(now, now, exitCode, session.id);
  }

  private audit(sessionId: string, eventType: string, metadata: unknown): void {
    this.database.db
      .prepare(
        "INSERT INTO terminal_events(session_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, eventType, JSON.stringify(metadata), new Date().toISOString());
  }

  private pruneTokens(): void {
    for (const [token, record] of this.tokens) {
      if (record.expiresAt <= Date.now()) this.tokens.delete(token);
    }
  }
}

function readCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== "orkestr_session") continue;
    return decodeURIComponent(part.slice(separator + 1));
  }
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
