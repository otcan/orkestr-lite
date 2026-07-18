import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private sessionSecret = "";

  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  onModuleInit(): void {
    this.sessionSecret =
      this.database.getSetting("session_secret") ??
      randomBytes(32).toString("base64url");
    this.database.setSetting("session_secret", this.sessionSecret);

    if (this.config.adminPassword) {
      this.storePassword(this.config.adminPassword);
      return;
    }

    if (!this.database.getSetting("admin_password_hash")) {
      const generated = randomBytes(18).toString("base64url");
      this.storePassword(generated);
      this.logger.warn(
        "Generated first-run administrator password. Save it now:",
      );
      this.logger.warn(generated);
    }
  }

  verifyPassword(password: string): boolean {
    const encoded = this.database.getSetting("admin_password_hash");
    if (!encoded) return false;
    const [salt, expected] = encoded.split(":");
    if (!salt || !expected) return false;
    const actual = scryptSync(password, salt, 32);
    const expectedBuffer = Buffer.from(expected, "base64url");
    return (
      actual.length === expectedBuffer.length &&
      timingSafeEqual(actual, expectedBuffer)
    );
  }

  createSession(): { token: string; csrfToken: string; expiresAt: string } {
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    const nonce = randomBytes(16).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ expiresAt, nonce })).toString(
      "base64url",
    );
    const signature = this.sign(payload);
    const token = `${payload}.${signature}`;
    return {
      token,
      csrfToken: this.csrfFor(token),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  verifySession(token: string | undefined): boolean {
    if (!token) return false;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return false;
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as {
        expiresAt?: number;
      };
      return (
        typeof decoded.expiresAt === "number" && decoded.expiresAt > Date.now()
      );
    } catch {
      return false;
    }
  }

  verifyCsrf(
    sessionToken: string | undefined,
    csrfToken: string | undefined,
  ): boolean {
    if (!sessionToken || !csrfToken) return false;
    const expected = Buffer.from(this.csrfFor(sessionToken));
    const actual = Buffer.from(csrfToken);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  createCsrfForExistingSession(sessionToken: string): string | null {
    return this.verifySession(sessionToken) ? this.csrfFor(sessionToken) : null;
  }

  private storePassword(password: string): void {
    const salt = randomBytes(16).toString("base64url");
    const hash = scryptSync(password, salt, 32).toString("base64url");
    this.database.setSetting("admin_password_hash", `${salt}:${hash}`);
  }

  private sign(value: string): string {
    return createHmac("sha256", this.sessionSecret)
      .update(value)
      .digest("base64url");
  }

  private csrfFor(sessionToken: string): string {
    return createHmac("sha256", this.sessionSecret)
      .update(`csrf:${sessionToken}`)
      .digest("base64url");
  }
}
