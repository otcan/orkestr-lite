import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import {
  cronExpressionNext,
  cronHourlyNext,
  parseTimerInput,
  previewRuns,
  TimersService,
} from "./timers.service.js";

test("hourly schedules run at the selected minute every hour", () => {
  const next = cronHourlyNext(25, "UTC", new Date("2026-07-19T12:17:00.000Z"));
  assert.equal(next?.toISOString(), "2026-07-19T12:25:00.000Z");

  const following = cronHourlyNext(
    25,
    "UTC",
    new Date("2026-07-19T12:25:01.000Z"),
  );
  assert.equal(following?.toISOString(), "2026-07-19T13:25:00.000Z");
});

test("interval and cron schedules enforce the five-minute floor", () => {
  assert.throws(
    () =>
      parseTimerInput({
        name: "Too fast",
        prompt: "Run",
        kind: "interval",
        intervalMinutes: 4,
        timezone: "UTC",
      }),
    /at least five minutes/,
  );
  assert.throws(
    () =>
      parseTimerInput({
        name: "Too fast",
        prompt: "Run",
        kind: "cron",
        cronExpression: "* * * * *",
        timezone: "UTC",
      }),
    /no more often than every five minutes/,
  );
  const input = parseTimerInput({
    name: "Watch",
    prompt: "Inspect",
    kind: "interval",
    intervalMinutes: 5,
    timezone: "UTC",
  });
  assert.deepEqual(
    previewRuns(input, new Date("2026-07-19T12:00:00.000Z"), 3).map((run) =>
      run.toISOString(),
    ),
    [
      "2026-07-19T12:05:00.000Z",
      "2026-07-19T12:10:00.000Z",
      "2026-07-19T12:15:00.000Z",
    ],
  );
});

test("five-field cron schedules honor timezone and DST transitions", () => {
  const spring = cronExpressionNext(
    "30 2 * * *",
    "Europe/Stockholm",
    new Date("2026-03-28T02:00:00.000Z"),
  );
  assert.equal(spring?.toISOString(), "2026-03-29T01:30:00.000Z");

  const autumn = cronExpressionNext(
    "30 2 * * *",
    "Europe/Stockholm",
    new Date("2026-10-24T02:00:00.000Z"),
  );
  assert.equal(autumn?.toISOString(), "2026-10-25T00:30:00.000Z");
});

test("cron input accepts exactly five fields", () => {
  assert.throws(
    () =>
      parseTimerInput({
        name: "Invalid",
        prompt: "Run",
        kind: "cron",
        cronExpression: "0 */2 * * * *",
        timezone: "UTC",
      }),
    /exactly five fields/,
  );
});

test("overlaps are skipped, Run now conflicts, and downtime is not backfilled", async () => {
  const home = mkdtempSync(join(tmpdir(), "orkestr-timers-test-"));
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port: 3000,
    home,
    codexHome: join(home, "codex"),
    workspace: join(home, "workspace"),
    filesRoot: home,
    databasePath: join(home, "orkestr.sqlite"),
    requestedModel: "gpt-5.6",
    cookieSecure: false,
    allowedOrigins: [],
    codexCommand: "codex",
    codexVersion: "0.144.5",
    publicDir: join(home, "public"),
  };
  const database = new DatabaseService(config);
  database.onModuleInit();
  let sequence = 0;
  const turns = {
    create: (
      input: { title: string; prompt: string; source: "timer" },
      timerId: string,
    ) => {
      const id = randomUUID();
      database.db
        .prepare(
          `INSERT INTO missions(
             id, title, prompt, source, workspace, status, created_at,
             timer_id, enqueue_sequence
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.prompt,
          input.source,
          config.workspace,
          new Date().toISOString(),
          timerId,
          ++sequence,
        );
      return { id };
    },
  };
  const service = new TimersService(database, turns as never);
  try {
    const overlapping = service.create({
      name: "Overlap",
      prompt: "Inspect",
      kind: "interval",
      intervalMinutes: 5,
      timezone: "UTC",
    });
    service.runNow(overlapping.id);
    assert.throws(() => service.runNow(overlapping.id), /pending work/);
    const overlapAt = new Date(Date.now() - 10_000).toISOString();
    database.db
      .prepare("UPDATE timers SET next_run_at = ? WHERE id = ?")
      .run(overlapAt, overlapping.id);

    const missed = service.create({
      name: "Missed",
      prompt: "Inspect",
      kind: "interval",
      intervalMinutes: 5,
      timezone: "UTC",
    });
    const missedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    database.db
      .prepare("UPDATE timers SET next_run_at = ? WHERE id = ?")
      .run(missedAt, missed.id);

    await (service as unknown as { tick(): Promise<void> }).tick();
    assert.deepEqual(
      database.db
        .prepare(
          "SELECT status, error FROM timer_runs WHERE timer_id = ? AND scheduled_for = ?",
        )
        .get(overlapping.id, overlapAt),
      { status: "skipped", error: "overlap" },
    );
    assert.deepEqual(
      database.db
        .prepare(
          "SELECT status, error FROM timer_runs WHERE timer_id = ? AND scheduled_for = ?",
        )
        .get(missed.id, missedAt),
      { status: "missed", error: null },
    );
    assert.ok(
      Date.parse(
        service.list().find((timer) => timer.id === missed.id)!.nextRunAt!,
      ) > Date.now(),
    );
    assert.equal(
      (
        database.db
          .prepare("SELECT COUNT(*) AS count FROM missions WHERE timer_id = ?")
          .get(missed.id) as { count: number }
      ).count,
      0,
    );
  } finally {
    database.onModuleDestroy();
    rmSync(home, { recursive: true, force: true });
  }
});
