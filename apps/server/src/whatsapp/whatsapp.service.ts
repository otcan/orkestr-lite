import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type { MissionEventRecord, MissionRecord } from "@orkestr/shared";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  realpath,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import QRCode from "qrcode";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { MissionEventBus } from "../missions/mission-event.bus.js";
import { MissionsService } from "../missions/missions.service.js";
import type {
  WhatsAppChat,
  WhatsAppClient,
  WhatsAppClientFactory,
  WhatsAppMessage,
  WhatsAppMessageView,
  WhatsAppSnapshot,
  WhatsAppState,
} from "./whatsapp.types.js";
import { WHATSAPP_CLIENT_FACTORY } from "./whatsapp.types.js";

const ENABLED_KEY = "whatsapp.enabled";
const SELF_CHAT_KEY = "whatsapp.self_chat_id";
const CLIENT_ID = "orkestr-lite";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_MESSAGES = 20;
const MAX_BATCH_ATTACHMENTS = 5;
const MAX_PENDING_TURNS = 250;
const BATCH_WINDOW_MS = 5_000;
const ACK_TIMEOUT_MS = 120_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const INBOX_CHAT_LIMIT = 100;
const INBOX_MESSAGES_PER_CHAT = 25;
const INBOX_RETENTION_COUNT = 1_000;
const INBOX_BODY_LIMIT = 8_000;
const TERMINAL_EVENTS = new Set([
  "turn/completed",
  "mission.failed",
  "mission.interrupted",
  "mission.cancelled",
]);

interface OutboxRow {
  id: string;
  turn_id: string | null;
  attachment_id: string | null;
  ordinal: number;
  kind: "text" | "media";
  body: string | null;
  attempt_count: number;
}

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly dataPath: string;
  private client: WhatsAppClient | null = null;
  private startPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: WhatsAppState = "idle";
  private authenticated = false;
  private qrSvg: string | null = null;
  private qrUpdatedAt: string | null = null;
  private qrVersion: string | null = null;
  private selfChatId: string | null = null;
  private selfChatMediaId: string | null = null;
  private selfChatAliases = new Set<string>();
  private accountLabel: string | null = null;
  private accountName: string | null = null;
  private accountNumber: string | null = null;
  private error: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private retryAt: string | null = null;
  private lastConnectedAt: string | null = null;
  private lastMessageAt: string | null = null;
  private readonly recentOutboundTexts = new Map<string, number[]>();
  private outboxFlushing = false;
  private readonly statusListeners = new Set<
    (status: WhatsAppSnapshot) => void
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly missions: MissionsService,
    private readonly bus: MissionEventBus,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(WHATSAPP_CLIENT_FACTORY)
    private readonly clientFactory: WhatsAppClientFactory,
  ) {
    this.dataPath = resolve(config.home, "whatsapp");
  }

  onModuleInit(): void {
    this.selfChatId = this.database.getSetting(SELF_CHAT_KEY);
    if (this.selfChatId) this.selfChatAliases.add(this.selfChatId);
    this.unsubscribe = this.bus.subscribe((event) =>
      this.onMissionEvent(event),
    );
    this.recoverOutbox();
    this.scheduleBatchFlush();
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 5_000);
    queueMicrotask(() => void this.cleanupExpiredAttachments());
    queueMicrotask(() => void this.writeInboxSnapshot());
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpiredAttachments(),
      24 * 60 * 60 * 1_000,
    );
    if (this.enabled()) queueMicrotask(() => void this.startSafely());
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    const client = this.client;
    this.client = null;
    if (client) await Promise.resolve(client.destroy()).catch(() => undefined);
  }

  snapshot(): WhatsAppSnapshot {
    return {
      state: this.state,
      enabled: this.enabled(),
      authenticated: this.authenticated,
      ready: this.state === "ready",
      qrAvailable: this.qrSvg !== null,
      qrUpdatedAt: this.qrUpdatedAt,
      qrVersion: this.qrVersion,
      accountLabel: this.accountLabel,
      accountName: this.accountName,
      accountNumber: this.accountNumber,
      error: this.error,
      retryAt: this.retryAt,
      retryAttempt: this.retryAttempt,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      queueDepth: this.missions.conversationStatus().queueDepth,
      outboxDepth: this.outboxDepth(),
    };
  }

  subscribe(listener: (status: WhatsAppSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.snapshot());
    return () => this.statusListeners.delete(listener);
  }

  recentMessages(limit = 50): WhatsAppMessageView[] {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.database.db
      .prepare(
        `SELECT message_id, direction, turn_id, source, body_preview, status, created_at
         FROM whatsapp_messages ORDER BY created_at DESC LIMIT ?`,
      )
      .all(safeLimit) as Array<{
      message_id: string;
      direction: "inbound" | "outbound";
      turn_id: string | null;
      source: string | null;
      body_preview: string;
      status: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      direction: row.direction,
      turnId: row.turn_id,
      source: row.source,
      bodyPreview: row.body_preview,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  recentInbox(limit = 100) {
    const safeLimit = Math.max(1, Math.min(INBOX_RETENTION_COUNT, limit));
    return this.database.db
      .prepare(
        `SELECT message_id AS messageId, chat_id AS chatId,
                sender_id AS senderId, sender_name AS senderName,
                direction, body, has_media AS hasMedia,
                message_at AS messageAt
         FROM whatsapp_inbox_messages
         ORDER BY message_at DESC LIMIT ?`,
      )
      .all(safeLimit) as Array<{
      messageId: string;
      chatId: string;
      senderId: string | null;
      senderName: string;
      direction: "inbound" | "outbound";
      body: string;
      hasMedia: 0 | 1;
      messageAt: string;
    }>;
  }

  qr(): string | null {
    return this.qrSvg;
  }

  async start(): Promise<WhatsAppSnapshot> {
    this.database.setSetting(ENABLED_KEY, "true");
    this.publishStatus();
    if (this.client && !["disconnected", "error"].includes(this.state)) {
      return this.snapshot();
    }
    if (!this.startPromise) {
      this.startPromise = this.initializeClient().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
    return this.snapshot();
  }

  async logout(): Promise<WhatsAppSnapshot> {
    this.database.setSetting(ENABLED_KEY, "false");
    const client = this.client;
    this.client = null;
    if (client) {
      await Promise.resolve(client.logout()).catch((error) =>
        this.logger.warn(`WhatsApp logout warning: ${errorMessage(error)}`),
      );
      await Promise.resolve(client.destroy()).catch(() => undefined);
    }
    const sessionPath = join(this.dataPath, `session-${CLIENT_ID}`);
    await rm(sessionPath, { recursive: true, force: true });
    this.database.setSetting(SELF_CHAT_KEY, "");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
    this.retryAttempt = 0;
    this.selfChatId = null;
    this.selfChatMediaId = null;
    this.selfChatAliases.clear();
    this.accountLabel = null;
    this.accountName = null;
    this.accountNumber = null;
    this.authenticated = false;
    this.qrSvg = null;
    this.qrUpdatedAt = null;
    this.qrVersion = null;
    this.error = null;
    this.state = "idle";
    this.publishStatus();
    return this.snapshot();
  }

  async sendTest(): Promise<WhatsAppSnapshot> {
    this.enqueueText(
      `Orkestr Lite is connected to ${this.accountName || "this account"}${this.accountNumber ? ` (${this.accountNumber})` : ""}.`,
      null,
      "system",
    );
    void this.flushOutbox();
    return this.snapshot();
  }

  private enabled(): boolean {
    return this.database.getSetting(ENABLED_KEY) === "true";
  }

  private async startSafely(): Promise<void> {
    try {
      await this.start();
    } catch (error) {
      this.logger.error(`WhatsApp startup failed: ${errorMessage(error)}`);
      this.scheduleReconnect();
    }
  }

  private async initializeClient(): Promise<void> {
    const previousClient = this.client;
    this.client = null;
    if (previousClient) {
      await Promise.resolve(previousClient.destroy()).catch(() => undefined);
    }
    this.state = "starting";
    this.error = null;
    this.qrSvg = null;
    this.qrVersion = null;
    this.publishStatus();
    await mkdir(this.dataPath, { recursive: true, mode: 0o700 });
    await chmod(this.dataPath, 0o700);
    await this.clearStaleBrowserLocks();
    try {
      const executablePath =
        process.env.WA_CHROME_PATH ||
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        undefined;
      const client = await this.clientFactory({
        dataPath: this.dataPath,
        clientId: CLIENT_ID,
        executablePath,
      });
      this.client = client;
      this.attachClientEvents(client);
      void Promise.resolve(client.initialize()).catch((error) => {
        this.fail(error);
        this.scheduleReconnect();
      });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private attachClientEvents(client: WhatsAppClient): void {
    client.on("qr", (value: unknown) => void this.onQr(String(value || "")));
    client.on("authenticated", () => {
      this.authenticated = true;
      this.state = "authenticated";
      this.error = null;
      this.publishStatus();
    });
    client.on("ready", () => void this.onReady(client));
    client.on("auth_failure", (message: unknown) => {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.fail(message);
      this.retryAt = null;
      this.publishStatus();
    });
    client.on("disconnected", (reason: unknown) => {
      if (this.client === client) this.client = null;
      this.authenticated = false;
      this.state = "disconnected";
      this.error = String(reason || "WhatsApp disconnected");
      this.publishStatus();
      this.scheduleReconnect();
    });
    client.on("message", (message: WhatsAppMessage) => {
      void this.onMessage(message).catch((error) =>
        this.logger.error(`WhatsApp message failed: ${errorMessage(error)}`),
      );
    });
    client.on("message_create", (message: WhatsAppMessage) => {
      void this.onMessage(message).catch((error) =>
        this.logger.error(`WhatsApp message failed: ${errorMessage(error)}`),
      );
    });
    client.on("message_ack", (message: WhatsAppMessage, ack: unknown) => {
      this.onMessageAck(message, Number(ack));
    });
  }

  private async onQr(value: string): Promise<void> {
    if (!value) return;
    const version = createHash("sha256")
      .update(value)
      .digest("base64url")
      .slice(0, 16);
    if (version === this.qrVersion && this.qrSvg) return;
    try {
      this.qrSvg = await QRCode.toString(value, {
        type: "svg",
        margin: 1,
        width: 320,
      });
      this.qrUpdatedAt = new Date().toISOString();
      this.qrVersion = version;
      this.state = "qr_needed";
      this.error = null;
      this.publishStatus();
    } catch (error) {
      this.fail(error);
    }
  }

  private async onReady(client: WhatsAppClient): Promise<void> {
    const accountId = serializedId(client.info?.wid);
    if (!accountId) {
      this.fail("WhatsApp connected without an account identity");
      return;
    }
    const identities = await resolveSelfChatIdentities(client, accountId);
    this.selfChatAliases = new Set(identities.aliases);
    this.selfChatId = identities.destination;
    this.selfChatMediaId = identities.phoneId;
    this.database.setSetting(SELF_CHAT_KEY, identities.destination);
    this.accountName = client.info?.pushname || "WhatsApp";
    this.accountNumber = whatsappNumber(identities.phoneId || accountId);
    this.accountLabel = [this.accountName, this.accountNumber]
      .filter(Boolean)
      .join(" · ");
    this.authenticated = true;
    this.state = "ready";
    this.qrSvg = null;
    this.qrUpdatedAt = null;
    this.qrVersion = null;
    this.error = null;
    this.retryAttempt = 0;
    this.retryAt = null;
    this.lastConnectedAt = new Date().toISOString();
    this.publishStatus();
    await this.flushOutbox();
    try {
      await this.syncRecentInbox(client);
    } catch (error) {
      this.logger.warn(`WhatsApp inbox sync warning: ${errorMessage(error)}`);
      await this.writeInboxSnapshot();
    }
  }

  private async onMessage(message: WhatsAppMessage): Promise<void> {
    if (message.isStatus || !this.selfChatId) return;
    const preliminaryId = serializedId(message.id);
    if (preliminaryId && !this.claimCallback(preliminaryId)) return;
    const chat = message.getChat
      ? await message.getChat().catch(() => null)
      : null;
    if (chat?.isGroup) return;
    const chatId = routeChatId(message, chat);
    if (!this.isSelfChatId(chatId)) {
      if (this.recordInboxMessage(message, chat, chatId)) {
        this.pruneInbox();
        await this.writeInboxSnapshot();
      }
      return;
    }
    const text = String(message.body || "").trim();
    const messageId =
      serializedId(message.id) || `${chatId}:${message.timestamp}`;
    if (!text && !message.hasMedia) return;
    if (
      message.fromMe &&
      text &&
      this.consumeMediaSendFailure(messageId, text)
    ) {
      return;
    }
    if (text && this.consumeRecentOutboundText(text)) {
      const now = new Date().toISOString();
      this.database.db
        .prepare(
          `UPDATE whatsapp_outbox SET status = 'acknowledged', remote_message_id = ?,
             updated_at = ? WHERE id = (
               SELECT id FROM whatsapp_outbox WHERE kind = 'text' AND body = ?
               AND status IN ('sending', 'sent_unconfirmed')
               ORDER BY created_at ASC, ordinal ASC LIMIT 1
             )`,
        )
        .run(messageId, now, text);
      if (messageId && !this.isOutboundMessage(messageId)) {
        this.recordLegacyOutbound(messageId, null);
        this.recordMessage(
          messageId,
          "outbound",
          null,
          "system",
          text,
          "echoed",
        );
      }
      return;
    }
    if (this.isOutboundMessage(messageId)) return;
    if (!this.claimInboundMessage(messageId, text || "Attachment")) return;
    this.lastMessageAt = new Date().toISOString();
    const command = !message.hasMedia ? parseWhatsAppCommand(text) : null;
    if (command) {
      this.linkMessage(messageId, null, "control");
      await this.handleControlCommand(command, messageId);
      this.publishStatus();
      return;
    }
    try {
      const attachment = message.hasMedia
        ? await this.saveIncomingMedia(messageId, message)
        : null;
      await this.addToBatch(messageId, text, attachment);
      this.publishStatus();
    } catch (error) {
      this.linkMessage(messageId, null, "failed");
      this.enqueueText(
        `Could not send the message: ${errorMessage(error)}`,
        null,
        "system",
      );
      void this.flushOutbox();
    }
  }

  private async handleControlCommand(
    command: WhatsAppControlCommand,
    messageId: string,
  ): Promise<void> {
    if (command.action === "help") {
      this.enqueueText(whatsAppHelpText(), null, "system");
      void this.flushOutbox();
      return;
    }
    if (command.action === "status" && !command.code) {
      const turns = this.missions.list();
      const active = turns.find((turn) =>
        ["starting", "running", "awaiting_approval"].includes(turn.status),
      );
      const queued = turns
        .filter((turn) => turn.status === "queued")
        .sort(
          (left, right) =>
            (left.enqueueSequence ?? 0) - (right.enqueueSequence ?? 0),
        );
      const lines = [
        active ? `Active: ${this.describeTurn(active)}` : "Active: none",
        `Queue depth: ${queued.length}`,
      ];
      if (queued.length) {
        lines.push(
          "Queued:",
          ...queued
            .slice(0, 5)
            .map((turn, index) => `${index + 1}. ${this.describeTurn(turn)}`),
        );
      }
      this.enqueueText(lines.join("\n"), active?.id ?? null, "system");
      void this.flushOutbox();
      return;
    }

    const mission = command.code
      ? this.missions.findByControlCode(command.code)
      : null;
    if (!mission) {
      this.enqueueText(
        `Unknown control code ${command.code}. Send help for command syntax.`,
        null,
        "system",
      );
      void this.flushOutbox();
      return;
    }

    const code = this.missions.controlCode(mission.id);
    try {
      if (command.action === "status") {
        this.missions.appendAuditEvent(mission.id, "whatsapp.control", {
          action: "status",
          code,
          messageId,
          outcome: "reported",
        });
        this.enqueueText(this.describeTurn(mission), mission.id, "system");
      } else if (command.action === "stop") {
        const stopped = await this.missions.interrupt(mission.id);
        this.missions.appendAuditEvent(mission.id, "whatsapp.control", {
          action: "stop",
          code,
          messageId,
          outcome: stopped.status,
        });
        this.enqueueText(
          `${code} · ${statusLabel(stopped.status)}`,
          mission.id,
          "system",
        );
      } else {
        const approval = this.missions.latestPendingApproval(mission.id);
        if (!approval) {
          throw new Error(`${code} has no pending approval request`);
        }
        const decision = command.action === "approve" ? "accept" : "decline";
        const updated = this.missions.approve(mission.id, {
          requestId: approval.requestId,
          decision,
        });
        this.missions.appendAuditEvent(mission.id, "whatsapp.control", {
          action: command.action,
          code,
          messageId,
          requestId: approval.requestId,
          outcome: "resolved",
        });
        this.enqueueText(
          `${code} · Approval ${command.action === "approve" ? "accepted" : "declined"}. ${statusLabel(updated.status)}.`,
          mission.id,
          "system",
        );
      }
    } catch (error) {
      this.missions.appendAuditEvent(mission.id, "whatsapp.control", {
        action: command.action,
        code,
        messageId,
        outcome: "rejected",
        error: errorMessage(error),
      });
      this.enqueueText(
        `${code} · ${errorMessage(error)}`,
        mission.id,
        "system",
      );
    }
    void this.flushOutbox();
  }

  private describeTurn(mission: MissionRecord): string {
    const code = this.missions.controlCode(mission.id);
    const position = this.missions.queuePosition(mission.id);
    const positionText = position ? ` · queue ${position}` : "";
    return `${code} · ${statusLabel(mission.status)}${positionText} · ${truncate(mission.title, 100)}`;
  }

  private claimCallback(messageId: string): boolean {
    const result = this.database.db
      .prepare(
        "INSERT OR IGNORE INTO whatsapp_callbacks(message_id, received_at) VALUES (?, ?)",
      )
      .run(messageId, new Date().toISOString());
    return result.changes === 1;
  }

  private async syncRecentInbox(client: WhatsAppClient): Promise<void> {
    if (!client.getChats) {
      await this.writeInboxSnapshot();
      return;
    }
    const chats = [...(await client.getChats())]
      .filter((chat) => !chat.isGroup)
      .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
      .slice(0, INBOX_CHAT_LIMIT);
    let changed = false;
    for (const chat of chats) {
      const chatId = serializedId(chat.id);
      if (!chatId || this.isSelfChatId(chatId) || !chat.fetchMessages) {
        continue;
      }
      const messages = await chat
        .fetchMessages({ limit: INBOX_MESSAGES_PER_CHAT })
        .catch(() => []);
      for (const message of messages) {
        changed = this.recordInboxMessage(message, chat, chatId) || changed;
      }
    }
    if (changed) this.pruneInbox();
    await this.writeInboxSnapshot();
  }

  private recordInboxMessage(
    message: WhatsAppMessage,
    chat: WhatsAppChat | null,
    chatId = routeChatId(message, chat),
  ): boolean {
    if (!chatId || this.isSelfChatId(chatId) || chat?.isGroup) return false;
    const body = String(message.body || "").trim();
    if (!body && !message.hasMedia) return false;
    const direction = message.fromMe ? "outbound" : "inbound";
    const senderId = message.fromMe
      ? serializedId(message.to) || chatId
      : serializedId(message.from) || chatId;
    const senderName = message.fromMe
      ? this.accountName || this.accountNumber || "You"
      : String(chat?.name || "").trim() ||
        whatsappNumber(senderId) ||
        senderId ||
        "Unknown contact";
    const messageAt = whatsappMessageTime(message.timestamp);
    const messageId =
      serializedId(message.id) ||
      `inbox:${createHash("sha256")
        .update(`${chatId}\n${messageAt}\n${direction}\n${body}`)
        .digest("base64url")
        .slice(0, 32)}`;
    const result = this.database.db
      .prepare(
        `INSERT INTO whatsapp_inbox_messages(
           message_id, chat_id, sender_id, sender_name, direction, body,
           has_media, message_at, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           sender_id = excluded.sender_id,
           sender_name = excluded.sender_name,
           direction = excluded.direction,
           body = excluded.body,
           has_media = excluded.has_media,
           message_at = excluded.message_at,
           observed_at = excluded.observed_at`,
      )
      .run(
        messageId,
        chatId,
        senderId || null,
        senderName.slice(0, 240),
        direction,
        (body || "[Media attachment]").slice(0, INBOX_BODY_LIMIT),
        message.hasMedia ? 1 : 0,
        messageAt,
        new Date().toISOString(),
      );
    return result.changes > 0;
  }

  private pruneInbox(): void {
    this.database.db
      .prepare(
        `DELETE FROM whatsapp_inbox_messages
         WHERE message_id NOT IN (
           SELECT message_id FROM whatsapp_inbox_messages
           ORDER BY message_at DESC LIMIT ?
         )`,
      )
      .run(INBOX_RETENTION_COUNT);
  }

  private async writeInboxSnapshot(): Promise<void> {
    try {
      const directory = join(this.config.workspace, ".orkestr", "whatsapp");
      const target = join(directory, "inbox.json");
      const temporary = join(directory, `.inbox-${randomUUID()}.tmp`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const messages = this.recentInbox(INBOX_RETENTION_COUNT).map(
        (message) => ({
          ...message,
          hasMedia: message.hasMedia === 1,
        }),
      );
      await writeFile(
        temporary,
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            linkedAccount: this.accountLabel,
            description:
              "Private local snapshot of recent non-group WhatsApp chats. Search senderName and body before claiming a message is unavailable.",
            messages,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      this.logger.warn(
        `WhatsApp inbox snapshot warning: ${errorMessage(error)}`,
      );
    }
  }

  private onMissionEvent(event: MissionEventRecord): void {
    if (event.kind === "approval.required") {
      const mission = this.missions.get(event.missionId);
      if (this.enabled()) {
        const code = this.missions.controlCode(mission.id);
        this.enqueueText(
          `Approval needed · ${code}\nReply approve ${code} or decline ${code}. You can also review it in Orkestr Lite.`,
          mission.id,
          mission.source,
          -50,
        );
        void this.flushOutbox();
      }
      return;
    }
    if (!TERMINAL_EVENTS.has(event.kind)) return;
    queueMicrotask(() => {
      const mission = this.missions.get(event.missionId);
      if (
        event.kind === "mission.interrupted" &&
        asRecord(event.payload).reason !== "user" &&
        mission.recoveryMetadata
      ) {
        return;
      }
      if (!this.enabled()) return;
      void this.deliverMission(mission).catch((error) =>
        this.logger.warn(`WhatsApp result queued: ${errorMessage(error)}`),
      );
    });
  }

  private async deliverMission(mission: MissionRecord): Promise<void> {
    const heading =
      mission.status === "completed"
        ? "Completed"
        : mission.status === "interrupted"
          ? "Interrupted"
          : mission.status === "cancelled"
            ? "Cancelled"
            : "Failed";
    const code = this.missions.controlCode(mission.id);
    const detail =
      mission.finalResponse ||
      mission.error ||
      mission.latestProgressSummary ||
      "No result text was returned.";
    const codeLine = mission.status === "completed" ? "" : ` · ${code}`;
    const message =
      mission.source === "whatsapp"
        ? `Orkestr · ${heading}${codeLine}\n\n${detail}`
        : `Orkestr · ${sourceLabel(mission.source)} · ${heading}${codeLine}\n\nYou: ${truncate(mission.prompt, 900)}\n\nCodex: ${detail}`;
    splitWhatsAppText(message).forEach((chunk, index) => {
      this.enqueueText(chunk, mission.id, mission.source, index);
    });
    const attachmentEvent = this.missions
      .events(mission.id)
      .find((candidate) => candidate.kind === "whatsapp.attachments_requested");
    const paths = attachmentEvent
      ? arrayStrings(asRecord(attachmentEvent.payload).paths).slice(0, 5)
      : [];
    for (const [index, path] of paths.entries()) {
      try {
        const attachmentId = await this.registerOutgoingAttachment(
          mission.id,
          path,
        );
        this.enqueueMedia(attachmentId, mission.id, 100 + index);
      } catch (error) {
        this.enqueueText(
          `Could not attach ${basename(path)}: ${errorMessage(error)}`,
          mission.id,
          "system",
          200 + index,
        );
      }
    }
    await this.flushOutbox();
  }

  private async sendToSelf(
    text: string,
    missionId?: string | null,
    source: string | null = null,
  ): Promise<string | null> {
    if (!this.client || !this.selfChatId || this.state !== "ready") {
      throw new Error("WhatsApp is not ready");
    }
    this.rememberOutboundText(text);
    // whatsapp-web.js can successfully enqueue a self-chat message while
    // returning undefined for its model. Sending through Client is important:
    // getChatById currently throws a bare `r` for this account's LID chat.
    const sent = await this.client.sendMessage(this.selfChatId, text);
    const messageId = serializedId(sent?.id);
    const durableId = messageId || `pending:${randomMessageId(text)}`;
    this.recordLegacyOutbound(durableId, missionId ?? null);
    this.recordMessage(
      durableId,
      "outbound",
      missionId ?? null,
      source,
      text,
      messageId ? "sent" : "sent_unconfirmed",
    );
    return messageId || null;
  }

  private consumeMediaSendFailure(messageId: string, text: string): boolean {
    if (!/^Could not send the message(?::\s*.*)?$/i.test(text)) return false;
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const row = this.database.db
      .prepare(
        `SELECT id, attempt_count FROM whatsapp_outbox
         WHERE kind = 'media' AND status IN ('sending', 'sent_unconfirmed')
         AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(cutoff) as { id: string; attempt_count: number } | undefined;
    if (!row) return false;
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `UPDATE whatsapp_outbox SET status = 'failed', next_attempt_at = ?,
         last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        new Date(
          Date.now() + acknowledgementRetryDelay(row.attempt_count),
        ).toISOString(),
        text.slice(0, 500),
        now,
        row.id,
      );
    this.recordLegacyOutbound(messageId, null);
    this.recordMessage(messageId, "outbound", null, "system", text, "failed");
    this.publishStatus();
    return true;
  }

  async sendFileToSelf(path: string): Promise<WhatsAppSnapshot> {
    const attachmentId = await this.registerExplicitAttachment(path);
    this.enqueueMedia(attachmentId, null, 0);
    void this.flushOutbox();
    return this.snapshot();
  }

  outbox(limit = 100, includeAcknowledged = false) {
    return this.database.db
      .prepare(
        `SELECT o.id, o.turn_id AS turnId, o.kind, o.body, o.status,
                o.attempt_count AS attemptCount, o.next_attempt_at AS nextAttemptAt,
                o.last_error AS lastError, o.created_at AS createdAt,
                a.original_name AS fileName
         FROM whatsapp_outbox o
         LEFT JOIN attachments a ON a.id = o.attachment_id
         WHERE (? = 1 OR o.status != 'acknowledged')
         ORDER BY o.created_at ASC, o.ordinal ASC LIMIT ?`,
      )
      .all(includeAcknowledged ? 1 : 0, Math.max(1, Math.min(250, limit)));
  }

  retryOutbox(id: string): WhatsAppSnapshot {
    this.requireOutbox(id);
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `UPDATE whatsapp_outbox SET status = 'pending', next_attempt_at = ?,
         last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
    void this.flushOutbox();
    return this.snapshot();
  }

  discardOutbox(id: string): WhatsAppSnapshot {
    this.requireOutbox(id);
    this.database.db
      .prepare("DELETE FROM whatsapp_outbox WHERE id = ?")
      .run(id);
    this.publishStatus();
    return this.snapshot();
  }

  private claimInboundMessage(messageId: string, text: string): boolean {
    const now = new Date().toISOString();
    const result = this.database.db
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_messages(
          message_id, direction, turn_id, source, body_preview, status, created_at, updated_at
        ) VALUES (?, 'inbound', NULL, 'whatsapp', ?, 'received', ?, ?)`,
      )
      .run(messageId, truncate(text, 1_000), now, now);
    return result.changes === 1;
  }

  private async saveIncomingMedia(
    messageId: string,
    message: WhatsAppMessage,
  ): Promise<string> {
    const media = await message.downloadMedia?.();
    if (!media?.data) throw new Error("WhatsApp media could not be downloaded");
    if (media.filesize && media.filesize > MAX_FILE_BYTES) {
      throw new Error("Attachment exceeds the 25 MB limit");
    }
    const normalizedBase64 = media.data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)) {
      throw new Error("Attachment contains malformed base64 data");
    }
    const buffer = Buffer.from(normalizedBase64, "base64");
    if (
      buffer.toString("base64").replace(/=+$/, "") !==
      normalizedBase64.replace(/=+$/, "")
    ) {
      throw new Error("Attachment contains malformed base64 data");
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error("Attachment exceeds the 25 MB limit");
    }
    const id = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    const directory = join(
      this.config.home,
      "attachments/whatsapp/incoming",
      date,
      safeSegment(messageId),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const originalName = safeFilename(
      media.filename || `attachment${extensionForMime(media.mimetype)}`,
    );
    const path = join(directory, originalName);
    const temporary = `${path}.${id}.part`;
    await writeFile(temporary, buffer, { mode: 0o600 });
    await rename(temporary, path);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
    this.database.db
      .prepare(
        `INSERT INTO attachments(
          id, message_id, direction, original_name, storage_path, mime_type,
          size_bytes, sha256, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
      )
      .run(
        id,
        messageId,
        originalName,
        path,
        media.mimetype || "application/octet-stream",
        buffer.length,
        createHash("sha256").update(buffer).digest("hex"),
        expiresAt,
        now,
        now,
      );
    this.database.db
      .prepare(
        "UPDATE whatsapp_messages SET attachment_id = ?, updated_at = ? WHERE message_id = ?",
      )
      .run(id, now, messageId);
    return id;
  }

  private async addToBatch(
    messageId: string,
    text: string,
    attachmentId: string | null,
  ): Promise<void> {
    const attachmentBytes = attachmentId
      ? ((
          this.database.db
            .prepare("SELECT size_bytes FROM attachments WHERE id = ?")
            .get(attachmentId) as { size_bytes: number } | undefined
        )?.size_bytes ?? 0)
      : 0;
    const pending = this.missions.conversationStatus().queueDepth;
    if (pending >= MAX_PENDING_TURNS) {
      throw new Error(
        `The workstation queue is full (${MAX_PENDING_TURNS} pending exchanges)`,
      );
    }
    const now = new Date();
    let dueAt = new Date(now.getTime() + BATCH_WINDOW_MS).toISOString();
    const batch = this.database.db
      .prepare(
        `SELECT id, message_count, attachment_count, total_bytes
         FROM whatsapp_batches WHERE status = 'open'
         ORDER BY enqueue_sequence DESC LIMIT 1`,
      )
      .get() as
      | {
          id: string;
          message_count: number;
          attachment_count: number;
          total_bytes: number;
        }
      | undefined;
    const canAppend =
      batch &&
      batch.message_count < MAX_BATCH_MESSAGES &&
      batch.attachment_count + (attachmentId ? 1 : 0) <=
        MAX_BATCH_ATTACHMENTS &&
      batch.total_bytes + attachmentBytes <= MAX_BATCH_BYTES;
    const batchId = canAppend ? batch.id : randomUUID();
    const messageCount = canAppend ? batch.message_count + 1 : 1;
    const attachmentCount = canAppend
      ? batch.attachment_count + (attachmentId ? 1 : 0)
      : attachmentId
        ? 1
        : 0;
    const totalBytes = canAppend
      ? batch.total_bytes + attachmentBytes
      : attachmentBytes;
    if (
      messageCount >= MAX_BATCH_MESSAGES ||
      attachmentCount >= MAX_BATCH_ATTACHMENTS ||
      totalBytes >= MAX_BATCH_BYTES
    ) {
      dueAt = now.toISOString();
    }
    const nowIso = now.toISOString();
    this.database.db.transaction(() => {
      if (!canAppend) {
        this.database.db
          .prepare(
            `INSERT INTO whatsapp_batches(
              id, enqueue_sequence, status, due_at, created_at, updated_at
            ) VALUES (?, ?, 'open', ?, ?, ?)`,
          )
          .run(batchId, this.nextEnqueueSequence(), dueAt, nowIso, nowIso);
      }
      this.database.db
        .prepare(
          `UPDATE whatsapp_batches SET due_at = ?, message_count = message_count + 1,
           attachment_count = attachment_count + ?, total_bytes = total_bytes + ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(dueAt, attachmentId ? 1 : 0, attachmentBytes, nowIso, batchId);
      this.database.db
        .prepare(
          `UPDATE whatsapp_messages SET batch_id = ?, body_preview = ?, status = 'batched',
           updated_at = ? WHERE message_id = ?`,
        )
        .run(batchId, truncate(text || "Attachment", 1_000), nowIso, messageId);
    })();
    this.scheduleBatchFlush();
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    const row = this.database.db
      .prepare(
        "SELECT due_at FROM whatsapp_batches WHERE status = 'open' ORDER BY due_at ASC LIMIT 1",
      )
      .get() as { due_at: string } | undefined;
    if (!row) return;
    const delay = Math.max(0, new Date(row.due_at).getTime() - Date.now());
    this.batchTimer = setTimeout(() => void this.flushBatches(), delay);
  }

  private async flushBatches(): Promise<void> {
    this.batchTimer = null;
    const batches = this.database.db
      .prepare(
        `SELECT id, enqueue_sequence FROM whatsapp_batches
         WHERE status = 'open' AND due_at <= ? ORDER BY enqueue_sequence ASC`,
      )
      .all(new Date().toISOString()) as Array<{
      id: string;
      enqueue_sequence: number;
    }>;
    for (const batch of batches) {
      const messages = this.database.db
        .prepare(
          `SELECT message_id, body_preview, attachment_id FROM whatsapp_messages
           WHERE batch_id = ? ORDER BY created_at ASC, message_id ASC`,
        )
        .all(batch.id) as Array<{
        message_id: string;
        body_preview: string;
        attachment_id: string | null;
      }>;
      const lines: string[] = [];
      for (const [index, message] of messages.entries()) {
        if (message.body_preview && message.body_preview !== "Attachment") {
          lines.push(
            messages.length > 1
              ? `${index + 1}. ${message.body_preview}`
              : message.body_preview,
          );
        }
        if (message.attachment_id) {
          const attachment = this.database.db
            .prepare(
              "SELECT original_name, storage_path, mime_type, size_bytes FROM attachments WHERE id = ?",
            )
            .get(message.attachment_id) as
            | {
                original_name: string;
                storage_path: string;
                mime_type: string;
                size_bytes: number;
              }
            | undefined;
          if (attachment) {
            lines.push(
              `Attachment: ${attachment.original_name} (${attachment.mime_type}, ${attachment.size_bytes} bytes) at ${attachment.storage_path}`,
            );
          }
        }
      }
      try {
        const mission = this.missions.create(
          {
            prompt: lines.join("\n\n") || "Inspect the attached WhatsApp file.",
            source: "whatsapp",
          },
          null,
          {
            ingressKey: `wa-batch:${batch.id}`,
            enqueueSequence: batch.enqueue_sequence,
          },
        );
        const now = new Date().toISOString();
        this.database.db.transaction(() => {
          this.database.db
            .prepare(
              "UPDATE whatsapp_batches SET status = 'queued', turn_id = ?, updated_at = ? WHERE id = ?",
            )
            .run(mission.id, now, batch.id);
          this.database.db
            .prepare(
              "UPDATE whatsapp_messages SET turn_id = ?, status = 'routed', updated_at = ? WHERE batch_id = ?",
            )
            .run(mission.id, now, batch.id);
          this.database.db
            .prepare(
              "UPDATE attachments SET turn_id = ?, updated_at = ? WHERE message_id IN (SELECT message_id FROM whatsapp_messages WHERE batch_id = ?)",
            )
            .run(mission.id, now, batch.id);
        })();
        const code = this.missions.controlCode(mission.id);
        this.enqueueText(
          mission.status === "queued" &&
            this.missions.queuePosition(mission.id)! > 1
            ? `Queued · ${code} · Position ${this.missions.queuePosition(mission.id)}\nReply status ${code} or stop ${code}.`
            : `Working · ${code} · Your message is now with Codex\nReply status ${code} or stop ${code}.`,
          mission.id,
          "whatsapp",
          -100,
        );
      } catch (error) {
        this.database.db
          .prepare(
            "UPDATE whatsapp_batches SET status = 'rejected', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), batch.id);
        this.enqueueText(
          `Could not queue WhatsApp work: ${errorMessage(error)}`,
          null,
          "system",
        );
      }
    }
    this.scheduleBatchFlush();
    void this.flushOutbox();
  }

  private nextEnqueueSequence(): number {
    const row = this.database.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM (
          SELECT enqueue_sequence AS sequence FROM missions
          UNION ALL SELECT enqueue_sequence AS sequence FROM whatsapp_batches
        )`,
      )
      .get() as { next: number };
    return row.next;
  }

  private enqueueText(
    text: string,
    missionId: string | null,
    source: string | null,
    ordinal?: number,
  ): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_outbox(
          id, turn_id, ordinal, kind, body, status, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'text', ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        missionId,
        ordinal ?? this.nextOutboxOrdinal(missionId),
        text,
        now,
        now,
        now,
      );
    this.publishStatus();
  }

  private nextOutboxOrdinal(missionId: string | null): number {
    if (!missionId) return 0;
    const row = this.database.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM whatsapp_outbox WHERE turn_id = ?",
      )
      .get(missionId) as { ordinal: number };
    return row.ordinal;
  }

  private enqueueMedia(
    attachmentId: string,
    missionId: string | null,
    ordinal: number,
  ): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_outbox(
          id, turn_id, attachment_id, ordinal, kind, status, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'media', 'pending', ?, ?, ?)`,
      )
      .run(id, missionId, attachmentId, ordinal, now, now, now);
    this.publishStatus();
  }

  private async flushOutbox(): Promise<void> {
    if (this.outboxFlushing || this.state !== "ready" || !this.client) return;
    this.outboxFlushing = true;
    try {
      for (let sentCount = 0; sentCount < 20; sentCount += 1) {
        const row = this.database.db
          .prepare(
            `SELECT * FROM whatsapp_outbox
             WHERE status IN ('pending', 'failed', 'sent_unconfirmed') AND next_attempt_at <= ?
             ORDER BY created_at ASC, ordinal ASC LIMIT 1`,
          )
          .get(new Date().toISOString()) as OutboxRow | undefined;
        if (!row) break;
        const now = new Date().toISOString();
        this.database.db
          .prepare(
            "UPDATE whatsapp_outbox SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
          )
          .run(now, row.id);
        try {
          let remoteMessageId: string | null = null;
          if (row.kind === "text") {
            remoteMessageId = await this.sendToSelf(
              row.body || "",
              row.turn_id,
              "outbox",
            );
          } else {
            const attachment = this.database.db
              .prepare(
                "SELECT storage_path, original_name FROM attachments WHERE id = ? AND status = 'available'",
              )
              .get(row.attachment_id) as
              | { storage_path: string; original_name: string }
              | undefined;
            if (!attachment || !this.client.sendFile)
              throw new Error("Attachment is unavailable");
            const result = await this.client.sendFile(
              this.selfChatMediaId || this.selfChatId!,
              attachment.storage_path,
            );
            remoteMessageId = serializedId(result?.id) || null;
            const durableId =
              remoteMessageId ||
              `pending:${randomMessageId(attachment.original_name)}`;
            this.recordLegacyOutbound(durableId, row.turn_id);
            this.recordMessage(
              durableId,
              "outbound",
              row.turn_id,
              "outbox",
              `[File] ${attachment.original_name}`,
              remoteMessageId ? "sent" : "sent_unconfirmed",
            );
          }
          this.database.db
            .prepare(
              `UPDATE whatsapp_outbox SET status = 'sent_unconfirmed', remote_message_id = ?,
               next_attempt_at = ?, last_error = NULL, updated_at = ?
               WHERE id = ? AND status = 'sending'`,
            )
            .run(
              remoteMessageId,
              new Date(
                Date.now() + acknowledgementRetryDelay(row.attempt_count + 1),
              ).toISOString(),
              new Date().toISOString(),
              row.id,
            );
        } catch (error) {
          const attempt = row.attempt_count + 1;
          const delay =
            row.kind === "media"
              ? acknowledgementRetryDelay(attempt)
              : Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempt, 6));
          this.database.db
            .prepare(
              `UPDATE whatsapp_outbox SET status = 'failed', next_attempt_at = ?,
               last_error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              new Date(Date.now() + delay).toISOString(),
              errorMessage(error).slice(0, 500),
              new Date().toISOString(),
              row.id,
            );
          break;
        }
      }
    } finally {
      this.outboxFlushing = false;
      this.publishStatus();
    }
  }

  private onMessageAck(message: WhatsAppMessage, ack: number): void {
    const messageId = serializedId(message.id);
    if (!messageId) return;
    if (ack >= 1) {
      const now = new Date().toISOString();
      this.database.db
        .prepare(
          "UPDATE whatsapp_outbox SET status = 'acknowledged', updated_at = ? WHERE remote_message_id = ?",
        )
        .run(now, messageId);
      this.database.db
        .prepare(
          "UPDATE whatsapp_messages SET status = 'acknowledged', updated_at = ? WHERE message_id = ?",
        )
        .run(now, messageId);
    } else if (ack < 0) {
      this.database.db
        .prepare(
          "UPDATE whatsapp_outbox SET status = 'failed', next_attempt_at = ?, last_error = 'WhatsApp acknowledgement failed', updated_at = ? WHERE remote_message_id = ?",
        )
        .run(
          new Date(Date.now() + 5_000).toISOString(),
          new Date().toISOString(),
          messageId,
        );
    }
    this.publishStatus();
  }

  private recoverOutbox(): void {
    this.database.db
      .prepare(
        "UPDATE whatsapp_outbox SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'",
      )
      .run(new Date().toISOString(), new Date().toISOString());
  }

  private outboxDepth(): number {
    const row = this.database.db
      .prepare(
        "SELECT COUNT(*) AS count FROM whatsapp_outbox WHERE status != 'acknowledged'",
      )
      .get() as { count: number };
    return row.count;
  }

  private async registerOutgoingAttachment(
    turnId: string,
    path: string,
  ): Promise<string> {
    await mkdir(join(this.config.home, "attachments/whatsapp/outgoing"), {
      recursive: true,
      mode: 0o700,
    });
    const root = await realpath(
      join(this.config.home, "attachments/whatsapp/outgoing"),
    );
    return this.registerFile(path, turnId, root);
  }

  private async registerExplicitAttachment(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error("File path must be absolute");
    await mkdir(join(this.config.home, "attachments"), {
      recursive: true,
      mode: 0o700,
    });
    const target = await realpath(path);
    const workspace = await realpath(this.config.workspace);
    const attachmentRoot = await realpath(
      join(this.config.home, "attachments"),
    );
    if (!isWithin(workspace, target) && !isWithin(attachmentRoot, target)) {
      throw new Error(
        "Only workspace and Orkestr attachment files can be sent",
      );
    }
    return this.registerFile(
      target,
      null,
      isWithin(workspace, target) ? workspace : attachmentRoot,
    );
  }

  private async registerFile(
    path: string,
    turnId: string | null,
    root: string,
  ): Promise<string> {
    const target = await realpath(path);
    if (!isWithin(root, target))
      throw new Error("Attachment path is outside the allowed directory");
    const details = await stat(target);
    if (!details.isFile())
      throw new Error("Attachment path is not a regular file");
    if (details.size > MAX_FILE_BYTES)
      throw new Error("Attachment exceeds the 25 MB limit");
    const existing = this.database.db
      .prepare(
        "SELECT id FROM attachments WHERE storage_path = ? AND status = 'available'",
      )
      .get(target) as { id: string } | undefined;
    if (existing) return existing.id;
    const buffer = await readFile(target);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `INSERT INTO attachments(
          id, turn_id, direction, original_name, storage_path, mime_type, size_bytes,
          sha256, status, pinned, created_at, updated_at
        ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, 'available', 1, ?, ?)`,
      )
      .run(
        id,
        turnId,
        basename(target),
        target,
        mimeForPath(target),
        details.size,
        createHash("sha256").update(buffer).digest("hex"),
        now,
        now,
      );
    return id;
  }

  private async cleanupExpiredAttachments(): Promise<void> {
    const rows = this.database.db
      .prepare(
        "SELECT id, storage_path FROM attachments WHERE pinned = 0 AND status = 'available' AND expires_at < ?",
      )
      .all(new Date().toISOString()) as Array<{
      id: string;
      storage_path: string;
    }>;
    for (const row of rows) {
      await rm(row.storage_path, { force: true }).catch(() => undefined);
      this.database.db
        .prepare(
          "UPDATE attachments SET status = 'expired', updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), row.id);
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled() || this.retryTimer) return;
    this.retryAttempt += 1;
    const maximum = Math.min(
      5 * 60_000,
      5_000 * 2 ** Math.min(this.retryAttempt - 1, 6),
    );
    const delay = Math.max(
      1_000,
      Math.round(maximum * (0.5 + Math.random() * 0.5)),
    );
    this.retryAt = new Date(Date.now() + delay).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.startSafely();
    }, delay);
    this.publishStatus();
  }

  private requireOutbox(id: string): void {
    const row = this.database.db
      .prepare("SELECT id FROM whatsapp_outbox WHERE id = ?")
      .get(id);
    if (!row) throw new Error("WhatsApp outbox item not found");
  }

  private recordLegacyOutbound(
    messageId: string,
    missionId: string | null,
  ): void {
    this.database.db
      .prepare(
        "INSERT OR IGNORE INTO whatsapp_outbound_messages(message_id, mission_id, created_at) VALUES (?, ?, ?)",
      )
      .run(messageId, missionId, new Date().toISOString());
  }

  private isOutboundMessage(messageId: string): boolean {
    if (!messageId) return false;
    return Boolean(
      this.database.db
        .prepare(
          `SELECT 1 AS found FROM whatsapp_messages
           WHERE message_id = ? AND direction = 'outbound'
           UNION ALL
           SELECT 1 AS found FROM whatsapp_outbound_messages WHERE message_id = ?
           LIMIT 1`,
        )
        .get(messageId, messageId),
    );
  }

  private hasSeenInbound(messageId: string): boolean {
    if (!messageId) return false;
    return Boolean(
      this.database.db
        .prepare(
          "SELECT 1 AS found FROM whatsapp_messages WHERE message_id = ? AND direction = 'inbound'",
        )
        .get(messageId),
    );
  }

  private isSelfChatId(candidate: string): boolean {
    return [...this.selfChatAliases].some((alias) =>
      sameWhatsAppId(candidate, alias),
    );
  }

  private settingIds(key: string): string[] {
    const value = this.database.getSetting(key);
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  private addSettingId(key: string, value: string, limit: number): void {
    const values = this.settingIds(key).filter((item) => item !== value);
    values.push(value);
    this.database.setSetting(key, JSON.stringify(values.slice(-limit)));
  }

  private removeSettingId(key: string, value: string): void {
    this.database.setSetting(
      key,
      JSON.stringify(this.settingIds(key).filter((item) => item !== value)),
    );
  }

  private recordMessage(
    messageId: string,
    direction: "inbound" | "outbound",
    turnId: string | null,
    source: string | null,
    text: string,
    status: string,
  ): void {
    this.database.db
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_messages(
          message_id, direction, turn_id, source, body_preview, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        direction,
        turnId,
        source,
        truncate(text, 1_000),
        status,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  }

  private linkMessage(
    messageId: string,
    turnId: string | null,
    status: string,
  ): void {
    this.database.db
      .prepare(
        "UPDATE whatsapp_messages SET turn_id = ?, status = ?, updated_at = ? WHERE message_id = ?",
      )
      .run(turnId, status, new Date().toISOString(), messageId);
  }

  private publishStatus(): void {
    const status = this.snapshot();
    for (const listener of this.statusListeners) listener(status);
  }

  private rememberOutboundText(text: string): void {
    this.pruneOutboundTexts();
    const timestamps = this.recentOutboundTexts.get(text) ?? [];
    timestamps.push(Date.now());
    this.recentOutboundTexts.set(text, timestamps);
  }

  private consumeRecentOutboundText(text: string): boolean {
    this.pruneOutboundTexts();
    const timestamps = this.recentOutboundTexts.get(text);
    if (!timestamps?.length) return false;
    timestamps.shift();
    if (!timestamps.length) this.recentOutboundTexts.delete(text);
    return true;
  }

  private pruneOutboundTexts(): void {
    const cutoff = Date.now() - 60_000;
    for (const [text, timestamps] of this.recentOutboundTexts) {
      const fresh = timestamps.filter((sentAt) => sentAt >= cutoff);
      if (fresh.length) this.recentOutboundTexts.set(text, fresh);
      else this.recentOutboundTexts.delete(text);
    }
  }

  private fail(error: unknown): void {
    this.authenticated = false;
    this.state = "error";
    const message = errorMessage(error);
    this.error = message.includes("profile appears to be in use")
      ? "The WhatsApp browser profile was locked by an earlier container. Try Link WhatsApp again."
      : message.slice(0, 500);
    this.logger.error(`WhatsApp connector error: ${this.error}`);
    this.publishStatus();
  }

  private async clearStaleBrowserLocks(): Promise<void> {
    const sessionPath = join(this.dataPath, `session-${CLIENT_ID}`);
    await Promise.all(
      ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) =>
        rm(join(sessionPath, name), { force: true }),
      ),
    );
  }
}

function routeChatId(
  message: WhatsAppMessage,
  chat: WhatsAppChat | null,
): string {
  const remote =
    typeof message.id === "object" ? serializedId(message.id.remote) : "";
  // For inbound DMs `to` is our own account, so accepting every matching
  // field would accidentally treat all contacts as the self-chat. Follow the
  // conversation side of the message instead.
  return message.fromMe
    ? serializedId(message.to) ||
        remote ||
        serializedId(message.from) ||
        serializedId(chat?.id)
    : serializedId(message.from) ||
        remote ||
        serializedId(message.to) ||
        serializedId(chat?.id);
}

function whatsappMessageTime(timestamp: number | undefined): string {
  const candidate = Number(timestamp);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return new Date().toISOString();
  }
  const milliseconds =
    candidate > 10_000_000_000 ? candidate : candidate * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

async function resolveSelfChatIdentities(
  client: WhatsAppClient,
  accountId: string,
): Promise<{ aliases: string[]; destination: string; phoneId: string }> {
  let lid = "";
  let phoneId = accountId;
  if (client.getContactLidAndPhone) {
    try {
      const mappings = await client.getContactLidAndPhone([accountId]);
      const mapping =
        mappings.find((value) =>
          [serializedId(value.lid), serializedId(value.pn)].some((id) =>
            sameWhatsAppId(id, accountId),
          ),
        ) ?? mappings[0];
      lid = serializedId(mapping?.lid);
      phoneId = serializedId(mapping?.pn) || accountId;
    } catch {
      // Older WhatsApp Web builds do not expose LID/phone mapping.
    }
  }
  const aliases = [accountId, phoneId, lid].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  return { aliases, destination: lid || phoneId, phoneId };
}

function serializedId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as { _serialized?: unknown; user?: unknown };
  if (typeof record._serialized === "string") return record._serialized.trim();
  if (typeof record.user === "string") return `${record.user}@c.us`;
  return "";
}

function sameWhatsAppId(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/:\d+(?=@)/, "");
  return Boolean(left && right && normalize(left) === normalize(right));
}

function whatsappNumber(id: string): string | null {
  const value = id.split("@")[0]?.replace(/\D/g, "") ?? "";
  return value ? `+${value}` : null;
}

function sourceLabel(source: MissionRecord["source"]): string {
  if (source === "timer") return "Scheduled";
  if (source === "whatsapp") return "WhatsApp";
  if (source === "demo") return "Demo";
  return "Browser";
}

export type WhatsAppControlCommand =
  | { action: "help" }
  | { action: "status"; code: string | null }
  | { action: "stop" | "approve" | "decline"; code: string };

export function parseWhatsAppCommand(
  value: string,
): WhatsAppControlCommand | null {
  const text = value.trim();
  if (/^help$/i.test(text)) return { action: "help" };
  if (/^status$/i.test(text)) return { action: "status", code: null };
  const match = /^(status|stop|approve|decline)\s+([A-Z0-9]{8})$/i.exec(text);
  if (!match) return null;
  const action = match[1]!.toLowerCase() as
    | "status"
    | "stop"
    | "approve"
    | "decline";
  const code = match[2]!.toUpperCase();
  return action === "status" ? { action, code } : { action, code };
}

export function whatsAppHelpText(): string {
  return [
    "Orkestr WhatsApp controls",
    "status — active work and queue",
    "status CODE — durable turn status",
    "stop CODE — cancel queued or stop active work",
    "approve CODE — accept the latest pending approval",
    "decline CODE — decline the latest pending approval",
    "help — show these commands",
    "",
    "Commands must be the whole message. Other text goes to Codex.",
  ].join("\n");
}

function statusLabel(status: MissionRecord["status"]): string {
  const labels: Record<MissionRecord["status"], string> = {
    queued: "Queued",
    starting: "Starting",
    running: "Working",
    awaiting_approval: "Approval needed",
    completed: "Completed",
    failed: "Failed",
    interrupted: "Stopped",
    cancelled: "Cancelled",
  };
  return labels[status];
}

function truncate(value: string, limit: number): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function randomMessageId(text: string): string {
  return createHash("sha256")
    .update(`${Date.now()}:${Math.random()}:${text}`)
    .digest("base64url")
    .slice(0, 24);
}

export function acknowledgementRetryDelay(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(5 * 60_000, ACK_TIMEOUT_MS * 2 ** (safeAttempt - 1));
}

export function splitWhatsAppText(text: string, limit = 3_500): string[] {
  const input = text.trim();
  if (input.length <= limit) return [input];
  const chunks: string[] = [];
  let remaining = input;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const space = remaining.lastIndexOf(" ", limit);
    const cut = Math.max(newline, space, Math.floor(limit * 0.7));
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function safeSegment(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return normalized || "message";
}

function safeFilename(value: string): string {
  const leaf = basename(value.replace(/\\/g, "/"))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return leaf && leaf !== "." && leaf !== ".." ? leaf : "attachment.bin";
}

function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase().split(";")[0] ?? "";
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
  };
  return extensions[normalized] ?? ".bin";
}

function mimeForPath(path: string): string {
  const extensions: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
  };
  return extensions[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
