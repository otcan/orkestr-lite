import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { DatabaseService } from "../database/database.service.js";
import { MissionsService } from "./missions.service.js";

export type ScheduleKind =
  | "once"
  | "interval"
  | "hourly"
  | "daily"
  | "weekly"
  | "cron";

const MINIMUM_FREQUENCY_MS = 5 * 60 * 1_000;
const MISSED_AFTER_MS = 60 * 60 * 1_000;

interface TimerRow {
  id: string;
  name: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  schedule_value: string;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_mission_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimerView {
  id: string;
  name: string;
  prompt: string;
  kind: ScheduleKind;
  runAt: string | null;
  time: string | null;
  weekday: number | null;
  minute: number | null;
  intervalMinutes: number | null;
  cronExpression: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTurnId: string | null;
  lastRunStatus: string | null;
  lastRunReason: string | null;
}

export interface TimerInput {
  name: string;
  prompt: string;
  kind: ScheduleKind;
  runAt: string | null;
  time: string | null;
  weekday: number | null;
  minute: number | null;
  intervalMinutes: number | null;
  cronExpression: string | null;
  timezone: string;
  enabled: boolean;
}

@Injectable()
export class TimersService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly turns: MissionsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 15_000);
    queueMicrotask(() => void this.tick());
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  list(): TimerView[] {
    return (
      this.database.db
        .prepare("SELECT * FROM timers ORDER BY created_at DESC")
        .all() as TimerRow[]
    ).map((row) => this.view(row));
  }

  create(input: unknown): TimerView {
    const parsed = parseInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const value = encodeSchedule(parsed);
    const nextRunAt = parsed.enabled ? nextRun(parsed, new Date()) : null;
    this.database.db
      .prepare(
        `INSERT INTO timers(
          id, name, prompt, schedule_kind, schedule_value, timezone,
          next_run_at, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        parsed.name,
        parsed.prompt,
        parsed.kind,
        value,
        parsed.timezone,
        nextRunAt?.toISOString() ?? null,
        parsed.enabled ? 1 : 0,
        now,
        now,
      );
    return this.require(id);
  }

  preview(input: unknown): { nextRuns: string[] } {
    const parsed = parseInput(input);
    return {
      nextRuns: previewRuns(parsed, new Date(), 3).map((run) =>
        run.toISOString(),
      ),
    };
  }

  update(id: string, input: unknown): TimerView {
    const current = this.require(id);
    const body = asRecord(input);
    const parsed = parseInput({
      name: body.name ?? current.name,
      prompt: body.prompt ?? current.prompt,
      kind: body.kind ?? current.kind,
      runAt: body.runAt ?? current.runAt,
      time: body.time ?? current.time,
      weekday: body.weekday ?? current.weekday,
      minute: body.minute ?? current.minute,
      intervalMinutes: body.intervalMinutes ?? current.intervalMinutes,
      cronExpression: body.cronExpression ?? current.cronExpression,
      timezone: body.timezone ?? current.timezone,
      enabled: body.enabled ?? current.enabled,
    });
    const next = parsed.enabled ? nextRun(parsed, new Date()) : null;
    this.database.db
      .prepare(
        `UPDATE timers SET name = ?, prompt = ?, schedule_kind = ?,
         schedule_value = ?, timezone = ?, enabled = ?, next_run_at = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(
        parsed.name,
        parsed.prompt,
        parsed.kind,
        encodeSchedule(parsed),
        parsed.timezone,
        parsed.enabled ? 1 : 0,
        next?.toISOString() ?? null,
        new Date().toISOString(),
        id,
      );
    return this.require(id);
  }

  toggle(id: string): TimerView {
    const current = this.require(id);
    return this.update(id, { enabled: !current.enabled });
  }

  runNow(id: string): TimerView {
    const row = this.requireRow(id);
    if (this.timerHasPendingWork(id)) {
      throw new ConflictException("This timer already has pending work");
    }
    const scheduledFor = `manual:${new Date().toISOString()}`;
    this.claimAndQueue(row, scheduledFor, true);
    return this.require(id);
  }

  remove(id: string): void {
    this.requireRow(id);
    this.database.db.prepare("DELETE FROM timers WHERE id = ?").run(id);
  }

  private requireRow(id: string): TimerRow {
    const row = this.database.db
      .prepare("SELECT * FROM timers WHERE id = ?")
      .get(id) as TimerRow | undefined;
    if (!row) throw new NotFoundException("Timer not found");
    return row;
  }

  private require(id: string): TimerView {
    return this.view(this.requireRow(id));
  }

  private view(row: TimerRow): TimerView {
    const schedule = decodeSchedule(row);
    const lastRun = this.database.db
      .prepare(
        "SELECT status, error FROM timer_runs WHERE timer_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(row.id) as { status: string; error: string | null } | undefined;
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      kind: row.schedule_kind,
      runAt: schedule.runAt,
      time: schedule.time,
      weekday: schedule.weekday,
      minute: schedule.minute,
      intervalMinutes: schedule.intervalMinutes,
      cronExpression: schedule.cronExpression,
      timezone: row.timezone,
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastTurnId: row.last_mission_id,
      lastRunStatus: lastRun?.status ?? null,
      lastRunReason: lastRun?.error ?? null,
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      const due = this.database.db
        .prepare(
          `SELECT * FROM timers WHERE enabled = 1 AND next_run_at IS NOT NULL
           AND next_run_at <= ? ORDER BY next_run_at LIMIT 20`,
        )
        .all(now.toISOString()) as TimerRow[];
      for (const row of due) {
        const scheduledFor = row.next_run_at as string;
        const scheduled = new Date(scheduledFor);
        if (now.getTime() - scheduled.getTime() > MISSED_AFTER_MS) {
          this.markMissed(row, scheduledFor, now);
          continue;
        }
        if (!runtimeFrequencyIsValid(row, scheduled)) {
          this.markFailed(
            row,
            scheduledFor,
            now,
            "Schedule frequency is below five minutes",
          );
          continue;
        }
        if (this.timerHasPendingWork(row.id)) {
          this.markSkipped(row, scheduledFor, now, "overlap");
          continue;
        }
        try {
          this.claimAndQueue(row, scheduledFor, false);
        } catch {
          // The transaction rolls back so a temporarily unavailable Codex can retry.
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private claimAndQueue(
    row: TimerRow,
    scheduledFor: string,
    manual: boolean,
  ): void {
    this.database.db.transaction(() => {
      const now = new Date();
      const result = this.database.db
        .prepare(
          `INSERT OR IGNORE INTO timer_runs(
            id, timer_id, scheduled_for, status, created_at
          ) VALUES (?, ?, ?, 'claimed', ?)`,
        )
        .run(randomUUID(), row.id, scheduledFor, now.toISOString());
      if (result.changes === 0) return;
      const turn = this.turns.create(
        { source: "timer", title: row.name, prompt: row.prompt },
        row.id,
      );
      this.database.db
        .prepare(
          `UPDATE timer_runs SET status = 'queued', turn_id = ?, completed_at = ?
           WHERE timer_id = ? AND scheduled_for = ?`,
        )
        .run(turn.id, now.toISOString(), row.id, scheduledFor);
      if (manual) {
        this.database.db
          .prepare(
            "UPDATE timers SET last_run_at = ?, last_mission_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(now.toISOString(), turn.id, now.toISOString(), row.id);
        return;
      }
      const next = nextAfter(row, now);
      this.database.db
        .prepare(
          `UPDATE timers SET last_run_at = ?, last_mission_id = ?, next_run_at = ?,
           enabled = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          now.toISOString(),
          turn.id,
          next?.toISOString() ?? null,
          row.schedule_kind === "once" ? 0 : 1,
          now.toISOString(),
          row.id,
        );
    })();
  }

  private markMissed(row: TimerRow, scheduledFor: string, now: Date): void {
    this.database.db.transaction(() => {
      const result = this.database.db
        .prepare(
          `INSERT OR IGNORE INTO timer_runs(
            id, timer_id, scheduled_for, status, created_at, completed_at
          ) VALUES (?, ?, ?, 'missed', ?, ?)`,
        )
        .run(
          randomUUID(),
          row.id,
          scheduledFor,
          now.toISOString(),
          now.toISOString(),
        );
      if (result.changes === 0) return;
      const next = nextAfter(row, now);
      this.database.db
        .prepare(
          "UPDATE timers SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          next?.toISOString() ?? null,
          row.schedule_kind === "once" ? 0 : 1,
          now.toISOString(),
          row.id,
        );
    })();
  }

  private markSkipped(
    row: TimerRow,
    scheduledFor: string,
    now: Date,
    reason: string,
  ): void {
    this.recordWithoutTurn(row, scheduledFor, now, "skipped", reason, false);
  }

  private markFailed(
    row: TimerRow,
    scheduledFor: string,
    now: Date,
    reason: string,
  ): void {
    this.recordWithoutTurn(row, scheduledFor, now, "failed", reason, true);
  }

  private recordWithoutTurn(
    row: TimerRow,
    scheduledFor: string,
    now: Date,
    status: "skipped" | "failed",
    reason: string,
    disable: boolean,
  ): void {
    this.database.db.transaction(() => {
      const result = this.database.db
        .prepare(
          `INSERT OR IGNORE INTO timer_runs(
            id, timer_id, scheduled_for, status, error, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          row.id,
          scheduledFor,
          status,
          reason,
          now.toISOString(),
          now.toISOString(),
        );
      if (result.changes === 0) return;
      const next = disable ? null : nextAfter(row, now);
      this.database.db
        .prepare(
          "UPDATE timers SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          next?.toISOString() ?? null,
          disable || row.schedule_kind === "once" ? 0 : 1,
          now.toISOString(),
          row.id,
        );
    })();
  }

  private timerHasPendingWork(timerId: string): boolean {
    const row = this.database.db
      .prepare(
        `SELECT 1 AS pending FROM missions
         WHERE timer_id = ?
           AND status IN ('queued', 'starting', 'running', 'awaiting_approval')
         LIMIT 1`,
      )
      .get(timerId) as { pending: number } | undefined;
    return Boolean(row);
  }
}

export function parseTimerInput(value: unknown): TimerInput {
  const body = asRecord(value);
  const name = cleanString(body.name, 120);
  const prompt = cleanString(body.prompt, 32_000);
  const kind = cleanString(body.kind ?? "daily", 16) as ScheduleKind;
  const timezone = cleanString(body.timezone ?? "UTC", 100);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  if (
    !name ||
    !prompt ||
    !["once", "interval", "hourly", "daily", "weekly", "cron"].includes(kind)
  ) {
    throw new BadRequestException(
      "Name, prompt, and a valid schedule are required",
    );
  }
  assertTimezone(timezone);
  const time = cleanString(body.time, 5) || null;
  const runAt = cleanString(body.runAt, 64) || null;
  const weekday = typeof body.weekday === "number" ? body.weekday : null;
  const minute = typeof body.minute === "number" ? body.minute : null;
  const intervalMinutes =
    typeof body.intervalMinutes === "number" ? body.intervalMinutes : null;
  const cronExpression = cleanString(body.cronExpression, 200) || null;
  if ((kind === "daily" || kind === "weekly") && !validTime(time)) {
    throw new BadRequestException("A valid time is required");
  }
  if (
    kind === "weekly" &&
    (!Number.isInteger(weekday) || weekday! < 0 || weekday! > 6)
  ) {
    throw new BadRequestException("Weekday must be between 0 and 6");
  }
  if (kind === "once") {
    const date = runAt ? new Date(runAt) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      throw new BadRequestException("Run time must be a valid future date");
    }
  }
  if (
    kind === "hourly" &&
    (!Number.isInteger(minute) || minute! < 0 || minute! > 59)
  ) {
    throw new BadRequestException("Minute must be between 0 and 59");
  }
  if (
    kind === "interval" &&
    (!Number.isInteger(intervalMinutes) || intervalMinutes! < 5)
  ) {
    throw new BadRequestException(
      "Interval must be an integer of at least five minutes",
    );
  }
  if (kind === "cron") {
    if (!cronExpression || cronExpression.split(/\s+/).length !== 5) {
      throw new BadRequestException(
        "Cron expression must contain exactly five fields",
      );
    }
    assertCron(cronExpression, timezone);
  }
  return {
    name,
    prompt,
    kind,
    runAt,
    time,
    weekday,
    minute,
    intervalMinutes,
    cronExpression,
    timezone,
    enabled,
  };
}

const parseInput = parseTimerInput;

function encodeSchedule(input: TimerInput): string {
  if (input.kind === "once") return input.runAt as string;
  if (input.kind === "hourly") return String(input.minute);
  if (input.kind === "interval") return String(input.intervalMinutes);
  if (input.kind === "cron") return input.cronExpression as string;
  if (input.kind === "daily") return input.time as string;
  return JSON.stringify({ time: input.time, weekday: input.weekday });
}

function decodeSchedule(
  row: TimerRow,
): Pick<
  TimerInput,
  "runAt" | "time" | "weekday" | "minute" | "intervalMinutes" | "cronExpression"
> {
  const empty = {
    runAt: null,
    time: null,
    weekday: null,
    minute: null,
    intervalMinutes: null,
    cronExpression: null,
  };
  if (row.schedule_kind === "once") {
    return {
      ...empty,
      runAt: row.schedule_value,
    };
  }
  if (row.schedule_kind === "hourly") {
    return {
      ...empty,
      minute: Number(row.schedule_value),
    };
  }
  if (row.schedule_kind === "interval") {
    return { ...empty, intervalMinutes: Number(row.schedule_value) };
  }
  if (row.schedule_kind === "cron") {
    return { ...empty, cronExpression: row.schedule_value };
  }
  if (row.schedule_kind === "daily") {
    return {
      ...empty,
      time: row.schedule_value,
    };
  }
  try {
    const value = JSON.parse(row.schedule_value) as {
      time?: unknown;
      weekday?: unknown;
    };
    return {
      ...empty,
      time: typeof value.time === "string" ? value.time : null,
      weekday: typeof value.weekday === "number" ? value.weekday : null,
    };
  } catch {
    return empty;
  }
}

function nextRun(input: TimerInput, after: Date): Date | null {
  if (input.kind === "once") return new Date(input.runAt as string);
  if (input.kind === "hourly") {
    return cronHourlyNext(input.minute as number, input.timezone, after);
  }
  if (input.kind === "interval") {
    return new Date(after.getTime() + input.intervalMinutes! * 60_000);
  }
  if (input.kind === "cron") {
    return cronExpressionNext(
      input.cronExpression as string,
      input.timezone,
      after,
    );
  }
  return cronNext(
    input.kind,
    input.time as string,
    input.weekday,
    input.timezone,
    after,
  );
}

function nextAfter(row: TimerRow, after: Date): Date | null {
  if (row.schedule_kind === "once") return null;
  const decoded = decodeSchedule(row);
  if (row.schedule_kind === "hourly") {
    return cronHourlyNext(decoded.minute as number, row.timezone, after);
  }
  if (row.schedule_kind === "interval") {
    return new Date(after.getTime() + decoded.intervalMinutes! * 60_000);
  }
  if (row.schedule_kind === "cron") {
    return cronExpressionNext(
      decoded.cronExpression as string,
      row.timezone,
      after,
    );
  }
  if (!decoded.time) return null;
  return cronNext(
    row.schedule_kind,
    decoded.time,
    decoded.weekday,
    row.timezone,
    after,
  );
}

export function previewRuns(input: TimerInput, after: Date, count = 3): Date[] {
  const runs: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const run = nextRun(input, cursor);
    if (!run) break;
    runs.push(run);
    if (input.kind === "once") break;
    cursor = run;
  }
  return runs;
}

export function cronExpressionNext(
  expression: string,
  timezone: string,
  after: Date,
): Date | null {
  return new Cron(expression, { timezone, paused: true }).nextRun(after);
}

export function cronHourlyNext(
  minute: number,
  timezone: string,
  after: Date,
): Date | null {
  return new Cron(`${minute} * * * *`, { timezone, paused: true }).nextRun(
    after,
  );
}

function cronNext(
  kind: "daily" | "weekly",
  time: string,
  weekday: number | null,
  timezone: string,
  after: Date,
): Date | null {
  const [hour, minute] = time.split(":").map(Number);
  const pattern =
    kind === "daily"
      ? `${minute} ${hour} * * *`
      : `${minute} ${hour} * * ${weekday}`;
  return new Cron(pattern, { timezone, paused: true }).nextRun(after);
}

function validTime(value: string | null): value is string {
  return Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new BadRequestException("Timezone is not valid");
  }
}

function assertCron(expression: string, timezone: string): void {
  try {
    const cron = new Cron(expression, { timezone, paused: true });
    let previous = cron.nextRun(new Date());
    if (!previous) throw new Error("Cron has no future occurrence");
    for (let index = 0; index < 20; index += 1) {
      const next = cron.nextRun(new Date(previous.getTime() + 1));
      if (!next) break;
      if (next.getTime() - previous.getTime() < MINIMUM_FREQUENCY_MS) {
        throw new BadRequestException(
          "Cron schedules must run no more often than every five minutes",
        );
      }
      previous = next;
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException("Cron expression is not valid");
  }
}

function runtimeFrequencyIsValid(row: TimerRow, after: Date): boolean {
  if (row.schedule_kind === "interval") {
    return Number(row.schedule_value) >= 5;
  }
  if (row.schedule_kind !== "cron") return true;
  try {
    const first = cronExpressionNext(row.schedule_value, row.timezone, after);
    const second = first
      ? cronExpressionNext(
          row.schedule_value,
          row.timezone,
          new Date(first.getTime() + 1),
        )
      : null;
    return Boolean(
      first &&
        second &&
        second.getTime() - first.getTime() >= MINIMUM_FREQUENCY_MS,
    );
  } catch {
    return false;
  }
}
