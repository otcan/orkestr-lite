import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService, errorText } from "./api.service";

interface TurnView {
  id: string;
  source: "web" | "whatsapp" | "timer" | "demo";
  prompt: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  latestProgressSummary: string | null;
  finalResponse: string | null;
  error: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  effectiveModel: string | null;
  enqueueSequence: number | null;
  queuePosition: number | null;
  attachments: AttachmentView[];
}

interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  direction: "inbound" | "outbound";
  createdAt: string;
}

interface TurnEvent {
  id: number;
  missionId: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

interface ConversationStatus {
  conversationReady: boolean;
  resumeError: string | null;
  queueDepth: number;
  queueLimit: number;
  compacting: boolean;
  context: {
    usedTokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    updatedAt: string | null;
    compactionCount: number;
    lastCompactedAt: string | null;
  };
}

interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
}

interface SetupStatus {
  codex: {
    selectedModel: string | null;
    models: CodexModelOption[];
  };
}

const DRAFT_KEY = "orkestr.conversation.draft.v1";
const EXECUTION_KEY = "orkestr.conversation.execution.v1";
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];

@Component({
  standalone: true,
  imports: [RouterLink],
  template: `
    <main class="conversation-page">
      <section class="conversation-column" id="chat">
        <header class="conversation-header">
          <div class="conversation-title-block">
            <p class="eyebrow">Orkestr workstation</p>
            <h1>Codex</h1>
            <p class="conversation-subtitle">
              One continuous conversation across Browser, Desk, WhatsApp, and
              schedules.
            </p>
          </div>
          <div class="conversation-header-actions">
            <span class="conversation-online">
              <span class="live-dot"></span>
              Workstation online
            </span>
            @if (activeTurn) {
              <button
                class="danger"
                type="button"
                (click)="stop()"
                [disabled]="busy"
              >
                Stop
              </button>
            }
          </div>
          <div class="execution-toolbar" aria-label="Codex execution settings">
            <label>
              <span>Model</span>
              <select
                aria-label="Codex model"
                [value]="selectedModel()"
                (change)="selectModel($any($event.target).value)"
                [disabled]="busy || !models().length"
              >
                @for (model of models(); track model.id) {
                  <option [value]="model.model">
                    {{ model.displayName }}
                  </option>
                }
              </select>
            </label>
            <label>
              <span>Effort</span>
              <select
                aria-label="Reasoning effort"
                [value]="reasoningEffort()"
                (change)="selectReasoningEffort($any($event.target).value)"
                [disabled]="busy"
              >
                @for (effort of reasoningOptions(); track effort) {
                  <option [value]="effort">{{ effortLabel(effort) }}</option>
                }
              </select>
            </label>
            <span
              class="yolo-mode"
              title="No approval prompts. Codex has full access inside the isolated Ubuntu workstation."
            >
              <span class="yolo-dot"></span>
              YOLO · full access
            </span>
          </div>
        </header>

        @if (connectivityDegraded()) {
          <div class="callout warning" role="status">
            Browser updates are delayed. Your draft is safe and live updates
            will resume automatically.
          </div>
        }

        @if (conversationStatus()?.context?.percent; as percent) {
          <div
            class="context-strip"
            [class.warning]="percent >= 80"
            [class.critical]="percent >= 90"
          >
            <div>
              <strong>Context {{ percent }}%</strong>
              <span>
                · {{ conversationStatus()?.context?.compactionCount || 0 }}
                compactions
              </span>
            </div>
            <div class="context-meter" aria-hidden="true">
              <span [style.width.%]="percent"></span>
            </div>
          </div>
        }

        @if (activeTurn; as current) {
          <div class="working-strip">
            <span class="live-dot"></span>
            <strong>Working</strong>
            <span
              >·
              {{
                current.latestProgressSummary || "Preparing the response"
              }}</span
            >
          </div>
        }

        @if (error) {
          <div class="callout error" role="alert">{{ error }}</div>
        }

        @if (resumeError) {
          <section class="callout warning conversation-recovery" role="status">
            <strong>Codex is reconnecting.</strong>
            <p>
              Your conversation, workspace, and queued messages are preserved.
              Orkestr will repair the Codex context automatically.
            </p>
            <div class="setup-actions">
              <button
                type="button"
                (click)="retryConversation()"
                [disabled]="busy"
              >
                Retry now
              </button>
              <a class="button-link quiet" routerLink="/diagnostics"
                >View diagnostics</a
              >
            </div>
          </section>
        }

        <section class="conversation-stream" aria-label="Conversation history">
          @if (nextCursor()) {
            <button
              class="quiet load-older"
              type="button"
              (click)="loadOlder()"
              [disabled]="loadingOlder()"
            >
              {{ loadingOlder() ? "Loading…" : "Load older messages" }}
            </button>
          }
          @if (!turns.length) {
            <div class="conversation-empty">
              <span class="brand-mark">O</span>
              <h2>One conversation. One workspace.</h2>
              <p>
                Browser, WhatsApp, and scheduled messages all continue here.
              </p>
            </div>
          }

          @for (turn of turns; track turn.id) {
            <article class="conversation-turn" [attr.id]="'turn-' + turn.id">
              <div class="message user-message">
                <div class="message-heading">
                  <p class="message-author">{{ author(turn) }}</p>
                  <time class="message-time" [attr.datetime]="turn.createdAt">
                    {{ timestamp(turn.createdAt) }}
                  </time>
                </div>
                <div>{{ turn.prompt }}</div>
                @if (attachmentsFor(turn, "inbound").length) {
                  <div class="message-attachments">
                    @for (
                      attachment of attachmentsFor(turn, "inbound");
                      track attachment.id
                    ) {
                      <a
                        class="message-attachment"
                        [href]="attachmentDownloadUrl(attachment.id)"
                        download
                      >
                        <span>{{ attachment.name }}</span>
                        <small>{{ formatBytes(attachment.sizeBytes) }}</small>
                      </a>
                    }
                  </div>
                }
              </div>

              <div class="message codex-message">
                <div class="message-heading">
                  <p class="message-author">Codex</p>
                  <span class="turn-source">{{
                    sourceLabel(turn.source)
                  }}</span>
                </div>
                @if (turn.status === "queued") {
                  <p class="turn-state">
                    Queued
                    @if (turn.queuePosition) {
                      <span>· Position {{ turn.queuePosition }}</span>
                    }
                  </p>
                  <button
                    class="quiet compact-button"
                    type="button"
                    (click)="cancelQueued(turn)"
                    [disabled]="busy"
                  >
                    Cancel queued message
                  </button>
                } @else if (isWorking(turn)) {
                  <p class="turn-state">
                    Working · {{ turn.latestProgressSummary || "Preparing" }}
                  </p>
                } @else if (turn.finalResponse) {
                  <div class="response-text">{{ turn.finalResponse }}</div>
                  <p class="turn-state">{{ completionLine(turn) }}</p>
                } @else if (turn.error) {
                  <p class="error">{{ turn.error }}</p>
                } @else {
                  <p class="turn-state">{{ readableStatus(turn.status) }}</p>
                }

                @if (attachmentsFor(turn, "outbound").length) {
                  <div class="message-attachments response-attachments">
                    @for (
                      attachment of attachmentsFor(turn, "outbound");
                      track attachment.id
                    ) {
                      <a
                        class="message-attachment"
                        [href]="attachmentDownloadUrl(attachment.id)"
                        download
                      >
                        <span>Download {{ attachment.name }}</span>
                        <small>{{ formatBytes(attachment.sizeBytes) }}</small>
                      </a>
                    }
                  </div>
                }

                <details
                  class="turn-activity"
                  [open]="activityExpanded(turn.id)"
                  (toggle)="activityToggled(turn.id, $any($event.target).open)"
                >
                  <summary>
                    <span>Activity log</span>
                    <span class="activity-summary">
                      {{ readableStatus(turn.status) }} ·
                      {{ activitySummary(turn) }}
                    </span>
                  </summary>
                  <div class="activity-facts">
                    <span>
                      <small>Created</small>
                      {{ timestamp(turn.createdAt) }}
                    </span>
                    <span>
                      <small>Model · effort</small>
                      {{
                        turn.effectiveModel ||
                          turn.requestedModel ||
                          "Selecting"
                      }}
                      · {{ turn.requestedReasoningEffort || "default" }}
                    </span>
                    <span>
                      <small>Duration</small>
                      {{ duration(turn) }}
                    </span>
                  </div>
                  @if (activityLoading(turn.id)) {
                    <p class="muted">Loading activity…</p>
                  } @else {
                    <div class="activity-timeline">
                      @for (event of activity(turn); track event.id) {
                        <div class="activity-event">
                          <time [attr.datetime]="event.createdAt">
                            {{ timestamp(event.createdAt) }}
                          </time>
                          <span class="activity-dot"></span>
                          <div>
                            <strong>{{ eventLabel(event) }}</strong>
                            @if (eventDetail(event); as detail) {
                              <p>{{ detail }}</p>
                            }
                          </div>
                        </div>
                      }
                    </div>
                  }
                  @if (
                    turn.id === activeTurn?.id && pendingApproval;
                    as approval
                  ) {
                    <div class="approval-inline">
                      <strong>Codex needs approval to continue.</strong>
                      <div class="setup-actions">
                        <button
                          type="button"
                          (click)="decide(approval, 'decline')"
                          [disabled]="busy"
                        >
                          Decline
                        </button>
                        <button
                          class="primary"
                          type="button"
                          (click)="decide(approval, 'accept')"
                          [disabled]="busy"
                        >
                          Approve once
                        </button>
                      </div>
                    </div>
                  }
                </details>
              </div>
            </article>
          }
        </section>

        <form
          class="conversation-composer panel"
          (submit)="send(); $event.preventDefault()"
        >
          @if (pendingAttachments().length) {
            <div class="pending-attachments" aria-label="Attached files">
              @for (attachment of pendingAttachments(); track attachment.id) {
                <span class="pending-attachment">
                  <span>
                    <strong>{{ attachment.name }}</strong>
                    <small>{{ formatBytes(attachment.sizeBytes) }}</small>
                  </span>
                  <button
                    type="button"
                    class="attachment-remove"
                    [attr.aria-label]="'Remove ' + attachment.name"
                    (click)="removePendingAttachment(attachment.id)"
                    [disabled]="busy"
                  >
                    ×
                  </button>
                </span>
              }
            </div>
          }
          <textarea
            rows="3"
            maxlength="32000"
            placeholder="Message Codex…"
            [value]="content()"
            (input)="updateContent($any($event.target).value)"
            (keydown.enter)="handleComposerEnter($any($event))"
          ></textarea>
          <div class="composer-footer">
            <div class="composer-meta">
              <label
                class="attachment-button"
                [class.disabled]="
                  busy ||
                  uploadingAttachments() ||
                  pendingAttachments().length >= 5
                "
              >
                <input
                  class="attachment-picker"
                  type="file"
                  multiple
                  aria-label="Attach files"
                  (change)="uploadFiles($event)"
                  [disabled]="
                    busy ||
                    uploadingAttachments() ||
                    pendingAttachments().length >= 5
                  "
                />
                {{ uploadingAttachments() ? "Uploading…" : "Attach files" }}
              </label>
              <span>
                {{ activeTurn ? "Sends to the queue" : "Ready" }} · Enter to
                send · Shift+Enter for newline
              </span>
            </div>
            <button
              class="primary"
              type="submit"
              [disabled]="
                busy ||
                uploadingAttachments() ||
                (!content().trim() && !pendingAttachments().length)
              "
            >
              {{ activeTurn ? "Queue message" : "Send" }}
            </button>
          </div>
        </form>
      </section>
    </main>
  `,
})
export class ConversationComponent implements OnInit, OnDestroy {
  readonly content = signal("");
  readonly nextCursor = signal<number | null>(null);
  readonly loadingOlder = signal(false);
  readonly connectivityDegraded = signal(false);
  readonly conversationStatus = signal<ConversationStatus | null>(null);
  readonly models = signal<CodexModelOption[]>([]);
  readonly selectedModel = signal("");
  readonly reasoningEffort = signal("");
  readonly pendingAttachments = signal<AttachmentView[]>([]);
  readonly uploadingAttachments = signal(false);
  private readonly turnsState = signal<TurnView[]>([]);
  private readonly eventsState = signal<TurnEvent[]>([]);
  private readonly activityState = signal<Record<string, TurnEvent[]>>({});
  private readonly activityLoadingState = signal<Set<string>>(new Set());
  private readonly expandedActivityState = signal<Set<string>>(new Set());
  private readonly busyState = signal(false);
  private readonly errorState = signal("");
  private readonly resumeErrorState = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  private connectivityTimer: ReturnType<typeof setInterval> | null = null;
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private eventsSource: EventSource | null = null;
  private lastHeartbeatAt = Date.now();
  private draftId: string = crypto.randomUUID();
  private submittedContent: string | null = null;
  private latestScrollPending = false;
  private latestScrollScheduled = false;
  constructor(private readonly api: ApiService) {}

  get turns(): TurnView[] {
    return [...this.turnsState()].reverse();
  }

  get busy(): boolean {
    return this.busyState();
  }

  get error(): string {
    return this.errorState();
  }

  get resumeError(): string | null {
    return this.resumeErrorState();
  }

  get activeTurn(): TurnView | null {
    return (
      this.turnsState().find((turn) =>
        ["starting", "running", "awaiting_approval"].includes(turn.status),
      ) ?? null
    );
  }

  get pendingApproval(): TurnEvent | null {
    const required = [...this.eventsState()]
      .reverse()
      .find((event) => event.kind === "approval.required");
    if (!required || this.activeTurn?.status !== "awaiting_approval")
      return null;
    const resolved = this.eventsState().some(
      (event) => event.kind === "approval.resolved" && event.id > required.id,
    );
    return resolved ? null : required;
  }

  ngOnInit(): void {
    this.restoreDraft();
    this.restoreExecutionPreferences();
    this.latestScrollPending = true;
    void this.refreshAll();
    this.openEventStream();
    this.timer = setInterval(() => void this.refreshAll(), 30_000);
    this.connectivityTimer = setInterval(
      () =>
        this.connectivityDegraded.set(
          Date.now() - this.lastHeartbeatAt > 45_000,
        ),
      5_000,
    );
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.connectivityTimer) clearInterval(this.connectivityTimer);
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.eventsSource?.close();
  }

  async send(): Promise<void> {
    const content = this.content().trim();
    const attachmentIds = this.pendingAttachments().map((item) => item.id);
    if (!content && !attachmentIds.length) return;
    const clientMessageId = this.draftId;
    this.submittedContent = content;
    await this.action(async () => {
      await this.api.post<TurnView>("/api/turns", {
        source: "web",
        content,
        model: this.selectedModel() || undefined,
        reasoningEffort: this.reasoningEffort() || undefined,
        clientMessageId,
        attachments: attachmentIds,
      });
      if (
        this.content().trim() === content &&
        sameIds(
          this.pendingAttachments().map((item) => item.id),
          attachmentIds,
        )
      ) {
        this.content.set("");
        this.pendingAttachments.set([]);
        localStorage.removeItem(DRAFT_KEY);
        this.draftId = crypto.randomUUID();
      }
      this.submittedContent = null;
      this.latestScrollPending = true;
      await this.refreshTurns();
    });
  }

  updateContent(value: string): void {
    if (
      this.submittedContent !== null &&
      value.trim() !== this.submittedContent
    ) {
      this.draftId = crypto.randomUUID();
      this.submittedContent = null;
    }
    this.content.set(value);
    this.persistDraft();
  }

  handleComposerEnter(event: KeyboardEvent): void {
    if (event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (this.busy || this.uploadingAttachments()) return;
    void this.send();
  }

  selectModel(model: string): void {
    this.selectedModel.set(model);
    const options = this.reasoningOptions();
    const metadata = this.models().find(
      (candidate) => candidate.model === model,
    );
    const nextEffort = options.includes(metadata?.defaultReasoningEffort || "")
      ? metadata!.defaultReasoningEffort!
      : options[0] || "";
    this.reasoningEffort.set(nextEffort);
    this.executionPreferenceChanged();
  }

  selectReasoningEffort(effort: string): void {
    this.reasoningEffort.set(effort);
    this.executionPreferenceChanged();
  }

  reasoningOptions(): string[] {
    const selected = this.models().find(
      (model) => model.model === this.selectedModel(),
    );
    const supported = selected?.supportedReasoningEfforts.map(
      (option) => option.reasoningEffort,
    );
    return supported?.length ? supported : FALLBACK_EFFORTS;
  }

  effortLabel(effort: string): string {
    return effort === "xhigh"
      ? "Extra high"
      : effort.charAt(0).toUpperCase() + effort.slice(1);
  }

  async uploadFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = "";
    if (!files.length) return;
    if (this.pendingAttachments().length + files.length > 5) {
      this.errorState.set("Attach up to 5 files per message");
      return;
    }
    const body = new FormData();
    for (const file of files) body.append("files", file, file.name);
    this.uploadingAttachments.set(true);
    this.errorState.set("");
    try {
      const result = await this.api.post<{ data: AttachmentView[] }>(
        "/api/attachments",
        body,
      );
      this.pendingAttachments.set([
        ...this.pendingAttachments(),
        ...result.data,
      ]);
      this.draftId = crypto.randomUUID();
      this.persistDraft();
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.uploadingAttachments.set(false);
    }
  }

  removePendingAttachment(id: string): void {
    this.pendingAttachments.set(
      this.pendingAttachments().filter((item) => item.id !== id),
    );
    this.draftId = crypto.randomUUID();
    this.persistDraft();
  }

  async cancelQueued(turn: TurnView): Promise<void> {
    await this.action(async () => {
      await this.api.post(`/api/turns/${turn.id}/stop`);
      await this.refreshTurns();
    });
  }

  async loadOlder(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingOlder()) return;
    this.loadingOlder.set(true);
    try {
      const result = await this.api.get<{
        data: TurnView[];
        nextCursor: number | null;
      }>(`/api/turns?before=${cursor}&limit=50`);
      const known = new Set(this.turnsState().map((turn) => turn.id));
      this.turnsState.set([
        ...this.turnsState(),
        ...result.data.filter((turn) => !known.has(turn.id)),
      ]);
      this.nextCursor.set(result.data.length ? result.nextCursor : null);
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.loadingOlder.set(false);
    }
  }

  async stop(): Promise<void> {
    const active = this.activeTurn;
    if (!active) return;
    await this.action(async () => {
      await this.api.post(`/api/turns/${active.id}/stop`);
      await this.refreshTurns();
    });
  }

  async retryConversation(): Promise<void> {
    await this.action(async () => {
      await this.api.post("/api/conversation/retry");
      await this.refreshConversationStatus();
    });
  }

  async startFresh(): Promise<void> {
    const confirmed = globalThis.confirm(
      "This clears the current conversation context. Your workspace files will not be deleted.",
    );
    if (!confirmed) return;
    await this.action(async () => {
      await this.api.post("/api/conversation/start-fresh");
      await this.refreshAll();
    });
  }

  async decide(
    event: TurnEvent,
    decision: "accept" | "decline",
  ): Promise<void> {
    const requestId = asRecord(event.payload).requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    await this.action(async () => {
      await this.api.post(`/api/turns/${event.missionId}/approve`, {
        requestId,
        decision,
      });
      await this.refreshAll();
    });
  }

  author(turn: TurnView): string {
    if (turn.source === "whatsapp") return "You · from WhatsApp";
    if (turn.source === "timer") return "Scheduled";
    return "You";
  }

  isWorking(turn: TurnView): boolean {
    return ["starting", "running", "awaiting_approval"].includes(turn.status);
  }

  readableStatus(status: string): string {
    return status
      .replaceAll("_", " ")
      .replace(/^./, (value) => value.toUpperCase());
  }

  completionLine(turn: TurnView): string {
    if (!turn.startedAt || !turn.completedAt) return "Completed";
    const seconds = Math.max(
      0,
      Math.round(
        (new Date(turn.completedAt).getTime() -
          new Date(turn.startedAt).getTime()) /
          1_000,
      ),
    );
    return `Completed in ${seconds} seconds`;
  }

  timestamp(value: string): string {
    return new Date(value).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  }

  duration(turn: TurnView): string {
    if (!turn.startedAt) return "Not started";
    const end = turn.completedAt ? new Date(turn.completedAt) : new Date();
    const seconds = Math.max(
      0,
      Math.round((end.getTime() - new Date(turn.startedAt).getTime()) / 1_000),
    );
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }

  sourceLabel(source: TurnView["source"]): string {
    if (source === "whatsapp") return "WhatsApp";
    if (source === "timer") return "Schedule";
    if (source === "demo") return "Demo";
    return "Browser";
  }

  attachmentsFor(
    turn: TurnView,
    direction: AttachmentView["direction"],
  ): AttachmentView[] {
    return (turn.attachments || []).filter(
      (attachment) => attachment.direction === direction,
    );
  }

  attachmentDownloadUrl(id: string): string {
    return `/api/attachments/${encodeURIComponent(id)}/download`;
  }

  formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  }

  activity(turn: TurnView): TurnEvent[] {
    const events = this.activityState()[turn.id] ?? [];
    if (!turn.completedAt) return events;
    const completedAt = new Date(turn.completedAt).getTime() + 1_000;
    return events.filter(
      (event) => new Date(event.createdAt).getTime() <= completedAt,
    );
  }

  activityCount(turn: TurnView): number {
    return this.activity(turn).length;
  }

  activitySummary(turn: TurnView): string {
    return this.activityState()[turn.id]
      ? `${this.activityCount(turn)} events`
      : "Open for logs";
  }

  activityExpanded(turnId: string): boolean {
    return this.expandedActivityState().has(turnId);
  }

  activityLoading(turnId: string): boolean {
    return this.activityLoadingState().has(turnId);
  }

  activityToggled(turnId: string, open: boolean): void {
    const expanded = new Set(this.expandedActivityState());
    if (open) {
      expanded.add(turnId);
      void this.loadActivity(turnId);
    } else {
      expanded.delete(turnId);
    }
    this.expandedActivityState.set(expanded);
  }

  eventLabel(event: TurnEvent): string {
    const labels: Record<string, string> = {
      "mission.queued": "Added to the queue",
      "mission.starting": "Workstation started the exchange",
      "conversation.turn_preparing": "Conversation context prepared",
      "codex.turn_started": "Codex started working",
      "turn/plan/updated": "Execution plan updated",
      "approval.required": "Approval requested",
      "approval.resolved": "Approval resolved",
      "model/rerouted": "Model rerouted",
      "turn/completed": "Response completed",
      "mission.failed": "Exchange failed",
      "mission.interrupted": "Exchange interrupted",
      "mission.cancelled": "Exchange cancelled",
      "browser.attachments_ready": "Download files are ready",
      "browser.attachments_failed": "Download file validation failed",
    };
    return labels[event.kind] ?? humanizeEventKind(event.kind);
  }

  eventDetail(event: TurnEvent): string {
    const payload = asRecord(event.payload);
    const item = asRecord(payload.item);
    const turn = asRecord(payload.turn);
    if (event.kind === "mission.queued") {
      return `Source · ${this.sourceLabel(String(payload.source || "web") as TurnView["source"])}`;
    }
    if (
      event.kind === "mission.starting" ||
      event.kind === "conversation.turn_preparing"
    ) {
      return payload.model ? `Model · ${String(payload.model)}` : "";
    }
    if (event.kind === "model/rerouted") {
      return payload.toModel ? `Using ${String(payload.toModel)}` : "";
    }
    if (event.kind === "approval.required") {
      return payload.method ? humanizeEventKind(String(payload.method)) : "";
    }
    if (event.kind === "item/completed" && item.type === "commandExecution") {
      return typeof item.command === "string"
        ? `Command · ${item.command}`
        : "Command finished";
    }
    if (event.kind === "item/completed" && item.type === "agentMessage") {
      return "Codex produced a response";
    }
    if (event.kind === "turn/completed" && turn.status) {
      return `Status · ${this.readableStatus(String(turn.status))}`;
    }
    if (payload.error) return String(payload.error);
    if (payload.reason) return humanizeEventKind(String(payload.reason));
    return "";
  }

  private async refreshAll(): Promise<void> {
    try {
      await this.refreshTurns();
      await Promise.all([
        this.refreshConversationStatus(),
        this.refreshModelOptions(),
        this.refreshEvents(),
      ]);
    } catch (error) {
      this.errorState.set(errorText(error));
    }
  }

  private async refreshTurns(): Promise<void> {
    const result = await this.api.get<{
      data: TurnView[];
      nextCursor: number | null;
    }>("/api/turns?limit=50");
    const older = this.turnsState().filter(
      (turn) => !result.data.some((fresh) => fresh.id === turn.id),
    );
    this.turnsState.set([...result.data, ...older]);
    if (!older.length) this.nextCursor.set(result.nextCursor);
    this.scrollToLatest();
  }

  private async loadActivity(turnId: string, force = false): Promise<void> {
    if (!force && this.activityState()[turnId]) return;
    this.activityLoadingState.set(
      new Set([...this.activityLoadingState(), turnId]),
    );
    try {
      const result = await this.api.get<{ data: TurnEvent[] }>(
        `/api/turns/${turnId}/events`,
      );
      this.activityState.set({
        ...this.activityState(),
        [turnId]: result.data,
      });
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      const loading = new Set(this.activityLoadingState());
      loading.delete(turnId);
      this.activityLoadingState.set(loading);
    }
  }

  private scrollToLatest(): void {
    if (!this.latestScrollPending || this.latestScrollScheduled) {
      return;
    }
    this.latestScrollScheduled = true;
    setTimeout(() => {
      this.latestScrollScheduled = false;
      globalThis.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "auto",
      });
      this.latestScrollPending = false;
    }, 0);
  }

  private async refreshEvents(): Promise<void> {
    const relevant = this.activeTurn ?? this.turnsState()[0];
    if (!relevant) {
      this.eventsState.set([]);
      return;
    }
    const result = await this.api.get<{ data: TurnEvent[] }>(
      `/api/turns/${relevant.id}/events`,
    );
    this.eventsState.set(result.data);
  }

  private async refreshConversationStatus(): Promise<void> {
    const status = await this.api.get<ConversationStatus>(
      "/api/conversation/status",
    );
    this.conversationStatus.set(status);
    this.resumeErrorState.set(status.resumeError);
  }

  private async refreshModelOptions(): Promise<void> {
    const status = await this.api.get<SetupStatus>("/api/setup/status");
    const models = status.codex.models.filter((model) => model.model);
    this.models.set(models);
    if (!models.length) return;
    const selected = models.some(
      (model) => model.model === this.selectedModel(),
    )
      ? this.selectedModel()
      : models.find((model) => model.model === status.codex.selectedModel)
          ?.model ||
        models.find((model) => model.isDefault)?.model ||
        models[0]!.model;
    this.selectedModel.set(selected);
    const options = this.reasoningOptions();
    if (!options.includes(this.reasoningEffort())) {
      const metadata = models.find((model) => model.model === selected);
      this.reasoningEffort.set(
        options.includes(metadata?.defaultReasoningEffort || "")
          ? metadata!.defaultReasoningEffort!
          : options[0] || "",
      );
    }
    this.persistExecutionPreferences();
  }

  private openEventStream(): void {
    this.eventsSource?.close();
    const source = new EventSource("/api/conversation/events");
    const connected = () => {
      this.lastHeartbeatAt = Date.now();
      this.connectivityDegraded.set(false);
    };
    source.onopen = connected;
    source.addEventListener("heartbeat", connected);
    source.addEventListener("turn", () => {
      connected();
      this.scheduleEventRefresh();
    });
    source.addEventListener("conversation", () => {
      connected();
      void this.refreshConversationStatus();
    });
    source.onerror = () => {
      if (Date.now() - this.lastHeartbeatAt > 45_000) {
        this.connectivityDegraded.set(true);
      }
    };
    this.eventsSource = source;
  }

  private scheduleEventRefresh(): void {
    if (this.refreshDebounce) return;
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null;
      void this.refreshAll();
      for (const turnId of Object.keys(this.activityState())) {
        void this.loadActivity(turnId, true);
      }
    }, 150);
  }

  private restoreDraft(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null") as {
        content?: unknown;
        id?: unknown;
        attachments?: unknown;
      } | null;
      if (typeof saved?.content === "string") this.content.set(saved.content);
      if (typeof saved?.id === "string" && saved.id) this.draftId = saved.id;
      if (Array.isArray(saved?.attachments)) {
        this.pendingAttachments.set(
          saved.attachments.filter(isAttachmentView).slice(0, 5),
        );
      }
    } catch {
      localStorage.removeItem(DRAFT_KEY);
    }
  }

  private persistDraft(): void {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        content: this.content(),
        id: this.draftId,
        attachments: this.pendingAttachments(),
      }),
    );
  }

  private restoreExecutionPreferences(): void {
    try {
      const saved = JSON.parse(
        localStorage.getItem(EXECUTION_KEY) || "null",
      ) as { model?: unknown; reasoningEffort?: unknown } | null;
      if (typeof saved?.model === "string") this.selectedModel.set(saved.model);
      if (typeof saved?.reasoningEffort === "string") {
        this.reasoningEffort.set(saved.reasoningEffort);
      }
    } catch {
      localStorage.removeItem(EXECUTION_KEY);
    }
  }

  private executionPreferenceChanged(): void {
    this.draftId = crypto.randomUUID();
    this.submittedContent = null;
    this.persistExecutionPreferences();
    this.persistDraft();
  }

  private persistExecutionPreferences(): void {
    localStorage.setItem(
      EXECUTION_KEY,
      JSON.stringify({
        model: this.selectedModel(),
        reasoningEffort: this.reasoningEffort(),
      }),
    );
  }

  private async action(action: () => Promise<void>): Promise<void> {
    this.busyState.set(true);
    this.errorState.set("");
    try {
      await action();
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.busyState.set(false);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function isAttachmentView(value: unknown): value is AttachmentView {
  const item = asRecord(value);
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.mimeType === "string" &&
    typeof item.sizeBytes === "number" &&
    (item.direction === "inbound" || item.direction === "outbound") &&
    typeof item.createdAt === "string"
  );
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function humanizeEventKind(kind: string): string {
  return kind
    .replaceAll(/[./_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase())
    .replaceAll(/\bThread\b/g, "Conversation")
    .replaceAll(/\bMission\b/g, "Exchange")
    .replaceAll(/\bMcp\b/g, "MCP");
}
