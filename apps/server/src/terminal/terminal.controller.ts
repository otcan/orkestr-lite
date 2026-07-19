import { Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { TerminalService } from "./terminal.service.js";

@Controller("api/terminal")
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  @Post()
  open() {
    return this.terminal.open();
  }

  @Post(":id/restart")
  restart(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.terminal.restart(id);
  }
}
