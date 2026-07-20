import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { CodexService } from "../codex/codex.service.js";
import { DatabaseService } from "../database/database.service.js";
import { AttachmentsService } from "./attachments.service.js";
import { ConversationTelemetryService } from "./conversation-telemetry.service.js";
import { MissionEventBus } from "./mission-event.bus.js";
import { MissionRepository } from "./mission.repository.js";
import { MissionsService } from "./missions.service.js";

test("clears Codex context only after the replacement is ready", async () => {
  await withService(async ({ database, repository, service, telemetry }) => {
    const startedAt = new Date(0).toISOString();
    database.setSetting("active_codex_thread_id", "thread_previous");
    database.setSetting("conversation_started_at", startedAt);
    database.setSetting("setup_completed", "true");
    telemetry.updateContext({
      tokenUsage: {
        last: { totalTokens: 80 },
        modelContextWindow: 100,
      },
    });
    telemetry.noteCompaction({ type: "contextCompaction" });
    const existing = repository.create(
      { prompt: "Keep this visible", source: "web" },
      "/workspace",
      "gpt-5.6",
    );
    repository.update(existing.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const status = await service.clearContext();

    assert.equal(database.getSetting("active_codex_thread_id"), "thread_new");
    assert.equal(database.getSetting("conversation_started_at"), startedAt);
    assert.deepEqual(
      JSON.parse(database.getSetting("archived_codex_thread_ids") || "[]"),
      ["thread_previous"],
    );
    assert.equal(service.turnPage().at(0)?.id, existing.id);
    assert.equal(status.context.usedTokens, null);
    assert.equal(status.context.compactionCount, 0);
    assert.ok(status.context.lastClearedAt);
    assert.equal(status.context.visibleHistoryCleared, false);
    assert.equal(telemetry.list().at(-1)?.kind, "conversation.context_cleared");
  });
});

test("can clear visible chat history while preserving durable turns", async () => {
  await withService(async ({ database, repository, service }) => {
    database.setSetting("active_codex_thread_id", "thread_previous");
    database.setSetting("conversation_started_at", new Date(0).toISOString());
    const existing = repository.create(
      { prompt: "Hide this from the fresh UI", source: "web" },
      "/workspace",
      "gpt-5.6",
    );
    repository.update(existing.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const status = await service.clearContext({ clearVisibleHistory: true });

    assert.equal(service.turnPage().length, 0);
    assert.equal(repository.find(existing.id)?.id, existing.id);
    assert.equal(status.context.visibleHistoryCleared, true);
    assert.equal(
      database.getSetting("conversation_started_at"),
      status.context.lastClearedAt,
    );
    assert.equal(
      database.getSetting("conversation_started_after_sequence"),
      String(existing.enqueueSequence),
    );
  });
});

test("keeps the previous context when replacement creation fails", async () => {
  await withService(async ({ database, service, telemetry }) => {
    database.setSetting("active_codex_thread_id", "thread_previous");
    telemetry.updateContext({
      tokenUsage: {
        last: { totalTokens: 40 },
        modelContextWindow: 100,
      },
    });

    await assert.rejects(service.clearContext(), /replacement failed/);

    assert.equal(
      database.getSetting("active_codex_thread_id"),
      "thread_previous",
    );
    assert.equal(telemetry.context().usedTokens, 40);
    assert.equal(telemetry.context().lastClearedAt, null);
  }, true);
});

test("rejects context clearing while work is queued", async () => {
  await withService(async ({ database, repository, service, startCalls }) => {
    database.setSetting("active_codex_thread_id", "thread_previous");
    repository.create(
      { prompt: "Queued work", source: "web" },
      "/workspace",
      "gpt-5.6",
    );

    await assert.rejects(service.clearContext(), /Wait for active, queued/);
    assert.equal(startCalls.count, 0);
    assert.equal(
      database.getSetting("active_codex_thread_id"),
      "thread_previous",
    );
  });
});

async function withService(
  run: (fixture: {
    database: DatabaseService;
    repository: MissionRepository;
    service: MissionsService;
    telemetry: ConversationTelemetryService;
    startCalls: { count: number };
  }) => Promise<void>,
  failStart = false,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-clear-context-"));
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
  try {
    const bus = new MissionEventBus();
    const repository = new MissionRepository(database, bus);
    const telemetry = new ConversationTelemetryService(database);
    const attachments = new AttachmentsService(database, config);
    const startCalls = { count: 0 };
    const codex = {
      snapshot: () => ({
        process: "ready",
        authenticated: true,
        modelReady: true,
      }),
      selectedModel: () => "gpt-5.6",
      startThread: async () => {
        startCalls.count += 1;
        if (failStart) throw new Error("replacement failed");
        return { thread: { id: "thread_new", model: "gpt-5.6" } };
      },
    } as unknown as CodexService;
    const service = new MissionsService(
      repository,
      bus,
      codex,
      database,
      telemetry,
      attachments,
      config,
    );
    await run({ database, repository, service, telemetry, startCalls });
  } finally {
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  }
}
