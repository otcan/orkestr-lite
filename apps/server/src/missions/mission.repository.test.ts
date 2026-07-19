import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { migrations } from "../database/migrations.js";
import { MissionEventBus } from "./mission-event.bus.js";
import { MissionRepository } from "./mission.repository.js";

test("persists mission state and ordered replayable events in WAL mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-missions-"));
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port: 3000,
    home: directory,
    codexHome: join(directory, "codex"),
    workspace: join(directory, "workspace"),
    filesRoot: directory,
    databasePath: join(directory, "orkestr.sqlite"),
    requestedModel: "gpt-5.6",
    cookieSecure: false,
    allowedOrigins: [],
    codexCommand: "codex",
    codexVersion: "0.144.5",
    publicDir: join(directory, "public"),
  };
  const database = new DatabaseService(config);
  database.onModuleInit();
  const bus = new MissionEventBus();
  const repository = new MissionRepository(database, bus);
  const published: number[] = [];
  const unsubscribe = bus.subscribe((event) => published.push(event.id));

  try {
    assert.equal(database.db.pragma("journal_mode", { simple: true }), "wal");
    const mission = repository.create(
      {
        prompt: "Fix the first failing test",
        source: "web",
        reasoningEffort: "xhigh",
      },
      config.workspace,
      "gpt-5.6",
    );
    assert.equal(mission.status, "queued");
    assert.equal(mission.requestedReasoningEffort, "xhigh");
    repository.update(mission.id, {
      status: "running",
      codexThreadId: "thr_test",
    });
    repository.appendEvent(mission.id, "turn/started", { turnId: "turn_test" });
    const restored = repository.require(mission.id);
    assert.equal(restored.codexThreadId, "thr_test");
    assert.equal(restored.status, "running");
    const events = repository.events(mission.id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["mission.queued", "turn/started"],
    );
    assert.deepEqual(
      published,
      events.map((event) => event.id),
    );

    const idempotent = repository.create(
      { prompt: "Keep this exactly once", source: "web" },
      config.workspace,
      "gpt-5.6",
      null,
      { ingressKey: "browser-draft-1" },
    );
    const duplicate = repository.create(
      { prompt: "Keep this exactly once", source: "web" },
      config.workspace,
      "gpt-5.6",
      null,
      { ingressKey: "browser-draft-1" },
    );
    assert.equal(duplicate.id, idempotent.id);
    const newestPage = repository.page(1);
    assert.equal(newestPage.length, 1);
    assert.equal(newestPage[0]?.id, idempotent.id);
    const olderPage = repository.page(10, idempotent.enqueueSequence ?? 0);
    assert.ok(olderPage.some((item) => item.id === mission.id));
  } finally {
    unsubscribe();
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("upgrades an existing conversation without losing older turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-migration-"));
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port: 3000,
    home: directory,
    codexHome: join(directory, "codex"),
    workspace: join(directory, "workspace"),
    filesRoot: directory,
    databasePath: join(directory, "orkestr.sqlite"),
    requestedModel: "gpt-5.6",
    cookieSecure: false,
    allowedOrigins: [],
    codexCommand: "codex",
    codexVersion: "0.144.5",
    publicDir: join(directory, "public"),
  };
  const legacy = new Database(config.databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of migrations.filter((item) => item.version <= 2)) {
    legacy.exec(migration.sql);
    legacy
      .prepare(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(migration.version, migration.name, new Date().toISOString());
  }
  legacy
    .prepare(
      `INSERT INTO missions(id, title, prompt, source, workspace, status, created_at)
       VALUES ('legacy-turn', 'Legacy', 'Keep me', 'web', ?, 'completed', ?)`,
    )
    .run(config.workspace, new Date().toISOString());
  legacy.close();

  const database = new DatabaseService(config);
  database.onModuleInit();
  try {
    const row = database.db
      .prepare(
        `SELECT enqueue_sequence, ingress_key, requested_reasoning_effort
         FROM missions WHERE id = 'legacy-turn'`,
      )
      .get() as {
      enqueue_sequence: number;
      ingress_key: string | null;
      requested_reasoning_effort: string | null;
    };
    assert.ok(Number.isInteger(row.enqueue_sequence));
    assert.equal(row.ingress_key, null);
    assert.equal(row.requested_reasoning_effort, null);
    const repository = new MissionRepository(database, new MissionEventBus());
    assert.equal(repository.require("legacy-turn").prompt, "Keep me");
  } finally {
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  }
});
