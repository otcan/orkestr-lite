import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { DatePipe, DecimalPipe } from "@angular/common";
import { Router, RouterLink } from "@angular/router";
import type { MissionRecord } from "@orkestr/shared";
import { ApiService, errorText } from "./api.service";

@Component({
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  template: `
    <main class="page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Mission control</p>
          <h1>Persistent Codex work</h1>
          <p class="muted">
            One mission runs at a time. Everything else waits safely in the
            queue.
          </p>
        </div>
        <a class="quiet button-link" routerLink="/setup">Setup diagnostics</a>
      </header>

      <section class="mission-composer panel">
        <div class="composer-heading">
          <div>
            <span class="live-dot"></span>
            <strong>New mission</strong>
          </div>
          <span class="model-label">GPT-5.6 verified at dispatch</span>
        </div>
        <form (submit)="create(); $event.preventDefault()">
          <textarea
            name="prompt"
            [value]="prompt()"
            (input)="prompt.set($any($event.target).value)"
            rows="5"
            maxlength="32000"
            placeholder="Describe a concrete outcome for Codex…"
            required
          ></textarea>
          <div class="composer-footer">
            <span>{{ prompt().length | number }} / 32,000</span>
            <button
              class="primary"
              type="submit"
              [disabled]="busy || !prompt().trim()"
            >
              {{ busy ? "Queueing…" : "Create mission" }}
            </button>
          </div>
        </form>
        @if (error) {
          <p class="error" role="alert">{{ error }}</p>
        }
      </section>

      @if (activeMission) {
        <section class="section-block">
          <div class="section-heading">
            <h2>Active mission</h2>
            <span>Live</span>
          </div>
          <a
            class="mission-card active-card"
            [routerLink]="['/missions', activeMission.id]"
          >
            <div>
              <span
                class="status-badge"
                [attr.data-status]="activeMission.status"
                >{{ activeMission.status }}</span
              >
              <h3>{{ activeMission.title }}</h3>
              <p>
                {{
                  activeMission.latestProgressSummary ||
                    "Codex is preparing the mission"
                }}
              </p>
            </div>
            <div class="mission-meta">
              <span>{{
                activeMission.effectiveModel || activeMission.requestedModel
              }}</span>
              <span>{{ activeMission.startedAt | date: "mediumTime" }}</span>
            </div>
          </a>
        </section>
      }

      @if (queuedMissions.length) {
        <section class="section-block">
          <div class="section-heading">
            <h2>Queue</h2>
            <span>{{ queuedMissions.length }}</span>
          </div>
          <div class="mission-list">
            @for (mission of queuedMissions; track mission.id) {
              <a class="mission-row" [routerLink]="['/missions', mission.id]">
                <span class="queue-position">{{ $index + 1 }}</span>
                <div>
                  <strong>{{ mission.title }}</strong>
                  <p>Queued {{ mission.createdAt | date: "shortTime" }}</p>
                </div>
                <span class="status-badge" data-status="queued">queued</span>
              </a>
            }
          </div>
        </section>
      }

      <section class="section-block">
        <div class="section-heading">
          <h2>Mission history</h2>
          <span>{{ previousMissions.length }}</span>
        </div>
        @if (!missions.length) {
          <div class="empty-state panel">
            <strong>No missions yet</strong>
            <p>
              Connect Codex in Setup, then create the first operational mission.
            </p>
          </div>
        } @else {
          <div class="mission-list panel flush">
            @for (mission of previousMissions; track mission.id) {
              <a class="mission-row" [routerLink]="['/missions', mission.id]">
                <span
                  class="status-icon"
                  [attr.data-status]="mission.status"
                ></span>
                <div>
                  <strong>{{ mission.title }}</strong>
                  <p>
                    {{ mission.source }} ·
                    {{ mission.createdAt | date: "medium" }}
                  </p>
                </div>
                <span
                  class="status-badge"
                  [attr.data-status]="mission.status"
                  >{{ mission.status }}</span
                >
              </a>
            }
          </div>
        }
      </section>
    </main>
  `,
})
export class MissionsComponent implements OnInit, OnDestroy {
  readonly prompt = signal("");
  private readonly missionsState = signal<MissionRecord[]>([]);
  private readonly busyState = signal(false);
  private readonly errorState = signal("");
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly router: Router,
  ) {}

  get missions(): MissionRecord[] {
    return this.missionsState();
  }

  get busy(): boolean {
    return this.busyState();
  }

  get error(): string {
    return this.errorState();
  }

  get activeMission(): MissionRecord | undefined {
    return this.missions.find((mission) =>
      ["starting", "running", "awaiting_approval"].includes(mission.status),
    );
  }

  get queuedMissions(): MissionRecord[] {
    return this.missions
      .filter((mission) => mission.status === "queued")
      .reverse();
  }

  get previousMissions(): MissionRecord[] {
    return this.missions.filter(
      (mission) =>
        mission.id !== this.activeMission?.id && mission.status !== "queued",
    );
  }

  ngOnInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async create(): Promise<void> {
    this.busyState.set(true);
    this.errorState.set("");
    try {
      const mission = await this.api.createMission({
        prompt: this.prompt().trim(),
        source: "web",
      });
      this.prompt.set("");
      await this.router.navigate(["/missions", mission.id]);
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.busyState.set(false);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const result = await this.api.get<{ data: MissionRecord[] }>(
        "/api/missions",
      );
      this.missionsState.set(result.data);
    } catch (error) {
      this.errorState.set(errorText(error));
    }
  }
}
