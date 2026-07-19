import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  signal,
} from "@angular/core";
import RFB from "@novnc/novnc";
import { ApiService, errorText } from "./api.service";

interface DeskStatus {
  enabled: boolean;
  healthy: boolean;
  connectionState: string;
  control: "watch" | "human";
  controlExpiresAt: string | null;
  activeTurnId: string | null;
  ubuntuVersion?: string;
  chromeVersion?: string;
  codexVersion?: string;
  desktopStartedAt?: string;
  restartCount?: number;
}

interface DeskSession {
  websocketPath: string;
  viewOnly: boolean;
  expiresAt: string;
}

@Component({
  standalone: true,
  template: `
    <main class="page desk-page">
      <header class="page-header desk-header">
        <div>
          <p class="eyebrow">Live Desk</p>
          <h1>Codex's Ubuntu workstation</h1>
          <p class="muted">
            @if (status()?.healthy) {
              {{ status()?.ubuntuVersion || "Ubuntu" }} ·
              {{
                status()?.control === "human"
                  ? "Codex paused · interactive"
                  : "Interactive"
              }}
            } @else {
              {{
                status()?.enabled
                  ? "Desk is reconnecting"
                  : "Desk profile is not running"
              }}
            }
          </p>
        </div>
        <div class="desk-actions">
          <button
            type="button"
            (click)="openBrowser()"
            [disabled]="!status()?.healthy || busy()"
          >
            Open Browser
          </button>
          @if (status()?.control === "human") {
            <button
              class="primary"
              type="button"
              (click)="releaseControl()"
              [disabled]="busy()"
            >
              Release Control
            </button>
          } @else {
            <button
              class="primary"
              type="button"
              (click)="takeControl()"
              [disabled]="!status()?.healthy || busy()"
            >
              Pause Codex
            </button>
          }
          <button
            type="button"
            (click)="restart()"
            [disabled]="!status()?.healthy || busy()"
          >
            Restart Desk
          </button>
          <button
            type="button"
            (click)="fullScreen()"
            [disabled]="!connected()"
          >
            Full Screen
          </button>
        </div>
      </header>

      @if (error()) {
        <div class="callout error" role="alert">{{ error() }}</div>
      }

      <section class="desk-frame panel" [class.disconnected]="!connected()">
        <div #screen class="desk-screen" tabindex="0"></div>
        @if (!connected()) {
          <div class="desk-overlay">
            <div class="spinner"></div>
            <strong>{{
              status()?.enabled
                ? "Connecting to Live Desk…"
                : "Start with docker compose --profile desk up"
            }}</strong>
          </div>
        }
      </section>

      <footer class="desk-facts muted">
        <span>Click or type directly in the desktop</span>
        <span
          >Connection:
          {{
            connected() ? "Live" : status()?.connectionState || "Checking"
          }}</span
        >
        @if (status()?.chromeVersion) {
          <span>{{ status()?.chromeVersion }}</span>
        }
        @if (status()?.codexVersion) {
          <span>Codex {{ status()?.codexVersion }}</span>
        }
        <span>Restarts: {{ status()?.restartCount || 0 }}</span>
      </footer>
    </main>
  `,
})
export class DeskComponent implements AfterViewInit, OnDestroy {
  @ViewChild("screen", { static: true }) screen!: ElementRef<HTMLElement>;
  readonly status = signal<DeskStatus | null>(null);
  readonly connected = signal(false);
  readonly busy = signal(false);
  readonly error = signal("");
  private rfb: RFB | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(private readonly api: ApiService) {}

  ngAfterViewInit(): void {
    void this.refresh(true);
    this.statusTimer = setInterval(() => void this.refresh(false), 5_000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.rfb?.disconnect();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
  }

  async takeControl(): Promise<void> {
    const active = this.status()?.activeTurnId;
    const interruptActive = active
      ? globalThis.confirm(
          "Codex is working. Stop the active response and take control?",
        )
      : false;
    if (active && !interruptActive) return;
    await this.run(() =>
      this.api.post("/api/desk/control/acquire", { interruptActive }),
    );
    this.rfb?.focus();
  }

  async releaseControl(): Promise<void> {
    await this.run(() => this.api.post("/api/desk/control/release"));
  }

  async openBrowser(): Promise<void> {
    await this.run(() => this.api.post("/api/desk/actions/open-browser"));
  }

  async restart(): Promise<void> {
    if (
      !globalThis.confirm(
        "Restart the desktop session? Files and browser data will be preserved.",
      )
    )
      return;
    this.rfb?.disconnect();
    await this.run(() => this.api.post("/api/desk/actions/restart"));
    this.scheduleReconnect(2_000);
  }

  async fullScreen(): Promise<void> {
    await this.screen.nativeElement.parentElement?.requestFullscreen();
  }

  private async refresh(connect: boolean): Promise<void> {
    try {
      const status = await this.api.get<DeskStatus>("/api/desk/status");
      this.status.set(status);
      if (
        status.enabled &&
        status.healthy &&
        !this.rfb &&
        (connect || !this.reconnectTimer)
      ) {
        await this.connect();
      }
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  private async connect(): Promise<void> {
    if (this.destroyed || this.rfb) return;
    try {
      const session = await this.api.post<DeskSession>("/api/desk/session");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${location.host}${session.websocketPath}`;
      const rfb = new RFB(this.screen.nativeElement, url);
      this.rfb = rfb;
      // Live Desk is always interactive. Taking control only pauses Codex's
      // queue so the user can work without concurrent automation.
      rfb.viewOnly = false;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;
      rfb.focusOnClick = true;
      rfb.addEventListener("connect", () => {
        this.connected.set(true);
        this.error.set("");
      });
      rfb.addEventListener("disconnect", () => {
        if (this.rfb === rfb) this.rfb = null;
        this.connected.set(false);
        this.scheduleReconnect(5_000);
      });
      rfb.addEventListener("securityfailure", () => {
        this.error.set("Live Desk authentication failed");
      });
    } catch (error) {
      this.rfb = null;
      this.connected.set(false);
      this.error.set(errorText(error));
      this.scheduleReconnect(5_000);
    }
  }

  private scheduleReconnect(delay: number): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refresh(false).then(() => {
        if (this.status()?.healthy) void this.connect();
        else this.scheduleReconnect(5_000);
      });
    }, delay);
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      await action();
      await this.refresh(false);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.busy.set(false);
    }
  }
}
