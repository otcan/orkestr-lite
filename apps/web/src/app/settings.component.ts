import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService, errorText } from "./api.service";

interface SettingsStatus {
  codex: {
    process: string;
    processError: string | null;
    authenticated: boolean;
    accountEmail: string | null;
    selectedModel: string | null;
    retryAt: string | null;
    retryAttempt: number;
    lastConnectedAt: string | null;
    lastMessageAt: string | null;
  };
}

interface ConversationStatus {
  queueDepth: number;
  queueLimit: number;
  compacting: boolean;
  context: {
    usedTokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    updatedAt: string | null;
    compactionCount: number;
    lastCompactedAt: string | null;
  };
}

interface DeskStatus {
  enabled: boolean;
  healthy: boolean;
  ubuntuVersion?: string;
  chromeVersion?: string;
  restartCount?: number;
  activeTurnId: string | null;
}

interface WhatsAppStatus {
  state: string;
  enabled: boolean;
  ready: boolean;
  qrAvailable: boolean;
  qrUpdatedAt: string | null;
  qrVersion: string | null;
  accountLabel: string | null;
  accountName: string | null;
  accountNumber: string | null;
  error: string | null;
  retryAt: string | null;
  retryAttempt: number;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  queueDepth: number;
  outboxDepth: number;
}

interface WhatsAppOutboxItem {
  id: string;
  kind: "text" | "media";
  body: string | null;
  fileName: string | null;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
}

interface WhatsAppMessage {
  messageId: string;
  direction: "inbound" | "outbound";
  source: string | null;
  bodyPreview: string;
  status: string;
  createdAt: string;
}

@Component({
  standalone: true,
  imports: [RouterLink],
  template: `
    <main class="page narrow settings-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Settings</p>
          <h1>Connections and conversation</h1>
        </div>
        <a class="quiet button-link" routerLink="/diagnostics">Diagnostics</a>
      </header>

      @if (error) {
        <div class="callout error" role="alert">{{ error }}</div>
      }

      <section class="panel settings-section">
        <p class="eyebrow">Codex</p>
        <h2>
          {{ status?.codex?.authenticated ? "Connected" : "Not connected" }}
        </h2>
        <p class="muted">
          {{ status?.codex?.accountEmail || "No account" }}
          @if (status?.codex?.selectedModel) {
            · {{ status.codex.selectedModel }}
          }
        </p>
        @if (status?.codex?.processError) {
          <p class="error">{{ status.codex.processError }}</p>
        }
        @if (status?.codex?.retryAt) {
          <p class="muted">
            Retry {{ status.codex.retryAttempt }} ·
            {{ timestamp(status.codex.retryAt) }}
          </p>
        }
        @if (status?.codex?.lastConnectedAt) {
          <p class="connection-facts">
            Connected {{ timestamp(status.codex.lastConnectedAt) }}
            @if (status.codex.lastMessageAt) {
              · Last event {{ timestamp(status.codex.lastMessageAt) }}
            }
          </p>
        }
        <a routerLink="/setup">Manage Codex connection</a>
      </section>

      @if (desk?.enabled) {
        <section class="panel settings-section">
          <p class="eyebrow">Live Desk</p>
          <h2>{{ desk.healthy ? "Connected" : "Unavailable" }}</h2>
          <p class="muted">
            {{ desk.ubuntuVersion || "Ubuntu workstation" }}
            @if (desk.chromeVersion) {
              · {{ desk.chromeVersion }}
            }
            · {{ desk.restartCount || 0 }} restarts
          </p>
          <button
            class="danger"
            type="button"
            (click)="resetDesk()"
            [disabled]="busy || !desk.healthy || !!desk.activeTurnId"
          >
            Reset Desk
          </button>
          <p class="muted">
            Clears desktop and browser preferences. Workspace files, Codex
            login, and conversation history are preserved.
          </p>
        </section>
      }

      <section class="panel settings-section">
        <p class="eyebrow">WhatsApp</p>
        <h2>{{ whatsapp?.ready ? "Connected" : "Linked device" }}</h2>
        <p class="muted">
          {{
            whatsapp?.ready
              ? whatsapp.accountName || whatsapp.accountLabel
              : "Optional · use your self-chat"
          }}
          @if (whatsapp?.ready && whatsapp.accountNumber) {
            · {{ whatsapp.accountNumber }}
          }
        </p>
        <p class="connection-facts">
          Queue {{ whatsapp?.queueDepth || 0 }} · Outbox
          {{ whatsapp?.outboxDepth || 0 }}
          @if (whatsapp?.lastConnectedAt) {
            · Connected {{ timestamp(whatsapp.lastConnectedAt) }}
          }
          @if (whatsapp?.lastMessageAt) {
            · Last message {{ timestamp(whatsapp.lastMessageAt) }}
          }
        </p>
        @if (whatsapp?.retryAt) {
          <p class="muted">
            Reconnect attempt {{ whatsapp.retryAttempt }} ·
            {{ timestamp(whatsapp.retryAt) }}
          </p>
        }
        @if (whatsapp?.state === "qr_needed" && whatsapp.qrAvailable) {
          <img
            class="settings-qr"
            [src]="qrUrl"
            alt="WhatsApp linked-device QR code"
          />
        }
        <div class="setup-actions">
          @if (!whatsapp?.ready && whatsapp?.state !== "qr_needed") {
            <button
              class="primary"
              type="button"
              (click)="linkWhatsApp()"
              [disabled]="busy"
            >
              Link WhatsApp
            </button>
          }
          @if (whatsapp?.enabled) {
            <button type="button" (click)="unlinkWhatsApp()" [disabled]="busy">
              Unlink
            </button>
          }
          @if (whatsapp?.ready) {
            <button type="button" (click)="sendTest()" [disabled]="busy">
              Send test message
            </button>
          }
        </div>
        @if (messages.length) {
          <div class="wa-message-list">
            <p class="eyebrow">Recent messages</p>
            @for (message of messages; track message.messageId) {
              <div class="wa-message-row">
                <span>{{
                  message.direction === "inbound"
                    ? "From WhatsApp"
                    : "To WhatsApp"
                }}</span>
                <span class="wa-message-body">{{ message.bodyPreview }}</span>
                <small>{{ message.status }}</small>
              </div>
            }
          </div>
        }
        @if (outbox.length) {
          <div class="wa-message-list">
            <p class="eyebrow">Pending delivery</p>
            @for (item of outbox; track item.id) {
              <div class="wa-outbox-row">
                <div>
                  <strong>{{ item.fileName || item.body || "Message" }}</strong>
                  <small>
                    {{ item.status }} · {{ item.attemptCount }} attempts
                    @if (item.lastError) {
                      · {{ item.lastError }}
                    }
                  </small>
                </div>
                <div class="setup-actions">
                  <button
                    type="button"
                    (click)="retryOutbox(item.id)"
                    [disabled]="busy"
                  >
                    Retry
                  </button>
                  <button
                    class="danger"
                    type="button"
                    (click)="discardOutbox(item.id)"
                    [disabled]="busy"
                  >
                    Discard
                  </button>
                </div>
              </div>
            }
          </div>
        }
      </section>

      <section class="panel settings-section danger-zone">
        <p class="eyebrow">Conversation</p>
        <h2>Context health</h2>
        <p class="muted">
          @if (
            conversation?.context?.percent !== null &&
            conversation?.context?.percent !== undefined
          ) {
            {{ conversation?.context?.percent }}% used ·
          }
          {{ conversation?.context?.compactionCount || 0 }} compactions
          @if (conversation?.context?.lastCompactedAt) {
            · Last {{ timestamp(conversation.context.lastCompactedAt) }}
          }
        </p>
        <button
          type="button"
          (click)="compactContext()"
          [disabled]="
            busy || !!conversation?.queueDepth || !!conversation?.compacting
          "
        >
          {{ conversation?.compacting ? "Compacting…" : "Compact context now" }}
        </button>
        <hr />
        <h2>Start a new conversation</h2>
        <p class="muted">
          Clears the current conversation context. Your workspace files will not
          be deleted.
        </p>
        <button
          class="danger"
          type="button"
          (click)="startFresh()"
          [disabled]="busy"
        >
          Start fresh
        </button>
      </section>
    </main>
  `,
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly statusState = signal<SettingsStatus | null>(null);
  private readonly whatsappState = signal<WhatsAppStatus | null>(null);
  private readonly conversationState = signal<ConversationStatus | null>(null);
  private readonly deskState = signal<DeskStatus | null>(null);
  private readonly messagesState = signal<WhatsAppMessage[]>([]);
  private readonly outboxState = signal<WhatsAppOutboxItem[]>([]);
  private readonly busyState = signal(false);
  private readonly errorState = signal("");
  private eventsSource: EventSource | null = null;

  constructor(private readonly api: ApiService) {}

  get status(): SettingsStatus | null {
    return this.statusState();
  }

  get whatsapp(): WhatsAppStatus | null {
    return this.whatsappState();
  }

  get conversation(): ConversationStatus | null {
    return this.conversationState();
  }

  get desk(): DeskStatus | null {
    return this.deskState();
  }

  get busy(): boolean {
    return this.busyState();
  }

  get messages(): WhatsAppMessage[] {
    return this.messagesState();
  }

  get outbox(): WhatsAppOutboxItem[] {
    return this.outboxState();
  }

  get error(): string {
    return this.errorState();
  }

  get qrUrl(): string {
    return `/api/setup/whatsapp/qr.svg?v=${encodeURIComponent(this.whatsapp?.qrVersion || "current")}`;
  }

  ngOnInit(): void {
    void this.refresh();
    this.openEventStream();
  }

  ngOnDestroy(): void {
    this.eventsSource?.close();
  }

  async linkWhatsApp(): Promise<void> {
    await this.run(() => this.api.post("/api/setup/whatsapp/start"));
  }

  async unlinkWhatsApp(): Promise<void> {
    await this.run(() => this.api.post("/api/setup/whatsapp/logout"));
  }

  async sendTest(): Promise<void> {
    await this.run(() => this.api.post("/api/whatsapp/test"));
  }

  async compactContext(): Promise<void> {
    await this.run(() => this.api.post("/api/conversation/compact"));
  }

  async resetDesk(): Promise<void> {
    if (
      !globalThis.confirm(
        "Reset desktop and browser preferences? Workspace files and Codex history will be kept.",
      )
    )
      return;
    await this.run(() => this.api.post("/api/desk/actions/reset"));
  }

  async retryOutbox(id: string): Promise<void> {
    await this.run(() => this.api.post(`/api/whatsapp/outbox/${id}/retry`));
  }

  async discardOutbox(id: string): Promise<void> {
    await this.run(() => this.api.post(`/api/whatsapp/outbox/${id}/discard`));
  }

  timestamp(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleString() : "";
  }

  async startFresh(): Promise<void> {
    const confirmed = globalThis.confirm(
      "This clears the current conversation context. Your workspace files will not be deleted.",
    );
    if (!confirmed) return;
    await this.run(() => this.api.post("/api/conversation/start-fresh"));
  }

  private async refresh(): Promise<void> {
    const [status, whatsapp, conversation, messages, outbox, desk] =
      await Promise.all([
        this.api.get<SettingsStatus>("/api/setup/status"),
        this.api.get<WhatsAppStatus>("/api/setup/whatsapp/status"),
        this.api.get<ConversationStatus>("/api/conversation/status"),
        this.api.get<{ data: WhatsAppMessage[] }>(
          "/api/whatsapp/messages?limit=12",
        ),
        this.api.get<{ data: WhatsAppOutboxItem[] }>(
          "/api/whatsapp/outbox?limit=50",
        ),
        this.api.get<DeskStatus>("/api/desk/status"),
      ]);
    this.statusState.set(status);
    this.whatsappState.set(whatsapp);
    this.conversationState.set(conversation);
    this.messagesState.set(messages.data);
    this.outboxState.set(outbox.data);
    this.deskState.set(desk);
  }

  private openEventStream(): void {
    const source = new EventSource("/api/whatsapp/events");
    source.addEventListener("status", (event) => {
      try {
        this.whatsappState.set(JSON.parse((event as MessageEvent).data));
        void this.api
          .get<{ data: WhatsAppMessage[] }>("/api/whatsapp/messages?limit=12")
          .then((result) => this.messagesState.set(result.data));
        void this.api
          .get<{ data: WhatsAppOutboxItem[] }>("/api/whatsapp/outbox?limit=50")
          .then((result) => this.outboxState.set(result.data));
      } catch {
        // EventSource reconnects automatically; the initial request remains visible.
      }
    });
    this.eventsSource = source;
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busyState.set(true);
    this.errorState.set("");
    try {
      await action();
      await this.refresh();
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.busyState.set(false);
    }
  }
}
