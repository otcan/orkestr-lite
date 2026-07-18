import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { loginSchema } from "@orkestr/shared";
import type { Request, Response } from "express";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { AuthService } from "./auth.service.js";
import { readCookie } from "./cookies.js";
import { Public } from "./public.decorator.js";

const failures = new Map<string, { count: number; resetAt: number }>();

@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = request.ip || "unknown";
    this.enforceRateLimit(key);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success || !this.auth.verifyPassword(parsed.data.password)) {
      this.recordFailure(key);
      throw new HttpException("Invalid credentials", HttpStatus.UNAUTHORIZED);
    }
    failures.delete(key);
    const session = this.auth.createSession();
    response.cookie("orkestr_session", session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.cookieSecure,
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return {
      authenticated: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  }

  @Public()
  @Get("session")
  session(@Req() request: Request) {
    const token = readCookie(request, "orkestr_session");
    const authenticated = this.auth.verifySession(token);
    return {
      authenticated,
      csrfToken:
        authenticated && token
          ? this.auth.createCsrfForExistingSession(token)
          : null,
    };
  }

  @Post("logout")
  @HttpCode(204)
  logout(@Res({ passthrough: true }) response: Response): void {
    this.auth.revokeSessions();
    response.clearCookie("orkestr_session", { path: "/" });
  }

  private enforceRateLimit(key: string): void {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= Date.now()) return;
    if (entry.count >= 5) {
      throw new HttpException(
        "Too many login attempts",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private recordFailure(key: string): void {
    const existing = failures.get(key);
    if (!existing || existing.resetAt <= Date.now()) {
      failures.set(key, { count: 1, resetAt: Date.now() + 15 * 60_000 });
      return;
    }
    existing.count += 1;
  }
}
