import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { DatePipe, DecimalPipe } from "@angular/common";
import { Router, RouterLink } from "@angular/router";
import type { MissionRecord } from "@orkestr/shared";
import { ApiService, errorText } from "./api.service";

@Component({
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  template: `
    <main class="page narrow">
      <header class="page-header">
        <div>
          <p class="eyebrow">Mission workspace</p>
          <h1>One focused mission</h1>
          <p class="muted">
            Give Codex one bounded outcome and stay with it through completion.
          </p>
        </div>
      </header>

      @if (error) {
        <div class="callout error" role="alert">{{ error }}</div>
      }

      @if (currentMission) {
        <section class="section-block current-mission">
          <div class="section-heading">
            <h2>Current mission</h2>
            <span>One at a time</span>
          </div>
          <a
            class="mission-card active-card"
            [routerLink]="['/mission', currentMission.id]"
          >
            <div>
              <span
                class="status-badge"
                [attr.data-status]="currentMission.status"
                >{{ currentMission.status }}</span
              >
              <h3>{{ currentMission.title }}</h3>
              <p>
                {{
                  currentMission.latestProgressSummary ||
                    "Codex is preparing the mission"
                }}
              </p>
            </div>
            <div class="mission-meta">
              <span>{{
                currentMission.effectiveModel || currentMission.requestedModel
              }}</span>
              <span>{{ currentMission.startedAt | date: "mediumTime" }}</span>
            </div>
          </a>
          <p class="single-mission-note muted">
            Finish or resume this mission before starting another.
          </p>
        </section>
      } @else {
        <section class="mission-composer panel">
          <div class="composer-heading">
            <div>
              <span class="live-dot"></span>
              <strong>Mission brief</strong>
            </div>
            <span class="model-label">GPT-5.6 verified at start</span>
          </div>
          <form (submit)="create(); $event.preventDefault()">
            <textarea
              name="prompt"
              [value]="prompt()"
              (input)="prompt.set($any($event.target).value)"
              rows="6"
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
                {{ busy ? "Starting…" : "Start mission" }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (!currentMission) {
        <section class="section-block">
          <div class="section-heading">
            <h2>Most recent mission</h2>
          </div>
          @if (!latestMission) {
            <div class="empty-state panel">
              <strong>Ready for the first mission</strong>
              <p>
                Complete workstation setup, then describe one concrete outcome
                above.
              </p>
            </div>
          } @else {
            <a
              class="mission-card"
              [routerLink]="['/mission', latestMission.id]"
            >
              <div>
                <span
                  class="status-badge"
                  [attr.data-status]="latestMission.status"
                  >{{ latestMission.status }}</span
                >
                <h3>{{ latestMission.title }}</h3>
                <p>
                  {{
                    latestMission.finalResponse ||
                      latestMission.error ||
                      "Open the mission result"
                  }}
                </p>
              </div>
              <div class="mission-meta">
                <span>{{ latestMission.createdAt | date: "medium" }}</span>
              </div>
            </a>
          }
        </section>
      }
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

  get currentMission(): MissionRecord | undefined {
    return this.missions.find((mission) =>
      [
        "queued",
        "starting",
        "running",
        "awaiting_approval",
        "interrupted",
      ].includes(mission.status),
    );
  }

  get latestMission(): MissionRecord | undefined {
    return this.missions[0];
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
      await this.router.navigate(["/mission", mission.id]);
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
