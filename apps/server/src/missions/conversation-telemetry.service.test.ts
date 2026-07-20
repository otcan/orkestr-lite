import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { ConversationTelemetryService } from "./conversation-telemetry.service.js";

test("uses last-turn context tokens and deduplicates compaction aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orkestr-context-"));
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
    const telemetry = new ConversationTelemetryService(database);
    telemetry.updateContext({
      tokenUsage: {
        total: { totalTokens: 999 },
        last: { totalTokens: 80 },
        modelContextWindow: 100,
      },
    });
    assert.deepEqual(telemetry.context(), {
      usedTokens: 80,
      contextWindow: 100,
      percent: 80,
      compactionCount: 0,
      updatedAt: telemetry.context().updatedAt,
      lastCompactedAt: null,
      lastClearedAt: null,
      visibleHistoryCleared: false,
    });

    telemetry.noteCompaction({ type: "contextCompaction" });
    telemetry.noteCompaction({ deprecated: "thread/compacted" });
    assert.equal(telemetry.context().compactionCount, 1);
    assert.equal(
      telemetry.list().at(-1)?.kind,
      "conversation.context_compacted",
    );

    const clearedAt = new Date().toISOString();
    telemetry.resetContext(clearedAt);
    assert.deepEqual(telemetry.context(), {
      usedTokens: null,
      contextWindow: null,
      percent: null,
      compactionCount: 0,
      updatedAt: clearedAt,
      lastCompactedAt: null,
      lastClearedAt: clearedAt,
      visibleHistoryCleared: false,
    });

    telemetry.resetContext(clearedAt, true);
    assert.equal(telemetry.context().visibleHistoryCleared, true);
  } finally {
    database.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  }
});
