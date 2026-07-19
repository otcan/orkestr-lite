import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  ApprovalDecisionInput,
  CreateMissionInput,
  MissionEventRecord,
  MissionRecord,
} from "@orkestr/shared";
import type {
  CodexNotification,
  CodexServerRequest,
} from "@orkestr/codex-client";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { CodexService, type CodexExitDetails } from "../codex/codex.service.js";
import { DatabaseService } from "../database/database.service.js";
import { MissionEventBus } from "./mission-event.bus.js";
import { MissionRepository } from "./mission.repository.js";
import { ConversationTelemetryService } from "./conversation-telemetry.service.js";
import { join } from "node:path";
import { AttachmentsService } from "./attachments.service.js";

const MAX_PENDING_TURNS = 250;
const ATTACHMENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "attachments"],
  properties: {
    message: { type: "string" },
    attachments: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
  },
};

const WORKSTATION_CAPABILITIES = `You are the Codex agent inside Orkestr Lite's isolated Ubuntu workstation. Treat these as real host capabilities, not hypothetical integrations:
- /workspace is the persistent shared workspace. Inspect and edit its files directly with shell tools.
- A visible XFCE Desk and Chromium browser are running on DISPLAY=:1. Use xdg-open for URLs; xdotool, wmctrl, and scrot are available for visible desktop interaction and inspection.
- The web UI exposes the same workspace through Files and provides an interactive Terminal. Do not claim that files or shell access are unavailable before checking them.
- A linked WhatsApp inbox snapshot is stored at /workspace/.orkestr/whatsapp/inbox.json. When asked about a WhatsApp contact or message, read and search that file before answering. It contains recent direct chats only; groups and status broadcasts are excluded. Never claim WhatsApp messages are inaccessible without checking the snapshot.
- WhatsApp self-chat messages, browser messages, and schedules all feed this one Orkestr conversation. Orkestr mirrors completed responses to the linked self-chat automatically.
- Browser and WhatsApp file deliveries use the explicit attachment contracts appended to relevant turns. Only return or send files when the user asks.
- You have full access inside this isolated workstation with no approval prompts. Still avoid destructive or externally consequential actions unless the user's request authorizes them.`;

@Injectable()
export class MissionsService implements OnModuleInit {
  private readonly logger = new Logger(MissionsService.name);
  private activeMissionId: string | null = null;
  private dispatching = false;
  private loadedThreadId: string | null = null;
  private threadPromise: Promise<string> | null = null;
  private conversationError: string | null = null;
  private compacting = false;
  private dispatchPaused = false;
  private dispatchRetryTimer: NodeJS.Timeout | null = null;
  private compactionTimer: NodeJS.Timeout | null = null;
  private pendingCompactionRecoveryId: string | null = null;
  private readonly pendingTurnNotifications = new Map<
    string,
    CodexNotification[]
  >();

  constructor(
    private readonly repository: MissionRepository,
    private readonly bus: MissionEventBus,
    private readonly codex: CodexService,
    private readonly database: DatabaseService,
    private readonly telemetry: ConversationTelemetryService,
    private readonly attachments: AttachmentsService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  onModuleInit(): void {
    this.migrateExistingConversation();
    this.recoverInfrastructureFailedTurns();
    for (const mission of this.repository.active()) {
      const recoveryAttempts = recoveryAttemptsFor(mission);
      const recoverable = Boolean(
        mission.codexThreadId && recoveryAttempts < 1,
      );
      this.repository.update(mission.id, {
        status: recoverable ? "queued" : "interrupted",
        finishedAt: new Date().toISOString(),
        interruptionMetadata: {
          reason: "application_restart",
          previousStatus: mission.status,
        },
      });
      this.repository.appendEvent(mission.id, "mission.interrupted", {
        reason: "application_restart",
        previousStatus: mission.status,
        resumable: mission.codexThreadId !== null,
      });
      if (recoverable) {
        this.repository.update(mission.id, {
          finishedAt: null,
          recoveryMetadata: {
            strategy: "inspect_then_continue",
            reason: "application_restart",
            attempts: recoveryAttempts + 1,
          },
        });
        this.repository.appendEvent(mission.id, "mission.recovery_queued", {
          reason: "application_restart",
          attempt: recoveryAttempts + 1,
        });
      }
    }
    this.codex.onNotification((notification) =>
      this.handleNotification(notification),
    );
    this.codex.onServerRequest((request) => this.handleServerRequest(request));
    this.codex.onExit((details) => this.handleCodexExit(details));
    this.codex.onReady(() =>
      queueMicrotask(() => void this.initializeConversation()),
    );
    queueMicrotask(() => void this.initializeConversation());
  }

  conversationStatus() {
    return {
      setupCompleted: this.database.getSetting("setup_completed") === "true",
      conversationReady: Boolean(
        this.database.getSetting("active_codex_thread_id") &&
          !this.conversationError,
      ),
      resumeError: this.conversationError,
      workspace: this.config.workspace,
      queueDepth: this.repository.pendingCount(),
      queueLimit: MAX_PENDING_TURNS,
      compacting: this.compacting,
      context: this.telemetry.context(),
      dispatchPaused: this.dispatchPaused,
      activeTurnId: this.activeMissionId,
    };
  }

  async completeSetup(): Promise<
    ReturnType<MissionsService["conversationStatus"]>
  > {
    await this.ensureConversationThread();
    this.database.setSetting("setup_completed", "true");
    return this.conversationStatus();
  }

  async startFresh(): Promise<
    ReturnType<MissionsService["conversationStatus"]>
  > {
    const busy = this.repository.pendingCount() > 0;
    if (busy) {
      throw new ConflictException(
        "Stop the current response and let the queue clear before starting fresh",
      );
    }
    const previous = this.database.getSetting("active_codex_thread_id");
    if (previous) {
      const archived = parseStringList(
        this.database.getSetting("archived_codex_thread_ids"),
      );
      archived.push(previous);
      this.database.setSetting(
        "archived_codex_thread_ids",
        JSON.stringify([...new Set(archived)].slice(-25)),
      );
    }
    this.database.setSetting("active_codex_thread_id", "");
    this.loadedThreadId = null;
    this.conversationError = null;
    await this.ensureConversationThread(true);
    this.database.setSetting(
      "conversation_started_at",
      new Date().toISOString(),
    );
    this.database.setSetting("setup_completed", "true");
    return this.conversationStatus();
  }

  async retryConversation(): Promise<
    ReturnType<MissionsService["conversationStatus"]>
  > {
    this.loadedThreadId = null;
    this.conversationError = null;
    await this.ensureConversationThread();
    return this.conversationStatus();
  }

  visibleTurns(): MissionRecord[] {
    const startedAt = this.database.getSetting("conversation_started_at");
    return this.repository
      .list()
      .filter((turn) => !startedAt || turn.createdAt >= startedAt);
  }

  turnPage(limit = 50, beforeSequence?: number): MissionRecord[] {
    const startedAt = this.database.getSetting("conversation_started_at");
    return this.repository
      .page(limit, beforeSequence)
      .filter((turn) => !startedAt || turn.createdAt >= startedAt);
  }

  queuePosition(id: string): number | null {
    return this.repository.queuePosition(id);
  }

  list(): MissionRecord[] {
    return this.repository.list();
  }

  get(id: string): MissionRecord {
    const mission = this.repository.find(id);
    if (!mission) throw new NotFoundException("Mission not found");
    return mission;
  }

  events(id: string, afterId = 0): MissionEventRecord[] {
    this.get(id);
    return this.repository.events(id, afterId);
  }

  subscribe(listener: (event: MissionEventRecord) => void): () => void {
    return this.bus.subscribe(listener);
  }

  subscribeConversation(
    listener: Parameters<ConversationTelemetryService["subscribe"]>[0],
  ): () => void {
    return this.telemetry.subscribe(listener);
  }

  create(
    input: CreateMissionInput,
    timerId: string | null = null,
    options: {
      ingressKey?: string;
      enqueueSequence?: number;
      attachmentIds?: string[];
    } = {},
  ): MissionRecord {
    const status = this.codex.snapshot();
    const configured =
      this.database.getSetting("setup_completed") === "true" &&
      Boolean(this.database.getSetting("active_codex_thread_id"));
    if (!configured && !status.authenticated) {
      throw new ServiceUnavailableException(
        "Complete Codex setup before sending a message",
      );
    }
    if (this.repository.pendingCount() >= MAX_PENDING_TURNS) {
      throw new HttpException(
        `The workstation queue is full (${MAX_PENDING_TURNS} pending exchanges)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const selectedModel =
      input.model ??
      status.selectedModel ??
      this.database.getSetting("active_codex_thread_model") ??
      this.config.requestedModel;
    const available =
      status.models.length === 0 ||
      status.models.some(
        (model) => model.id === selectedModel || model.model === selectedModel,
      );
    if (status.process === "ready" && !available)
      throw new BadRequestException("Selected model is not available");
    const selectedModelStatus = status.models.find(
      (model) => model.id === selectedModel || model.model === selectedModel,
    );
    if (
      input.reasoningEffort &&
      selectedModelStatus?.supportedReasoningEfforts.length &&
      !selectedModelStatus.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === input.reasoningEffort,
      )
    ) {
      throw new BadRequestException(
        "Selected reasoning effort is not available for this model",
      );
    }
    const existing = options.ingressKey
      ? this.repository.findByIngress(input.source, options.ingressKey)
      : null;
    const attachmentIds = options.attachmentIds ?? [];
    if (attachmentIds.length) {
      this.attachments.assertClaimableBrowserUploads(
        attachmentIds,
        existing?.id ?? null,
      );
    }
    const mission = this.repository.create(
      input,
      this.config.workspace,
      selectedModel,
      timerId,
      options,
    );
    if (attachmentIds.length) {
      this.attachments.claimBrowserUploads(mission.id, attachmentIds);
    }
    void this.processNext();
    return mission;
  }

  async compactConversation(): Promise<
    ReturnType<MissionsService["conversationStatus"]>
  > {
    if (this.activeMissionId || this.repository.pendingCount() > 0) {
      throw new ConflictException(
        "Wait for the active response before compacting",
      );
    }
    this.compacting = true;
    try {
      const threadId = await this.ensureConversationThread();
      this.telemetry.append("conversation.compaction_requested", { threadId });
      await this.codex.compactThread(threadId);
      if (this.compacting) this.armCompactionTimeout();
    } catch (error) {
      this.compacting = false;
      this.clearCompactionTimeout();
      this.telemetry.append("conversation.compaction_failed", {
        error: errorMessage(error),
      });
      throw error;
    }
    return this.conversationStatus();
  }

  conversationEvents(afterId = 0, limit = 200) {
    return this.telemetry.list(afterId, limit);
  }

  async interrupt(id: string): Promise<MissionRecord> {
    const mission = this.get(id);
    if (mission.status === "queued") {
      const cancelled = this.repository.update(id, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      });
      this.repository.appendEvent(id, "mission.cancelled", { reason: "user" });
      return cancelled;
    }
    if (!mission.codexThreadId || !mission.codexTurnId) {
      throw new ConflictException("Mission has no active Codex turn");
    }
    if (
      !["starting", "running", "awaiting_approval"].includes(mission.status)
    ) {
      throw new ConflictException("Mission is not active");
    }
    await this.codex.interruptTurn(mission.codexThreadId, mission.codexTurnId);
    const interrupted = this.repository.update(id, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
      interruptionMetadata: { reason: "user" },
    });
    this.repository.appendEvent(id, "mission.interrupted", {
      reason: "user",
      resumable: true,
    });
    this.finishActive(id);
    return interrupted;
  }

  activeTurnId(): string | null {
    return this.activeMissionId;
  }

  setDispatchPaused(paused: boolean): void {
    this.dispatchPaused = paused;
    if (!paused) queueMicrotask(() => void this.processNext());
  }

  resume(id: string): MissionRecord {
    const mission = this.get(id);
    if (mission.status !== "interrupted" || !mission.codexThreadId) {
      throw new ConflictException(
        "Only interrupted missions with a Codex thread can be resumed",
      );
    }
    const queued = this.repository.update(id, {
      status: "queued",
      finishedAt: null,
      error: null,
      recoveryMetadata: {
        requestedAt: new Date().toISOString(),
        strategy: "inspect_then_continue",
      },
    });
    this.repository.appendEvent(id, "mission.resume_queued", {
      strategy: "inspect_then_continue",
    });
    void this.processNext();
    return queued;
  }

  approve(id: string, input: ApprovalDecisionInput): MissionRecord {
    const mission = this.get(id);
    if (mission.status !== "awaiting_approval") {
      throw new ConflictException("Mission is not awaiting approval");
    }
    this.codex.answerServerRequest(input.requestId, {
      decision: input.decision,
    });
    const running = this.repository.update(id, { status: "running" });
    this.repository.appendEvent(id, "approval.resolved", input);
    return running;
  }

  private async processNext(): Promise<void> {
    if (
      this.dispatching ||
      this.activeMissionId ||
      this.compacting ||
      this.dispatchPaused ||
      this.codex.snapshot().process !== "ready"
    )
      return;
    const next = this.repository.nextQueued();
    if (!next) return;
    this.dispatching = true;
    this.activeMissionId = next.id;
    try {
      await this.startMission(next);
    } catch (error) {
      const message = errorMessage(error);
      const current = this.repository.find(next.id);
      if (current?.status === "interrupted") {
        this.logger.warn(
          `Mission ${next.id} start aborted after interruption: ${message}`,
        );
      } else if (isInfrastructureStartError(error)) {
        const attempts = recoveryAttemptsFor(current ?? next);
        this.logger.warn(
          `Mission ${next.id} deferred while Codex reconnects: ${message}`,
        );
        this.repository.update(next.id, {
          status: "queued",
          error: null,
          finishedAt: null,
          recoveryMetadata: {
            strategy: "inspect_then_continue",
            reason: "codex_reconnecting",
            attempts: attempts + 1,
          },
        });
        this.repository.appendEvent(next.id, "mission.deferred", {
          reason: "codex_reconnecting",
        });
        this.armDispatchRetry();
      } else {
        this.logger.error(`Mission ${next.id} failed to start: ${message}`);
        this.repository.update(next.id, {
          status: "failed",
          error: message,
          finishedAt: new Date().toISOString(),
        });
        this.repository.appendEvent(next.id, "mission.failed", {
          error: message,
        });
      }
      this.activeMissionId = null;
      if (!isInfrastructureStartError(error))
        queueMicrotask(() => void this.processNext());
    } finally {
      this.dispatching = false;
    }
  }

  private async startMission(mission: MissionRecord): Promise<void> {
    const model = mission.requestedModel ?? this.codex.selectedModel();
    let effectiveModel = mission.effectiveModel ?? model;
    this.repository.update(mission.id, {
      status: "starting",
      startedAt: mission.startedAt ?? new Date().toISOString(),
      finishedAt: null,
    });
    this.repository.appendEvent(mission.id, "mission.starting", {
      model,
      reasoningEffort: mission.requestedReasoningEffort,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    const threadId = await this.ensureConversationThread();
    effectiveModel =
      this.database.getSetting("active_codex_thread_model") ?? effectiveModel;
    this.repository.update(mission.id, {
      codexThreadId: threadId,
      effectiveModel,
    });
    this.repository.appendEvent(mission.id, "conversation.turn_preparing", {
      model,
      reasoningEffort: mission.requestedReasoningEffort,
    });

    let prompt = mission.recoveryMetadata
      ? `Resume the interrupted mission. Inspect the current workspace and prior thread state before acting. Do not repeat completed or uncertain side effects. Continue toward the original goal:\n\n${mission.prompt}`
      : mission.prompt;
    prompt = `${WORKSTATION_CAPABILITIES}\n\nCurrent user request:\n${prompt}`;
    const inputAttachments = this.attachments.promptForTurn(mission.id);
    if (inputAttachments) prompt += `\n\n${inputAttachments}`;
    let outputSchema: typeof ATTACHMENT_OUTPUT_SCHEMA | undefined;
    let additionalWritableRoots: string[] = [];
    if (mission.source === "whatsapp") {
      prompt += `\n\nWhatsApp delivery contract: return a JSON object with a concise "message" and an "attachments" array. Only include files that the user explicitly asked to receive. Create returned files under ${join(this.config.home, "attachments/whatsapp/outgoing")}.`;
      outputSchema = ATTACHMENT_OUTPUT_SCHEMA;
      additionalWritableRoots = [
        join(this.config.home, "attachments/whatsapp/outgoing"),
      ];
    } else if (mission.source === "web") {
      const outputDirectory =
        await this.attachments.prepareBrowserOutputDirectory(mission.id);
      prompt += `\n\nBrowser delivery contract: return a JSON object with a "message" and an "attachments" array. Only include files that the user explicitly asked to create or download. Write returned files under ${outputDirectory} and use absolute paths in "attachments".`;
      outputSchema = ATTACHMENT_OUTPUT_SCHEMA;
      additionalWritableRoots = [outputDirectory];
    }
    const turn = await this.codex.startTurn({
      threadId,
      prompt,
      cwd: mission.workspace,
      model,
      effort: mission.requestedReasoningEffort ?? undefined,
      clientUserMessageId: mission.ingressKey ?? mission.id,
      outputSchema,
      additionalWritableRoots,
    });
    effectiveModel =
      this.repository.find(mission.id)?.effectiveModel ?? effectiveModel;
    this.repository.update(mission.id, {
      status: "running",
      codexThreadId: threadId,
      codexTurnId: turn.turn.id,
      effectiveModel,
    });
    this.repository.appendEvent(mission.id, "codex.turn_started", {
      threadId,
      turnId: turn.turn.id,
      recovery: mission.recoveryMetadata !== null,
    });
    this.replayPendingTurnNotifications(turn.turn.id);
  }

  private handleNotification(notification: CodexNotification): void {
    const threadId = stringValue(notification.params.threadId);
    const turn = recordValue(notification.params.turn);
    const item = recordValue(notification.params.item);
    const notificationTurnId =
      stringValue(notification.params.turnId) ??
      stringValue(turn.id) ??
      stringValue(item.turnId);
    let mission = notificationTurnId
      ? this.repository.findByTurn(notificationTurnId)
      : null;
    if (
      !mission &&
      notification.method === "turn/started" &&
      notificationTurnId &&
      this.activeMissionId
    ) {
      const active = this.repository.find(this.activeMissionId);
      if (active && (!threadId || active.codexThreadId === threadId)) {
        this.repository.update(active.id, {
          codexTurnId: notificationTurnId,
        });
        mission = active;
      }
    }

    if (notification.method === "thread/tokenUsage/updated") {
      this.telemetry.updateContext(notification.params);
      this.telemetry.append(
        notification.method,
        sanitizePayload(notification.params),
      );
      return;
    }

    if (notification.method.toLowerCase().includes("mcp")) {
      this.telemetry.append(
        notification.method,
        sanitizePayload(notification.params),
      );
      return;
    }

    const contextCompaction =
      notification.method === "thread/compacted" ||
      (notification.method === "item/completed" &&
        recordValue(notification.params.item).type === "contextCompaction");
    if (contextCompaction) {
      this.telemetry.noteCompaction(sanitizePayload(notification.params));
      this.compacting = false;
      this.clearCompactionTimeout();
      const recoveryId = this.pendingCompactionRecoveryId;
      this.pendingCompactionRecoveryId = null;
      if (recoveryId) {
        this.repository.update(recoveryId, {
          status: "queued",
          finishedAt: null,
          error: null,
        });
        this.repository.appendEvent(recoveryId, "mission.recovery_queued", {
          reason: "context_compaction",
        });
      }
      void this.processNext();
      return;
    }

    if (isContextWindowError(notification.params)) {
      if (mission) void this.recoverFromContextWindow(mission);
      else
        this.telemetry.append(
          "conversation.context_error",
          sanitizePayload(notification.params),
        );
      return;
    }

    if (!mission && notificationTurnId && this.activeMissionId) {
      const active = this.repository.find(this.activeMissionId);
      if (active && (!threadId || active.codexThreadId === threadId)) {
        const pending =
          this.pendingTurnNotifications.get(notificationTurnId) ?? [];
        pending.push(notification);
        this.pendingTurnNotifications.set(
          notificationTurnId,
          pending.slice(-100),
        );
        return;
      }
    }

    if (!mission) {
      this.telemetry.append(
        notification.method,
        sanitizePayload(notification.params),
      );
      if (notification.method === "turn/completed" && this.compacting) {
        this.telemetry.noteCompaction(sanitizePayload(notification.params));
        this.compacting = false;
        this.clearCompactionTimeout();
        const recoveryId = this.pendingCompactionRecoveryId;
        this.pendingCompactionRecoveryId = null;
        if (recoveryId) {
          this.repository.update(recoveryId, {
            status: "queued",
            finishedAt: null,
            error: null,
          });
          this.repository.appendEvent(recoveryId, "mission.recovery_queued", {
            reason: "context_compaction",
          });
        }
        void this.processNext();
      }
      return;
    }

    if (notification.method.toLowerCase().endsWith("delta")) return;
    if (notification.method === "rawResponseItem/completed") return;

    if (notification.method === "model/rerouted") {
      const effective = stringValue(notification.params.toModel);
      if (effective)
        this.repository.update(mission.id, { effectiveModel: effective });
    }

    if (notification.method === "turn/plan/updated") {
      this.repository.update(mission.id, {
        latestProgressSummary: "Codex updated its execution plan",
      });
    }

    if (notification.method === "item/completed") {
      const item = recordValue(notification.params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const structured = ["whatsapp", "web"].includes(mission.source)
          ? parseAttachmentResponse(item.text)
          : null;
        this.repository.update(mission.id, {
          finalResponse: structured?.message ?? item.text,
        });
        if (structured?.attachments.length) {
          if (mission.source === "whatsapp") {
            this.repository.appendEvent(
              mission.id,
              "whatsapp.attachments_requested",
              { paths: structured.attachments },
            );
          } else if (mission.source === "web") {
            void this.attachments
              .registerBrowserOutputs(mission.id, structured.attachments)
              .then((registered) => {
                this.repository.appendEvent(
                  mission.id,
                  "browser.attachments_ready",
                  { attachmentIds: registered.map((item) => item.id) },
                );
              })
              .catch((error) => {
                this.repository.appendEvent(
                  mission.id,
                  "browser.attachments_failed",
                  { error: errorMessage(error) },
                );
              });
          }
        }
      }
      if (item.type === "commandExecution") {
        this.repository.update(mission.id, {
          latestProgressSummary:
            typeof item.command === "string"
              ? `Ran ${item.command}`
              : "Command completed",
        });
      }
    }

    this.repository.appendEvent(
      mission.id,
      notification.method,
      sanitizePayload(notification.params),
    );

    if (notification.method === "turn/completed") {
      const turn = recordValue(notification.params.turn);
      const turnStatus = stringValue(turn.status);
      if (turnStatus === "completed") {
        this.repository.update(mission.id, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          error: null,
          latestProgressSummary: "Response completed",
        });
      } else if (turnStatus === "interrupted") {
        this.repository.update(mission.id, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          interruptionMetadata: { reason: "codex_turn_interrupted" },
        });
      } else {
        const error = recordValue(turn.error);
        this.repository.update(mission.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: stringValue(error.message) ?? "Codex turn failed",
        });
      }
      this.finishActive(mission.id);
    }
  }

  private handleServerRequest(request: CodexServerRequest): void {
    const threadId = stringValue(request.params.threadId);
    const turnId = stringValue(request.params.turnId);
    const active = this.activeMissionId
      ? this.repository.find(this.activeMissionId)
      : null;
    const mission = turnId
      ? this.repository.findByTurn(turnId)
      : active && threadId && active.codexThreadId === threadId
        ? active
        : null;
    if (!mission) {
      this.codex.answerServerRequest(request.id, { decision: "cancel" });
      return;
    }
    this.repository.update(mission.id, {
      status: "awaiting_approval",
      latestProgressSummary: "Approval required",
    });
    this.repository.appendEvent(mission.id, "approval.required", {
      requestId: request.id,
      method: request.method,
      params: sanitizePayload(request.params),
    });
  }

  private handleCodexExit(details: CodexExitDetails): void {
    this.telemetry.append("codex.connection_lost", details);
    this.loadedThreadId = null;
    const mission = this.activeMissionId
      ? this.repository.find(this.activeMissionId)
      : (this.repository.active()[0] ?? null);
    if (
      !mission ||
      !["starting", "running", "awaiting_approval"].includes(mission.status)
    ) {
      this.activeMissionId = null;
      return;
    }

    const attempts = recoveryAttemptsFor(mission);
    const recoverable = Boolean(mission.codexThreadId && attempts < 1);
    this.repository.update(mission.id, {
      status: recoverable ? "queued" : "interrupted",
      finishedAt: new Date().toISOString(),
      interruptionMetadata: {
        reason: "codex_app_server_exit",
        previousStatus: mission.status,
        code: details.code,
        signal: details.signal,
      },
      recoveryMetadata: recoverable
        ? {
            strategy: "inspect_then_continue",
            reason: "codex_app_server_exit",
            attempts: attempts + 1,
          }
        : mission.recoveryMetadata,
    });
    this.repository.appendEvent(mission.id, "mission.interrupted", {
      reason: "codex_app_server_exit",
      previousStatus: mission.status,
      code: details.code,
      signal: details.signal,
      resumable: mission.codexThreadId !== null,
    });
    if (recoverable) {
      this.repository.appendEvent(mission.id, "mission.recovery_queued", {
        reason: "codex_app_server_exit",
        attempt: attempts + 1,
      });
    }
    this.activeMissionId = null;
  }

  private async recoverFromContextWindow(
    mission: MissionRecord,
  ): Promise<void> {
    const attempts = recoveryAttemptsFor(mission);
    if (attempts >= 1 || !mission.codexThreadId) {
      this.repository.update(mission.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: "Codex ran out of context after a recovery attempt",
      });
      this.repository.appendEvent(mission.id, "mission.failed", {
        reason: "context_window_exceeded",
      });
      this.finishActive(mission.id);
      return;
    }
    this.repository.update(mission.id, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
      recoveryMetadata: {
        strategy: "inspect_then_continue",
        reason: "context_window_exceeded",
        attempts: attempts + 1,
      },
    });
    this.repository.appendEvent(mission.id, "mission.interrupted", {
      reason: "context_window_exceeded",
      resumable: true,
    });
    this.activeMissionId = null;
    this.pendingCompactionRecoveryId = mission.id;
    this.compacting = true;
    try {
      if (mission.codexTurnId) {
        await this.codex
          .interruptTurn(mission.codexThreadId, mission.codexTurnId)
          .catch(() => undefined);
      }
      await this.codex.compactThread(mission.codexThreadId);
      if (this.compacting) this.armCompactionTimeout();
    } catch (error) {
      this.compacting = false;
      this.clearCompactionTimeout();
      this.pendingCompactionRecoveryId = null;
      this.repository.update(mission.id, {
        status: "failed",
        error: `Context compaction failed: ${errorMessage(error)}`,
      });
    }
  }

  private finishActive(missionId: string): void {
    if (this.activeMissionId === missionId) this.activeMissionId = null;
    queueMicrotask(() => void this.processNext());
  }

  private armCompactionTimeout(): void {
    this.clearCompactionTimeout();
    this.compactionTimer = setTimeout(() => {
      this.compactionTimer = null;
      if (!this.compacting) return;
      this.compacting = false;
      const recoveryId = this.pendingCompactionRecoveryId;
      this.pendingCompactionRecoveryId = null;
      this.telemetry.append("conversation.compaction_failed", {
        error: "Context compaction timed out",
      });
      if (recoveryId) {
        this.repository.update(recoveryId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "Context compaction timed out",
        });
        this.repository.appendEvent(recoveryId, "mission.failed", {
          reason: "context_compaction_timeout",
        });
      }
      void this.processNext();
    }, 120_000);
  }

  private clearCompactionTimeout(): void {
    if (this.compactionTimer) clearTimeout(this.compactionTimer);
    this.compactionTimer = null;
  }

  private replayPendingTurnNotifications(turnId: string): void {
    const notifications = this.pendingTurnNotifications.get(turnId);
    if (!notifications?.length) return;
    this.pendingTurnNotifications.delete(turnId);
    for (const notification of notifications) {
      this.handleNotification(notification);
    }
  }

  private async initializeConversation(): Promise<void> {
    const status = this.codex.snapshot();
    if (
      status.process !== "ready" ||
      !status.authenticated ||
      !status.modelReady
    )
      return;
    this.telemetry.append("codex.connected", {
      model: status.selectedModel,
      at: status.lastConnectedAt,
    });
    try {
      await this.ensureConversationThread();
    } catch (error) {
      this.logger.warn(
        `Conversation could not be resumed: ${errorMessage(error)}`,
      );
    }
    await this.processNext();
  }

  private async ensureConversationThread(forceFresh = false): Promise<string> {
    if (this.threadPromise) return this.threadPromise;
    this.threadPromise = this.openConversationThread(forceFresh).finally(() => {
      this.threadPromise = null;
    });
    return this.threadPromise;
  }

  private async openConversationThread(forceFresh: boolean): Promise<string> {
    const status = this.codex.snapshot();
    if (
      status.process !== "ready" ||
      !status.authenticated ||
      !status.modelReady
    ) {
      throw new ServiceUnavailableException("Codex is not ready");
    }
    const saved = forceFresh
      ? null
      : this.database.getSetting("active_codex_thread_id") || null;
    if (saved && this.loadedThreadId === saved) return saved;
    if (saved) {
      try {
        const thread = await this.codex.resumeThread(saved);
        if (thread.thread.model) {
          this.database.setSetting(
            "active_codex_thread_model",
            thread.thread.model,
          );
        }
        this.loadedThreadId = saved;
        this.conversationError = null;
        return saved;
      } catch (error) {
        this.loadedThreadId = null;
        const resumeFailure = errorMessage(error);
        this.telemetry.append("conversation.resume_failed", {
          previousThreadId: saved,
          error: resumeFailure,
          recovery: "fresh_context",
        });
        this.logger.warn(
          `Saved Codex context ${saved} could not be resumed; opening a replacement context: ${resumeFailure}`,
        );
        try {
          return await this.startConversationThread(saved);
        } catch (replacementError) {
          this.conversationError =
            "Codex is reconnecting. Your conversation and queued messages are preserved.";
          throw new ServiceUnavailableException(this.conversationError, {
            cause: replacementError,
          });
        }
      }
    }
    return this.startConversationThread(null);
  }

  private async startConversationThread(
    previousThreadId: string | null,
  ): Promise<string> {
    const thread = await this.codex.startThread({
      cwd: this.config.workspace,
      model: this.codex.selectedModel(),
      developerInstructions: WORKSTATION_CAPABILITIES,
    });
    const threadId = thread.thread.id;
    this.database.setSetting("active_codex_thread_id", threadId);
    this.database.setSetting(
      "active_codex_thread_model",
      thread.thread.model ?? this.codex.selectedModel(),
    );
    if (!this.database.getSetting("conversation_started_at")) {
      this.database.setSetting(
        "conversation_started_at",
        new Date(0).toISOString(),
      );
    }
    this.loadedThreadId = threadId;
    this.conversationError = null;
    if (previousThreadId) {
      const archived = parseStringList(
        this.database.getSetting("archived_codex_thread_ids"),
      );
      archived.push(previousThreadId);
      this.database.setSetting(
        "archived_codex_thread_ids",
        JSON.stringify([...new Set(archived)].slice(-25)),
      );
      this.telemetry.append("conversation.context_replaced", {
        previousThreadId,
        threadId,
        visibleHistoryPreserved: true,
      });
    }
    return threadId;
  }

  private armDispatchRetry(): void {
    if (this.dispatchRetryTimer) return;
    this.dispatchRetryTimer = setTimeout(() => {
      this.dispatchRetryTimer = null;
      void this.initializeConversation();
    }, 5_000);
  }

  private recoverInfrastructureFailedTurns(): void {
    for (const mission of this.repository.list()) {
      if (
        mission.status !== "failed" ||
        mission.codexTurnId ||
        !mission.error ||
        !isInfrastructureStartMessage(mission.error)
      )
        continue;
      const attempts = recoveryAttemptsFor(mission);
      this.repository.update(mission.id, {
        status: "queued",
        error: null,
        finishedAt: null,
        recoveryMetadata: {
          strategy: "inspect_then_continue",
          reason: "codex_reconnecting",
          attempts: attempts + 1,
        },
      });
      this.repository.appendEvent(mission.id, "mission.recovery_queued", {
        reason: "codex_reconnecting",
        attempt: attempts + 1,
      });
    }
  }

  private migrateExistingConversation(): void {
    if (this.database.getSetting("active_codex_thread_id")) return;
    const row = this.database.db
      .prepare(
        "SELECT codex_thread_id FROM missions WHERE codex_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { codex_thread_id: string } | undefined;
    if (!row?.codex_thread_id) return;
    this.database.setSetting("active_codex_thread_id", row.codex_thread_id);
    this.database.setSetting("setup_completed", "true");
  }
}

function parseStringList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function recoveryAttemptsFor(mission: MissionRecord): number {
  const metadata = recordValue(mission.recoveryMetadata);
  return typeof metadata.attempts === "number" ? metadata.attempts : 0;
}

function isContextWindowError(payload: unknown): boolean {
  return JSON.stringify(payload).includes("contextWindowExceeded");
}

function isInfrastructureStartError(error: unknown): boolean {
  return (
    error instanceof ServiceUnavailableException ||
    isInfrastructureStartMessage(errorMessage(error))
  );
}

function isInfrastructureStartMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "codex is not ready",
    "codex is reconnecting",
    "codex app-server",
    "codex conversation could not be resumed",
    "previous codex conversation could not be resumed",
    "connection closed",
    "socket closed",
    "desk codex transport",
  ].some((fragment) => normalized.includes(fragment));
}

function parseAttachmentResponse(
  value: string,
): { message: string; attachments: string[] } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = recordValue(parsed);
    if (typeof record.message !== "string") return null;
    const attachments = Array.isArray(record.attachments)
      ? record.attachments
          .filter((item): item is string => typeof item === "string")
          .slice(0, 5)
      : [];
    return { message: record.message, attachments };
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      return value.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_API_KEY]");
    }
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/api.?key|access.?token|authorization/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = sanitizePayload(child);
    }
  }
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
