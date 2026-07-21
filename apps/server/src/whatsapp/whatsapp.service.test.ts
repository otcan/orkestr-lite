import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import {
  acknowledgementRetryDelay,
  parseWhatsAppCommand,
  WhatsAppService,
  splitWhatsAppText,
} from "./whatsapp.service.js";
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
  returnFileMessageModel = true;
  echoFileDuringSend = false;

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
    const id = `file-${this.sentFiles.length}`;
    if (this.echoFileDuringSend) {
      this.emit("message_create", {
        id: { _serialized: id, remote: "123456789@lid" },
        fromMe: true,
        to: "123456789@lid",
        type: "document",
        deviceType: "web",
        hasMedia: true,
      } satisfies WhatsAppMessage);
    }
    return this.returnFileMessageModel
      ? { id: { _serialized: id } }
      : undefined;
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

test("missing acknowledgements back off from two to five minutes", () => {
  assert.equal(acknowledgementRetryDelay(1), 120_000);
  assert.equal(acknowledgementRetryDelay(2), 240_000);
  assert.equal(acknowledgementRetryDelay(3), 300_000);
  assert.equal(acknowledgementRetryDelay(20), 300_000);
});

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
      const mission = repository.create(
        input,
        config.workspace,
        config.requestedModel,
        timerId,
        options,
      );
      ensureControlCode(mission.id);
      return mission;
    },
    list: () => repository.list(),
    get: (id: string) => repository.require(id),
    events: (id: string) => repository.events(id),
    queuePosition: (id: string) => repository.queuePosition(id),
    controlCode: (id: string) => ensureControlCode(id),
    findByControlCode: (code: string) => {
      const row = database.db
        .prepare(
          "SELECT turn_id FROM turn_control_codes WHERE code = ? COLLATE NOCASE",
        )
        .get(code) as { turn_id: string } | undefined;
      return row ? repository.require(row.turn_id) : null;
    },
    appendAuditEvent: (id: string, kind: string, payload: unknown) =>
      repository.appendEvent(id, kind, payload),
    interrupt: async (id: string) => {
      const mission = repository.require(id);
      if (
        !["queued", "starting", "running", "awaiting_approval"].includes(
          mission.status,
        )
      ) {
        throw new Error("Only active or queued work can be stopped");
      }
      const status = mission.status === "queued" ? "cancelled" : "interrupted";
      return repository.update(id, {
        status,
        finishedAt: new Date().toISOString(),
      });
    },
    latestPendingApproval: (id: string) => {
      const mission = repository.require(id);
      if (mission.status !== "awaiting_approval") return null;
      const events = repository.events(id);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (event.kind === "approval.resolved") return null;
        if (event.kind !== "approval.required") continue;
        const requestId = (event.payload as { requestId?: unknown }).requestId;
        return typeof requestId === "string" || typeof requestId === "number"
          ? { requestId }
          : null;
      }
      return null;
    },
    approve: (
      id: string,
      input: { requestId: string | number; decision: string },
    ) => {
      const mission = repository.require(id);
      if (mission.status !== "awaiting_approval") {
        throw new Error("Mission is not awaiting approval");
      }
      repository.appendEvent(id, "approval.resolved", input);
      return repository.update(id, { status: "running" });
    },
  };
  function ensureControlCode(id: string): string {
    const existing = database.db
      .prepare("SELECT code FROM turn_control_codes WHERE turn_id = ?")
      .get(id) as { code: string } | undefined;
    if (existing) return existing.code;
    const count = (
      database.db
        .prepare("SELECT COUNT(*) AS count FROM turn_control_codes")
        .get() as { count: number }
    ).count;
    const code = `TEST${String(count + 1).padStart(4, "0")}`;
    database.db
      .prepare(
        "INSERT INTO turn_control_codes(turn_id, code, created_at) VALUES (?, ?, ?)",
      )
      .run(id, code, new Date().toISOString());
    return code;
  }
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
    assert.equal(client.sentFiles[0]?.path, realpathSync(validFile));
    assert.equal(client.sentFiles[0]?.chatId, "46700000000@c.us");
    client.emit("message_ack", { id: { _serialized: "file-1" } }, 1);
    await settle();
    assert.equal(service.outbox().length, 0);
    assert.equal(
      (service.outbox(100, true)[0] as { status: string }).status,
      "acknowledged",
    );
    const inputCountBeforeMediaEcho = createdInputs.length;
    client.returnFileMessageModel = false;
    client.echoFileDuringSend = true;
    await service.sendFileToSelf(validFile);
    await settle();
    assert.equal(createdInputs.length, inputCountBeforeMediaEcho);
    assert.equal(
      service
        .outbox()
        .filter((item) => (item as { kind: string }).kind === "media").length,
      0,
      "the outgoing media callback should acknowledge the outbox row",
    );
    assert.equal(
      client.sent.some(({ text }) =>
        text.startsWith("Could not send the message"),
      ),
      false,
      "the app must not try to download its own outgoing document",
    );
    client.echoFileDuringSend = false;
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
      "Working · TEST0001 · Your message is now with Codex\nReply status TEST0001 or stop TEST0001.",
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

    client.emitMessage({
      id: { _serialized: "control-status", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: "StAtUs test0001",
    });
    await settle();
    assert.equal(createdInputs.length, 2, "commands must bypass batching");
    assert.match(client.sent.at(-1)?.text || "", /^TEST0001 · Queued/);

    client.emitMessage({
      id: { _serialized: "control-stop", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: "stop TEST0001",
    });
    client.emitInboundMessage({
      id: { _serialized: "control-stop", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: "stop TEST0001",
    });
    await settle();
    assert.equal(client.sent.at(-1)?.text, "TEST0001 · Cancelled");
    assert.equal(
      repository
        .events(
          repository
            .list()
            .find(
              (item) => item.id && ensureControlCode(item.id) === "TEST0001",
            )!.id,
        )
        .filter((event) => event.kind === "whatsapp.control").length,
      2,
      "status and stop are audited once despite duplicate callbacks",
    );

    client.emitMessage({
      id: { _serialized: "control-terminal", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: "stop TEST0001",
    });
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      "TEST0001 · Only active or queued work can be stopped",
    );

    client.emitMessage({
      id: { _serialized: "control-unknown", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: "status DEADCODE",
    });
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      "Unknown control code DEADCODE. Send help for command syntax.",
    );

    const approvalMission = repository.create(
      { source: "web", prompt: "Request an approval" },
      config.workspace,
      config.requestedModel,
    );
    const approvalCode = ensureControlCode(approvalMission.id);
    repository.update(approvalMission.id, { status: "awaiting_approval" });
    repository.appendEvent(approvalMission.id, "approval.required", {
      requestId: "approval-1",
    });
    await settle();
    client.emitMessage({
      id: { _serialized: "control-approve", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: `approve ${approvalCode}`,
    });
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      `${approvalCode} · Approval accepted. Working.`,
    );
    assert.equal(repository.require(approvalMission.id).status, "running");

    client.emitMessage({
      id: {
        _serialized: "control-already-resolved",
        remote: "123456789@lid",
      },
      fromMe: true,
      to: "123456789@lid",
      body: `approve ${approvalCode}`,
    });
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      `${approvalCode} · ${approvalCode} has no pending approval request`,
    );

    const declineMission = repository.create(
      { source: "web", prompt: "Decline an approval" },
      config.workspace,
      config.requestedModel,
    );
    const declineCode = ensureControlCode(declineMission.id);
    repository.update(declineMission.id, { status: "awaiting_approval" });
    repository.appendEvent(declineMission.id, "approval.required", {
      requestId: "approval-2",
    });
    await settle();
    client.emitMessage({
      id: { _serialized: "control-decline", remote: "123456789@lid" },
      fromMe: true,
      to: "123456789@lid",
      body: `decline ${declineCode}`,
    });
    await settle();
    assert.equal(
      client.sent.at(-1)?.text,
      `${declineCode} · Approval declined. Working.`,
    );

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
      body: client.sent[0]?.text,
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
            "SELECT status FROM whatsapp_outbox WHERE body LIKE 'Working · TEST0001%' ORDER BY created_at LIMIT 1",
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

test("WhatsApp controls require exact whole-message commands", () => {
  assert.deepEqual(parseWhatsAppCommand(" status "), {
    action: "status",
    code: null,
  });
  assert.deepEqual(parseWhatsAppCommand("ApPrOvE abcd1234"), {
    action: "approve",
    code: "ABCD1234",
  });
  assert.deepEqual(parseWhatsAppCommand("HELP"), { action: "help" });
  assert.equal(parseWhatsAppCommand("please stop ABCD1234"), null);
  assert.equal(parseWhatsAppCommand("status ABC"), null);
  assert.equal(parseWhatsAppCommand("help me with this"), null);
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
