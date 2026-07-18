import { Component, OnDestroy, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { ApiService, errorText } from "./api.service";

interface SetupStatus {
  system: { ready: boolean };
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
    login: {
      state: string;
      verificationUrl: string | null;
      userCode: string | null;
      error: string | null;
    };
  };
  workspace: { ready: boolean; path: string };
  firstMissionReady: boolean;
}

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main class="page narrow">
      <header class="page-header">
        <div>
          <p class="eyebrow">Workstation setup</p>
          <h1>Connect the runtime</h1>
          <p class="muted">
            Each check has one clear action and keeps credentials inside Codex.
          </p>
        </div>
      </header>

      @if (error) {
        <div class="callout error" role="alert">{{ error }}</div>
      }

      @if (!status) {
        <section class="panel">Loading diagnostics…</section>
      } @else {
        <section class="checklist panel">
          <article class="check-row">
            <span class="status-dot" [class.ready]="status.system.ready"></span>
            <div>
              <h2>System ready</h2>
              <p>SQLite, runtime directories, and web server</p>
            </div>
            <strong>{{ status.system.ready ? "Ready" : "Waiting" }}</strong>
          </article>

          <article class="check-row">
            <span
              class="status-dot"
              [class.ready]="
                status.codex.authenticated && status.codex.modelReady
              "
            ></span>
            <div class="check-content">
              <h2>Codex connected</h2>
              <p>
                @if (status.codex.authenticated) {
                  {{ status.codex.accountEmail || status.codex.authMode }} ·
                  {{ status.codex.selectedModel || "GPT-5.6 unavailable" }}
                } @else {
                  Authenticate with a ChatGPT device code or an API key.
                }
              </p>
              @if (
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
                    Connect with device code
                  </button>
                  <details>
                    <summary>Use an API key instead</summary>
                    <form class="inline-form" (ngSubmit)="loginApiKey()">
                      <input
                        type="password"
                        name="apiKey"
                        autocomplete="off"
                        placeholder="sk-…"
                        [(ngModel)]="apiKey"
                        required
                      />
                      <button type="submit" [disabled]="busy || !apiKey">
                        Connect
                      </button>
                    </form>
                  </details>
                </div>
              }
              <details>
                <summary>Diagnostics</summary>
                <dl class="diagnostics">
                  <dt>Process</dt>
                  <dd>{{ status.codex.process }}</dd>
                  <dt>CLI</dt>
                  <dd>{{ status.codex.cliVersion || "not detected" }}</dd>
                  <dt>Required model</dt>
                  <dd>{{ status.codex.requestedModel }}</dd>
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
            <strong>{{
              status.codex.authenticated && status.codex.modelReady
                ? "Ready"
                : "Action needed"
            }}</strong>
          </article>

          <article class="check-row">
            <span
              class="status-dot"
              [class.ready]="status.workspace.ready"
            ></span>
            <div>
              <h2>Workspace mounted</h2>
              <p>
                <code>{{ status.workspace.path }}</code>
              </p>
            </div>
            <strong>{{ status.workspace.ready ? "Ready" : "Missing" }}</strong>
          </article>

          <article class="check-row optional">
            <span class="status-dot"></span>
            <div>
              <h2>WhatsApp connected</h2>
              <p>Optional · available after the browser mission milestone</p>
            </div>
            <strong>Later</strong>
          </article>

          <article class="check-row">
            <span
              class="status-dot"
              [class.ready]="status.firstMissionReady"
            ></span>
            <div>
              <h2>First mission ready</h2>
              <p>
                A verified GPT-5.6 model can work inside the mounted workspace.
              </p>
            </div>
            <strong>{{
              status.firstMissionReady ? "Ready" : "Waiting"
            }}</strong>
          </article>
        </section>

        <a
          class="primary button-link start-mission"
          routerLink="/missions"
          [class.disabled]="!status.firstMissionReady"
          [attr.aria-disabled]="!status.firstMissionReady"
          >Start your first mission</a
        >
      }
    </main>
  `,
})
export class SetupComponent implements OnInit, OnDestroy {
  status: SetupStatus | null = null;
  apiKey = "";
  busy = false;
  error = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async startDeviceLogin(): Promise<void> {
    await this.run(async () => {
      await this.api.post("/api/setup/codex/device-auth");
      await this.refresh();
    });
  }

  async loginApiKey(): Promise<void> {
    const apiKey = this.apiKey;
    this.apiKey = "";
    await this.run(async () => {
      await this.api.post("/api/setup/codex/api-key", { apiKey });
      await this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    try {
      this.status = await this.api.get<SetupStatus>("/api/setup/status");
    } catch (error) {
      this.error = errorText(error);
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      await action();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
    }
  }
}
