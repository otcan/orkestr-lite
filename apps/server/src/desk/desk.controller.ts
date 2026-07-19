import { Body, Controller, Get, Post } from "@nestjs/common";
import { DeskService } from "./desk.service.js";

@Controller("api/desk")
export class DeskController {
  constructor(private readonly desk: DeskService) {}

  @Get("status")
  status() {
    return this.desk.status();
  }

  @Post("session")
  session() {
    return this.desk.createSession();
  }

  @Post("control/acquire")
  acquire(@Body() body: unknown) {
    return this.desk.acquireControl(
      Boolean((body as { interruptActive?: unknown })?.interruptActive),
    );
  }

  @Post("control/release")
  release() {
    return this.desk.releaseControl();
  }

  @Post("actions/open-browser")
  openBrowser() {
    return this.desk.action("open-browser");
  }

  @Post("actions/restart")
  restart() {
    return this.desk.action("restart");
  }

  @Post("actions/reset")
  reset() {
    return this.desk.action("reset");
  }
}
