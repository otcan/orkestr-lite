import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";
import { readCookie } from "./cookies.js";

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    if (request.path === "/api/auth/login") return true;
    const csrfHeader = request.header("x-orkestr-csrf") ?? undefined;
    return this.auth.verifyCsrf(
      readCookie(request, "orkestr_session"),
      csrfHeader,
    );
  }
}
