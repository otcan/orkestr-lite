import {
  BadRequestException,
  Body,
  Controller,
  Get,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  Sse,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { approvalDecisionSchema, createMissionSchema } from "@orkestr/shared";
import { MissionsService } from "./missions.service.js";
import { Observable } from "rxjs";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import {
  AttachmentsService,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  type AttachmentView,
  type BrowserUpload,
} from "./attachments.service.js";

@Controller("api")
export class ConversationController {
  constructor(
    private readonly turns: MissionsService,
    private readonly attachments: AttachmentsService,
  ) {}

  @Get("conversation/status")
  status() {
    return this.turns.conversationStatus();
  }

  @Post("conversation/complete-setup")
  completeSetup() {
    return this.turns.completeSetup();
  }

  @Post("conversation/start-fresh")
  startFresh() {
    return this.turns.startFresh();
  }

  @Post("conversation/retry")
  retry() {
    return this.turns.retryConversation();
  }

  @Post("conversation/compact")
  compact() {
    return this.turns.compactConversation();
  }

  @Get("conversation/events/history")
  conversationEvents(
    @Query("after") after?: string,
    @Query("limit") limit?: string,
  ) {
    return {
      data: this.turns.conversationEvents(
        Number(after) || 0,
        Number(limit) || 200,
      ),
    };
  }

  @Get("turns")
  list(@Query("before") before?: string, @Query("limit") limit?: string) {
    const pageLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const cursor = before === undefined ? undefined : Number(before);
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 1)) {
      throw new BadRequestException("Invalid pagination cursor");
    }
    const data = this.turns
      .turnPage(pageLimit, cursor)
      .map((turn) =>
        turnView(
          turn,
          this.turns.queuePosition(turn.id),
          this.attachments.listForTurn(turn.id),
        ),
      );
    return {
      data,
      nextCursor:
        data.length === pageLimit
          ? (data.at(-1)?.enqueueSequence ?? null)
          : null,
    };
  }

  @Sse("conversation/events")
  eventsStream(): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      const unsubscribe = this.turns.subscribe((event) =>
        subscriber.next({ type: "turn", data: event }),
      );
      const unsubscribeConversation = this.turns.subscribeConversation(
        (event) => subscriber.next({ type: "conversation", data: event }),
      );
      const heartbeat = setInterval(
        () => subscriber.next({ type: "heartbeat", data: String(Date.now()) }),
        20_000,
      );
      return () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeConversation();
      };
    });
  }

  @Post("turns")
  enqueue(@Body() body: unknown) {
    const input = body as {
      content?: unknown;
      source?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
      clientMessageId?: unknown;
      attachments?: unknown;
    };
    const attachmentIds = browserAttachmentIds(input?.attachments);
    const content =
      typeof input?.content === "string" && input.content.trim()
        ? input.content
        : attachmentIds.length
          ? "Please review the attached files."
          : input?.content;
    const parsed = createMissionSchema.safeParse({
      prompt: content,
      source: input?.source ?? "web",
      model: input?.model,
      reasoningEffort: input?.reasoningEffort,
    });
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (attachmentIds.length && parsed.data.source !== "web") {
      throw new BadRequestException(
        "Browser attachments can only be added to browser messages",
      );
    }
    const candidateId =
      typeof input.clientMessageId === "string"
        ? input.clientMessageId.trim().slice(0, 128)
        : undefined;
    const clientMessageId = candidateId || undefined;
    const turn = this.turns.create(parsed.data, null, {
      ingressKey: clientMessageId,
      attachmentIds,
    });
    return turnView(
      turn,
      this.turns.queuePosition(turn.id),
      this.attachments.listForTurn(turn.id),
    );
  }

  @Post("attachments")
  @UseInterceptors(
    FilesInterceptor("files", MAX_CHAT_ATTACHMENTS, {
      limits: {
        files: MAX_CHAT_ATTACHMENTS,
        fileSize: MAX_CHAT_ATTACHMENT_BYTES,
      },
    }),
  )
  async uploadAttachments(@UploadedFiles() files: BrowserUpload[]) {
    return { data: await this.attachments.saveBrowserUploads(files || []) };
  }

  @Get("attachments/:id/download")
  async downloadAttachment(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.attachments.download(id);
    response.type(file.mimeType);
    response.download(file.absolute, file.name);
  }

  @Get("turns/:id")
  turn(@Param("id", new ParseUUIDPipe()) id: string) {
    return turnView(
      this.turns.get(id),
      this.turns.queuePosition(id),
      this.attachments.listForTurn(id),
    );
  }

  @Get("turns/:id/events")
  events(@Param("id", new ParseUUIDPipe()) id: string) {
    return { data: this.turns.events(id) };
  }

  @Post("turns/:id/stop")
  async stop(@Param("id", new ParseUUIDPipe()) id: string) {
    const turn = await this.turns.interrupt(id);
    return turnView(turn, null, this.attachments.listForTurn(id));
  }

  @Post("turns/:id/approve")
  approve(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const parsed = approvalDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return turnView(
      this.turns.approve(id, parsed.data),
      null,
      this.attachments.listForTurn(id),
    );
  }
}

function turnView(
  turn: ReturnType<MissionsService["get"]>,
  queuePosition: number | null = null,
  attachments: AttachmentView[] = [],
) {
  return {
    id: turn.id,
    source: turn.source,
    prompt: turn.prompt,
    status: turn.status,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    completedAt: turn.finishedAt,
    latestProgressSummary: turn.latestProgressSummary,
    finalResponse: turn.finalResponse,
    error: turn.error,
    requestedModel: turn.requestedModel,
    requestedReasoningEffort: turn.requestedReasoningEffort,
    effectiveModel: turn.effectiveModel,
    enqueueSequence: turn.enqueueSequence,
    queuePosition,
    attachments,
  };
}

function browserAttachmentIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException("Attachments must be a list");
  }
  if (value.length > MAX_CHAT_ATTACHMENTS) {
    throw new BadRequestException(
      `Attach up to ${MAX_CHAT_ATTACHMENTS} files per message`,
    );
  }
  const ids = value.map((candidate) => String(candidate || "").trim());
  if (
    ids.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  ) {
    throw new BadRequestException("Attachment ID is invalid");
  }
  return [...new Set(ids)];
}
