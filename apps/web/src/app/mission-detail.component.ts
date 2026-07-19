import { DatePipe, JsonPipe } from "@angular/common";
import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import type { MissionEventRecord, MissionRecord } from "@orkestr/shared";
import { ApiService, errorText } from "./api.service";

@Component({
  standalone: true,
  imports: [DatePipe, JsonPipe, RouterLink],
  template: `
    <main class="page detail-page">
      <a class="back-link" routerLink="/mission">← Mission workspace</a>
      @if (error) {
        <div class="callout error" role="alert">{{ error }}</div>
      }
      @if (mission) {
        <header class="mission-detail-header">
          <div>
            <span
              class="status-badge large"
              [attr.data-status]="mission.status"
              >{{ mission.status }}</span
            >
            <h1>{{ mission.title }}</h1>
            <p class="mission-prompt">{{ mission.prompt }}</p>
          </div>
          <div class="action-stack">
            @if (
              ["starting", "running", "awaiting_approval"].includes(
                mission.status
              )
            ) {
              <button
                class="danger"
                type="button"
                (click)="interrupt()"
                [disabled]="busy"
              >
                Interrupt
              </button>
            }
            @if (mission.status === "interrupted" && mission.codexThreadId) {
              <button
                class="primary"
                type="button"
                (click)="resume()"
                [disabled]="busy"
              >
                Resume safely
              </button>
            }
          </div>
        </header>

        <section class="mission-facts panel">
          <div>
            <span>Requested model</span
            ><strong>{{ mission.requestedModel || "—" }}</strong>
          </div>
          <div>
            <span>Effective model</span
            ><strong>{{ mission.effectiveModel || "Waiting" }}</strong>
          </div>
          <div>
            <span>Started</span
            ><strong>{{
              (mission.startedAt | date: "medium") || "Queued"
            }}</strong>
          </div>
        </section>

        @if (pendingApproval; as approval) {
          <section class="approval-panel panel">
            <div>
              <p class="eyebrow">Human checkpoint</p>
              <h2>Approval required</h2>
              <p>{{ approvalReason(approval) }}</p>
              <pre>{{ approval.payload | json }}</pre>
            </div>
            <div class="approval-actions">
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
          </section>
        }

        <div class="detail-grid">
          <section class="activity-panel panel">
            <div class="section-heading">
              <h2>Codex activity</h2>
              <span class="connection" [class.connected]="connected">{{
                connected ? "Live" : "Reconnecting"
              }}</span>
            </div>
            <div class="activity-stream">
              @if (!events.length) {
                <p class="muted">Waiting for the first event…</p>
              }
              @for (event of visibleEvents; track event.id) {
                <article class="event-row" [attr.data-kind]="event.kind">
                  <span class="event-marker"></span>
                  <div>
                    <div class="event-heading">
                      <strong>{{ eventTitle(event) }}</strong
                      ><time>{{ event.createdAt | date: "mediumTime" }}</time>
                    </div>
                    @if (eventText(event); as text) {
                      <p>{{ text }}</p>
                    }
                    @if (event.kind === "turn/diff/updated") {
                      <pre class="diff">{{ payloadField(event, "diff") }}</pre>
                    }
                    @if (
                      event.kind === "item/completed" &&
                      payloadItemType(event) === "commandExecution"
                    ) {
                      <pre>{{
                        payloadItemField(event, "aggregatedOutput")
                      }}</pre>
                    }
                  </div>
                </article>
              }
            </div>
          </section>

          <aside class="result-column">
            <section class="panel">
              <p class="eyebrow">Latest progress</p>
              <p>
                {{
                  mission.latestProgressSummary || "No progress summary yet."
                }}
              </p>
            </section>
            @if (mission.finalResponse) {
              <section class="panel final-response">
                <p class="eyebrow">Final response</p>
                <div>{{ mission.finalResponse }}</div>
              </section>
            }
            @if (mission.error) {
              <section class="panel error">
                <p class="eyebrow">Failure</p>
                <p>{{ mission.error }}</p>
              </section>
            }
          </aside>
        </div>
      }
    </main>
  `,
})
export class MissionDetailComponent implements OnInit, OnDestroy {
  private readonly missionState = signal<MissionRecord | null>(null);
  private readonly eventsState = signal<MissionEventRecord[]>([]);
  private readonly errorState = signal("");
  private readonly busyState = signal(false);
  private readonly connectedState = signal(false);
  private eventSource: EventSource | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly id: string;

  constructor(
    route: ActivatedRoute,
    private readonly api: ApiService,
  ) {
    this.id = route.snapshot.paramMap.get("id") ?? "";
  }

  get mission(): MissionRecord | null {
    return this.missionState();
  }

  get events(): MissionEventRecord[] {
    return this.eventsState();
  }

  get error(): string {
    return this.errorState();
  }

  get busy(): boolean {
    return this.busyState();
  }

  get connected(): boolean {
    return this.connectedState();
  }

  get visibleEvents(): MissionEventRecord[] {
    return this.events
      .filter((event) => !event.kind.endsWith("/delta"))
      .slice(-250);
  }

  get pendingApproval(): MissionEventRecord | null {
    const required = [...this.events]
      .reverse()
      .find((event) => event.kind === "approval.required");
    if (!required) return null;
    const resolved = this.events.some(
      (event) => event.kind === "approval.resolved" && event.id > required.id,
    );
    return resolved || this.mission?.status !== "awaiting_approval"
      ? null
      : required;
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.connectEvents();
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  async interrupt(): Promise<void> {
    await this.action(() =>
      this.api.post(`/api/missions/${this.id}/interrupt`),
    );
  }

  async resume(): Promise<void> {
    await this.action(() => this.api.post(`/api/missions/${this.id}/resume`));
  }

  async decide(event: MissionEventRecord, decision: string): Promise<void> {
    const payload = asRecord(event.payload);
    await this.action(() =>
      this.api.post(`/api/missions/${this.id}/approve`, {
        requestId: payload.requestId,
        decision,
      }),
    );
  }

  eventTitle(event: MissionEventRecord): string {
    const titles: Record<string, string> = {
      "mission.queued": "Mission queued",
      "mission.starting": "Starting Codex",
      "codex.thread_started": "Codex session started",
      "codex.thread_resumed": "Codex session resumed",
      "codex.turn_started": "Codex turn started",
      "turn/started": "Work started",
      "turn/plan/updated": "Plan updated",
      "turn/diff/updated": "Workspace diff updated",
      "turn/completed": "Turn completed",
      "item/started": "Activity started",
      "item/completed": "Activity completed",
      "approval.required": "Approval required",
      "approval.resolved": "Approval resolved",
      "model/rerouted": "Model routing updated",
    };
    return (
      titles[event.kind] ??
      event.kind.replaceAll("/", " · ").replaceAll("_", " ")
    );
  }

  eventText(event: MissionEventRecord): string {
    const payload = asRecord(event.payload);
    if (event.kind === "mission.starting" && typeof payload.model === "string")
      return payload.model;
    if (event.kind === "warning" && typeof payload.message === "string")
      return payload.message;
    if (event.kind === "item/completed") {
      const item = asRecord(payload.item);
      if (item.type === "agentMessage" && typeof item.text === "string")
        return item.text;
      if (item.type === "commandExecution" && typeof item.command === "string")
        return item.command;
    }
    return "";
  }

  approvalReason(event: MissionEventRecord): string {
    const params = asRecord(asRecord(event.payload).params);
    return typeof params.reason === "string"
      ? params.reason
      : "Codex needs permission before it can continue this operation.";
  }

  payloadField(event: MissionEventRecord, key: string): unknown {
    return asRecord(event.payload)[key] ?? "";
  }

  payloadItemType(event: MissionEventRecord): unknown {
    return asRecord(asRecord(event.payload).item).type;
  }

  payloadItemField(event: MissionEventRecord, key: string): unknown {
    return asRecord(asRecord(event.payload).item)[key] ?? "";
  }

  private connectEvents(): void {
    this.eventSource = new EventSource(`/api/missions/${this.id}/events`);
    this.eventSource.onopen = () => this.connectedState.set(true);
    this.eventSource.onerror = () => this.connectedState.set(false);
    this.eventSource.addEventListener("mission-event", (message) => {
      const event = JSON.parse(
        (message as MessageEvent<string>).data,
      ) as MissionEventRecord;
      if (!this.events.some((existing) => existing.id === event.id)) {
        this.eventsState.set(
          [...this.events, event].sort((left, right) => left.id - right.id),
        );
      }
      this.scheduleRefresh();
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 100);
  }

  private async refresh(): Promise<void> {
    try {
      this.missionState.set(
        await this.api.get<MissionRecord>(`/api/missions/${this.id}`),
      );
    } catch (error) {
      this.errorState.set(errorText(error));
    }
  }

  private async action(action: () => Promise<unknown>): Promise<void> {
    this.busyState.set(true);
    this.errorState.set("");
    try {
      await action();
      await this.refresh();
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
