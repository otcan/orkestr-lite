import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { TimersService } from "./timers.service.js";

@Controller("api/timers")
export class TimersController {
  constructor(private readonly timers: TimersService) {}

  @Get()
  list() {
    return { data: this.timers.list() };
  }

  @Post()
  create(@Body() body: unknown) {
    return this.timers.create(body);
  }

  @Post("preview")
  preview(@Body() body: unknown) {
    return this.timers.preview(body);
  }

  @Patch(":id")
  update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.timers.update(id, body);
  }

  @Post(":id/toggle")
  toggle(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.timers.toggle(id);
  }

  @Post(":id/run")
  run(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.timers.runNow(id);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", new ParseUUIDPipe()) id: string): void {
    this.timers.remove(id);
  }
}
