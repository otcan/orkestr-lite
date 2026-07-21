import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { Router } from "@angular/router";
import { ApiService, errorText } from "./api.service";

interface SetupStatus {
  codex: {
    process: "starting" | "ready" | "error";
    processError: string | null;
    cliVersion: string | null;
    authenticated: boolean;
    authMode: string | null;
    accountEmail: string | null;
    planType: string | null;
    requestedModel: string;
    selectedModel: string | null;
    modelReady: boolean;
    models: Array<{
      id: string;
      model: string;
      displayName: string;
    }>;
    login: {
      state: string;
      verificationUrl: string | null;
      userCode: string | null;
      expiresAt: string | null;
      error: string | null;
    };
  };
  ready: boolean;
}

interface WhatsAppStatus {
  state:
    | "idle"
    | "starting"
    | "qr_needed"
    | "authenticated"
    | "ready"
    | "disconnected"
    | "error";
  enabled: boolean;
  authenticated: boolean;
  ready: boolean;
  qrAvailable: boolean;
  qrUpdatedAt: string | null;
  qrVersion: string | null;
  accountLabel: string | null;
  accountName: string | null;
  accountNumber: string | null;
  error: string | null;
}

@Component({
  standalone: true,
  imports: [],
  template: `
    <main class="page narrow">
      <header class="page-header">
        <div>
          <p class="eyebrow">Workstation setup</p>
          <h1>Connect your workstation</h1>
          <p class="muted">
            Docker is already running. Connect Codex, then optionally link
            WhatsApp to use the same conversation from your phone.
          </p>
        </div>
      </header>

      @if (error) {
        <div class="callout error" role="alert">{{ error }}</div>
      }

      @if (!status) {
        <section class="panel connection-panel">Checking Codex…</section>
      } @else {
        <div class="setup-stack">
          <section class="panel connection-panel">
            <article class="setup-connection">
              <span
                class="status-dot"
                [class.ready]="status.codex.authenticated"
              ></span>
              <div class="check-content">
                <p class="eyebrow">Codex account</p>
                <h2>
                  {{
                    status.codex.authenticated
                      ? "Codex connected"
                      : "Sign in to Codex"
                  }}
                </h2>

                @if (status.codex.authenticated) {
                  <p class="connection-summary">
                    {{ status.codex.accountEmail || "ChatGPT account" }}
                    @if (status.codex.selectedModel) {
                      · {{ status.codex.selectedModel }}
                    } @else if (status.codex.models.length) {
                      · {{ status.codex.requestedModel }} unavailable
                    } @else {
                      · checking model access…
                    }
                  </p>
                } @else {
                  <p class="connection-summary">
                    Authenticate with your ChatGPT account or an API key.
                  </p>
                }

                @if (
                  !status.codex.authenticated &&
                  status.codex.login.verificationUrl &&
                  status.codex.login.userCode
                ) {
                  <div class="device-code">
                    <span>Device code</span>
                    <strong>{{ status.codex.login.userCode }}</strong>
                    <a
                      [href]="status.codex.login.verificationUrl"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open verification page
                    </a>
                    <small>Refreshes automatically before it expires.</small>
                  </div>
                }

                @if (!status.codex.authenticated) {
                  <div class="setup-actions">
                    <button
                      class="primary"
                      type="button"
                      (click)="startDeviceLogin()"
                      [disabled]="busy"
                    >
                      {{
                        status.codex.login.userCode
                          ? "Refresh code now"
                          : "Connect with ChatGPT"
                      }}
                    </button>
                    <details>
                      <summary>Use an API key instead</summary>
                      <form
                        class="inline-form"
                        (submit)="loginApiKey(); $event.preventDefault()"
                      >
                        <input
                          type="password"
                          name="apiKey"
                          autocomplete="off"
                          placeholder="sk-…"
                          [value]="apiKey()"
                          (input)="apiKey.set($any($event.target).value)"
                          required
                        />
                        <button type="submit" [disabled]="busy || !apiKey()">
                          Connect
                        </button>
                      </form>
                    </details>
                  </div>
                }

                @if (status.codex.authenticated && !status.codex.modelReady) {
                  <p class="model-wait">
                    @if (status.codex.models.length) {
                      Codex is connected, but this account does not expose
                      {{ status.codex.requestedModel }}.
                    } @else {
                      Codex is connected. Checking available models…
                    }
                  </p>
                }

                <details class="setup-diagnostics">
                  <summary>Diagnostics</summary>
                  <dl class="diagnostics">
                    <dt>Authentication</dt>
                    <dd>
                      {{
                        status.codex.authenticated
                          ? status.codex.authMode || "connected"
                          : "not connected"
                      }}
                    </dd>
                    <dt>Account</dt>
                    <dd>{{ status.codex.accountEmail || "—" }}</dd>
                    <dt>Codex CLI</dt>
                    <dd>{{ status.codex.cliVersion || "not detected" }}</dd>
                    <dt>Selected model</dt>
                    <dd>{{ status.codex.selectedModel || "checking" }}</dd>
                    <dt>Error</dt>
                    <dd>
                      {{
                        status.codex.processError ||
                          status.codex.login.error ||
                          "none"
                      }}
                    </dd>
                  </dl>
                </details>
              </div>
              <strong
                class="connection-state"
                [class.ready]="status.codex.authenticated"
                >{{
                  status.codex.authenticated ? "Connected" : "Action needed"
                }}</strong
              >
            </article>
          </section>

          <section class="panel connection-panel">
            <article class="setup-connection">
              <span class="status-dot" [class.ready]="whatsapp?.ready"></span>
              <div class="check-content">
                <p class="eyebrow">WhatsApp linked device</p>
                <h2>{{ whatsappHeading }}</h2>
                <p class="connection-summary">{{ whatsappSummary }}</p>

                @if (whatsapp?.state === "qr_needed" && whatsapp.qrAvailable) {
                  <div class="whatsapp-qr">
                    <img
                      [src]="whatsappQrUrl"
                      alt="WhatsApp linked-device QR code"
                    />
                    <div>
                      <strong>Scan with WhatsApp</strong>
                      <ol>
                        <li>Open WhatsApp on your phone</li>
                        <li>Go to Linked devices</li>
                        <li>Choose Link a device and scan this code</li>
                      </ol>
                    </div>
                  </div>
                }

                @if (whatsapp?.error) {
                  <p class="model-wait">{{ whatsapp.error }}</p>
                }

                <div class="setup-actions">
                  @if (
                    !whatsapp?.ready &&
                    whatsapp?.state !== "qr_needed" &&
                    whatsapp?.state !== "authenticated"
                  ) {
                    <button
                      class="primary"
                      type="button"
                      (click)="startWhatsApp()"
                      [disabled]="busy || whatsapp?.state === 'starting'"
                    >
                      Link WhatsApp
                    </button>
                  }
                  @if (whatsapp?.enabled) {
                    <button
                      class="quiet"
                      type="button"
                      (click)="logoutWhatsApp()"
                      [disabled]="busy"
                    >
                      Unlink
                    </button>
                  }
                </div>
              </div>
              <strong
                class="connection-state"
                [class.ready]="whatsapp?.ready"
                >{{
                  whatsapp?.ready
                    ? "Connected"
                    : whatsapp?.state === "qr_needed"
                      ? "Scan QR"
                      : "Not linked"
                }}</strong
              >
            </article>
          </section>
        </div>

        @if (status.ready) {
          <button
            class="primary setup-complete"
            type="button"
            (click)="openOrkestr()"
            [disabled]="busy"
          >
            Open Orkestr
          </button>
        } @else if (status.codex.authenticated) {
          <p class="setup-wait muted">Checking model access…</p>
        }
      }
    </main>
  `,
})
export class SetupComponent implements OnInit, OnDestroy {
  readonly apiKey = signal("");
  private readonly statusState = signal<SetupStatus | null>(null);
  private readonly whatsappState = signal<WhatsAppStatus | null>(null);
  private readonly busyState = signal(false);
  private readonly errorState = signal("");
  private timer: ReturnType<typeof setInterval> | null = null;
  private whatsappEvents: EventSource | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly router: Router,
  ) {}

  get status(): SetupStatus | null {
    return this.statusState();
  }

  get busy(): boolean {
    return this.busyState();
  }

  get error(): string {
    return this.errorState();
  }

  get whatsapp(): WhatsAppStatus | null {
    return this.whatsappState();
  }

  get whatsappHeading(): string {
    switch (this.whatsapp?.state) {
      case "ready":
        return "WhatsApp connected";
      case "qr_needed":
        return "Scan to link WhatsApp";
      case "starting":
      case "authenticated":
        return "Connecting WhatsApp…";
      case "disconnected":
      case "error":
        return "Reconnect WhatsApp";
      default:
        return "Link WhatsApp";
    }
  }

  get whatsappSummary(): string {
    if (this.whatsapp?.ready) {
      const account = [
        this.whatsapp.accountName ||
          this.whatsapp.accountLabel ||
          "Linked account",
        this.whatsapp.accountNumber,
      ]
        .filter(Boolean)
        .join(" · ");
      return `${account} · messages to yourself enter this conversation`;
    }
    if (this.whatsapp?.state === "qr_needed") {
      return "Use WhatsApp’s Linked devices screen. No phone number or API token needed.";
    }
    return "Built in to Orkestr Lite. Your linked-device session stays on this workstation.";
  }

  get whatsappQrUrl(): string {
    const version = encodeURIComponent(this.whatsapp?.qrVersion || "current");
    return `/api/setup/whatsapp/qr.svg?v=${version}`;
  }

  ngOnInit(): void {
    void this.refresh();
    this.openWhatsAppEvents();
    this.timer = setInterval(() => void this.refreshCodex(), 2_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.whatsappEvents?.close();
  }

  async startDeviceLogin(): Promise<void> {
    await this.run(async () => {
      await this.api.post("/api/setup/codex/device-auth");
      await this.refresh();
    });
  }

  async loginApiKey(): Promise<void> {
    const apiKey = this.apiKey();
    this.apiKey.set("");
    await this.run(async () => {
      await this.api.post("/api/setup/codex/api-key", { apiKey });
      await this.refresh();
    });
  }

  async startWhatsApp(): Promise<void> {
    await this.run(async () => {
      this.whatsappState.set(
        await this.api.post<WhatsAppStatus>("/api/setup/whatsapp/start"),
      );
    });
  }

  async logoutWhatsApp(): Promise<void> {
    await this.run(async () => {
      this.whatsappState.set(
        await this.api.post<WhatsAppStatus>("/api/setup/whatsapp/logout"),
      );
    });
  }

  async openOrkestr(): Promise<void> {
    await this.run(async () => {
      await this.api.post("/api/conversation/complete-setup");
      await this.router.navigateByUrl("/chat");
    });
  }

  private async refresh(): Promise<void> {
    try {
      const [status, whatsapp] = await Promise.all([
        this.api.get<SetupStatus>("/api/setup/status"),
        this.api.get<WhatsAppStatus>("/api/setup/whatsapp/status"),
      ]);
      this.statusState.set(status);
      this.whatsappState.set(whatsapp);
    } catch (error) {
      this.errorState.set(errorText(error));
    }
  }

  private async refreshCodex(): Promise<void> {
    try {
      this.statusState.set(
        await this.api.get<SetupStatus>("/api/setup/status"),
      );
    } catch (error) {
      this.errorState.set(errorText(error));
    }
  }

  private openWhatsAppEvents(): void {
    const source = new EventSource("/api/whatsapp/events");
    source.addEventListener("status", (event) => {
      try {
        this.whatsappState.set(JSON.parse((event as MessageEvent).data));
      } catch {
        // EventSource reconnects automatically.
      }
    });
    this.whatsappEvents = source;
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busyState.set(true);
    this.errorState.set("");
    try {
      await action();
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.busyState.set(false);
    }
  }
}
