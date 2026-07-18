import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
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
      { prompt: "Fix the first failing test", source: "web" },
      config.workspace,
      "gpt-5.6",
    );
    assert.equal(mission.status, "queued");
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
  } finally {
    unsubscribe();
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  }
});
