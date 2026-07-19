import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { MissionEventBus } from "../missions/mission-event.bus.js";
import { MissionRepository } from "../missions/mission.repository.js";
import { WhatsAppService, splitWhatsAppText } from "./whatsapp.service.js";
import type {
  WhatsAppClient,
  WhatsAppClientFactory,
  WhatsAppMessage,
} from "./whatsapp.types.js";

class FakeClient extends EventEmitter implements WhatsAppClient {
  info = {
    wid: { _serialized: "46700000000@c.us", user: "46700000000" },
    pushname: "Test owner",
  };
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly sentFiles: Array<{ chatId: string; path: string }> = [];
  returnMessageModel = false;

  initialize(): void {}

  async getContactLidAndPhone() {
    return [{ lid: "123456789@lid", pn: "46700000000@c.us" }];
  }

  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return this.returnMessageModel
      ? { id: { _serialized: `out-${this.sent.length}` } }
      : undefined;
  }

  async sendFile(chatId: string, path: string) {
    this.sentFiles.push({ chatId, path });
    return { id: { _serialized: `file-${this.sentFiles.length}` } };
  }

  logout(): void {}

  destroy(): void {}

  emitMessage(message: WhatsAppMessage): void {
    this.emit("message_create", message);
  }

  emitInboundMessage(message: WhatsAppMessage): void {
    this.emit("message", message);
  }
}

test("linked-device QR routes self messages into the shared conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "orkestr-wa-test-"));
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
  const bus = new MissionEventBus();
  const repository = new MissionRepository(database, bus);
  const createdInputs: Array<{ prompt: string; source: string }> = [];
  const missions = {
    conversationStatus: () => ({ queueDepth: repository.pendingCount() }),
    create: (
      input: { prompt: string; source: "web" | "whatsapp" | "timer" | "demo" },
      timerId: string | null,
      options: { ingressKey?: string; enqueueSequence?: number },
    ) => {
      createdInputs.push(input);
      return repository.create(
        input,
        config.workspace,
        config.requestedModel,
        timerId,
        options,
      );
    },
    get: (id: string) => repository.require(id),
    events: (id: string) => repository.events(id),
    queuePosition: (id: string) => repository.queuePosition(id),
  };
  const client = new FakeClient();
  const factory: WhatsAppClientFactory = async () => client;
  const service = new WhatsAppService(
    database,
    missions as never,
    bus,
    config,
    factory,
  );

  try {
    service.onModuleInit();
    assert.equal((await service.start()).state, "starting");

    client.emit("qr", "test-qr-value");
    await settle();
    assert.equal(service.snapshot().state, "qr_needed");
    assert.match(service.qr() ?? "", /<svg/);

    client.emit("authenticated");
    client.emit("ready");
    await settle();
    assert.equal(service.snapshot().state, "ready");
    assert.equal(service.snapshot().accountLabel, "Test owner · +46700000000");
    assert.equal(service.snapshot().outboxDepth, 0);

    const validFile = join(config.workspace, "result.txt");
    writeFileSync(validFile, "result");
    await service.sendFileToSelf(validFile);
    await settle();
    assert.equal(client.sentFiles[0]?.path, validFile);
    const disallowedFile = join(home, "private.txt");
    writeFileSync(disallowedFile, "private");
    await assert.rejects(
      service.sendFileToSelf(disallowedFile),
      /Only workspace and Orkestr attachment files can be sent/,
    );

    const duplicatedMessage = {
      id: { _serialized: "in-1", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: "Summarize the workspace",
    };
    client.emitMessage(duplicatedMessage);
    client.emitInboundMessage(duplicatedMessage);
    await waitForBatch();
    assert.deepEqual(createdInputs, [
      { prompt: "Summarize the workspace", source: "whatsapp" },
    ]);
    assert.equal(
      client.sent[0]?.text,
      "Working · Your message is now with Codex",
    );
    assert.equal(client.sent[0]?.chatId, "123456789@lid");

    client.emitInboundMessage({
      id: { _serialized: "in-2", remote: "123456789@lid" },
      fromMe: false,
      from: "123456789@lid",
      to: "46700000000@c.us",
      body: "Check the tests",
    });
    await waitForBatch();
    assert.deepEqual(createdInputs.at(-1), {
      prompt: "Check the tests",
      source: "whatsapp",
    });

    client.emitInboundMessage({
      id: { _serialized: "external-1", remote: "49111111111@c.us" },
      fromMe: false,
      from: "49111111111@c.us",
      to: "46700000000@c.us",
      body: "This direct message must not become a mission",
      timestamp: 1_750_000_000,
      getChat: async () => ({
        id: "49111111111@c.us",
        isGroup: false,
        name: "Nur Ünver",
      }),
    });
    await settle();
    assert.equal(createdInputs.length, 2);
    assert.deepEqual(service.recentInbox(1)[0], {
      messageId: "external-1",
      chatId: "49111111111@c.us",
      senderId: "49111111111@c.us",
      senderName: "Nur Ünver",
      direction: "inbound",
      body: "This direct message must not become a mission",
      hasMedia: 0,
      messageAt: "2025-06-15T15:06:40.000Z",
    });
    const inboxPath = join(
      config.workspace,
      ".orkestr",
      "whatsapp",
      "inbox.json",
    );
    await waitForInboxSnapshot(inboxPath);
    const inboxSnapshot = JSON.parse(readFileSync(inboxPath, "utf8")) as {
      messages: Array<{ senderName: string; body: string }>;
    };
    assert.deepEqual(inboxSnapshot.messages[0], {
      messageId: "external-1",
      chatId: "49111111111@c.us",
      senderId: "49111111111@c.us",
      senderName: "Nur Ünver",
      direction: "inbound",
      body: "This direct message must not become a mission",
      hasMedia: false,
      messageAt: "2025-06-15T15:06:40.000Z",
    });

    client.emitMessage({
      id: { _serialized: "echo-1", remote: "46700000000@c.us" },
      fromMe: true,
      to: "46700000000@c.us",
      body: "Working · Your message is now with Codex",
    });
    await settle();
    assert.equal(
      createdInputs.length,
      2,
      "outbound echoes must not create turns",
    );
    assert.equal(
      (
        database.db
          .prepare(
            "SELECT status FROM whatsapp_outbox WHERE body = 'Working · Your message is now with Codex' ORDER BY created_at LIMIT 1",
          )
          .get() as { status: string }
      ).status,
      "acknowledged",
    );

    const firstMission = repository
      .list()
      .find((item) => item.source === "whatsapp")!;
    repository.update(firstMission.id, {
      status: "completed",
      finalResponse: "The workspace is healthy.",
      finishedAt: new Date().toISOString(),
    });
    repository.appendEvent(firstMission.id, "turn/completed", {});
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      "Orkestr · Completed\n\nThe workspace is healthy.",
    );

    const webMission = repository.create(
      { source: "web", prompt: "Hello" },
      config.workspace,
      config.requestedModel,
    );
    repository.update(webMission.id, {
      status: "completed",
      finalResponse: "Hello from Codex.",
      finishedAt: new Date().toISOString(),
    });
    repository.appendEvent(webMission.id, "turn/completed", {});
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      "Orkestr · Browser · Completed\n\nYou: Hello\n\nCodex: Hello from Codex.",
    );
  } finally {
    await service.onModuleDestroy();
    database.onModuleDestroy();
    rmSync(home, { recursive: true, force: true });
  }
});

test("long WhatsApp results are split below the message limit", () => {
  const chunks = splitWhatsAppText(`Result\n\n${"word ".repeat(2_000)}`, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(
    chunks.join(" ").replace(/\s+/g, " ").trim(),
    `Result ${"word ".repeat(2_000)}`.replace(/\s+/g, " ").trim(),
  );
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForBatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  await settle();
}

async function waitForInboxSnapshot(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) {
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as {
        messages?: unknown[];
      };
      if (snapshot.messages?.length) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("WhatsApp inbox snapshot was not written");
}
