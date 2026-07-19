import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { AuthService } from "./auth/auth.service.js";
import { readRuntimeConfig } from "./config/runtime-config.js";
import { TerminalService } from "./terminal/terminal.service.js";
import { DeskService } from "./desk/desk.service.js";

async function bootstrap(): Promise<void> {
  process.umask(0o077);
  const config = readRuntimeConfig();
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.useBodyParser("json", { limit: "64kb" });
  app.useBodyParser("urlencoded", { limit: "16kb", extended: false });
  app.use(
    "/api",
    (_request: Request, response: Response, next: NextFunction) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Pragma", "no-cache");
      next();
    },
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.cookieSecure ? undefined : false,
    }),
  );
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.header("origin");
    if (!origin) return next();
    const forwardedProto = request
      .header("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim();
    const protocol = forwardedProto ?? request.protocol;
    const sameOrigin = origin === `${protocol}://${request.get("host")}`;
    const explicitlyAllowed = config.allowedOrigins.includes(origin);
    if (!sameOrigin && !explicitlyAllowed) {
      response
        .status(403)
        .json({ statusCode: 403, message: "Origin not allowed" });
      return;
    }
    next();
  });
  app.enableShutdownHooks();
  app.get(TerminalService).attach(app.getHttpServer(), app.get(AuthService));
  app.get(DeskService).attach(app.getHttpServer(), app.get(AuthService));
  await app.listen(config.port, config.host);
  logger.log(`Orkestr Lite listening on http://${config.host}:${config.port}`);
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    logger.warn(
      "Listening on a non-loopback interface. Keep the published host port loopback-only or use authenticated HTTPS.",
    );
  }
}

void bootstrap();
