import {
  Body,
  Controller,
  Get,
  Headers,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from "@nestjs/common";
import { approvalDecisionSchema, createMissionSchema } from "@orkestr/shared";
import { BadRequestException } from "@nestjs/common";
import { Observable } from "rxjs";
import { MissionsService } from "./missions.service.js";

@Controller("api/missions")
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Get()
  list() {
    return { data: this.missions.list() };
  }

  @Post()
  create(@Body() body: unknown) {
    const parsed = createMissionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.missions.create(parsed.data);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.missions.get(id);
  }

  @Post(":id/interrupt")
  interrupt(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.missions.interrupt(id);
  }

  @Post(":id/resume")
  resume(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.missions.resume(id);
  }

  @Post(":id/approve")
  approve(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const parsed = approvalDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.missions.approve(id, parsed.data);
  }

  @Sse(":id/events")
  events(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Query("after") after: string | undefined,
  ): Observable<MessageEvent> {
    let cursor = parseCursor(after ?? lastEventId);
    return new Observable<MessageEvent>((subscriber) => {
      while (!subscriber.closed) {
        const replay = this.missions.events(id, cursor);
        if (replay.length === 0) break;
        for (const event of replay) {
          subscriber.next({
            id: String(event.id),
            type: "mission-event",
            data: event,
          });
          cursor = event.id;
        }
      }

      const unsubscribe = this.missions.subscribe((event) => {
        if (event.missionId !== id || event.id <= cursor) return;
        cursor = event.id;
        subscriber.next({
          id: String(event.id),
          type: "mission-event",
          data: event,
        });
      });
      return unsubscribe;
    });
  }
}

function parseCursor(value: string | undefined): number {
  if (!value) return 0;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}
