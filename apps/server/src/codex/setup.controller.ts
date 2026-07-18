import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";
import { apiKeyLoginSchema } from "@orkestr/shared";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { CodexService } from "./codex.service.js";

@Controller("api/setup")
export class SetupController {
  constructor(
    private readonly codex: CodexService,
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Get("status")
  status() {
    const codex = this.codex.snapshot();
    return {
      system: { ready: this.database.ping() },
      codex,
      workspace: { ready: true, path: this.config.workspace },
      firstMissionReady:
        codex.process === "ready" && codex.authenticated && codex.modelReady,
    };
  }

  @Post("codex/device-auth")
  deviceAuth() {
    return this.codex.startDeviceLogin();
  }

  @Post("codex/api-key")
  @HttpCode(204)
  async apiKey(@Body() body: unknown): Promise<void> {
    const parsed = apiKeyLoginSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException("Invalid API key", HttpStatus.BAD_REQUEST);
    }
    await this.codex.loginApiKey(parsed.data.apiKey);
  }

  @Get("codex/status")
  codexStatus() {
    return this.codex.snapshot();
  }
}
