import { Module } from "@nestjs/common";
import { TerminalController } from "./terminal.controller.js";
import { TerminalService } from "./terminal.service.js";

@Module({
  controllers: [TerminalController],
  providers: [TerminalService],
  exports: [TerminalService],
})
export class TerminalModule {}
