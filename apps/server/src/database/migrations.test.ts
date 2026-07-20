import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

test("v5 timer history migrates losslessly and accepts skipped runs", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    for (const migration of migrations.filter((item) => item.version <= 5)) {
      database.exec(migration.sql);
    }
    const now = "2026-07-19T12:00:00.000Z";
    database
      .prepare(
        `INSERT INTO timers(
          id, name, prompt, schedule_kind, schedule_value, timezone,
          enabled, created_at, updated_at
        ) VALUES ('timer-1', 'Existing', 'Inspect', 'daily', '09:00', 'UTC', 1, ?, ?)`,
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO timer_runs(
          id, timer_id, scheduled_for, status, error, created_at, completed_at
        ) VALUES ('run-1', 'timer-1', ?, 'missed', 'downtime', ?, ?)`,
      )
      .run(now, now, now);

    database.exec(migrations.find((item) => item.version === 6)!.sql);

    assert.deepEqual(
      database
        .prepare(
          "SELECT id, timer_id, status, error FROM timer_runs ORDER BY id",
        )
        .all(),
      [
        {
          id: "run-1",
          timer_id: "timer-1",
          status: "missed",
          error: "downtime",
        },
      ],
    );
    database
      .prepare(
        `INSERT INTO timer_runs(
          id, timer_id, scheduled_for, status, error, created_at, completed_at
        ) VALUES ('run-2', 'timer-1', '2026-07-20T12:00:00.000Z',
                  'skipped', 'overlap', ?, ?)`,
      )
      .run(now, now);
    assert.equal(
      (
        database
          .prepare("SELECT status FROM timer_runs WHERE id = 'run-2'")
          .get() as { status: string }
      ).status,
      "skipped",
    );
  } finally {
    database.close();
  }
});
