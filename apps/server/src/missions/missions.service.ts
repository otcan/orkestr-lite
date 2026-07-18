import {
  BadRequestException,
  ConflictException,
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
import { MissionEventBus } from "./mission-event.bus.js";
import { MissionRepository } from "./mission.repository.js";

@Injectable()
export class MissionsService implements OnModuleInit {
  private readonly logger = new Logger(MissionsService.name);
  private activeMissionId: string | null = null;
  private dispatching = false;

  constructor(
    private readonly repository: MissionRepository,
    private readonly bus: MissionEventBus,
    private readonly codex: CodexService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  onModuleInit(): void {
    for (const mission of this.repository.active()) {
      this.repository.update(mission.id, {
        status: "interrupted",
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
    }
    this.codex.onNotification((notification) =>
      this.handleNotification(notification),
    );
    this.codex.onServerRequest((request) => this.handleServerRequest(request));
    this.codex.onExit((details) => this.handleCodexExit(details));
    this.codex.onReady(() => queueMicrotask(() => void this.processNext()));
    queueMicrotask(() => void this.processNext());
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

  create(input: CreateMissionInput): MissionRecord {
    const status = this.codex.snapshot();
    if (
      status.process !== "ready" ||
      !status.authenticated ||
      !status.modelReady
    ) {
      throw new ServiceUnavailableException(
        "Complete Codex setup before creating a mission",
      );
    }
    const selectedModel = input.model ?? this.codex.selectedModel();
    const available = status.models.some(
      (model) => model.id === selectedModel || model.model === selectedModel,
    );
    if (!available)
      throw new BadRequestException("Selected model is not available");
    const mission = this.repository.create(
      input,
      this.config.workspace,
      selectedModel,
    );
    void this.processNext();
    return mission;
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
    this.repository.appendEvent(mission.id, "mission.starting", { model });

    let threadId = mission.codexThreadId;
    if (threadId) {
      const thread = await this.codex.resumeThread(threadId);
      effectiveModel = thread.thread.model ?? effectiveModel;
      this.repository.update(mission.id, { effectiveModel });
      this.repository.appendEvent(mission.id, "codex.thread_resumed", {
        threadId,
      });
    } else {
      const thread = await this.codex.startThread({
        cwd: mission.workspace,
        model,
      });
      threadId = thread.thread.id;
      effectiveModel = thread.thread.model ?? model;
      this.repository.update(mission.id, {
        codexThreadId: threadId,
        effectiveModel,
      });
      this.repository.appendEvent(mission.id, "codex.thread_started", {
        threadId,
        model,
      });
    }

    const prompt = mission.recoveryMetadata
      ? `Resume the interrupted mission. Inspect the current workspace and prior thread state before acting. Do not repeat completed or uncertain side effects. Continue toward the original goal:\n\n${mission.prompt}`
      : mission.prompt;
    const turn = await this.codex.startTurn({
      threadId,
      prompt,
      cwd: mission.workspace,
      model,
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
  }

  private handleNotification(notification: CodexNotification): void {
    const threadId = stringValue(notification.params.threadId);
    const mission = threadId
      ? this.repository.findByThread(threadId)
      : this.activeMissionId
        ? this.repository.find(this.activeMissionId)
        : null;
    if (!mission) return;

    if (notification.method === "item/reasoning/textDelta") return;
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
        this.repository.update(mission.id, { finalResponse: item.text });
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
          latestProgressSummary: "Mission completed",
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
    const mission = threadId ? this.repository.findByThread(threadId) : null;
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

    this.repository.update(mission.id, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
      interruptionMetadata: {
        reason: "codex_app_server_exit",
        previousStatus: mission.status,
        code: details.code,
        signal: details.signal,
      },
    });
    this.repository.appendEvent(mission.id, "mission.interrupted", {
      reason: "codex_app_server_exit",
      previousStatus: mission.status,
      code: details.code,
      signal: details.signal,
      resumable: mission.codexThreadId !== null,
    });
    this.activeMissionId = null;
  }

  private finishActive(missionId: string): void {
    if (this.activeMissionId === missionId) this.activeMissionId = null;
    queueMicrotask(() => void this.processNext());
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
