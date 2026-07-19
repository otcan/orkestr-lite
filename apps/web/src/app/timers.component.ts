import { Component, OnInit, signal } from "@angular/core";
import { ApiService, errorText } from "./api.service";

type ScheduleKind = "once" | "hourly" | "daily" | "weekly";

interface TimerView {
  id: string;
  name: string;
  prompt: string;
  kind: ScheduleKind;
  runAt: string | null;
  time: string | null;
  weekday: number | null;
  minute: number | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTurnId: string | null;
  lastRunStatus: string | null;
}

@Component({
  standalone: true,
  template: `
    <main class="page narrow">
      <header class="page-header">
        <div>
          <p class="eyebrow">Schedule</p>
          <h1>Scheduled messages</h1>
          <p class="muted">
            Every scheduled prompt enters the same conversation queue and its
            reply is mirrored to WhatsApp.
          </p>
        </div>
      </header>

      @if (error) {
        <div class="callout error" role="alert">{{ error }}</div>
      }

      <form class="panel timer-form" (submit)="save(); $event.preventDefault()">
        <label>
          Name
          <input
            type="text"
            maxlength="120"
            placeholder="Daily check"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
            required
          />
        </label>
        <label>
          Schedule
          <select
            [value]="kind()"
            (change)="kind.set($any($event.target).value)"
          >
            <option value="once">Once</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        @if (kind() === "once") {
          <label>
            Run at
            <input
              type="datetime-local"
              [value]="runAt()"
              (input)="runAt.set($any($event.target).value)"
              required
            />
          </label>
        } @else if (kind() === "hourly") {
          <label>
            Minute past the hour
            <input
              type="number"
              min="0"
              max="59"
              [value]="minute()"
              (input)="minute.set(+$any($event.target).value)"
              required
            />
          </label>
        } @else {
          @if (kind() === "weekly") {
            <label>
              Weekday
              <select
                [value]="weekday()"
                (change)="weekday.set(+$any($event.target).value)"
              >
                @for (day of weekdays; track $index) {
                  <option [value]="$index">{{ day }}</option>
                }
              </select>
            </label>
          }
          <label>
            Time
            <input
              type="time"
              [value]="time()"
              (input)="time.set($any($event.target).value)"
              required
            />
          </label>
        }
        <label class="timer-prompt">
          Message for Codex
          <textarea
            rows="4"
            maxlength="32000"
            placeholder="Run the tests and summarize any new failures."
            [value]="prompt()"
            (input)="prompt.set($any($event.target).value)"
            required
          ></textarea>
        </label>
        <div class="composer-footer timer-footer">
          <span>{{ timezone }}</span>
          <div class="timer-actions">
            @if (editingId()) {
              <button type="button" (click)="resetForm()">Cancel</button>
            }
            <button class="primary" type="submit" [disabled]="busy || !canSave">
              {{ editingId() ? "Save timer" : "Add timer" }}
            </button>
          </div>
        </div>
      </form>

      <section class="timer-list">
        @if (!timers.length) {
          <div class="panel empty-state">
            <strong>No timers yet</strong>
            <p>
              Create one above. Its response will appear in the main
              conversation.
            </p>
          </div>
        }
        @for (timer of timers; track timer.id) {
          <article class="panel timer-row">
            <div>
              <p class="eyebrow">{{ timer.enabled ? "Enabled" : "Paused" }}</p>
              <h2>{{ timer.name }}</h2>
              <p>{{ timer.prompt }}</p>
              <small class="muted">
                {{ scheduleLabel(timer) }} · {{ timer.timezone }}
                @if (timer.nextRunAt) {
                  · next {{ date(timer.nextRunAt) }}
                }
                @if (timer.lastRunAt) {
                  · last {{ date(timer.lastRunAt) }} ({{
                    timer.lastRunStatus || "queued"
                  }})
                }
              </small>
            </div>
            <div class="timer-actions">
              <button type="button" (click)="edit(timer)" [disabled]="busy">
                Edit
              </button>
              <button type="button" (click)="runNow(timer)" [disabled]="busy">
                Run now
              </button>
              <button type="button" (click)="toggle(timer)" [disabled]="busy">
                {{ timer.enabled ? "Pause" : "Enable" }}
              </button>
              <button
                class="danger"
                type="button"
                (click)="remove(timer)"
                [disabled]="busy"
              >
                Delete
              </button>
            </div>
          </article>
        }
      </section>
    </main>
  `,
})
export class TimersComponent implements OnInit {
  readonly name = signal("");
  readonly prompt = signal("");
  readonly kind = signal<ScheduleKind>("daily");
  readonly time = signal("09:00");
  readonly weekday = signal(1);
  readonly minute = signal(0);
  readonly runAt = signal(defaultLocalDateTime());
  readonly editingId = signal<string | null>(null);
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  readonly weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  private readonly timersState = signal<TimerView[]>([]);
  private readonly busyState = signal(false);
  private readonly errorState = signal("");

  constructor(private readonly api: ApiService) {}

  get timers(): TimerView[] {
    return this.timersState();
  }
  get busy(): boolean {
    return this.busyState();
  }
  get error(): string {
    return this.errorState();
  }
  get canSave(): boolean {
    return Boolean(
      this.name().trim() &&
        this.prompt().trim() &&
        (this.kind() === "once"
          ? this.runAt()
          : this.kind() === "hourly"
            ? Number.isInteger(this.minute()) &&
              this.minute() >= 0 &&
              this.minute() <= 59
            : this.time()),
    );
  }

  ngOnInit(): void {
    void this.refresh();
  }

  async save(): Promise<void> {
    const body = {
      name: this.name(),
      prompt: this.prompt(),
      kind: this.kind(),
      time: ["once", "hourly"].includes(this.kind()) ? null : this.time(),
      weekday: this.kind() === "weekly" ? this.weekday() : null,
      minute: this.kind() === "hourly" ? this.minute() : null,
      runAt:
        this.kind() === "once" ? new Date(this.runAt()).toISOString() : null,
      timezone: this.timezone,
    };
    await this.run(async () => {
      const id = this.editingId();
      if (id) await this.api.patch(`/api/timers/${id}`, body);
      else await this.api.post("/api/timers", body);
      this.resetForm();
    });
  }

  edit(timer: TimerView): void {
    this.editingId.set(timer.id);
    this.name.set(timer.name);
    this.prompt.set(timer.prompt);
    this.kind.set(timer.kind);
    this.time.set(timer.time || "09:00");
    this.weekday.set(timer.weekday ?? 1);
    this.minute.set(timer.minute ?? 0);
    this.runAt.set(
      timer.runAt ? toLocalDateTime(timer.runAt) : defaultLocalDateTime(),
    );
    globalThis.scrollTo({ top: 0, behavior: "smooth" });
  }

  resetForm(): void {
    this.editingId.set(null);
    this.name.set("");
    this.prompt.set("");
    this.kind.set("daily");
    this.time.set("09:00");
    this.weekday.set(1);
    this.minute.set(0);
    this.runAt.set(defaultLocalDateTime());
  }

  async toggle(timer: TimerView): Promise<void> {
    await this.run(() => this.api.post(`/api/timers/${timer.id}/toggle`));
  }

  async runNow(timer: TimerView): Promise<void> {
    await this.run(() => this.api.post(`/api/timers/${timer.id}/run`));
  }

  async remove(timer: TimerView): Promise<void> {
    if (!globalThis.confirm(`Delete “${timer.name}”?`)) return;
    await this.run(() => this.api.delete(`/api/timers/${timer.id}`));
  }

  scheduleLabel(timer: TimerView): string {
    if (timer.kind === "once")
      return `Once at ${timer.runAt ? this.date(timer.runAt) : "—"}`;
    if (timer.kind === "hourly")
      return `Hourly at :${String(timer.minute ?? 0).padStart(2, "0")}`;
    if (timer.kind === "weekly")
      return `${this.weekdays[timer.weekday ?? 0]} at ${timer.time}`;
    return `Daily at ${timer.time}`;
  }

  date(value: string): string {
    return new Date(value).toLocaleString();
  }

  private async refresh(): Promise<void> {
    const result = await this.api.get<{ data: TimerView[] }>("/api/timers");
    this.timersState.set(result.data);
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
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

function defaultLocalDateTime(): string {
  return toLocalDateTime(new Date(Date.now() + 60 * 60 * 1_000).toISOString());
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
