import { Controller, Get, Inject } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

@Controller("api")
export class SystemController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Public()
  @Get("health")
  health() {
    return { status: this.database.ping() ? "ok" : "error" };
  }

  @Public()
  @Get("ready")
  ready() {
    return { ready: this.database.ping() };
  }

  @Public()
  @Get("version")
  version() {
    return {
      name: "Orkestr Lite",
      version: "0.1.0",
      codexProtocolVersion: this.config.codexVersion,
      requiredModelFamily: "GPT-5.6",
    };
  }
}
