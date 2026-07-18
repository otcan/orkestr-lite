import { Global, Module } from "@nestjs/common";
import { CodexService } from "./codex.service.js";
import { SetupController } from "./setup.controller.js";

@Global()
@Module({
  controllers: [SetupController],
  providers: [CodexService],
  exports: [CodexService],
})
export class CodexModule {}
