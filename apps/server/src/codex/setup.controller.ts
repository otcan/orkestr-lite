import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from "@nestjs/common";
import { apiKeyLoginSchema } from "@orkestr/shared";
import { CodexService } from "./codex.service.js";

@Controller("api/setup")
export class SetupController {
  constructor(private readonly codex: CodexService) {}

  @Get("status")
  status() {
    const codex = this.codex.snapshot();
    return {
      codex,
      ready:
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
