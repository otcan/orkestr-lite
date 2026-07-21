import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  Sse,
} from "@nestjs/common";
import type { Response } from "express";
import { Observable } from "rxjs";
import { WhatsAppService } from "./whatsapp.service.js";

@Controller(["api/whatsapp", "api/setup/whatsapp"])
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get("status")
  status() {
    return this.whatsapp.snapshot();
  }

  @Get("messages")
  messages(@Query("limit") limit?: string) {
    return { data: this.whatsapp.recentMessages(Number(limit) || 50) };
  }

  @Get("inbox")
  inbox(@Query("limit") limit?: string) {
    return { data: this.whatsapp.recentInbox(Number(limit) || 100) };
  }

  @Sse("events")
  events(): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      const unsubscribe = this.whatsapp.subscribe((status) =>
        subscriber.next({ type: "status", data: status }),
      );
      const heartbeat = setInterval(
        () => subscriber.next({ type: "heartbeat", data: String(Date.now()) }),
        20_000,
      );
      return () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    });
  }

  @Post(["start", "connect"])
  start() {
    return this.whatsapp.start();
  }

  @Post(["logout", "disconnect"])
  @HttpCode(200)
  logout() {
    return this.whatsapp.logout();
  }

  @Post("test")
  test() {
    return this.whatsapp.sendTest();
  }

  @Post("files")
  sendFile(@Body() body: unknown) {
    const path =
      body &&
      typeof body === "object" &&
      typeof (body as { path?: unknown }).path === "string"
        ? (body as { path: string }).path.trim()
        : "";
    if (!path)
      throw new BadRequestException("An absolute file path is required");
    return this.whatsapp.sendFileToSelf(path);
  }

  @Get("outbox")
  outbox(
    @Query("limit") limit?: string,
    @Query("includeAcknowledged") includeAcknowledged?: string,
  ) {
    return {
      data: this.whatsapp.outbox(
        Number(limit) || 100,
        includeAcknowledged === "1" || includeAcknowledged === "true",
      ),
    };
  }

  @Post("outbox/:id/retry")
  retryOutbox(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.whatsapp.retryOutbox(id);
  }

  @Post("outbox/:id/discard")
  discardOutbox(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.whatsapp.discardOutbox(id);
  }

  @Get("qr.svg")
  qr(
    @Query("v") version: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): string {
    const status = this.whatsapp.snapshot();
    const svg = this.whatsapp.qr();
    if (!svg || !status.qrVersion) {
      response.status(404).type("text/plain");
      return "WhatsApp QR code is not available";
    }
    if (version && version !== status.qrVersion) {
      response.status(409).type("text/plain");
      return "WhatsApp QR code has refreshed";
    }
    const etag = `\"${status.qrVersion}\"`;
    response.setHeader("ETag", etag);
    response.setHeader(
      "Cache-Control",
      version ? "private, max-age=60, immutable" : "no-store, private",
    );
    if (ifNoneMatch === etag) {
      response.status(304);
      return "";
    }
    response.type("image/svg+xml");
    return svg;
  }
}
