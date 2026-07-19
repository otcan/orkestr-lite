import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { AuthService } from "../auth/auth.service.js";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { MissionsService } from "../missions/missions.service.js";

const TICKET_LIFETIME_MS = 60_000;
const CONTROL_LIFETIME_MS = 15 * 60_000;

interface DeskHealth {
  status?: string;
  ubuntuVersion?: string;
  chromeVersion?: string;
  codexVersion?: string;
  desktopStartedAt?: string;
  restartCount?: number;
}

@Injectable()
export class DeskService implements OnModuleDestroy {
  private readonly tickets = new Map<string, number>();
  private websocketServer: WebSocketServer | null = null;
  private server: Server | null = null;
  private upgradeListener:
    | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;
  private controlExpiresAt = 0;
  private everHealthy = false;
  private controlTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    private readonly missions: MissionsService,
  ) {}

  async status() {
    const health = await this.health();
    if (health) this.everHealthy = true;
    const now = Date.now();
    if (this.controlExpiresAt && this.controlExpiresAt <= now)
      this.expireControl();
    return {
      enabled:
        Boolean(this.config.deskUrl && this.config.deskVncUrl) &&
        (this.everHealthy ||
          health !== null ||
          this.config.codexTransport === "desk"),
      configured: Boolean(this.config.deskUrl && this.config.deskVncUrl),
      healthy: health !== null,
      connectionState: health
        ? "ready"
        : this.config.deskUrl
          ? "unavailable"
          : "disabled",
      control: this.controlExpiresAt > now ? "human" : "watch",
      controlExpiresAt:
        this.controlExpiresAt > now
          ? new Date(this.controlExpiresAt).toISOString()
          : null,
      activeTurnId: this.missions.activeTurnId(),
      ...health,
    };
  }

  async createSession() {
    if (!(await this.health()))
      throw new ServiceUnavailableException("Live Desk is unavailable");
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, Date.now() + TICKET_LIFETIME_MS);
    this.pruneTickets();
    return {
      websocketPath: `/api/desk/vnc?ticket=${encodeURIComponent(ticket)}`,
      // The workstation is directly interactive. "Take control" is an
      // optional queue-pause/exclusivity action, not a prerequisite for input.
      viewOnly: false,
      expiresAt: new Date(Date.now() + TICKET_LIFETIME_MS).toISOString(),
    };
  }

  async acquireControl(interruptActive: boolean) {
    const active = this.missions.activeTurnId();
    if (active && !interruptActive) {
      throw new ConflictException(
        "Stop the active response before taking control",
      );
    }
    this.missions.setDispatchPaused(true);
    if (active) await this.missions.interrupt(active);
    this.controlExpiresAt = Date.now() + CONTROL_LIFETIME_MS;
    this.armControlTimer();
    return this.status();
  }

  releaseControl() {
    this.expireControl();
    return this.status();
  }

  async action(action: "open-browser" | "restart" | "reset") {
    if (action !== "open-browser" && this.missions.activeTurnId()) {
      throw new ConflictException(
        "Stop the active response before changing Desk state",
      );
    }
    const result = await this.callDesk(`/actions/${action}`, "POST");
    if (action === "restart" || action === "reset") this.expireControl();
    return result;
  }

  attach(server: Server, auth: AuthService): void {
    if (this.websocketServer) return;
    this.server = server;
    this.websocketServer = new WebSocketServer({ noServer: true });
    this.websocketServer.on("connection", (browser) => this.proxyVnc(browser));
    this.upgradeListener = (request, socket, head) => {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname !== "/api/desk/vnc") return;
      const ticket = url.searchParams.get("ticket") || "";
      if (
        !this.validOrigin(request) ||
        !auth.verifySession(readSessionCookie(request.headers.cookie)) ||
        !this.consumeTicket(ticket)
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocketServer?.handleUpgrade(request, socket, head, (client) =>
        this.websocketServer?.emit("connection", client, request),
      );
    };
    server.on("upgrade", this.upgradeListener);
  }

  onModuleDestroy(): void {
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.websocketServer?.close();
    if (this.server && this.upgradeListener)
      this.server.off("upgrade", this.upgradeListener);
  }

  private proxyVnc(browser: WebSocket): void {
    if (!this.config.deskVncUrl) {
      browser.close(1013, "Live Desk is disabled");
      return;
    }
    const upstream = new WebSocket(this.config.deskVncUrl);
    upstream.on("open", () => {
      browser.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => {
        if (browser.readyState === WebSocket.OPEN)
          browser.send(data, { binary });
      });
    });
    const close = () => {
      if (browser.readyState === WebSocket.OPEN) browser.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    upstream.on("close", close);
    upstream.on("error", close);
    browser.on("close", close);
    browser.on("error", close);
  }

  private async health(): Promise<DeskHealth | null> {
    if (!this.config.deskUrl) return null;
    try {
      const response = await fetch(`${this.config.deskUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as DeskHealth;
    } catch {
      return null;
    }
  }

  private async callDesk(path: string, method: "POST") {
    if (!this.config.deskUrl)
      throw new ServiceUnavailableException("Live Desk is disabled");
    let token: string;
    try {
      token = (
        await readFile(
          this.config.deskTokenFile ?? "/run/orkestr-desk-auth/token",
          "utf8",
        )
      ).trim();
    } catch {
      throw new ServiceUnavailableException(
        "Live Desk credentials are unavailable",
      );
    }
    try {
      const response = await fetch(`${this.config.deskUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as unknown;
      if (!response.ok) {
        const responseBody =
          typeof body === "string" ||
          (typeof body === "object" && body !== null)
            ? body
            : "Live Desk request failed";
        throw new HttpException(responseBody, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException("Live Desk did not respond");
    }
  }

  private consumeTicket(ticket: string): boolean {
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return Boolean(expiresAt && expiresAt > Date.now());
  }

  private pruneTickets(): void {
    for (const [ticket, expiresAt] of this.tickets) {
      if (expiresAt <= Date.now()) this.tickets.delete(ticket);
    }
    if (this.tickets.size > 100) {
      throw new HttpException(
        "Too many Desk connection attempts",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private validOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    const forwarded = String(request.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      ?.trim();
    const protocol = forwarded || (this.config.cookieSecure ? "https" : "http");
    return (
      origin === `${protocol}://${request.headers.host}` ||
      this.config.allowedOrigins.includes(origin)
    );
  }

  private armControlTimer(): void {
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.controlTimer = setTimeout(
      () => this.expireControl(),
      CONTROL_LIFETIME_MS,
    );
  }

  private expireControl(): void {
    this.controlExpiresAt = 0;
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.controlTimer = null;
    this.missions.setDispatchPaused(false);
  }
}

function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "orkestr_session")
      continue;
    return decodeURIComponent(part.slice(separator + 1));
  }
  return undefined;
}
